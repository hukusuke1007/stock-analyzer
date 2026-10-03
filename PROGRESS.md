# 実行計画: セルフホスト対応(TanStack Start + Drizzle + SQLite)

株分析シミュレーターを、Cloudflare・GCP・AWS のどこにでも置ける構成に移す。
UI は TanStack Start(Router・Query)と Vite の React アプリに作り直し、JSON ファイルへの保存は Drizzle 経由の SQLite に置き換える。
見出しは大きな issue の単位とし、その下にやるべきタスクを1行ずつ並べる。終わったタスクには `[x]` を付ける。

## 前提と決めたこと

- [x] API は Hono のまま残し、TanStack Start のサーバールート `/api/$` に載せる(エンドポイントの処理を書き直さずに Node・Workers の両方で動かすため)
- [x] API のパスは `/api/...` に移す(画面のパスと衝突させないため)
- [x] SQLite は libSQL のサーバー(sqld)を Compose で立て、Drizzle から HTTP で接続する(Workers でも同じドライバー `@libsql/client/web` で Turso に繋げるため)
- [x] 画面はクライアント描画(`defaultSsr: false`)にする(localStorage とチャートの描画がブラウザ前提のため)
- [x] Codex App Server は子プロセスを起動するので、Node で動かすときだけ使える。Workers では Jev だけを使う
- [x] 1つの SQLite データベースを複数のユーザーで共有する。判定結果・スクリーニング・関心銘柄・設定・シミュレーターの口座はすべてユーザーごとに分ける
- [x] 認証はメールアドレスとパスワードだけにする。パスワードは Web Crypto の PBKDF2 でハッシュ化する(Workers でも追加の依存なしで動くため)
- [x] ログイン状態は DB のセッションと HttpOnly の Cookie で持つ(トークンはハッシュだけを保存する)
- [x] 背景は黒に統一する

## 1. TanStack Start の土台

- [x] 依存を入れ替える(React・TanStack Start / Router / Query・Drizzle・libSQL を足し、`@hono/node-server` を外す)
- [x] `vite.config.ts` を TanStack Start + React + Nitro(Node 用)の構成にする
- [x] `tsconfig.json` を React(JSX)とサーバー・UI の両方を型検査する設定にする
- [x] `src/router.tsx`・`src/start.ts`・`src/routes/__root.tsx` を作り、`pnpm dev` で空の画面が出ることを確かめる

## 2. API の移植

- [x] サーバー側のコードを `src/server/` に移す(`git mv` で履歴を残す)
- [x] `server.ts` から Node 専用の起動処理(`serve`・`serveStatic`)を外し、Hono アプリを `/api` 配下で公開する
- [x] `src/routes/api/$.ts` で全メソッドを Hono に渡す
- [x] `settings.ts` の `package.json` 読み込み・`storage.ts` の `import.meta.dirname` など、ファイルシステム前提の処理を外す
- [x] `curl` で `/api/health`・`/api/strategies`・`/api/bars/7203`・`/api/judge` の応答を確かめる

## 3. データベース(Drizzle + SQLite)

- [x] `compose.yaml` に libSQL サーバー(sqld)を定義し、データをボリュームに永続化する
- [x] Drizzle のスキーマを定義する(判定結果・スクリーニング履歴・関心銘柄・設定・シミュレーターの口座 / 保有株 / 売買履歴)
- [x] `drizzle.config.ts` とマイグレーションを作り、`pnpm db:migrate` で適用できるようにする
- [x] DB クライアントを `DATABASE_URL`・`DATABASE_AUTH_TOKEN` から作る

## 4. 認証(マルチユーザー)

- [x] ユーザー・セッションのテーブルを足す
- [x] パスワードのハッシュ化と照合、セッションの発行・検証・破棄を作る
- [x] アカウント作成・ログイン・ログアウト・退会・ログイン中のユーザーの API を作る
- [x] 認証が要る API にミドルウェアを掛け、未ログインなら 401 を返す
- [x] 退会でそのユーザーのデータ(判定結果・関心銘柄・設定・口座・セッション)をすべて消す

## 5. 保存処理の置き換え

- [x] `storage.ts` の判定結果・スクリーニング・関心銘柄を、ユーザーごとに Drizzle で読み書きする形に置き換える
- [x] 設定(`settings.ts`)をユーザーごとに、リクエストのたびに DB から読む形にする(複数インスタンスで設定が食い違わないため)
- [x] シミュレーターの注文を DB のトランザクションで処理する(プロセス内の直列化キューは複数インスタンスで効かないため)
- [x] 既存の `data/*.json` を指定したユーザーの DB に取り込むスクリプト(`pnpm db:import`)を作り、手元のデータで確かめる

## 6. UI の土台(Router・Query)

- [x] 画面を `/`(チャート)・`/watchlist`(関心銘柄)・`/sim`(シミュレーター)のルートに分ける
- [x] API クライアントと TanStack Query のクエリ・ミューテーションを定義する
- [x] 売買ルール・材料・インジケーターなどの画面の状態を、localStorage に保存するストアにまとめる
- [x] 上部バー(タブ・銘柄検索・売買ルール・材料・インジケーター・ライブ更新・AI の状態)を作る
- [x] 設定ダイアログを作る
- [x] アカウント作成・ログイン画面と、ログアウト・退会の操作を作る。未ログインならログイン画面に移す
- [x] 既存の `style.css` を移し、背景を黒に統一する

## 7. UI: チャート画面

