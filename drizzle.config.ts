import { defineConfig } from "drizzle-kit";

// SQLite(libSQL・Turso・Cloudflare D1)のマイグレーションの生成(pnpm db:generate)に使う。
// 適用は scripts/migrate.mjs(pnpm db:migrate)、D1 は wrangler d1 migrations apply で行う。
// PostgreSQL(Cloud SQL・RDS)は drizzle.pg.config.ts
export default defineConfig({
  dialect: "turso",
  schema: "./src/server/db/schema.sqlite.ts",
  out: "./drizzle",
  dbCredentials: {
    url: process.env.DATABASE_URL || "http://localhost:8080",
    ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
  },
});
