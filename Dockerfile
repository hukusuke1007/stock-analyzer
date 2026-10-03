# Node のサーバーとして動かすイメージ(Docker Compose・Cloud Run・ECS 向け)。手順は HOW_TO_DEPLOY.md
# 起動時に Codex にログインし(認証情報はシークレットから環境変数で受け取る)、
# drizzle/(SQLite)か drizzle-pg/(PostgreSQL)のマイグレーションを適用してから、TanStack Start のサーバーを立てる

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
# Codex のログイン情報と作業ファイルの置き場所(node ユーザーのホームの下)
ENV CODEX_HOME=/home/node/.codex
# Codex CLI が要るもの。slim のイメージには入っていない
# - ca-certificates: OpenAI に TLS で繋ぐときの証明書の検証(ないと証明書を検証できず、再接続を繰り返して判定が止まる)
# - bubblewrap: Codex のサンドボックス(Codex の動作環境の前提)
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates bubblewrap \
  && rm -rf /var/lib/apt/lists/*
# 判定とランク付けに使う Codex CLI。動きが変わらないよう版を固定する
RUN npm install -g @openai/codex@0.160.0 && npm cache clean --force
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.output ./.output
COPY package.json ./
COPY drizzle ./drizzle
COPY drizzle-pg ./drizzle-pg
COPY scripts/migrate.mjs ./scripts/migrate.mjs
# RDS(PostgreSQL)に TLS で繋ぎ、サーバーの証明書まで検証するための CA 証明書の束(AWS が公開しているもの)。
# DATABASE_URL に ?sslmode=verify-full&sslrootcert=/app/rds-global-bundle.pem を付けて使う
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-global-bundle.pem
COPY docker/entrypoint.sh ./docker/entrypoint.sh
EXPOSE 3000
# 本番では root で動かさない
USER node
# Codex へのログイン → マイグレーション → サーバーの起動(docker/entrypoint.sh)
CMD ["./docker/entrypoint.sh"]
