import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import type { SimPlan } from "../simulator";
import type { Repository, SimAccountRecord } from "./repository";
import * as schema from "./schema.sqlite";

// SQLite 版の Repository。libSQL(ローカルの sqld・Turso)と Cloudflare D1 で共通に使う。
// D1 は BEGIN による対話的なトランザクションを使えないので、まとめて書き込むところはすべて batch にする
// (batch は1つのトランザクションとして実行され、途中で失敗したら全部取り消される)。

const {
  users,
  sessions,
  userSettings,
  watchlists,
  judgments,
  screens,
  screenResults,
  simAccounts,
  simPositions,
  simTrades,
} = schema;

// D1 の drizzle は型が別だが、ここで使う操作(select / insert / update / delete / batch / returning / get)は同じ形なので、
// libSQL の型にそろえて受け取る(connection.cloudflare.ts で変換する)
export type SqliteDatabase = LibSQLDatabase<typeof schema>;

// 銘柄ごとの結果を1つの INSERT に入れる行数。D1 は1つの文のバインド変数が100個までなので、
// 1行あたりの変数(screen_results の4列 + user_id で5個)で割って収める
const RESULT_ROWS_PER_INSERT = 20;

/**
 * SQLite 版の Repository を作る。
 */
export function createSqliteRepository(db: SqliteDatabase): Repository {
  return {
    async findUserByEmail(email) {
      return (await db.select().from(users).where(eq(users.email, email)).get()) ?? null;
    },

    async findUserById(id) {
      return (await db.select().from(users).where(eq(users.id, id)).get()) ?? null;
    },

    async insertUser(user) {
      await db.insert(users).values(user);
    },

    async insertSession(session) {
      await db.insert(sessions).values(session);
    },

    async findSessionUser(sessionId, now) {
      const row = await db
        .select({ id: users.id, email: users.email })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
        .get();

      return row ?? null;
    },

    async deleteSession(sessionId) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    // 外部キーの ON DELETE CASCADE でも消えるが、接続先の設定(PRAGMA foreign_keys)に左右されないよう、
    // 子のテーブルから明示的に消してから users を消す
    async deleteUserData(userId) {
      await db.batch([
        db.delete(sessions).where(eq(sessions.userId, userId)),
        db.delete(userSettings).where(eq(userSettings.userId, userId)),
        db.delete(watchlists).where(eq(watchlists.userId, userId)),
        db.delete(judgments).where(eq(judgments.userId, userId)),
        db.delete(screenResults).where(eq(screenResults.userId, userId)),
        db.delete(screens).where(eq(screens.userId, userId)),
        db.delete(simTrades).where(eq(simTrades.userId, userId)),
        db.delete(simPositions).where(eq(simPositions.userId, userId)),
        db.delete(simAccounts).where(eq(simAccounts.userId, userId)),
        db.delete(users).where(eq(users.id, userId)),
      ]);
    },

    async loadSettings(userId) {
      const row = await db
        .select({
          decisionsProvider: userSettings.decisionsProvider,
          codexModel: userSettings.codexModel,
          notifyTakeProfit: userSettings.notifyTakeProfit,
          notifyStopLoss: userSettings.notifyStopLoss,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .get();

      return row ?? null;
    },

    async saveSettings(userId, settings) {
      await db
        .insert(userSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({ target: userSettings.userId, set: settings });
    },

    async loadWatchlist(userId) {
      const row = await db
        .select({ codes: watchlists.codes, columns: watchlists.columns })
        .from(watchlists)
        .where(eq(watchlists.userId, userId))
        .get();

      return row ?? null;
    },

    async saveWatchlist(userId, watchlist) {
      await db
        .insert(watchlists)
        .values({ userId, ...watchlist })
        .onConflictDoUpdate({ target: watchlists.userId, set: watchlist });
    },

    async saveJudgment(userId, strategy, { code, judgedAt, data }) {
      await db
        .insert(judgments)
        .values({ userId, strategy, code, judgedAt, data })
        .onConflictDoUpdate({ target: [judgments.userId, judgments.strategy, judgments.code], set: { judgedAt, data } });
    },

    async loadJudgments(userId, strategy) {
      const rows = await db
        .select({ data: judgments.data })
        .from(judgments)
        .where(and(eq(judgments.userId, userId), eq(judgments.strategy, strategy)))
        .orderBy(judgments.code);

      return rows.map((r) => r.data);
    },

    async saveScreen(userId, strategy, { scannedAt, summary, results }) {
      const id = crypto.randomUUID();
      const rows = results.map((data, position) => ({ screenId: id, userId, position, data }));
      const chunks: (typeof rows)[] = [];
      for (let i = 0; i < rows.length; i += RESULT_ROWS_PER_INSERT) {
        chunks.push(rows.slice(i, i + RESULT_ROWS_PER_INSERT));
      }

      // 1つの batch で入れ、途中で失敗しても半端なスキャン結果を残さない
      await db.batch([
        db.insert(screens).values({ id, userId, strategy, scannedAt, data: summary }),
        ...chunks.map((chunk) => db.insert(screenResults).values(chunk)),
      ]);
    },

    async hasScreen(userId, strategy, scannedAt) {
      const row = await db
        .select({ id: screens.id })
        .from(screens)
        .where(and(eq(screens.userId, userId), eq(screens.strategy, strategy), eq(screens.scannedAt, scannedAt)))
        .get();

      return Boolean(row);
    },

    async loadLatestScreen(userId, strategy) {
      const latest = await db
        .select({ id: screens.id, data: screens.data })
        .from(screens)
        .where(and(eq(screens.userId, userId), eq(screens.strategy, strategy)))
        .orderBy(desc(screens.scannedAt))
        .limit(1)
        .get();
      if (!latest) {
        return null;
      }

      const rows = await db
        .select({ data: screenResults.data })
        .from(screenResults)
        .where(eq(screenResults.screenId, latest.id))
        .orderBy(asc(screenResults.position));

      return { ...(latest.data as object), results: rows.map((r) => r.data) };
    },

    async clearResults(userId, strategy) {
      const screensOfStrategy = and(eq(screens.userId, userId), eq(screens.strategy, strategy));
      const screenIds = db.select({ id: screens.id }).from(screens).where(screensOfStrategy);

      // 銘柄ごとの結果は、外部キーの設定に頼らず、概要より先に消す
      const [deletedJudgments, , deletedScreens] = await db.batch([
        db
          .delete(judgments)
          .where(and(eq(judgments.userId, userId), eq(judgments.strategy, strategy)))
          .returning({ code: judgments.code }),
        db.delete(screenResults).where(inArray(screenResults.screenId, screenIds)),
        db.delete(screens).where(screensOfStrategy).returning({ id: screens.id }),
      ]);

      return { judgments: deletedJudgments.length, screens: deletedScreens.length };
    },

    async readSimAccount(userId) {
      const account = await db.select().from(simAccounts).where(eq(simAccounts.userId, userId)).get();
      if (!account) {
        return null;
      }

      const positions = await db.select().from(simPositions).where(eq(simPositions.userId, userId)).orderBy(asc(simPositions.openedAt));
      const trades = await db.select().from(simTrades).where(eq(simTrades.userId, userId)).orderBy(asc(simTrades.at));

      return {
        initialCash: account.initialCash,
        cash: account.cash,
        revision: account.revision,
        createdAt: account.createdAt,
        positions: positions.map(({ userId: _owner, ...p }) => ({ ...p, plan: (p.plan as SimPlan | null) ?? null })),
        trades: trades.map(({ userId: _owner, ...t }) => t),
      };
    },

    async createSimAccountIfMissing(userId, account) {
      await db
        .insert(simAccounts)
        .values(accountRow(userId, account))
        .onConflictDoNothing({ target: simAccounts.userId });
    },

    async replaceSimAccount(userId, account) {
      const row = accountRow(userId, account);

      await db.batch([
        db.delete(simTrades).where(eq(simTrades.userId, userId)),
        db.delete(simPositions).where(eq(simPositions.userId, userId)),
        db.insert(simAccounts).values(row).onConflictDoUpdate({ target: simAccounts.userId, set: row }),
        ...account.positions.map((p) => db.insert(simPositions).values({ userId, ...p, plan: p.plan ?? null })),
        ...account.trades.map((t) => db.insert(simTrades).values({ userId, ...t })),
      ]);
    },

    // 1文目で revision を確かめながら現金を書き換え、2文目以降は「1文目が書き換えた後の revision」のときだけ書く。
    // 別の注文が先に revision を変えていれば1文目は0行になり、2文目以降も何も書かないので、口座は食い違わない
    async commitSimOrder(userId, expectedRevision, nextRevision, { cash, position, trade }) {
      const applied = sql`exists (select 1 from ${simAccounts} where ${simAccounts.userId} = ${userId} and ${simAccounts.revision} = ${nextRevision})`;

      let positionStatement;
      if (position.kind === "insert") {
        const p = position.position;
        positionStatement = db.run(sql`
          insert into ${simPositions} (user_id, code, name, shares, avg_price, opened_at, plan)
          select ${userId}, ${p.code}, ${p.name}, ${p.shares}, ${p.avgPrice}, ${p.openedAt}, ${p.plan ? JSON.stringify(p.plan) : null}
          where ${applied}`);
      } else if (position.kind === "update") {
        positionStatement = db
          .update(simPositions)
          .set({ shares: position.shares, avgPrice: position.avgPrice, plan: position.plan })
          .where(and(eq(simPositions.userId, userId), eq(simPositions.code, position.code), applied));
      } else {
        positionStatement = db.delete(simPositions).where(and(eq(simPositions.userId, userId), eq(simPositions.code, position.code), applied));
      }

      const [claimed] = await db.batch([
        db
          .update(simAccounts)
          .set({ cash, revision: nextRevision })
          .where(and(eq(simAccounts.userId, userId), eq(simAccounts.revision, expectedRevision)))
          .returning({ userId: simAccounts.userId }),
        positionStatement,
        db.run(sql`
          insert into ${simTrades} (id, user_id, at, side, code, name, shares, price, price_date, amount, realized)
          select ${trade.id}, ${userId}, ${trade.at}, ${trade.side}, ${trade.code}, ${trade.name}, ${trade.shares},
                 ${trade.price}, ${trade.priceDate}, ${trade.amount}, ${trade.realized}
          where ${applied}`),
      ]);

      return claimed.length > 0;
    },
  };
}

/**
 * 口座のテーブルの1行に変える。
 */
function accountRow(userId: string, account: SimAccountRecord) {
  return { userId, initialCash: account.initialCash, cash: account.cash, revision: account.revision, createdAt: account.createdAt };
}
