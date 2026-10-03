# セルフホストの手順

株分析シミュレーターを自分のサーバーやクラウドに置く手順を、Cloudflare・GCP・AWS の場合に分けて書く。
どの場合も、置くものはアプリ(画面と API)とデータベースの2つである。

## 構成

アプリは TanStack Start の Web アプリで、画面と API(`/api/*`)を1つのサーバーが配信する。
ビルドの出力は2種類あり、置き場所に合わせて選ぶ。

| ビルド             | コマンド                               | 置き場所                       |
| ------------------ | -------------------------------------- | ------------------------------ |
| Node のサーバー    | `pnpm build`(Docker では `Dockerfile`) | Docker Compose・Cloud Run・ECS |
| Cloudflare Workers | `pnpm build:cloudflare`                | Cloudflare Workers             |

データベースは、置き場所ごとに次のものを使う。
どの置き場所でも、代わりに Turso(libSQL のマネージドサービス)を選べる。

| 置き場所                 | データベース                 | 代わりに選べるもの                |
| ------------------------ | ---------------------------- | --------------------------------- |
| ローカル(Docker Compose) | SQLite(libSQL サーバー sqld) | PostgreSQL(Compose の `postgres`) |
| Cloudflare Workers       | Cloudflare D1                | Turso                             |
| GCP(Cloud Run)           | Cloud SQL for PostgreSQL     | Turso                             |
| AWS(ECS Express Mode)    | Amazon RDS for PostgreSQL    | Turso                             |

SQLite 系(sqld・Turso・D1)と PostgreSQL では SQL の方言が違うので、アプリは DB の読み書きを方言ごとに2つ実装しており、接続先に合わせて使い分ける。
接続先は次の規則で決まる。

- Node のサーバー: `DATABASE_URL` が `postgres://` か `postgresql://` で始まれば PostgreSQL、それ以外(`http://`・`libsql://`)なら libSQL(sqld・Turso)
- Cloudflare Workers: シークレットの `DATABASE_URL` があれば Turso、なければ `wrangler.jsonc` の D1(バインディング名 `DB`)

マイグレーションも方言ごとに分かれている。
`drizzle/` は SQLite 系(sqld・Turso・D1)用、`drizzle-pg/` は PostgreSQL 用である。

### 環境変数

| 名前                  | 必須         | 内容                                                                                                                                                                   |
| --------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`        | Node では○   | 接続先。sqld は `http://ホスト:8080`、Turso は `libsql://〜`、PostgreSQL は `postgresql://ユーザー:パスワード@ホスト:5432/DB 名`。Workers で D1 を使うときは設定しない |
| `DATABASE_AUTH_TOKEN` | Turso のとき | Turso のデータベースのトークン                                                                                                                                         |
| `TYPESAFE_API_KEY`    |              | 判定の AI を Jev にするときのキー                                                                                                                                      |
| `PORT`                |              | Node のサーバーが待ち受けるポート(既定 3000)                                                                                                                           |

PostgreSQL の URL のパスワードに `@`・`:`・`/` などの記号を含めるときは、URL エンコードする。

判定の AI のうち Codex は、サーバーで `codex` コマンドを起動して ChatGPT アカウントのログインを使う。
Docker イメージには Codex CLI を入れていないうえ、Cloudflare Workers ではプロセスを起動できないので、クラウドに置いた場合は Codex を使えない。
クラウドで AI の判定を使うなら `TYPESAFE_API_KEY` を設定し、画面の設定で判定の AI を Jev にする。
どちらの AI も使えないときは、数値条件だけで判定する。

### 公開する前に確認すること

アプリの URL に届く人は、誰でもアカウントを作れる。
自分だけで使う場合は、Cloudflare Access・Identity-Aware Proxy(GCP)・ALB の認証(AWS)などで、URL そのものへのアクセスを絞る。
また、ログインの Cookie は HTTPS のときだけ Secure 属性を付けるので、本番は HTTPS で配信する。
Cloud Run・ECS Express Mode・Cloudflare Workers は、どれも既定で HTTPS の URL を発行する。

## ローカル(Docker Compose)

クラウドに置く前に、手元で本番と同じイメージを動かして確かめられる。

```bash
docker compose --profile app up -d --build
```

`db`(sqld)と `app`(アプリ)が立ち上がり、`http://localhost:3000` で開ける。
アプリのコンテナは起動のたびにマイグレーションを適用してから待ち受ける。
データはボリュームに残るので、`docker compose down` してもアカウントや口座は消えない(`down -v` は消える)。

Cloud SQL・RDS と同じ PostgreSQL で確かめるときは、`postgres` も立ててアプリの接続先を切り替える。

