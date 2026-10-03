import { drizzle as drizzleLibsql } from "drizzle-orm/libsql/web";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

// マイグレーションを DATABASE_URL の DB に適用する。適用済みのものは飛ばす。
// - postgres:// / postgresql://: drizzle-pg/ を PostgreSQL(Cloud SQL・RDS)に
// - それ以外: drizzle/ を libSQL(ローカルの sqld・Turso)に
// Cloudflare D1 には使わない(wrangler d1 migrations apply で drizzle/ を当てる)。
// Docker のコンテナでも起動前に動かすので、TypeScript ではなく、そのまま node で動く JS にしている
const url = process.env.DATABASE_URL || "http://localhost:8080";
const folder = (name) => new URL(`../${name}`, import.meta.url).pathname;

if (/^postgres(ql)?:\/\//.test(url)) {
  const pool = new pg.Pool({ connectionString: url });

  try {
    await migratePg(drizzlePg({ client: pool }), { migrationsFolder: folder("drizzle-pg") });
  } finally {
    await pool.end();
  }
} else {
  const db = drizzleLibsql({
    connection: { url, ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}) },
  });

  await migrateLibsql(db, { migrationsFolder: folder("drizzle") });
}

console.log("マイグレーションを適用しました");
