# シーケンス図

`/api/screen`（東証プライム全銘柄）と `/api/judge`（銘柄を指定）で、サーバー内部と外部サービスの間で何が起きるかを示す。
参加者とソースコードの対応は次のとおり。

| 参加者   | 実体                                                          |
| -------- | ------------------------------------------------------------- |
| Client   | 画面、または curl など(ログインの Cookie を付ける)            |
| Server   | `src/server/api.ts`（Hono。TanStack Start の `/api/*` から呼ばれる）                                       |
| Strategy | `src/server/strategies/rebound.ts` / `swing.ts`（`strategy` で選ぶ） |
| JPX      | 東証上場銘柄一覧（`data_j.xlsx`）。`src/server/prime.ts` が取得      |
| Yahoo    | Yahoo Finance chart API（日足）。`src/server/technicals.ts` が取得   |
| Decisions | 銘柄ごとの判定。Node の既定は Codex App Server 経由の GPT-6 Luna、Cloudflare Workers の既定は Workers AI(`src/server/ai/decisions-batch.ts`)。設定で Jev を選んだら TypeSafe AI の Jev(`src/server/ai/decisions-jev.ts`) |
| Codex    | ランク付け。Codex App Server(`codex app-server`、stdio の JSON-RPC)の GPT-6 Luna。Codex を使えない Workers では Workers AI(`src/server/ai/ranking.ts`) |

## `/api/screen`: 東証プライム全銘柄を調べる

進捗を SSE で返し、最後に全結果を `result` イベントで返す。所要時間は約40〜50秒(AI の判定とランク付けを含めるとさらに延びる)。

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Server
    participant ST as Strategy
    participant J as JPX
    participant Y as Yahoo
    participant JV as Decisions
    participant CX as Codex

    C->>S: GET /api/screen?strategy=swing
    alt strategy が不正
        S-->>C: 400 {"error"}
    end
    S-->>C: SSE 開始 / progress(listing 0/1)

    alt 今日の銘柄一覧がキャッシュにない
        S->>J: data_j.xlsx を取得
        J-->>S: 上場銘柄一覧
        Note over S: 「プライム」の銘柄だけ残す(約1,560件)<br/>1日1回キャッシュ
    end
    S-->>C: progress(listing 1/1)

    loop 全銘柄(同時8件まで)
        S->>ST: analyze(code)
        ST->>Y: 日足1年分を取得
        Y-->>ST: OHLCV
        Note over ST: テクニカル指標を計算<br/>条件の数値部分を判定<br/>売り方(sellPlan)を計算
        ST-->>S: Analysis(checks, technicals, sellPlan)
        S-->>C: progress(analyze n/1557)(5%刻み)
    end

    Note over S: isCandidate で候補に絞る<br/>明らかに見送りの銘柄は AI に聞かず結果にも含めない

    loop 候補(Codex は同時120件まで・20件ずつまとめて聞く / Jev は同時8件まで)
        opt 判定の AI を使える(Codex にログイン済み / Jev のキーがある)
            S->>JV: 問い(ルールの要約・指標・条件の判定結果)<br/>qualitative / verdict / badNews
            JV-->>S: 値動きの読み取りの確率・総合判断
        end
        Note over S: Decisions の読み取りで条件を補う<br/>50%未満なら「買い」を「打診買い」に下げる<br/>rationale / concerns を作る
        S-->>C: progress(judge n/候補数)(5%刻み)
    end

    Note over S: 買い → 打診買い → 見送り の順に並べる<br/>同じ判定なら条件を多く満たした順
    opt Codex を使える(codex CLI にログイン済み)
        S-->>C: progress(rank 0/1)
        S->>CX: initialize → thread/start(ephemeral, read-only) → turn/start(outputSchema)
        Note right of S: 上位30件の判定・条件・指標・確率・決算・ニュース見出し
        CX-->>S: turn/completed: ranking(code / score / reason) と summary
        Note over S: ランキング順に並べ替える(31件目以降は判定順のまま後ろ)
        S-->>C: progress(rank 1/1)
    end
    S-->>C: result(summary, ranking, results, errors)
    S-->>C: SSE 終了

    opt 途中で例外(銘柄一覧が取れないなど)
        S-->>C: error {"error"}
    end
```

- 個々の銘柄の取得や判定に失敗しても全体は止めず、`errors` に入れて続ける。
- `/api/screen` ではニュースを渡せないので、`badNews` の答えは使わない（`materialChecked: false`）。

## `/api/judge`: 銘柄を指定して調べる

指定した銘柄を並列に調べ、まとめて JSON で返す。候補の絞り込みはしない（指定した銘柄はすべて結果に入る）。

```mermaid
sequenceDiagram
    autonumber
    participant C as Client
    participant S as Server
    participant ST as Strategy
    participant Y as Yahoo
    participant JV as Decisions
    participant CX as Codex

    C->>S: POST /api/judge {"strategy","codes","news"}
    alt strategy が不正 / codes が空
        S-->>C: 400 {"error"}
    end

    par codes の各銘柄を並列に
        S->>ST: analyze(code)
        ST->>Y: 日足1年分を取得
        Y-->>ST: OHLCV
        Note over ST: テクニカル指標・条件・sellPlan を計算
        ST-->>S: Analysis
        opt 判定の AI を使える(Codex にログイン済み / Jev のキーがある)
            S->>JV: 問い(ルールの要約・指標・条件・news[code])
            JV-->>S: qualitative / verdict / badNews
        end
        Note over S: news があり悪材料の確率が50%以上なら「見送り」<br/>値動きの読み取りが50%未満なら「買い」を「打診買い」に<br/>rationale / concerns を作る
    end

    Note over S: 判定順に並べる
    opt 2銘柄以上 かつ Codex を使える
        S->>CX: 判定済みの銘柄をまとめてランク付け
        CX-->>S: ranking
    end
    S-->>C: 200 {disclaimer, strategy, ranking, results, errors}
```

- `news` を渡した銘柄だけ、Decisions の `badNews`（悪材料の確率）を判定に使う。
- 存在しないコードなど、取得できなかった銘柄は `errors` に入る。

## Decisions に渡すもの・返ってくるもの(Codex の場合)

Jev の場合は、同じ内容を1銘柄ずつ `systemOne`(state と questions: qualitative=noul / verdict=choice / badNews=noul)で送る。

どちらのエンドポイントでも、銘柄をためて20件ずつ1ターンにまとめ、各銘柄について3つの質問を聞く(同時に6ターンまで)。
Codex App Server のプロセスは1つを使い回し、ターンごとに使い捨てのスレッドを作る。

```mermaid
sequenceDiagram
    participant S as Server(ai/decisions.ts)
    participant JV as Decisions(Codex App Server)

    S->>JV: thread/start(model: gpt-6-luna, ephemeral, read-only)
    S->>JV: turn/start(outputSchema)
    Note right of S: instructions:<br/>rules(ルールの要約・決算 / ニュースの扱い)<br/>questions の説明
    Note right of S: input(銘柄ごと):<br/>id(通し番号)<br/>stock(コード・名前・基準日)<br/>technicals(指標と直近の値動き)<br/>numericChecks(条件の判定結果)<br/>news(未指定なら「未確認」)
    JV-->>S: turn/completed: decisions[](id ごとに<br/>qualitative の確率・verdict と各確率・badNews の確率)
    Note over S: 確率は合計1に正規化して使う<br/>答えにない銘柄は数値条件だけで判定
```
