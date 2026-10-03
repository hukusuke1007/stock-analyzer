import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

// 判定結果をファイルに保存する。サーバーを再起動しても UI で前回の結果を見られるようにする。
// data/
// ├── judgments/<strategy>/<code>.json      # /judge の結果(銘柄ごとに最新だけ)
// ├── screens/<strategy>/<日時>.json         # /screen の結果(実行ごとに1ファイル)
// ├── simulator.json                         # 株シミュレーターの口座
// └── settings.json                          # アプリの設定(判定の AI・モデル)
// 保存先は DATA_DIR で変えられる(既定はこのディレクトリの data/)
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(import.meta.dirname, "../data"));

// 証券コードをファイル名に使うので、パス区切りなどを含むものは保存しない
const SAFE = /^[0-9A-Za-z.]+$/;

async function writeJson(file: string, data: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  // 書きかけのファイルを読まないよう、一時ファイルに書いてから置き換える
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}

async function jsonFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

export async function saveJudgment(strategy: string, result: { code: string }) {
  if (!SAFE.test(result.code)) return;
  await writeJson(path.join(DATA_DIR, "judgments", strategy, `${result.code}.json`), result);
}

export async function loadJudgments(strategy: string): Promise<unknown[]> {
  const dir = path.join(DATA_DIR, "judgments", strategy);
  const all = await Promise.all((await jsonFiles(dir)).map((f) => readJson(path.join(dir, f))));
  return all.filter((x) => x !== null);
}

export async function saveScreen(strategy: string, data: { scannedAt: string }) {
  const name = data.scannedAt.replace(/[:.]/g, "-");
  await writeJson(path.join(DATA_DIR, "screens", strategy, `${name}.json`), data);
}

export async function loadLatestScreen(strategy: string): Promise<unknown> {
  const dir = path.join(DATA_DIR, "screens", strategy);
  const latest = (await jsonFiles(dir)).at(-1);
  return latest ? readJson(path.join(dir, latest)) : null;
}

// 売買ルール1つ分の保存結果(個別の判定とスクリーニングの履歴)をまとめて消す
export async function clearResults(strategy: string) {
  const counts = {
    judgments: (await jsonFiles(path.join(DATA_DIR, "judgments", strategy))).length,
    screens: (await jsonFiles(path.join(DATA_DIR, "screens", strategy))).length,
  };
  await Promise.all(
    ["judgments", "screens"].map((kind) => rm(path.join(DATA_DIR, kind, strategy), { recursive: true, force: true })),
  );
  return counts;
}

// 関心銘柄(ウォッチリスト)。並び順と、一覧タブの1行の表示数
export type Watchlist = { codes: string[]; columns: number };
const WATCHLIST_FILE = path.join(DATA_DIR, "watchlist.json");

export async function loadWatchlist(): Promise<Watchlist | null> {
  return readJson<Watchlist>(WATCHLIST_FILE);
}

export async function saveWatchlist(w: Watchlist) {
  await writeJson(WATCHLIST_FILE, w);
}

// 株シミュレーターの口座(元金・現金・保有株・売買履歴)。中身の型は simulator.ts
const SIM_FILE = path.join(DATA_DIR, "simulator.json");

export async function loadSim<T>(): Promise<T | null> {
  return readJson<T>(SIM_FILE);
}

export async function saveSim(account: unknown) {
  await writeJson(SIM_FILE, account);
}

// アプリの設定(判定の AI・モデル)。中身の型は settings.ts
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

export async function loadSettingsFile<T>(): Promise<T | null> {
  return readJson<T>(SETTINGS_FILE);
}

export async function saveSettingsFile(settings: unknown) {
  await writeJson(SETTINGS_FILE, settings);
}
