import { readFileSync } from "node:fs";
import path from "node:path";
import { loadSettingsFile, saveSettingsFile } from "./storage.js";

// アプリの設定。UI の設定ダイアログから変え、data/settings.json に保存する。
// 判定(Decisions)は decisionsProvider、Codex で使うモデル(判定とランク付け)は codexModel で決まる。

export type Provider = "codex" | "jev";
export type Settings = { decisionsProvider: Provider; codexModel: string };

export const PROVIDERS: Record<Provider, string> = {
  codex: "Codex(Codex App Server)",
  jev: "Jev(TypeSafe AI)",
};

const DEFAULTS: Settings = { decisionsProvider: "codex", codexModel: "gpt-6-luna" };

// 設定ダイアログに出すアプリの情報
const pkg = JSON.parse(readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8")) as { version: string; license: string };
export const APP_INFO = {
  name: "株分析シミュレーター(stock-analyzer)",
  version: pkg.version,
  license: pkg.license,
  author: "hobbydevelop",
  x: "https://x.com/hobbydevelop",
};

// 判定のたびにファイルを読まないよう、起動時に読み込んでメモリに持つ
let current: Settings = { ...DEFAULTS };
export const settingsReady = loadSettingsFile<Partial<Settings>>().then((saved) => {
  if (saved) current = { ...DEFAULTS, ...saved };
});

export function getSettings(): Settings {
  return current;
}

export class SettingsError extends Error {}

// 受け取った値を確かめてから保存する。省略した項目は今の値のまま
export async function updateSettings(body: unknown, models: string[]): Promise<Settings> {
  const b = (body ?? {}) as Record<string, unknown>;
  const next = { ...current };
  if (b.decisionsProvider !== undefined) {
    if (b.decisionsProvider !== "codex" && b.decisionsProvider !== "jev") {
      throw new SettingsError("decisionsProvider は codex / jev のいずれかを指定してください");
    }
    next.decisionsProvider = b.decisionsProvider;
  }
  if (b.codexModel !== undefined) {
    // Codex のモデル一覧が取れたときだけ照合する(取れないときは Codex 自体を使えない)
    if (typeof b.codexModel !== "string" || !b.codexModel.trim() || (models.length > 0 && !models.includes(b.codexModel))) {
      throw new SettingsError(`codexModel は Codex で使えるモデルを指定してください(${models.join(" / ")})`);
    }
    next.codexModel = b.codexModel;
  }
  await saveSettingsFile(next);
  current = next;
  return current;
}