- [x] インジケーターの計算(`computeIndicators`・一目均衡表)を TypeScript のモジュールに移す
- [x] メインチャート(ローソク足・移動平均・ボリンジャーバンド・一目均衡表・出来高・RSI・RCI・MACD)を作る
- [x] 凡例・データ表示・利確 / 損切りライン・期間ボタン・ツールバーを作る
- [x] 右パネル(ウォッチリスト・判定の詳細・ニュースの入力・再判定)を作る
- [x] スクリーナー(全銘柄スキャンの SSE・絞り込み・並べ替え・結果のクリア)を作る
- [x] 取引時間中のライブ更新を作る

## 8. UI: 関心銘柄タブ

- [x] 関心銘柄のチャートを格子状に並べる(表示数の切り替え・並べ替え・追加・削除)

## 9. UI: シミュレーター タブ

- [x] 口座の概要・保有株・売買履歴・元金のリセットを作る
- [x] 売買ダイアログ(注文欄・判定の売り方の引き継ぎ)を作る

## 10. ロゴと通知

- [x] 上部バー・ログイン画面・ファビコンのロゴを、SVG でデザインし直す
- [x] シミュレーターの保有株が利確ライン・損切りラインに届いたら、ブラウザ通知を出す(同じラインでは1回だけ)
- [x] 利確・損切りの通知をそれぞれ設定ダイアログで ON / OFF できるようにし、ユーザーごとの設定として DB に保存する(ON にするときにブラウザの通知の許可を求める)

## 11. セルフホスト

- [x] Node 用の `Dockerfile` を作り、Compose に app サービスを足して `docker compose up` で全体が動くことを確かめる
- [x] Cloudflare Workers 用の設定(`wrangler.jsonc`・ビルドの切り替え)を作り、ビルドが通ることを確かめる
- [x] セルフホストの手順を `HOW_TO_DEPLOY.md` に、Cloudflare・GCP・AWS の場合に分けて書く

## 12. ドキュメントと CI

- [x] `README.md`(起動の仕方・環境変数・API のパス・保存先)を更新する
- [x] `AGENTS.md`・`DESIGN.md`(コードの構成)・`docs/sequence.md` を更新する
- [x] CI(`.github/workflows/ci.yml`)を新しいコマンド(型検査・ビルド)に合わせる
- [x] 旧 UI(`ui/`)と不要になった設定を削除する

## 13. Cloudflare では D1 を使う

- [x] Workers でビルドしたときは D1 のバインディング(`DB`)に、Node では libSQL(`DATABASE_URL`)に接続する
- [x] シミュレーターの注文をトランザクション(`BEGIN`)なしで処理する(D1 は対話的なトランザクションに対応していないため)
- [x] `wrangler.jsonc` に D1 のバインディングとマイグレーションの置き場所(`drizzle/`)を設定し、ローカルの D1 で動作を確かめる
- [x] 手元の sqld のデータを D1 に移す手順を用意する
- [x] `HOW_TO_DEPLOY.md` の Cloudflare の手順を D1 に書き換え、README・DESIGN.md の記述を合わせる
- [x] D1 の1行の上限(2MB)に収まるよう、スクリーニング結果を銘柄ごとの行に分けて保存する

## 14. GCP は Cloud SQL、AWS は RDS(PostgreSQL)を使う

- [x] DB の読み書きを Repository にまとめ、SQLite 版(libSQL・D1)と PostgreSQL 版を実装する
- [x] PostgreSQL のスキーマとマイグレーション(`drizzle-pg/`)を作り、`pnpm db:migrate` が接続先に合わせて適用するようにする
- [x] `DATABASE_URL` が `postgres://` なら PostgreSQL に接続する(Cloud SQL は Unix ソケット、RDS は TLS)
- [x] Turso(libSQL)も選べるようにする。Node・Workers とも `DATABASE_URL` が `libsql://` なら Turso に繋ぎ、Workers で `DATABASE_URL` がなければ D1 を使う
- [x] Compose に PostgreSQL を足し、PostgreSQL 版で API とシミュレーターの同時注文を確かめる
- [x] 既存の JSON の取り込み(`pnpm db:import`)を Repository 経由にして、どの DB にも入れられるようにする
- [x] `HOW_TO_DEPLOY.md` の GCP を Cloud Run + Cloud SQL、AWS を ECS Express Mode + RDS に書き換える

## 15. コンテナで Codex を使う

- [x] Docker イメージに Codex CLI を入れる(版を固定する)
- [x] 起動時に、シークレットから渡された `OPENAI_API_KEY`(推奨)か `CODEX_AUTH_JSON`(ChatGPT のログイン情報)で Codex にログインする
- [x] Codex App Server が起動するだけでなく、ログインしているときだけ Codex を「使える」とする
- [x] 手元のコンテナで、ログインの有無に応じて Codex の状態が切り替わることを確かめる
- [x] `HOW_TO_DEPLOY.md` に、GCP の Secret Manager・AWS の Secrets Manager から認証情報を渡す手順と、Cloudflare Workers では Codex を使えない理由を書く

## 16. Cloudflare Workers では Workers AI で AI 機能を動かす

- [x] 判定の AI の選択肢に Workers AI を足し、Workers では既定にする
- [x] Codex と同じ問い合わせ(まとめて聞く判定・ランク付け)を Workers AI の JSON Mode でも行えるようにする
- [x] ランク付けは、Codex を使えなければ Workers AI で行う。上部バーと設定ダイアログにランク付けの AI を出す
- [ ] `wrangler.jsonc` に AI のバインディングを足し、Workers で動作を確かめる(バインディングは追加済み。Workers AI を実際に呼ぶ確認は、wrangler へのログイン待ち)
- [x] `HOW_TO_DEPLOY.md`・README・DESIGN.md を更新する
