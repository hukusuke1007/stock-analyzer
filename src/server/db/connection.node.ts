import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/web";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import pg from "pg";
import type { Repository } from "./repository";
import { createPgRepository } from "./repository.pg";
import { createSqliteRepository } from "./repository.sqlite";
import * as pgSchema from "./schema.pg";
import * as sqliteSchema from "./schema.sqlite";

// Node で動かすとき(ローカル・Docker・Cloud Run・ECS)の接続。DATABASE_URL の形で接続先を選ぶ。
// - postgres:// / postgresql://: PostgreSQL(Cloud SQL・RDS)
// - それ以外(http:// / https:// / libsql://): libSQL(ローカルの sqld・Turso)
// vite.config.ts と tsconfig.json の "#db-connection" がこのファイルを指す(Workers 向けのビルドでは connection.cloudflare.ts)

const DEFAULT_URL = "http://localhost:8080";

/**
 * 環境変数から接続先を決め、DB の読み書きの窓口を作る。
 */
export function connectRepository(): Repository {
  const url = process.env.DATABASE_URL || DEFAULT_URL;

  if (/^postgres(ql)?:\/\//.test(url)) {
    // 接続はプールで使い回す。Cloud SQL の Unix ソケット(?host=/cloudsql/...)や RDS の TLS(?sslmode=...)は URL で指定する
    const pool = new pg.Pool({ connectionString: url });

    return createPgRepository(drizzlePg({ client: pool, schema: pgSchema }));
  }

  // libSQL は HTTP で繋ぐ。Node でも Workers でも同じ web 版のクライアントを使う
  const db = drizzleLibsql({
    connection: { url, ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}) },
    schema: sqliteSchema,
  });

  return createSqliteRepository(db);
}
