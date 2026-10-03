# AGENTS.md

「株分析シミュレーター」(パッケージ名 stock-analyzer)。日本株の買い判断とランク付けを行う株分析ツール(Hono の API サーバー + Vite のブラウザ UI、TypeScript)。
AI エージェント(Codex / Claude Code など)がこのリポジトリで作業するときのルール。`CLAUDE.md` はこのファイルへのシンボリックリンク。

## まず読むもの

- `README.md` — 起動の仕方と使い方
- `DESIGN.md` — 判定の考え方、売買ルール、AI の使い分け、コードの構成
- `docs/sequence.md` — `/screen` と `/judge` のシーケンス図

## コマンド

| コマンド         | 内容                                         |
| ---------------- | -------------------------------------------- |
| `pnpm install`   | 依存を入れる(pnpm 12。npm / yarn は使わない) |
| `pnpm dev`       | API(:3000) と UI(:5173) を起動               |
| `pnpm typecheck` | 型チェック                                   |
| `pnpm ui:build`  | UI のビルド                                  |

変更したら `pnpm typecheck` と `pnpm ui:build` を必ず通す(CI と同じ)。
API の動きを変えたら `pnpm dev` で起動し、`curl` で `/health`・`/judge` を叩いて確かめる。

## 構成

- `src/server.ts` — エンドポイント、判定の組み立て(`judge`)、並び替えとランク付けの呼び出し
- `src/ai/` — AI の呼び出し。判定(Decisions)は `decisions.ts` が設定(`src/settings.ts`、UI の設定ダイアログで変更、`data/settings.json` に保存)の `decisionsProvider`(`codex` 既定 / `jev`)で振り分ける。ランク付けは `codex.ts`
- `src/strategies/` — 売買ルール。増やすときは `Strategy` 型のオブジェクトを作り、`index.ts` の `STRATEGIES` に登録する
- `src/technicals.ts` — 日足の取得とテクニカル指標。UI(`ui/src/`)のインジケーターも同じ式で計算しているので、式を変えたら両方を直す
- `ui/` — ブラウザ UI(素の JS + lightweight-charts)。API のパスを増やしたら `vite.config.ts` のプロキシにも足す

## 書き方

- コメント・ドキュメント・UI の文言は日本語。コメントは「なぜそうするか」を書く
- 数値で決まることはコードで判定し、AI には数値で決まらない判断だけを任せる(DESIGN.md の「役割の分け方」)
- AI の呼び出しに失敗しても全体は止めない。数値条件だけの判定に切り替え、失敗の内容を `concerns` に出す
- 株価・業績などの数値をコードやドキュメントに推測で書かない。例を載せるときは取得日を添える

## やってはいけないこと

- `data/`(判定結果・関心銘柄・シミュレーターの口座)と `.env` をコミットしない。スクリーンショットにも個人の口座を写さない(デモ用は `DATA_DIR` を別の場所にして作る)
- 実際の発注につながる機能を足さない。シミュレーターは仮想売買のみ
- `pnpm-lock.yaml` の `xlsx` の integrity を消さない(pnpm 12 がインストールを止める)
- `/screen` を短時間に何度も実行しない(Yahoo Finance に約1,560件のリクエストを送る)
- 判定を投資助言として書かない。出力には免責(`DISCLAIMER`)を残す
