#!/bin/sh
# コンテナの起動スクリプト。Codex にログインし、マイグレーションを適用してから、アプリのサーバーを立てる。
# Codex の認証情報は、ホスティング先のシークレット(GCP の Secret Manager・AWS の Secrets Manager)から環境変数で受け取る。
# - OPENAI_API_KEY: OpenAI の API キー。Codex の公式が自動化に勧める方法なので、こちらを優先する
# - CODEX_AUTH_JSON: 手元で codex login して作られた ~/.codex/auth.json の中身(ChatGPT のログイン)
# どちらもなければ Codex は使えない扱いになり、判定は Jev か数値条件だけ、ランク付けは判定順になる
set -eu

mkdir -p "$CODEX_HOME"

if [ -n "${OPENAI_API_KEY:-}" ]; then
  # 値をコマンドの引数に置くとプロセスの一覧に出るので、標準入力で渡す
  printenv OPENAI_API_KEY | codex login --with-api-key > /dev/null
  echo "Codex: API キーでログインしました"
elif [ -n "${CODEX_AUTH_JSON:-}" ]; then
  # auth.json はパスワードと同じ扱い。自分だけが読めるようにしてから書く
  umask 077
  printenv CODEX_AUTH_JSON > "$CODEX_HOME/auth.json"
  echo "Codex: ChatGPT のログイン情報(CODEX_AUTH_JSON)を使います"
else
  echo "Codex: 認証情報(OPENAI_API_KEY / CODEX_AUTH_JSON)がないので使いません"
fi

# Codex がログイン情報を読み終えたので、子プロセス(アプリが起動する codex app-server を含む)に秘密を残さない
unset OPENAI_API_KEY CODEX_AUTH_JSON

node scripts/migrate.mjs
exec node .output/server/index.mjs
