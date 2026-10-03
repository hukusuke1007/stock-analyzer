import { bigint, boolean, doublePrecision, index, integer, jsonb, pgTable, primaryKey, text } from "drizzle-orm/pg-core";

// PostgreSQL(Cloud SQL・RDS)のスキーマ。SQLite 版(schema.sqlite.ts)とテーブル名・列名をそろえ、
// 型だけを PostgreSQL のものにする(JSON は jsonb、真偽値は boolean、金額は倍精度の浮動小数点)。
// 片方の列を変えたら、もう片方も同じように変えてマイグレーションを両方作る(pnpm db:generate)

export const users = pgTable("users", {
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
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    // UNIX 時刻(ミリ秒)は 32bit の integer に収まらないので bigint にする
    expiresAt: bigint("expires_at", { mode: "number" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const userSettings = pgTable("user_settings", {
  userId: userId().primaryKey(),
  decisionsProvider: text("decisions_provider", { enum: ["codex", "jev"] }).notNull(),
  codexModel: text("codex_model").notNull(),
  notifyTakeProfit: boolean("notify_take_profit").notNull().default(false),
  notifyStopLoss: boolean("notify_stop_loss").notNull().default(false),
});

export const watchlists = pgTable("watchlists", {
  userId: userId().primaryKey(),
  codes: jsonb("codes").$type<string[]>().notNull(),
  columns: integer("columns").notNull(),
});

export const judgments = pgTable(
  "judgments",
  {
    userId: userId(),
    strategy: text("strategy").notNull(),
    code: text("code").notNull(),
    judgedAt: text("judged_at").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.strategy, t.code] })],
);

export const screens = pgTable(
  "screens",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    strategy: text("strategy").notNull(),
    scannedAt: text("scanned_at").notNull(),
    data: jsonb("data").$type<object>().notNull(),
  },
  (t) => [index("screens_user_strategy_idx").on(t.userId, t.strategy, t.scannedAt)],
);

export const screenResults = pgTable(
  "screen_results",
  {
    screenId: text("screen_id")
      .notNull()
      .references(() => screens.id, { onDelete: "cascade" }),
    userId: userId(),
    position: integer("position").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.screenId, t.position] }), index("screen_results_user_idx").on(t.userId)],
);

export const simAccounts = pgTable("sim_accounts", {
  userId: userId().primaryKey(),
  initialCash: doublePrecision("initial_cash").notNull(),
  cash: doublePrecision("cash").notNull(),
  revision: text("revision").notNull().default(""),
  createdAt: text("created_at").notNull(),
});

export const simPositions = pgTable(
  "sim_positions",
  {
    userId: userId(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    shares: integer("shares").notNull(),
    avgPrice: doublePrecision("avg_price").notNull(),
    openedAt: text("opened_at").notNull(),
    plan: jsonb("plan").$type<unknown>(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.code] })],
);

export const simTrades = pgTable(
  "sim_trades",
  {
    id: text("id").primaryKey(),
    userId: userId(),
    at: text("at").notNull(),
    side: text("side", { enum: ["buy", "sell"] }).notNull(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    shares: integer("shares").notNull(),
    price: doublePrecision("price").notNull(),
    priceDate: text("price_date").notNull(),
    amount: doublePrecision("amount").notNull(),
    realized: doublePrecision("realized"),
  },
  (t) => [index("sim_trades_user_idx").on(t.userId, t.at)],
);
