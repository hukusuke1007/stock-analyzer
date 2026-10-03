import { defineConfig } from "drizzle-kit";

// PostgreSQL(Cloud SQL・RDS)のマイグレーションの生成(pnpm db:generate)に使う。
// SQLite 版(drizzle.config.ts)とは方言が違うので、マイグレーションも drizzle-pg/ に分けて持つ
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/server/db/schema.pg.ts",
  out: "./drizzle-pg",
});