```bash
APP_DATABASE_URL=postgresql://stock:stock@postgres:5432/stock docker compose --profile app --profile postgres up -d --build
```

開発中は `pnpm db:up` で `db` だけを立て、アプリは `pnpm dev` で動かす。

## Cloudflare(Workers + D1)

Cloudflare では、アプリを Workers に置き、データベースには D1 を使う。

Workers は有料プラン(Workers Paid)が必要である。
無料プランは1リクエストの CPU 時間が 10ms に制限されており、東証の銘柄一覧(Excel)の読み込みやパスワードのハッシュ化がこの時間に収まらない可能性が高い。
有料プランでも既定の CPU 時間は30秒で、東証プライム全銘柄のスキャン(`/api/screen`)が長引くと足りなくなることがある。
その場合は `wrangler.jsonc` に `"limits": { "cpu_ms": 300000 }` を足して上限(5分)まで延ばす。

D1 には1行 2MB・1つの SQL 文のバインド変数100個などの上限がある。
アプリはスクリーニング結果を銘柄ごとの行に分け、まとめて入れる行数も上限に収めているので、設定を変える必要はない。

1. Cloudflare にログインし、D1 のデータベースを作る。表示された `database_id` を、`wrangler.jsonc` の `d1_databases` の `database_id` に書く。

   ```bash
   pnpm exec wrangler login
   pnpm exec wrangler d1 create stock-analyzer
   ```

2. D1 にマイグレーションを適用する。`wrangler.jsonc` の `migrations_dir` が `drizzle/` を指しているので、SQLite 系のマイグレーションがそのまま当たる。

   ```bash
   pnpm exec wrangler d1 migrations apply stock-analyzer --remote
   ```

3. Workers にデプロイする。`pnpm deploy:cloudflare` は Workers 向けにビルドしてから `wrangler deploy` を実行する。

   ```bash
   pnpm deploy:cloudflare
   ```

4. Jev を使う場合は、キーを Workers のシークレットに登録する。

   ```bash
   pnpm exec wrangler secret put TYPESAFE_API_KEY
   ```

デプロイが終わると `https://stock-analyzer.<アカウントのサブドメイン>.workers.dev` で開ける。
独自ドメインで公開する場合は、Cloudflare のダッシュボードで Workers に Custom Domain を追加する。

手元で Workers の実行環境とローカルの D1 のまま確かめたいときは、ローカルの D1 にマイグレーションを当ててから、Workers 向けにビルドして起動する。

```bash
pnpm exec wrangler d1 migrations apply stock-analyzer --local
pnpm build:cloudflare
DEPLOY_TARGET=cloudflare pnpm exec vite preview
```

### D1 の代わりに Turso を使う場合

Turso のデータベースを作り、手元からマイグレーションを適用してから、接続先を Workers のシークレットに登録する。
`DATABASE_URL` が登録されていると、アプリは D1 ではなく Turso に繋ぐ。

```bash
turso auth login
turso db create stock-analyzer
turso db show stock-analyzer --url
turso db tokens create stock-analyzer
DATABASE_URL="libsql://..." DATABASE_AUTH_TOKEN="..." pnpm db:migrate
pnpm exec wrangler secret put DATABASE_URL
pnpm exec wrangler secret put DATABASE_AUTH_TOKEN
```

## GCP(Cloud Run + Cloud SQL for PostgreSQL)

GCP では、アプリを Cloud Run に置き、データベースには Cloud SQL for PostgreSQL を使う。
Cloud Run は、Cloud SQL のインスタンスを Unix ソケット(`/cloudsql/接続名`)としてコンテナに渡す。
アプリはそのソケットに繋ぐので、VPC やファイアウォールの設定は要らない。

1. 使う API を有効にする。

   ```bash
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com sqladmin.googleapis.com
   ```

2. Cloud SQL のインスタンス・データベース・ユーザーを作る。PostgreSQL 16 以降の既定は Enterprise Plus エディションなので、小さな構成で始めるときは `--edition=ENTERPRISE` を付けて共有コアのマシン(`db-f1-micro`)を選ぶ。

   ```bash
   gcloud sql instances create stock-db --database-version=POSTGRES_17 --edition=ENTERPRISE --tier=db-f1-micro --region=asia-northeast1
   gcloud sql databases create stock --instance=stock-db
   gcloud sql users create app --instance=stock-db --password="パスワード"
   gcloud sql instances describe stock-db --format='value(connectionName)'
   ```

   最後のコマンドで、接続名(`プロジェクト ID:asia-northeast1:stock-db`)が表示される。

