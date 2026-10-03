# Node のサーバーとして動かすイメージ(Docker Compose・Cloud Run・ECS 向け)。手順は HOW_TO_DEPLOY.md
# 起動時に drizzle/(SQLite)か drizzle-pg/(PostgreSQL)のマイグレーションを適用してから、TanStack Start のサーバーを立てる

FROM node:24-slim AS base
WORKDIR /app
# package.json の packageManager に書いた版の pnpm を使う
RUN corepack enable

# 本番で要る依存だけを入れる(起動時のマイグレーションが drizzle-orm と @libsql/client / pg を使う)
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile

# 画面とサーバーをビルドする
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY package.json ./
COPY drizzle ./drizzle
COPY drizzle-pg ./drizzle-pg
COPY scripts/migrate.mjs ./scripts/migrate.mjs
# RDS(PostgreSQL)に TLS で繋ぎ、サーバーの証明書まで検証するための CA 証明書の束(AWS が公開しているもの)。
# DATABASE_URL に ?sslmode=verify-full&sslrootcert=/app/rds-global-bundle.pem を付けて使う
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
EXPOSE 3000
# 本番では root で動かさない
USER node
CMD ["sh", "-c", "node scripts/migrate.mjs && node .output/server/index.mjs"]
