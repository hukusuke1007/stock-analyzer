# AGENTS.md

「株分析シミュレーター」(パッケージ名 stock-analyzer)。日本株の買い判断とランク付けを行う株分析ツール(TanStack Start + React の Web アプリ、API は Hono、データは Drizzle で SQLite(sqld・Turso・D1)と PostgreSQL(Cloud SQL・RDS)の両方に保存できる、TypeScript)。
AI エージェント(Codex / Claude Code など)がこのリポジトリで作業するときのルール。`CLAUDE.md` はこのファイルへのシンボリックリンク。

## まず読むもの

- `README.md` — 起動の仕方と使い方
- `DESIGN.md` — 判定の考え方、売買ルール、AI の使い分け、コードの構成、データの持ち方と認証
- `HOW_TO_DEPLOY.md` — セルフホスト(Cloudflare・GCP・AWS)の手順
- `docs/sequence.md` — `/api/screen` と `/api/judge` のシーケンス図

## コマンド

| コマンド                | 内容                                                  |
| ----------------------- | ----------------------------------------------------- |
| `pnpm install`          | 依存を入れる(pnpm 12。npm / yarn は使わない)          |
| `pnpm db:up`            | SQLite(libSQL サーバー)を Docker Compose で起動       |
| `pnpm db:migrate`       | マイグレーションを適用                                |
| `pnpm dev`              | アプリ(画面と API)を :3000 で起動                     |
| `pnpm typecheck`        | 型チェック                                            |
| `pnpm build`            | Node のサーバーとしてビルド                           |
| `pnpm build:cloudflare` | Cloudflare Workers 向けにビルド                       |

変更したら `pnpm typecheck`・`pnpm build`・`pnpm build:cloudflare` を必ず通す(CI と同じ)。
API の動きを変えたら `pnpm dev` で起動し、`curl` で `/api/auth/login` してから、Cookie を付けて `/api/health`・`/api/judge` を叩いて確かめる。
DB のスキーマを変えるときは、`src/server/db/schema.sqlite.ts` と `schema.pg.ts` の両方を同じように直し、`pnpm db:generate` で `drizzle/` と `drizzle-pg/` のマイグレーションを作ってコミットする。
DB の読み書きを変えたら、`src/server/db/repository.sqlite.ts` と `repository.pg.ts` の両方を直し、sqld と PostgreSQL(`docker compose --profile postgres up -d postgres`)の両方で確かめる。

## 構成

- `src/server/api.ts` — API(Hono、`/api` 配下)。エンドポイント、判定の組み立て(`judge`)、並び替えとランク付けの呼び出し。`src/routes/api/$.ts` から呼ばれる
- `src/server/auth.ts` — アカウント作成・ログイン・ログアウト・退会と、ログインが要る API の確認
- `src/server/db/` — DB の読み書きの窓口(`Repository`)と、SQLite 版・PostgreSQL 版の実装・スキーマ・接続先の選択。ユーザーのデータはすべて `user_id` で分ける
- `src/server/ai/` — AI の呼び出し。判定(Decisions)は `decisions.ts` がユーザーの設定(`src/server/settings.ts`、UI の設定ダイアログで変更)の `decisionsProvider`(`codex`(Node の既定) / `workers-ai`(Workers の既定) / `jev`)で振り分ける。ランク付けは `ranking.ts`(Codex、使えなければ Workers AI)
- `src/server/strategies/` — 売買ルール。増やすときは `Strategy` 型のオブジェクトを作り、`index.ts` の `STRATEGIES` に登録する
- `src/server/technicals.ts` — 日足の取得とテクニカル指標。画面のインジケーター(`src/lib/indicators.ts`)も同じ式で計算しているので、式を変えたら両方を直す
- `src/routes/`・`src/components/`・`src/lib/` — 画面(React + TanStack Router / Query / Store、lightweight-charts)
- `price_drivers/` — 東証プライムの企業ごとの株価変動要因レポート(`証券コード_企業名/日付_xxxx.md`)。アプリのコードではない。書き方は同ディレクトリの `AGENTS.md`

## 書き方

- コメント・ドキュメント・UI の文言は日本語。コメントは「なぜそうするか」を書く
- 数値で決まることはコードで判定し、AI には数値で決まらない判断だけを任せる(DESIGN.md の「役割の分け方」)
- AI の呼び出しに失敗しても全体は止めない。数値条件だけの判定に切り替え、失敗の内容を `concerns` に出す
- 株価・業績などの数値をコードやドキュメントに推測で書かない。例を載せるときは取得日を添える

## やってはいけないこと

- `data/`(旧版の判定結果・関心銘柄・シミュレーターの口座)・`.env`・`.dev.vars` をコミットしない。スクリーンショットにも個人の口座を写さない(デモ用は別のアカウントを作って撮る)
- 実際の発注につながる機能を足さない。シミュレーターは仮想売買のみ
- `pnpm-lock.yaml` の `xlsx` の integrity を消さない(pnpm 12 がインストールを止める)
- `/api/screen` を短時間に何度も実行しない(Yahoo Finance に約1,560件のリクエストを送る)
- 判定を投資助言として書かない。出力には免責(`DISCLAIMER`)を残す