3. 接続先の URL を Secret Manager に入れる。Unix ソケットに繋ぐときは、ホストを空にして `host` パラメーターにソケットのディレクトリを書く。

   ```bash
   printf '%s' "postgresql://app:パスワード@/stock?host=/cloudsql/プロジェクト ID:asia-northeast1:stock-db" \
     | gcloud secrets create stock-analyzer-database-url --data-file=-
   ```

4. Cloud Run のサービスアカウント(既定は `プロジェクト番号-compute@developer.gserviceaccount.com`)に、Cloud SQL に繋ぐロールとシークレットを読むロールを付ける。

   ```bash
   gcloud projects add-iam-policy-binding プロジェクト ID --member="serviceAccount:サービスアカウント" --role=roles/cloudsql.client
   gcloud projects add-iam-policy-binding プロジェクト ID --member="serviceAccount:サービスアカウント" --role=roles/secretmanager.secretAccessor
   ```

5. Cloud Run にデプロイする。`--source .` はリポジトリの `Dockerfile` でイメージをビルドしてからデプロイする。全銘柄のスキャンは結果を SSE で流し続けるので、リクエストのタイムアウトを延ばしておく。

   ```bash
   gcloud run deploy stock-analyzer \
     --source . \
     --region asia-northeast1 \
     --allow-unauthenticated \
     --timeout 900 \
     --add-cloudsql-instances プロジェクト ID:asia-northeast1:stock-db \
     --set-secrets DATABASE_URL=stock-analyzer-database-url:latest
   ```

コンテナは起動のたびに `drizzle-pg/` のマイグレーションを適用するので、テーブルを作る手順は要らない。
Jev を使う場合は、`TYPESAFE_API_KEY` も同じように Secret Manager に入れて `--set-secrets` で渡す。
デプロイが終わると、`https://stock-analyzer-〜.run.app` の URL が表示される。

Cloud SQL の代わりに Turso を使う場合は、「Cloudflare」の Turso の手順でデータベースを作ってマイグレーションを適用し、`--add-cloudsql-instances` を外して、`DATABASE_URL`(`libsql://〜`)と `DATABASE_AUTH_TOKEN` を渡す。

## AWS(ECS Express Mode + RDS for PostgreSQL)

AWS では、アプリを ECS の Express Mode で Fargate に置き、データベースには Amazon RDS for PostgreSQL を使う。
Express Mode はコンテナイメージから、HTTPS のロードバランサー・オートスケーリング・ログまでをまとめて作る。
App Runner は2026年4月30日に新規の利用者の受け付けを終えたので、この手順では使わない。

RDS for PostgreSQL 15 以降は、既定で TLS の接続しか受け付けない(`rds.force_ssl` が 1)。
Docker イメージには AWS が公開している RDS の CA 証明書の束を `/app/rds-global-bundle.pem` に入れてあるので、接続先の URL で指定して、サーバーの証明書まで検証する。

1. ECR にリポジトリを作り、イメージを入れる。Fargate の既定は x86_64 なので、Apple シリコンの Mac では `--platform linux/amd64` でビルドする。

   ```bash
   aws ecr create-repository --repository-name stock-analyzer
   aws ecr get-login-password --region ap-northeast-1 | docker login --username AWS --password-stdin <アカウント ID>.dkr.ecr.ap-northeast-1.amazonaws.com
   docker build --platform linux/amd64 -t <アカウント ID>.dkr.ecr.ap-northeast-1.amazonaws.com/stock-analyzer:latest .
   docker push <アカウント ID>.dkr.ecr.ap-northeast-1.amazonaws.com/stock-analyzer:latest
   ```

2. RDS for PostgreSQL のインスタンスを、アプリと同じ VPC のプライベートサブネットに作る。インターネットには公開せず、セキュリティグループでアプリのタスクのセキュリティグループからの 5432 番ポートだけを許可する。

   ```bash
   aws rds create-db-instance \
     --db-instance-identifier stock-db \
     --engine postgres \
     --db-instance-class db.t4g.micro \
     --allocated-storage 20 \
     --master-username app \
     --master-user-password "パスワード" \
     --db-name stock \
     --no-publicly-accessible \
     --db-subnet-group-name <プライベートサブネットの DB サブネットグループ> \
     --vpc-security-group-ids <RDS 用のセキュリティグループ>
   ```

3. 接続先の URL を Secrets Manager に入れる。ホストは RDS のエンドポイント(`aws rds describe-db-instances` の `Endpoint.Address`)である。

   ```bash
   aws secretsmanager create-secret --name stock-analyzer/database-url \
     --secret-string "postgresql://app:パスワード@<エンドポイント>:5432/stock?sslmode=verify-full&sslrootcert=/app/rds-global-bundle.pem"
   ```

