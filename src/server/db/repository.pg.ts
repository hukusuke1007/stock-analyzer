import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { SimPlan } from "../simulator";
import type { Repository, SimAccountRecord } from "./repository";
import * as schema from "./schema.pg";

// PostgreSQL 版の Repository(Cloud SQL・RDS)。SQLite 版(repository.sqlite.ts)と同じ動きを、
// PostgreSQL の書き方(結果の1行目は配列から取る、まとめて書き込むところはトランザクション)で書く。

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

export type PgDatabase = NodePgDatabase<typeof schema>;

// 銘柄ごとの結果を1つの INSERT に入れる行数。PostgreSQL のバインド変数の上限(65,535)には遠いが、
// 1文が大きくなりすぎないよう区切る
const RESULT_ROWS_PER_INSERT = 200;

/**
 * PostgreSQL 版の Repository を作る。
 */
export function createPgRepository(db: PgDatabase): Repository {
  return {
    async findUserByEmail(email) {
      const [row] = await db.select().from(users).where(eq(users.email, email)).limit(1);

      return row ?? null;
    },

    async findUserById(id) {
      const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);

      return row ?? null;
    },

    async insertUser(user) {
      await db.insert(users).values(user);
    },

    async insertSession(session) {
      await db.insert(sessions).values(session);
    },

    async findSessionUser(sessionId, now) {
      const [row] = await db
        .select({ id: users.id, email: users.email })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(and(eq(sessions.id, sessionId), gt(sessions.expiresAt, now)))
        .limit(1);

      return row ?? null;
    },

    async deleteSession(sessionId) {
      await db.delete(sessions).where(eq(sessions.id, sessionId));
    },

    // ON DELETE CASCADE でも消えるが、SQLite 版と同じく子のテーブルから明示的に消す
    async deleteUserData(userId) {
      await db.transaction(async (tx) => {
        await tx.delete(sessions).where(eq(sessions.userId, userId));
        await tx.delete(userSettings).where(eq(userSettings.userId, userId));
        await tx.delete(watchlists).where(eq(watchlists.userId, userId));
        await tx.delete(judgments).where(eq(judgments.userId, userId));
        await tx.delete(screenResults).where(eq(screenResults.userId, userId));
        await tx.delete(screens).where(eq(screens.userId, userId));
        await tx.delete(simTrades).where(eq(simTrades.userId, userId));
        await tx.delete(simPositions).where(eq(simPositions.userId, userId));
        await tx.delete(simAccounts).where(eq(simAccounts.userId, userId));
        await tx.delete(users).where(eq(users.id, userId));
      });
    },

    async loadSettings(userId) {
      const [row] = await db
        .select({
          decisionsProvider: userSettings.decisionsProvider,
          codexModel: userSettings.codexModel,
          notifyTakeProfit: userSettings.notifyTakeProfit,
          notifyStopLoss: userSettings.notifyStopLoss,
        })
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);

      return row ?? null;
    },

    async saveSettings(userId, settings) {
      await db
        .insert(userSettings)
        .values({ userId, ...settings })
        .onConflictDoUpdate({ target: userSettings.userId, set: settings });
    },

    async loadWatchlist(userId) {
      const [row] = await db
        .select({ codes: watchlists.codes, columns: watchlists.columns })
        .from(watchlists)
        .where(eq(watchlists.userId, userId))
        .limit(1);

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

      // 1つのトランザクションで入れ、途中で失敗しても半端なスキャン結果を残さない
      await db.transaction(async (tx) => {
        await tx.insert(screens).values({ id, userId, strategy, scannedAt, data: summary });

        for (let i = 0; i < rows.length; i += RESULT_ROWS_PER_INSERT) {
          await tx.insert(screenResults).values(rows.slice(i, i + RESULT_ROWS_PER_INSERT));
        }
      });
    },

    async hasScreen(userId, strategy, scannedAt) {
      const [row] = await db
        .select({ id: screens.id })
        .from(screens)
        .where(and(eq(screens.userId, userId), eq(screens.strategy, strategy), eq(screens.scannedAt, scannedAt)))
        .limit(1);

      return Boolean(row);
    },

    async loadLatestScreen(userId, strategy) {
      const [latest] = await db
        .select({ id: screens.id, data: screens.data })
        .from(screens)
        .where(and(eq(screens.userId, userId), eq(screens.strategy, strategy)))
        .orderBy(desc(screens.scannedAt))
        .limit(1);
      if (!latest) {
        return null;
      }

      const rows = await db
        .select({ data: screenResults.data })
        .from(screenResults)
        .where(eq(screenResults.screenId, latest.id))
        .orderBy(asc(screenResults.position));

      return { ...latest.data, results: rows.map((r) => r.data) };
    },

    async clearResults(userId, strategy) {
      const screensOfStrategy = and(eq(screens.userId, userId), eq(screens.strategy, strategy));

      return db.transaction(async (tx) => {
        const deletedJudgments = await tx
          .delete(judgments)
          .where(and(eq(judgments.userId, userId), eq(judgments.strategy, strategy)))
          .returning({ code: judgments.code });
        await tx.delete(screenResults).where(inArray(screenResults.screenId, tx.select({ id: screens.id }).from(screens).where(screensOfStrategy)));
        const deletedScreens = await tx.delete(screens).where(screensOfStrategy).returning({ id: screens.id });

        return { judgments: deletedJudgments.length, screens: deletedScreens.length };
      });
    },

    async readSimAccount(userId) {
      const [account] = await db.select().from(simAccounts).where(eq(simAccounts.userId, userId)).limit(1);
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

      await db.transaction(async (tx) => {
        await tx.delete(simTrades).where(eq(simTrades.userId, userId));
        await tx.delete(simPositions).where(eq(simPositions.userId, userId));
        await tx.insert(simAccounts).values(row).onConflictDoUpdate({ target: simAccounts.userId, set: row });
        if (account.positions.length) {
          await tx.insert(simPositions).values(account.positions.map((p) => ({ userId, ...p, plan: p.plan ?? null })));
        }
        if (account.trades.length) {
          await tx.insert(simTrades).values(account.trades.map((t) => ({ userId, ...t })));
        }
      });
    },

    // revision を確かめながら現金を書き換え、書き換えられたときだけ同じトランザクションで保有株と売買履歴を書く。
    // 別の注文が先に revision を変えていれば何も書かずに false を返す(SQLite 版と同じ約束)
    async commitSimOrder(userId, expectedRevision, nextRevision, { cash, position, trade }) {
      return db.transaction(async (tx) => {
        const claimed = await tx
          .update(simAccounts)
          .set({ cash, revision: nextRevision })
          .where(and(eq(simAccounts.userId, userId), eq(simAccounts.revision, expectedRevision)))
          .returning({ userId: simAccounts.userId });
        if (claimed.length === 0) {
          return false;
        }

        if (position.kind === "insert") {
          await tx.insert(simPositions).values({ userId, ...position.position, plan: position.position.plan ?? null });
        } else if (position.kind === "update") {
          await tx
            .update(simPositions)
            .set({ shares: position.shares, avgPrice: position.avgPrice, plan: position.plan })
            .where(and(eq(simPositions.userId, userId), eq(simPositions.code, position.code)));
        } else {
          await tx.delete(simPositions).where(and(eq(simPositions.userId, userId), eq(simPositions.code, position.code)));
        }
        await tx.insert(simTrades).values({ userId, ...trade });

        return true;
      });
    },
  };
}

/**
 * 口座のテーブルの1行に変える。
 */
function accountRow(userId: string, account: SimAccountRecord) {
  return { userId, initialCash: account.initialCash, cash: account.cash, revision: account.revision, createdAt: account.createdAt };
}
