import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { getRepository } from "./db/repository";

// メールアドレスとパスワードによる認証。
// パスワードは PBKDF2(SHA-256)でハッシュ化し、ログイン状態は DB のセッションと HttpOnly の Cookie で持つ。
// Web Crypto だけで書いているので、Node でも Cloudflare Workers でも追加の依存なしで動く。

export type SessionUser = { id: string; email: string };
export type AuthEnv = { Variables: { user: SessionUser } };

const SESSION_COOKIE = "sa_session";
const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600_000;

// Cloudflare Workers の PBKDF2 は反復回数の上限が 100,000 なので、それに合わせる
const PBKDF2_ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL = 254;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 409,
  ) {
    super(message);
  }
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/**
 * パスワードとソルトから PBKDF2 の派生鍵を作る。
 */
async function derivePasswordKey(password: string, salt: Uint8Array<ArrayBuffer>, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, material, HASH_BITS);

  return new Uint8Array(bits);
}

/**
 * パスワードをハッシュ化する。
 * 形式は `pbkdf2$反復回数$ソルト$ハッシュ`(Base64)。反復回数を残すのは、あとで回数を変えても古いハッシュを照合できるようにするため。
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordKey(password, salt, PBKDF2_ITERATIONS);

  return `pbkdf2$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/**
 * パスワードが保存したハッシュと一致するかを返す。
 * 比較は全バイトを見てから結果を出し、一致した長さで応答時間が変わらないようにする。
 */
export async function isPasswordValid(password: string, stored: string): Promise<boolean> {
  const [scheme, iterations, salt, hash] = stored.split("$");
  if (scheme !== "pbkdf2" || !iterations || !salt || !hash) {
    return false;
  }

  const expected = fromBase64(hash);
  const actual = await derivePasswordKey(password, fromBase64(salt), Number(iterations));
  if (actual.length !== expected.length) {
    return false;
  }

  let diff = 0;
  for (let i = 0; i < actual.length; i++) {
    diff |= actual[i]! ^ expected[i]!;
  }

  return diff === 0;
}

/**
 * セッションのトークンから、DB に保存する id(SHA-256 の16進)を作る。
 */
async function sessionIdFor(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 受け取ったメールアドレスとパスワードを確かめ、メールアドレスは小文字にそろえて返す。
 */
function validateCredentials(body: unknown): { email: string; password: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  const password = typeof b.password === "string" ? b.password : "";

  if (!EMAIL.test(email) || email.length > MAX_EMAIL) {
    throw new AuthError("メールアドレスの形式が正しくありません", 400);
  }
  if (password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new AuthError(`パスワードは${MIN_PASSWORD}〜${MAX_PASSWORD}文字で指定してください`, 400);
  }

  return { email, password };
}

/**
 * アカウントを作る。同じメールアドレスがすでにあれば 409 にする。
 */
export async function createAccount(body: unknown): Promise<SessionUser> {
  const { email, password } = validateCredentials(body);
  const repository = getRepository();

  const existing = await repository.findUserByEmail(email);
  if (existing) {
    throw new AuthError("このメールアドレスはすでに登録されています", 409);
  }

  const user = { id: crypto.randomUUID(), email };
  // 確認と登録のあいだに同じメールアドレスで登録されても、email の UNIQUE 制約で2件目は失敗する
  await repository.insertUser({ ...user, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() });

  return user;
}

/**
 * メールアドレスとパスワードを照合して、ユーザーを返す。
 * 未登録とパスワード違いは同じ文言で断る(どちらを間違えたかをログイン画面で教えないため)。
 */
export async function authenticate(body: unknown): Promise<SessionUser> {
  const { email, password } = validateCredentials(body);

  const row = await getRepository().findUserByEmail(email);
  if (!row || !(await isPasswordValid(password, row.passwordHash))) {
    throw new AuthError("メールアドレスかパスワードが違います", 401);
  }

  return { id: row.id, email: row.email };
}

/**
 * セッションを作り、Cookie に入れるトークンを返す。DB にはトークンのハッシュだけを残す。
 */
export async function createSession(userId: string): Promise<string> {
  const token = toBase64(crypto.getRandomValues(new Uint8Array(32)));

  await getRepository().insertSession({
    id: await sessionIdFor(token),
    userId,
    expiresAt: Date.now() + SESSION_MS,
    createdAt: new Date().toISOString(),
  });

  return token;
}

/**
 * トークンから有効期限内のセッションのユーザーを探す。見つからなければ null。
 */
export async function findSessionUser(token: string): Promise<SessionUser | null> {
  return getRepository().findSessionUser(await sessionIdFor(token), Date.now());
}

/**
 * セッションを消す(ログアウト)。
 */
export async function deleteSession(token: string) {
  await getRepository().deleteSession(await sessionIdFor(token));
}

/**
 * ユーザーとそのデータをすべて消す(退会)。
 */
export async function deleteAccount(userId: string) {
  await getRepository().deleteUserData(userId);
}

/**
 * セッションの Cookie を付ける。
 * HTTPS のときだけ Secure を付ける(ローカルの http://localhost でもログインできるようにするため)。
 */
function setSessionCookie(c: Parameters<typeof setCookie>[0], token: string) {
  const https = new URL(c.req.url).protocol === "https:" || c.req.header("x-forwarded-proto") === "https";

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    // 別サイトからの POST などに Cookie を送らせない(CSRF 対策)
    sameSite: "Lax",
    secure: https,
    path: "/",
    maxAge: SESSION_MS / 1000,
  });
}

/**
 * ログインが要る API の前に置く。セッションが有効なら c.var.user にユーザーを入れ、なければ 401 を返す。
 */
export const requireUser = createMiddleware<AuthEnv>(async (c, next) => {
  const token = getCookie(c, SESSION_COOKIE);
  const user = token ? await findSessionUser(token) : null;
  if (!user) {
    return c.json({ error: "ログインしてください" }, 401);
  }

  c.set("user", user);
  await next();
});

/**
 * 認証の API(/api/auth/*)。
 */
export const authRoutes = new Hono<AuthEnv>();

authRoutes.onError((e, c) => {
  if (e instanceof AuthError) {
    return c.json({ error: e.message }, e.status);
  }

  throw e;
});

// アカウントを作り、そのままログインした状態にする
authRoutes.post("/signup", async (c) => {
  const user = await createAccount(await c.req.json().catch(() => null));

  setSessionCookie(c, await createSession(user.id));

  return c.json({ user }, 201);
});

authRoutes.post("/login", async (c) => {
  const user = await authenticate(await c.req.json().catch(() => null));

  setSessionCookie(c, await createSession(user.id));

  return c.json({ user });
});

// ログアウト。セッションが切れていても Cookie は消す
authRoutes.post("/logout", async (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  if (token) {
    await deleteSession(token);
  }

  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.json({ ok: true });
});

// ログイン中のユーザー。画面の起動時に、ログイン画面へ移すかどうかの判断に使う
authRoutes.get("/me", requireUser, (c) => c.json({ user: c.var.user }));

// 退会。誤操作や、開いたままの端末から他人に消されるのを防ぐため、パスワードを入れ直してもらう
authRoutes.delete("/account", requireUser, async (c) => {
  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  const password = typeof body?.password === "string" ? body.password : "";

  const row = await getRepository().findUserById(c.var.user.id);
  if (!row || !(await isPasswordValid(password, row.passwordHash))) {
    throw new AuthError("パスワードが違います", 401);
  }

  await deleteAccount(c.var.user.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/" });

  return c.json({ ok: true });
});
