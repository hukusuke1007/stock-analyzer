import { connectRepository } from "#db-connection";
import type { Settings } from "../settings";
import type { Account, Position, Trade } from "../simulator";

// DB の読み書きの窓口。保存先は3種類あり、SQL の方言と、まとめて書き込む方法(batch / トランザクション)が違う。
// - libSQL(ローカルの sqld)と Cloudflare D1: SQLite。repository.sqlite.ts
// - Cloud SQL・RDS: PostgreSQL。repository.pg.ts
// 呼び出す側(認証・設定・保存・シミュレーター)はこの型だけを使い、どの DB かを意識しない。
// どの DB に繋ぐかはビルドの種類と DATABASE_URL で決まる(connection.node.ts / connection.cloudflare.ts)

export type UserRecord = { id: string; email: string; passwordHash: string; createdAt: string };

export type SessionRecord = { id: string; userId: string; expiresAt: number; createdAt: string };

export type WatchlistRecord = { codes: string[]; columns: number };

// シミュレーターの口座。revision は口座を書き換えるたびに新しくする値で、同時に来た注文の食い違いの検出に使う
export type SimAccountRecord = Account & { revision: string };

// 注文1件で口座に加える変更。保有株は「新しく持つ / 株数などを変える / 売り切って消す」のどれか
export type SimPositionChange =
  | { kind: "insert"; position: Position }
  | { kind: "update"; code: string; shares: number; avgPrice: number; plan: Position["plan"] }
  | { kind: "delete"; code: string };

export type SimOrderChange = { cash: number; position: SimPositionChange; trade: Trade };

export type Repository = {
  // ---------- 認証 ----------
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: string): Promise<UserRecord | null>;
  // 同じメールアドレスがあれば、DB の一意制約で失敗する
  insertUser(user: UserRecord): Promise<void>;
  insertSession(session: SessionRecord): Promise<void>;
  // 有効期限(now より後)のセッションのユーザーを返す
  findSessionUser(sessionId: string, now: number): Promise<{ id: string; email: string } | null>;
  deleteSession(sessionId: string): Promise<void>;
  // ユーザーとそのデータをすべての表から消す(退会)
  deleteUserData(userId: string): Promise<void>;

  // ---------- 設定・関心銘柄 ----------
  loadSettings(userId: string): Promise<Settings | null>;
  saveSettings(userId: string, settings: Settings): Promise<void>;
  loadWatchlist(userId: string): Promise<WatchlistRecord | null>;
  saveWatchlist(userId: string, watchlist: WatchlistRecord): Promise<void>;

  // ---------- 判定結果・スクリーニング結果 ----------
  saveJudgment(userId: string, strategy: string, judgment: { code: string; judgedAt: string; data: unknown }): Promise<void>;
  loadJudgments(userId: string, strategy: string): Promise<unknown[]>;
  // 概要(summary)と銘柄ごとの結果(results)を1回の書き込みでまとめて保存する
  saveScreen(userId: string, strategy: string, screen: { scannedAt: string; summary: object; results: unknown[] }): Promise<void>;
  hasScreen(userId: string, strategy: string, scannedAt: string): Promise<boolean>;
  loadLatestScreen(userId: string, strategy: string): Promise<(object & { results: unknown[] }) | null>;
  clearResults(userId: string, strategy: string): Promise<{ judgments: number; screens: number }>;

  // ---------- シミュレーター ----------
  readSimAccount(userId: string): Promise<SimAccountRecord | null>;
  // 口座がまだなければ作る(すでにあれば何もしない)
  createSimAccountIfMissing(userId: string, account: SimAccountRecord): Promise<void>;
  // 保有株・売買履歴を消し、口座を account で置き換える(元金のリセット・旧版のデータの取り込み)
  replaceSimAccount(userId: string, account: SimAccountRecord): Promise<void>;
  // 口座の revision が expectedRevision のままなら、注文の変更をまとめて書き込み nextRevision にして true を返す。
  // 別の注文が先に書き込んでいたら何もせず false を返す(呼び出し側で読み直してやり直す)
  commitSimOrder(userId: string, expectedRevision: string, nextRevision: string, change: SimOrderChange): Promise<boolean>;
};

let repository: Repository | undefined;

/**
 * DB の読み書きの窓口を返す。接続は最初に使うときに1つだけ作って使い回す。
 */
export function getRepository(): Repository {
  repository ??= connectRepository();

  return repository;
}