4. Express Mode のサービスを作る。タスク実行ロールと、Express Mode が使うインフラストラクチャロールを先に用意し、タスク実行ロールには手順3のシークレットを読む権限を足しておく。RDS と同じ VPC のサブネットと、アプリのタスク用のセキュリティグループを指定する。

   ```bash
   aws ecs create-express-gateway-service \
     --service-name stock-analyzer \
     --execution-role-arn arn:aws:iam::<アカウント ID>:role/ecsTaskExecutionRole \
     --infrastructure-role-arn arn:aws:iam::<アカウント ID>:role/ecsInfrastructureRoleForExpressServices \
     --primary-container '{
       "image": "<アカウント ID>.dkr.ecr.ap-northeast-1.amazonaws.com/stock-analyzer:latest",
       "containerPort": 3000,
       "secrets": [{ "name": "DATABASE_URL", "valueFrom": "arn:aws:secretsmanager:ap-northeast-1:<アカウント ID>:secret:stock-analyzer/database-url" }]
     }' \
     --network-configuration '{ "subnets": ["<サブネット ID>"], "securityGroups": ["<アプリのタスク用のセキュリティグループ>"] }' \
     --health-check-path "/login" \
     --scaling-target '{"minTaskCount":1,"maxTaskCount":2}'
   ```

コンテナは起動のたびに `drizzle-pg/` のマイグレーションを適用するので、テーブルを作る手順は要らない。
作成が終わると、出力の `ingressPaths` にアプリの HTTPS の URL が入っている。
ロードバランサーのアイドルタイムアウトは既定で60秒である。全銘柄のスキャンは進捗を送り続けるが、AI の判定やランク付けの1回の問い合わせが60秒を超えるとその間は何も送らないので、接続が切れる場合はロードバランサーのアイドルタイムアウトを延ばす。

RDS の代わりに Turso を使う場合は、「Cloudflare」の Turso の手順でデータベースを作ってマイグレーションを適用し、`DATABASE_URL`(`libsql://〜`)と `DATABASE_AUTH_TOKEN` を Secrets Manager から渡す。

## 更新のしかた

アプリを更新するときは、ビルドとデプロイをやり直す。
Node のサーバー(Docker・Cloud Run・ECS)は起動時にマイグレーションを適用するので、スキーマの変更もそのまま反映される。
Cloudflare Workers は起動時にマイグレーションを流さないので、スキーマを変えたときはデプロイの前に適用する。
D1 は `pnpm exec wrangler d1 migrations apply stock-analyzer --remote`、Turso は `pnpm db:migrate` を Turso に向けて実行する。

スキーマを変えるときは、`src/server/db/schema.sqlite.ts` と `src/server/db/schema.pg.ts` の両方を同じように直し、`pnpm db:generate` で `drizzle/` と `drizzle-pg/` のマイグレーションをまとめて作る。

## 旧版のデータの取り込み

旧版はデータを `data/*.json` に保存していた。
新しい環境で画面からアカウントを作ってから、取り込み先の DB を `DATABASE_URL`(と `DATABASE_AUTH_TOKEN`)で指定して実行すると、そのアカウントに取り込める。

```bash
pnpm db:import --email you@example.com --data-dir ./data
```

設定・関心銘柄・シミュレーターの口座はファイルの内容で置き換え、判定結果は銘柄ごとに上書きし、スクリーニング結果はまだない実行分だけを足す。
同じデータで何度実行しても結果は変わらない。
手元から Cloud SQL に繋ぐときは Cloud SQL Auth Proxy を、RDS に繋ぐときは同じ VPC の踏み台を経由する。

D1 には手元から直接繋げないので、ローカルの sqld に取り込んでから、データだけを SQL にして D1 に流す。
この方法は sqld のアカウントごと移すので、マイグレーションだけを当てた空の D1 に対して行う。

```bash
# 1. ローカルの sqld で、移したいアカウントを作って取り込む(pnpm db:up と pnpm dev で起動しておく)
pnpm db:import --email you@example.com

# 2. sqld の中身から、データの INSERT 文だけを取り出す。外部キーの確認は最後にまとめて行う
{ echo 'PRAGMA defer_foreign_keys = on;'; curl -s http://localhost:8080/dump \
  | grep -E '^INSERT INTO ' | grep -vE '^INSERT INTO "?(__drizzle_migrations|sqlite_sequence)'; } > d1-data.sql

# 3. D1 に流す
pnpm exec wrangler d1 execute stock-analyzer --remote --file d1-data.sql
```
