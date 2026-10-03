import { getRepository } from "./db/repository";

// 判定結果・スクリーニング結果・関心銘柄を DB に保存する。サーバーを再起動しても UI で前回の結果を見られるようにする。
// どれもユーザーごとに分けて持つ(userId はログイン中のユーザー)。DB ごとの書き方の違いは Repository(db/)が吸収する。
// シミュレーターの口座は simulator.ts、設定は settings.ts が読み書きする。

/**
 * /judge の結果を保存する。売買ルールと銘柄ごとに最新の1件だけを残す。
 */
export async function saveJudgment(userId: string, strategy: string, result: { code: string; judgedAt: string }) {
  await getRepository().saveJudgment(userId, strategy, { code: result.code, judgedAt: result.judgedAt, data: result });
}

/**
 * 売買ルール1つ分の、銘柄ごとの判定結果をすべて返す。
 */
export async function loadJudgments(userId: string, strategy: string): Promise<unknown[]> {
  return getRepository().loadJudgments(userId, strategy);
}

/**
 * /screen の結果を保存する。実行ごとに、概要と銘柄ごとの結果を足す。
 * 1回分を1行にまとめると数 MB になり、D1 の1行の上限(2MB)を超えるので、銘柄ごとの結果は別の行に分ける。
 */
export async function saveScreen(userId: string, strategy: string, payload: { scannedAt: string; results: unknown[] }) {
  const { results, ...summary } = payload;

  await getRepository().saveScreen(userId, strategy, { scannedAt: payload.scannedAt, summary, results });
}

/**
 * 売買ルール1つ分の、最新のスクリーニング結果を返す。まだなければ null。
 */
export async function loadLatestScreen(userId: string, strategy: string): Promise<unknown> {
  return getRepository().loadLatestScreen(userId, strategy);
}

/**
 * 売買ルール1つ分の保存結果(個別の判定とスクリーニングの履歴)をまとめて消し、消した件数を返す。
 */
export async function clearResults(userId: string, strategy: string) {
  return getRepository().clearResults(userId, strategy);
}

// 関心銘柄(ウォッチリスト)。並び順と、一覧タブの1行の表示数
export type Watchlist = { codes: string[]; columns: number };

/**
 * 関心銘柄を返す。まだ保存していなければ null。
 */
export async function loadWatchlist(userId: string): Promise<Watchlist | null> {
  return getRepository().loadWatchlist(userId);
}

/**
 * 関心銘柄を保存する(行がなければ作り、あれば置き換える)。
 */
export async function saveWatchlist(userId: string, w: Watchlist) {
  await getRepository().saveWatchlist(userId, w);
}
