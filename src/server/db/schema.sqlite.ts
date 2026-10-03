import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

// 1つの SQLite データベース(libSQL / Cloudflare D1)を複数のユーザーで共有する。
// ユーザーのデータを持つテーブルはすべて user_id を持ち、退会したらユーザーごと消す(ON DELETE CASCADE)。
// 判定結果やスクリーニング結果は形が大きく、画面がそのまま読むだけなので JSON の列に入れる。
// D1 は1行が 2MB までなので、1行の JSON が大きくなりすぎない分け方にする(スクリーニング結果は銘柄ごとの行に分ける)。

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  // 大文字小文字の違いで別アカウントにならないよう、小文字にそろえて保存する
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: text("created_at").notNull(),
});

const userId = () =>
  text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" });

// ログイン中のセッション。Cookie に入れるトークンは保存せず、SHA-256 のハッシュを id にする
// (DB が漏れても、そのままセッションを乗っ取れないようにするため)
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    expiresAt: integer("expires_at").notNull(), // UNIX 時刻(ミリ秒)
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

// アプリの設定(判定の AI・Codex のモデル・通知)。行がなければ既定値を使う
export const userSettings = sqliteTable("user_settings", {
  userId: userId().primaryKey(),
  decisionsProvider: text("decisions_provider", { enum: ["codex", "jev", "workers-ai"] }).notNull(),
  codexModel: text("codex_model").notNull(),
  // シミュレーターの保有株が利確 / 損切りラインに届いたときのブラウザ通知
  notifyTakeProfit: integer("notify_take_profit", { mode: "boolean" }).notNull().default(false),
  notifyStopLoss: integer("notify_stop_loss", { mode: "boolean" }).notNull().default(false),
});

// 関心銘柄(ウォッチリスト)の並び順と、一覧タブの1行の表示数
export const watchlists = sqliteTable("watchlists", {
  userId: userId().primaryKey(),
  codes: text("codes", { mode: "json" }).$type<string[]>().notNull(),
  columns: integer("columns").notNull(),
});

// /judge の結果。売買ルールと銘柄ごとに最新の1件だけを持つ
export const judgments = sqliteTable(
  "judgments",
  {
    userId: userId(),
    strategy: text("strategy").notNull(),
    code: text("code").notNull(),
    judgedAt: text("judged_at").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.strategy, t.code] })],
);

// /screen の結果。実行ごとに1行を残す(画面は最新の1回分を読む)。
// data には銘柄ごとの結果(results)を除いた概要(件数・ランキングの要約・エラーなど)を入れる。
// id は、結果の行を同じ batch で一緒に入れられるよう、DB の採番ではなくアプリで作る
export const screens = sqliteTable(
  "screens",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    strategy: text("strategy").notNull(),
    scannedAt: text("scanned_at").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>().notNull(),
  },
  (t) => [index("screens_user_strategy_idx").on(t.userId, t.strategy, t.scannedAt)],
);

// /screen の銘柄ごとの結果。1回分をまとめて1行にすると数 MB になり、D1 の1行の上限(2MB)を超えるので分ける。
// position はスキャン結果の並び順(ランキング順)
export const screenResults = sqliteTable(
  "screen_results",
  {
    screenId: text("screen_id")
      .notNull()
      .references(() => screens.id, { onDelete: "cascade" }),
    userId: userId(),
    position: integer("position").notNull(),
    data: text("data", { mode: "json" }).$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.screenId, t.position] }), index("screen_results_user_idx").on(t.userId)],
);

// 株シミュレーターの口座。保有株と売買履歴は別のテーブルに持つ。
// revision は口座を書き換えるたびに新しくする値。D1 は BEGIN による対話的なトランザクションを使えないので、
// 注文は「読んだときの revision のままなら書く」形で、同時に来た別の注文との食い違いを防ぐ(simulator.ts)
export const simAccounts = sqliteTable("sim_accounts", {
  userId: userId().primaryKey(),
  initialCash: real("initial_cash").notNull(),
  cash: real("cash").notNull(),
  revision: text("revision").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

// 買ったときの判定の売り方(利確・損切りライン)。中身の型は simulator.ts の SimPlan
export const simPositions = sqliteTable(
  "sim_positions",
  {
    userId: userId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    shares: integer("shares").notNull(),
    avgPrice: real("avg_price").notNull(),
    openedAt: text("opened_at").notNull(),
    plan: text("plan", { mode: "json" }).$type<unknown>(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

export const simTrades = sqliteTable(
  "sim_trades",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    at: text("at").notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    shares: integer("shares").notNull(),
    price: real("price").notNull(),
    priceDate: text("price_date").notNull(),
    amount: real("amount").notNull(),
    realized: real("realized"),
  },
  (t) => [index("sim_trades_user_idx").on(t.userId, t.at)],
);
