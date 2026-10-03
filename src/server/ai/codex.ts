import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { getSettings } from "../settings.js";
import type { JsonValue } from "../strategies/index.js";

// Codex App Server(`codex app-server`、stdio の JSON-RPC)のクライアント。
// 認証は Codex CLI のログイン(ChatGPT アカウント)をそのまま使うので API キーは要らない。
// プロセスは1つだけ立ち上げて使い回し、問い合わせごとに使い捨てのスレッド(ephemeral)で1ターンだけ回す。
// 銘柄ごとの判定(ai/decisions-batch.ts)と、判定済みの銘柄のランク付け(ai/ranking.ts)に使う。
// プロトコル: https://developers.openai.com/codex/app-server

const BIN = process.env.CODEX_BIN ?? "codex";
// 判定(Decisions)とランク付けの両方で使うモデルは、設定(settings.ts の codexModel)で決める
export const codexModel = () => getSettings().codexModel;
const TURN_TIMEOUT_MS = 5 * 60_000;


type TurnCompleted = {
  threadId: string;
  turn: { status: string; error: { message: string } | null; items: { type: string; text?: string }[] };
};

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  // スレッドごとのターン完了待ち
  private turns = new Map<string, { resolve: (p: TurnCompleted) => void; reject: (e: Error) => void }>();
  private stderr = "";
  closed: Error | null = null;
  ready: Promise<void>;

  constructor() {
    this.child = spawn(BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.on("error", (e) => this.close(e));
    this.child.on("exit", (code) => this.close(new Error(`codex app-server が終了した(code ${code}) ${this.stderr.trim()}`)));
    this.ready = (async () => {
      await this.request("initialize", {
        clientInfo: { name: "stock_analyzer", title: "Stock Analyzer", version: "0.2.0" },
        capabilities: null,
      });
      this.send({ method: "initialized" });
    })();
  }

  private send(msg: object) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string) {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.id !== undefined) {
      // サーバーからの要求(コマンド実行の承認など)。何も実行させないので断る
      this.send({ id: msg.id, error: { code: -32601, message: "このクライアントは対応していない" } });
    } else if (msg.method === "turn/completed") {
      const p = msg.params as TurnCompleted;
      this.turns.get(p.threadId)?.resolve(p);
      this.turns.delete(p.threadId);
    } else if (msg.method === "error") {
      const p = msg.params as { threadId?: string; error?: { message?: string }; willRetry?: boolean };
      if (p.willRetry || !p.threadId) return;
      this.turns.get(p.threadId)?.reject(new Error(redactApiKey(p.error?.message ?? "Codex のエラー")));
      this.turns.delete(p.threadId);
    }
  }

  private close(e: Error) {
    if (this.closed) return;
    this.closed = e;
    for (const p of this.pending.values()) p.reject(e);
    for (const t of this.turns.values()) t.reject(e);
    this.pending.clear();
    this.turns.clear();
    this.child.kill();
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    const res = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    this.send({ id, method, params });
    return res;
  }

  // 構造化出力(outputSchema)つきで1ターン回し、最終メッセージを JSON で返す
  async turn<T>(opts: TurnOptions): Promise<{ model: string; output: T }> {
    await this.ready;
    const started = await this.request<{ thread: { id: string }; model: string }>("thread/start", {
      model: opts.model,
      cwd: os.tmpdir(), // リポジトリを読ませない
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      developerInstructions: opts.instructions,
      serviceName: "stock_analyzer",
    });
    const threadId = started.thread.id;
    let timer: NodeJS.Timeout | undefined;
    const completed = new Promise<TurnCompleted>((resolve, reject) => {
      this.turns.set(threadId, { resolve, reject });
      timer = setTimeout(() => {
        this.turns.delete(threadId);
        reject(new Error(`Codex のターンが ${TURN_TIMEOUT_MS / 1000} 秒で終わらない`));
      }, TURN_TIMEOUT_MS);
    });
    try {
      await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        effort: opts.effort,
        outputSchema: opts.schema,
      });
      const { turn } = await completed;
      if (turn.status !== "completed") throw new Error(`Codex のターンが ${turn.status}: ${redactApiKey(turn.error?.message ?? "")}`);
      const text = turn.items.filter((i) => i.type === "agentMessage").at(-1)?.text;
      if (!text) throw new Error("Codex の応答に最終メッセージがない");
      return { model: started.model, output: JSON.parse(text) as T };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * エラー文に入る API キー(OpenAI は一部を伏せて sk-abcd*****wxyz の形で返す)を、すべて伏せる。
 * エラー文は判定結果の懸念点として保存され、ほかのユーザーも見る画面に出るため。
 */
function redactApiKey(message: string): string {
  return message.replace(/sk-[A-Za-z0-9_*-]+/g, "sk-***");
}

export type TurnOptions = { instructions: string; prompt: string; schema: JsonValue; model: string; effort: string };

// 落ちていたら立ち上げ直す
let server: AppServer | undefined;
function appServer() {
  if (!server || server.closed) server = new AppServer();
  return server;
}

export function runTurn<T>(opts: TurnOptions) {
  return appServer().turn<T>(opts);
}

// Codex で使えるモデルの一覧(設定ダイアログの選択肢)。ChatGPT アカウントで使えるものだけが返る
export type CodexModel = { id: string; label: string; isDefault: boolean };
let modelsCache: Promise<CodexModel[]> | undefined;
export function listCodexModels(): Promise<CodexModel[]> {
  modelsCache ??= (async () => {
    if (!(await codexAvailable())) return [];
    const s = appServer();
    const res = await s.request<{ data: { id?: string; model?: string; displayName?: string; isDefault?: boolean }[] }>("model/list", {});
    return res.data.flatMap((m) => {
      const id = m.id ?? m.model;
      return id ? [{ id, label: m.displayName ?? id, isDefault: Boolean(m.isDefault) }] : [];
    });
  })().catch((e) => {
    modelsCache = undefined; // 次に開いたときに取り直す
    throw e;
  });
  return modelsCache;
}

// 起動時に一度だけ、App Server が立ち上がって初期化でき、ログインしているかを確かめる。
// ログインしていなくても App Server は起動するので、ログインまで見ないと、判定のたびに認証のエラーで失敗する
let available: Promise<boolean> | undefined;
export function codexAvailable(): Promise<boolean> {
  available ??= (async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      // Cloudflare Workers のようにプロセスを起動できない環境では、ここで例外になる(Codex は使えない扱い)
      const s = appServer();
      await Promise.race([
        s.ready,
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("20秒で初期化できない")), 20_000))),
      ]);

      // account は ChatGPT のログインなら { type: "chatgpt" }、API キーなら { type: "apiKey" }、未ログインなら null
      const { account } = await s.request<{ account: { type: string } | null }>("account/read", {});
      if (!account) {
        console.error("Codex にログインしていない。手元では codex login、コンテナでは OPENAI_API_KEY か CODEX_AUTH_JSON を設定する");
        return false;
      }

      return true;
    } catch (e) {
      console.error(`Codex App Server を使えない: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return available;
}
