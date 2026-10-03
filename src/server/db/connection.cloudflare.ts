import { env } from "cloudflare:workers";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/web";
import type { Repository } from "./repository";
import { createSqliteRepository, type SqliteDatabase } from "./repository.sqlite";
import * as sqliteSchema from "./schema.sqlite";

// Cloudflare Workers で動かすときの接続。
// - DATABASE_URL(シークレット)があれば、その libSQL(Turso)に HTTP で繋ぐ
// - なければ、wrangler.jsonc の D1 のバインディング(DB)を使う
// Workers は TCP で PostgreSQL に繋がないので、ここでは SQLite(D1・Turso)だけを扱う

/**
 * Workers のバインディングとシークレットから接続先を決め、DB の読み書きの窓口を作る。
 */
export function connectRepository(): Repository {
  if (env.DATABASE_URL) {
    const db = drizzleLibsql({
      connection: { url: env.DATABASE_URL, ...(env.DATABASE_AUTH_TOKEN ? { authToken: env.DATABASE_AUTH_TOKEN } : {}) },
      schema: sqliteSchema,
    });

    return createSqliteRepository(db);
  }

  if (!env.DB) {
    throw new Error("D1 のバインディング DB がありません。wrangler.jsonc の d1_databases を確認してください");
  }

  // D1 と libSQL の drizzle は型が別だが、Repository が使う操作は同じ形なので libSQL の型にそろえる
  const db = drizzleD1(env.DB as Parameters<typeof drizzleD1>[0], { schema: sqliteSchema }) as unknown as SqliteDatabase;

  return createSqliteRepository(db);
}
