import { AsyncLocalStorage } from "node:async_hooks";
import pkg from "../../package.json";
import { workersAiAvailable } from "./ai/workers-ai";
import { getRepository } from "./db/repository";

// アプリの設定。UI の設定ダイアログから変え、ユーザーごとに DB(user_settings)に保存する。
// 判定(Decisions)は decisionsProvider、Codex で使うモデル(判定とランク付け)は codexModel で決まる。
// notifyTakeProfit / notifyStopLoss は、シミュレーターの保有株がラインに届いたときのブラウザ通知(画面側で出す)。

export type Provider = "codex" | "jev" | "workers-ai";
export type Settings = { decisionsProvider: Provider; codexModel: string; notifyTakeProfit: boolean; notifyStopLoss: boolean };

export const PROVIDERS: Record<Provider, string> = {
  codex: "Codex(Codex App Server)",
  jev: "Jev(TypeSafe AI)",
  "workers-ai": "Workers AI(Cloudflare)",
};

const PROVIDER_IDS = Object.keys(PROVIDERS) as Provider[];

/**
 * まだ設定を保存していないユーザーの設定。判定の AI は、Codex を起動できない Cloudflare Workers では Workers AI にする。
 */
function defaultSettings(): Settings {
  return {
    decisionsProvider: workersAiAvailable() ? "workers-ai" : "codex",
    codexModel: "gpt-6-luna",
    notifyTakeProfit: false,
    notifyStopLoss: false,
  };
}

// 設定ダイアログに出すアプリの情報
export const APP_INFO = {
  name: "株分析シミュレーター(stock-analyzer)",
  version: pkg.version,
  license: pkg.license,
  author: "hobbydevelop",
  x: "https://x.com/hobbydevelop",
};

// リクエストを出したユーザーとその設定。AI の呼び出し(ai/)は深い所で設定を読むので、
// 引数で渡し回さずにリクエストの処理全体から読めるようにする。
// プロセス全体の変数に置くと、同時に来た別のユーザーのリクエストと設定が混ざる
const requestContext = new AsyncLocalStorage<{ userId: string; settings: Settings }>();

/**
 * ユーザーの設定を DB から読む。まだ保存していなければ既定値を返す。
 * 複数のサーバー(インスタンス)で設定が食い違わないよう、メモリに持たずリクエストのたびに読む。
 */
export async function loadSettings(userId: string): Promise<Settings> {
  return (await getRepository().loadSettings(userId)) ?? defaultSettings();
}

/**
 * userId のユーザーのリクエストとして、settings を今の設定にして fn を実行する。
 * fn の中から呼んだ getSettings()・getRequestUserId() はこの値を返す。
 */
export function runWithSettings<T>(userId: string, settings: Settings, fn: () => T): T {
  return requestContext.run({ userId, settings }, fn);
}

/**
 * 今のリクエストの設定を返す。リクエストの外(起動時など)では既定値。
 */
export function getSettings(): Settings {
  return requestContext.getStore()?.settings ?? defaultSettings();
}

/**
 * 今のリクエストを出したユーザーの ID を返す。リクエストの外では null。
 */
export function getRequestUserId(): string | null {
  return requestContext.getStore()?.userId ?? null;
}

export class SettingsError extends Error {}

/**
 * 受け取った値を確かめてから、ユーザーの設定として保存する。省略した項目は今の値のまま。
 */
export async function updateSettings(userId: string, body: unknown, models: string[]): Promise<Settings> {
  const b = (body ?? {}) as Record<string, unknown>;
  const next = await loadSettings(userId);

  if (b.decisionsProvider !== undefined) {
    if (!PROVIDER_IDS.includes(b.decisionsProvider as Provider)) {
      throw new SettingsError(`decisionsProvider は ${PROVIDER_IDS.join(" / ")} のいずれかを指定してください`);
    }
    next.decisionsProvider = b.decisionsProvider as Provider;
  }
  if (b.codexModel !== undefined) {
    // Codex のモデル一覧が取れたときだけ照合する(取れないときは Codex 自体を使えない)
    if (typeof b.codexModel !== "string" || !b.codexModel.trim() || (models.length > 0 && !models.includes(b.codexModel))) {
      throw new SettingsError(`codexModel は Codex で使えるモデルを指定してください(${models.join(" / ")})`);
    }
    next.codexModel = b.codexModel;
  }
  for (const key of ["notifyTakeProfit", "notifyStopLoss"] as const) {
    if (b[key] === undefined) {
      continue;
    }
    if (typeof b[key] !== "boolean") {
      throw new SettingsError(`${key} は true / false で指定してください`);
    }

    next[key] = b[key];
  }

  await getRepository().saveSettings(userId, next);

  return next;
}
