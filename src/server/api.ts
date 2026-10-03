import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { codexAvailable, codexModel, listCodexModels, type RankItem, type Ranking, rankStocks } from "./ai/codex.js";
import {
  askDecision,
  decisionCapacity,
  type DecisionResult,
  decisionsAvailable,
  decisionsProvider,
  jevAvailable,
  PROVIDERS,
} from "./ai/decisions.js";
import { type AuthEnv, authRoutes, requireUser } from "./auth.js";
import { APP_INFO, getSettings, loadSettings, runWithSettings, type Settings, SettingsError, updateSettings } from "./settings.js";
import { type EarningsInfo, fetchNews, type NewsItem, nextEarnings, newsText } from "./materials.js";
import { primeListings, searchListings, stockListings } from "./prime.js";
import {
  execute as simExecute,
  parseOrder,
  reset as simReset,
  SimError,
  snapshot as simSnapshot,
} from "./simulator.js";
import { type Analysis, type JsonValue, STRATEGIES, type Strategy, type Verdict } from "./strategies/index.js";
import {
  clearResults,
  loadJudgments,
  loadLatestScreen,
  loadWatchlist,
  saveJudgment,
  saveScreen,
  saveWatchlist,
} from "./storage.js";
import { fetchDaily } from "./technicals.js";

const DISCLAIMER =
  "選択した売買ルールに照らした機械的な判定のサンプルであり、投資助言ではありません。利用は自己責任で行い、最終判断はご自身で行ってください。作者はこのツールの利用によるいかなる損害についても一切の責任を負いません。";
const SOURCE = "Yahoo Finance chart API(日足・終値ベース)";

const RANK: Record<Verdict, number> = { 買い: 0, 打診買い: 1, 見送り: 2 };

// テクニカル以外の判断材料(オプション)。決算とニュースは取得に時間がかかるので、指定したときだけ調べる
type Options = { earnings: boolean; news: boolean };
const NO_OPTIONS: Options = { earnings: false, news: false };
// 決算発表までこの営業日数以内なら、最短の保有期間も取れないので「見送り」にする
const EARNINGS_BLOCK_DAYS = 5;

type Materials = {
  earnings: EarningsInfo | null; // 決算オプションがオフなら null
  news: NewsItem[] | null; // ニュースオプションがオフなら null
  errors: string[]; // 取得に失敗した材料
};

async function gatherMaterials(code: string, name: string, options: Options): Promise<Materials> {
  const errors: string[] = [];
  const [earnings, news] = await Promise.all([
    options.earnings
      ? nextEarnings(code).catch((e) => (errors.push(`決算: ${e}`), null))
      : null,
    options.news ? fetchNews(name).catch((e) => (errors.push(`ニュース: ${e}`), null)) : null,
  ]);
  return { earnings, news, errors };
}

// JPX の和名(ニュースの検索に使う)。取れなければ Yahoo の英名のまま
async function japaneseName(code: string, fallback: string) {
  const listings = await stockListings().catch(() => []);
  return listings.find((l) => l.code === code)?.name ?? fallback;
}

const fmtDate = (d: string) => d.slice(5).replace("-", "/");

async function judge(strategy: Strategy, a: Analysis, userNews: string | undefined, options: Options = NO_OPTIONS, name = a.name) {
  const checks = a.checks.map((c) => ({ ...c }));
  const m = await gatherMaterials(a.code, name, options);
  const next = m.earnings?.next ?? null;

  // 自分で調べたニュース(userNews)と、取得した見出しをまとめて Decisions に渡す
  const news = [userNews, m.news ? newsText(m.news) : undefined].filter((x) => x !== undefined).join("\n\n") || undefined;
  const earningsForAi = options.earnings
    ? next
      ? { nextDate: next.date, businessDaysUntil: next.businessDays, confirmed: next.confirmed, maxHoldingDays: strategy.maxHoldingDays }
      : "次回の決算発表日は不明"
    : undefined;
  // Decisions に失敗しても、数値条件だけの判定にして結果は返す
  let decisionError: string | null = null;
  const decision: DecisionResult | null = (await decisionsAvailable())
    ? await askDecision(strategy, { ...a, checks }, news, earningsForAi).catch((e) => ((decisionError = String(e)), null))
    : null;

  // 数値だけでは決まらない条件の後半を Decisions の判定で補う
  if (decision) {
    const target = checks[strategy.qualitative.checkIndex]!;
    target.ok &&= decision.qualitative.probability >= 0.5;
    target.value += ` / ${decision.qualitative.label}確率 ${Math.round(decision.qualitative.probability * 100)}%`;
  }
  const satisfied = checks.filter((c) => c.ok).length;

  let verdict: Verdict;
  let reason: string;
  if (decision?.badNews != null && decision.badNews >= 0.5) {
    verdict = "見送り";
    reason = `ニュースに悪材料がある(確率 ${Math.round(decision.badNews * 100)}%)`;
  } else if (next && next.businessDays <= EARNINGS_BLOCK_DAYS) {
    // 決算はまたがない(両ルール共通)。発表まで短すぎて、買っても保有期間が取れない
    verdict = "見送り";
    reason = `決算発表(${fmtDate(next.date)}、あと${next.businessDays}営業日)が近い。決算はまたがない`;
  } else if (decision) {
    verdict = decision.verdict;
    reason = `${PROVIDERS[decision.provider]}の総合判断(確信度 ${Math.round(decision.verdictConfidence * 100)}%)`;
    // 値動きの読み取り(下げ止まり / トレンド中の押し目)が確認できないうちは「買い」にしない
    if (verdict === "買い" && decision.qualitative.probability < 0.5) {
      verdict = "打診買い";
      reason += `。ただし${decision.qualitative.label}が確認できないので打診買いに下げた`;
    }
  } else {
    verdict = strategy.fallbackVerdict(checks);
    reason = decisionError
      ? "Decisions の呼び出しに失敗したため、数値条件だけで判定"
      : `${PROVIDERS[decisionsProvider()]}を使えないため、数値条件だけで判定`;
  }

  // 買いの根拠 = 満たした条件、懸念点 = 満たしていない条件と未確認の項目
  const describe = (c: (typeof checks)[number]) => `${c.label}: ${c.value}(基準 ${c.criterion})`;
  const rationale = checks.filter((c) => c.ok).map(describe);
  const concerns = [
    ...checks.filter((c) => !c.ok).map(describe),
    ...(news === undefined ? ["ニュース(材料)は未確認。悪材料が出ていないか調べてから買う"] : []),
    ...(m.news && !decision ? ["ニュースは取得したが、Decisions を使えないため悪材料は判定していない"] : []),
    ...(decisionError ? [`Decisions: ${decisionError}`] : []),
    ...(options.earnings && !next ? ["次回の決算発表日が分からない。決算をまたがないか買う前に確認する"] : []),
    ...(next && !next.confirmed ? [`決算発表日(${fmtDate(next.date)})は推定。確定したら確認し直す`] : []),
    ...(next && next.businessDays > EARNINGS_BLOCK_DAYS && next.businessDays <= strategy.maxHoldingDays
      ? [`保有期間中に決算発表(${fmtDate(next.date)}、あと${next.businessDays}営業日)がある。その前に手仕舞う`]
      : []),
    ...m.errors.map((e) => `取得できなかった材料: ${e}`),
  ];
  // 決算日が分かっていれば、売り方に「決算の前に手仕舞う」を足す
  const sellPlan =
    next && next.businessDays <= strategy.maxHoldingDays
      ? { ...a.sellPlan, signals: [...a.sellPlan.signals, `決算発表(${fmtDate(next.date)})の前営業日までに手仕舞う`] }
      : a.sellPlan;

  return {
    code: a.code,
    name: a.name,
    asOf: a.asOf,
    judgedAt: new Date().toISOString(),
    source: SOURCE,
    // 足種は開いたページで「日足」を選ぶ(期間ボタンは分足に切り替わるので注意)
    chartUrl: `https://finance.yahoo.co.jp/quote/${a.symbol}/chart`,
    verdict,
    reason,
    satisfied: `${satisfied}/${checks.length}`,
    rationale,
    concerns,
    sellPlan,
    checks,
    materialChecked: news !== undefined,
    options,
    materials: { earnings: m.earnings, news: m.news },
    technicals: a.technicals,
    decision,
    ranking: null as RankItem | null, // Codex のランク付け(rankResults で入れる)
  };
}

// strategy の指定を解決する。省略時はスイング
function resolveStrategy(id: unknown): Strategy | undefined {
  return id === undefined ? STRATEGIES.swing : typeof id === "string" ? STRATEGIES[id] : undefined;
}
const STRATEGY_ERROR = `strategy は ${Object.keys(STRATEGIES).join(" / ")} のいずれかを指定してください`;

// TanStack Start のサーバールート(src/routes/api/$.ts)から呼ぶ。画面のパスと分けるため /api 配下に置く
export const app = new Hono<AuthEnv>().basePath("/api");

// 別のサイトから来た API のリクエストは断る(CSRF 対策)。
// Cookie は SameSite=Lax なので別サイトからの POST には付かないが、GET /api/screen のような
// 重い処理や保存を伴う GET は、別サイトのリンクから開かれると Cookie 付きで届いてしまう。
// ブラウザは Sec-Fetch-Site を必ず付けるので、それが same-origin / none 以外なら止める(curl などは付けないので通る)
app.use("*", async (c, next) => {
  const site = c.req.header("sec-fetch-site");
  if (site === "cross-site" || site === "same-site") {
    return c.json({ error: "別のサイトからのリクエストは受け付けません" }, 403);
  }

  await next();
});

// アカウント作成・ログイン・ログアウト・退会
app.route("/auth", authRoutes);

// ログインしなくても使える API。売買ルールの一覧はログイン画面の前でも害がないので公開する
const PUBLIC_PATHS = new Set(["/api/strategies"]);

// それ以外の API はログインが要る。判定結果や口座はユーザーごとに分けて保存し、
// 外部(Yahoo Finance・AI)へのリクエストも生むので、誰でも叩ける状態にはしない。
// ログイン中のユーザーの設定は、リクエストの処理全体から getSettings() で読めるようにしておく
app.use("*", async (c, next) => {
  if (PUBLIC_PATHS.has(c.req.path) || c.req.path.startsWith("/api/auth/")) {
    return next();
  }

  return requireUser(c, async () => {
    const settings = await loadSettings(c.var.user.id);

    await runWithSettings(c.var.user.id, settings, next);
  });
});

app.get("/health", async (c) =>
  c.json({
    ok: true,
    // 判定(Decisions)に使う AI と、使えるかどうか。ランク付けはいつも Codex
    decisions: { provider: decisionsProvider(), label: PROVIDERS[decisionsProvider()], available: await decisionsAvailable() },
    codex: await codexAvailable(),
    codexModel: codexModel(),
  }),
);

// アプリの設定(判定の AI・Codex のモデル)と、設定ダイアログに出す選択肢・アプリの情報。
// settings を省略したら、リクエストの始めに読んだログイン中のユーザーの設定
async function settingsPayload(settings: Settings = getSettings()) {
  const [codex, models] = await Promise.all([codexAvailable(), listCodexModels().catch(() => [])]);
  return {
    settings,
    options: {
      providers: [
        { id: "codex", label: PROVIDERS.codex, available: codex, note: codex ? null : "Codex CLI のインストールとログイン(codex login)が必要" },
        { id: "jev", label: PROVIDERS.jev, available: jevAvailable(), note: jevAvailable() ? null : ".env に TYPESAFE_API_KEY が必要" },
      ],
      codexModels: models,
    },
    app: APP_INFO,
  };
}

app.get("/settings", async (c) => c.json(await settingsPayload()));

// 設定を変える。body は {"decisionsProvider":"codex"|"jev","codexModel":"gpt-6-luna"}(省略した項目はそのまま)
app.put("/settings", async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const models = (await listCodexModels().catch(() => [])).map((m) => m.id);
    const updated = await updateSettings(c.var.user.id, body, models);
    return c.json(await settingsPayload(updated));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, e instanceof SettingsError ? 400 : 500);
  }
});

// 売買ルールの一覧(UI の切り替え用)
app.get("/strategies", (c) =>
  c.json(Object.values(STRATEGIES).map((s) => ({ id: s.id, label: s.label, maxHoldingDays: s.maxHoldingDays }))),
);

// 保存済みの判定結果。/judge の銘柄ごとの最新と、/screen の最新1回分
app.get("/results", async (c) => {
  const strategy = resolveStrategy(c.req.query("strategy"));
  if (!strategy) return c.json({ error: STRATEGY_ERROR }, 400);
  const [judgments, screen] = await Promise.all([loadJudgments(c.var.user.id, strategy.id), loadLatestScreen(c.var.user.id, strategy.id)]);
  return c.json({ strategy: { id: strategy.id, label: strategy.label }, judgments, screen });
});

// 保存済みの判定結果を消す。消しすぎないよう strategy の指定は必須
app.delete("/results", async (c) => {
  const id = c.req.query("strategy");
  const strategy = id === undefined ? undefined : resolveStrategy(id);
  if (!strategy) return c.json({ error: STRATEGY_ERROR }, 400);
  return c.json({ strategy: { id: strategy.id, label: strategy.label }, deleted: await clearResults(c.var.user.id, strategy.id) });
});

// 関心銘柄(ウォッチリスト)。まだ保存していなければ codes は null
const CODE = /^[0-9A-Z]{4}$/;
const MAX_WATCH = 200;
app.get("/watchlist", async (c) => c.json((await loadWatchlist(c.var.user.id)) ?? { codes: null, columns: 3 }));

app.put("/watchlist", async (c) => {
  const body = await c.req.json<{ codes?: unknown; columns?: unknown }>().catch(() => null);
  const codes = body?.codes;
  const columns = body?.columns;
  if (!Array.isArray(codes) || !codes.every((x) => typeof x === "string" && CODE.test(x)) || codes.length > MAX_WATCH) {
    return c.json({ error: `codes に4桁の証券コードの配列(${MAX_WATCH}件まで)を指定してください` }, 400);
  }
  if (typeof columns !== "number" || !Number.isInteger(columns) || columns < 1 || columns > 5) {
    return c.json({ error: "columns は1〜5の整数で指定してください" }, 400);
  }
  const saved = { codes: [...new Set(codes as string[])], columns };
  await saveWatchlist(c.var.user.id, saved);
  return c.json(saved);
});

// 株シミュレーター(仮想売買)。実際には発注しない
const simError = (e: unknown) => (e instanceof SimError ? 400 : 502) as 400 | 502;

app.get("/sim", async (c) => {
  try {
    return c.json(await simSnapshot(c.var.user.id));
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// 元金を指定して始め直す(保有株・履歴は消える)。省略時は100万円
app.post("/sim/reset", async (c) => {
  const body = await c.req.json<{ initialCash?: unknown }>().catch(() => ({}) as { initialCash?: unknown });
  try {
    await simReset(c.var.user.id, body.initialCash);
    return c.json(await simSnapshot(c.var.user.id));
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, simError(e));
  }
});

// 最新の株価で約定したことにする。body は {"code","side":"buy"|"sell","shares","plan"}
app.post("/sim/orders", async (c) => {
  const body = await c.req.json().catch(() => null);
  try {
    const trade = await simExecute(c.var.user.id, parseOrder(body));
    return c.json({ trade, account: await simSnapshot(c.var.user.id) });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, simError(e));
  }
});

// 銘柄検索(証券コードの前方一致・銘柄名の部分一致)。UI の検索欄の候補に使う
app.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  try {
    return c.json({ results: await searchListings(q) });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

// 日足(1年分)。UI のチャート描画用
app.get("/bars/:code", async (c) => {
  try {
    const { code, symbol, name, bars } = await fetchDaily(c.req.param("code"));
    return c.json({ code, symbol, name, source: SOURCE, bars });
  } catch (e) {
    return c.json({ error: String(e) }, 502);
  }
});

app.post("/judge", async (c) => {
  const body = await c.req
    .json<{ codes?: unknown; news?: Record<string, string>; strategy?: unknown; options?: Partial<Options> }>()
    .catch(() => null);
  const strategy = resolveStrategy(body?.strategy);
  if (!strategy) return c.json({ error: STRATEGY_ERROR }, 400);
  const codes = body?.codes;
  if (!Array.isArray(codes) || codes.length === 0 || !codes.every((x) => typeof x === "string")) {
    return c.json({ error: 'codes に証券コードの配列を指定してください。例: {"codes":["7203","6758"]}' }, 400);
  }

  const options = parseOptions(body?.options?.earnings, body?.options?.news);
  const settled = await Promise.allSettled(
    codes.map(async (code) => {
      const a = await strategy.analyze(code);
      return judge(strategy, a, body?.news?.[code], options, options.news ? await japaneseName(code, a.name) : a.name);
    }),
  );
  const { results, ranking } = await rankResults(
    strategy,
    settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : [])),
  );
  const errors = settled.flatMap((s, i) =>
    s.status === "rejected" ? [{ code: codes[i], error: String(s.reason) }] : [],
  );
  // 保存に失敗しても判定結果は返す
  await Promise.all(
    results.map((r) => saveJudgment(c.var.user.id, strategy.id, r).catch((e) => console.error(`判定結果を保存できない: ${e}`))),
  );

  return c.json({
    disclaimer: DISCLAIMER,
    strategy: { id: strategy.id, label: strategy.label },
    ranking,
    results,
    errors,
  });
});

// 東証プライム全銘柄を調べる。テクニカル値は全銘柄で計算し、
// 明らかに見送りの銘柄(strategy.isCandidate が false)は AI に聞かず、結果にも含めない。
// 残った候補は Decisions(Codex App Server 経由の GPT-6 Luna)で判定し、上位を Codex でランク付けする。
// 時間がかかるので SSE で返す。途中は progress イベント、最後に result イベントで全結果を送る。
app.get("/screen", (c) => {
  const strategy = resolveStrategy(c.req.query("strategy"));
  if (!strategy) return c.json({ error: STRATEGY_ERROR }, 400);
  const options = parseOptions(c.req.query("earnings") === "1", c.req.query("news") === "1");

  return streamSSE(c, async (stream) => {
    // 進捗は 5% 刻みと最後の1件だけ送る(1,500件超を1件ずつ送るとうるさい)
    const progress = (phase: "listing" | "analyze" | "judge" | "rank") => {
      let lastStep = -1;
      return async (done: number, total: number) => {
        const step = Math.floor((done / total) * 20);
        if (step === lastStep && done !== total) return;
        lastStep = step;
        await stream.writeSSE({ event: "progress", data: JSON.stringify({ phase, done, total }) });
      };
    };

    try {
      await stream.writeSSE({ event: "progress", data: JSON.stringify({ phase: "listing", done: 0, total: 1 }) });
      const listings = await primeListings();
      await progress("listing")(1, 1);

      const analyzed = await mapPool(listings, CONCURRENCY, (l) => strategy.analyze(l.code), progress("analyze"));
      const errors: { code: string; error: string }[] = [];
      const candidates = analyzed.flatMap((r, i) => {
        const l = listings[i]!;
        if (r.status === "rejected") {
          errors.push({ code: l.code, error: String(r.reason) });
          return [];
        }
        return strategy.isCandidate(r.value.checks) ? [{ listing: l, a: r.value }] : [];
      });

      // 候補の判定は、今の設定の AI がまとめて聞ける件数まで並べる(Codex は多め、Jev は少なめ)。
      // 日足は取得済みなので、ここで Yahoo に投げるのは決算オプションのときの予定日だけ
      const judged = await mapPool(
        candidates,
        decisionCapacity(),
        async ({ listing, a }) => ({
          // 決算・ニュースは候補ごとに取得し、判定の本体と同じ Decisions への問い合わせに入れる
          ...(await judge(strategy, a, undefined, options, listing.name)),
          name: listing.name,
          sector: listing.sector,
          scale: listing.scale,
        }),
        progress("judge"),
      );
      const judgedResults = judged.flatMap((r, i) => {
        if (r.status === "fulfilled") return [r.value];
        errors.push({ code: candidates[i]!.listing.code, error: String(r.reason) });
        return [];
      });

      await stream.writeSSE({ event: "progress", data: JSON.stringify({ phase: "rank", done: 0, total: 1 }) });
      const { results, ranking } = await rankResults(strategy, judgedResults);
      await progress("rank")(1, 1);

      const payload = {
        disclaimer: DISCLAIMER,
        strategy: { id: strategy.id, label: strategy.label },
        scannedAt: new Date().toISOString(),
        options,
        summary: {
          market: "東証プライム",
          listed: listings.length,
          analyzed: analyzed.filter((r) => r.status === "fulfilled").length,
          candidates: candidates.length,
          byVerdict: {
            買い: results.filter((r) => r.verdict === "買い").length,
            打診買い: results.filter((r) => r.verdict === "打診買い").length,
            見送り: results.filter((r) => r.verdict === "見送り").length,
          },
        },
        ranking,
        results,
        errors,
      };
      await saveScreen(c.var.user.id, strategy.id, payload).catch((e) => console.error(`スクリーニング結果を保存できない: ${e}`));
      await stream.writeSSE({ event: "result", data: JSON.stringify(payload) });
    } catch (e) {
      await stream.writeSSE({ event: "error", data: JSON.stringify({ error: String(e) }) });
    }
  });
});

function parseOptions(earnings: unknown, news: unknown): Options {
  return { earnings: earnings === true, news: news === true };
}

// 買い候補を上に並べる。同じ判定なら条件の充足数、次に Decisions の「買い」確率が高い順
function sortResults<T extends { verdict: Verdict; decision: DecisionResult | null; checks: { ok: boolean }[] }>(
  results: T[],
): T[] {
  const satisfied = (r: T) => r.checks.filter((c) => c.ok).length;
  return results.sort(
    (a, b) =>
      RANK[a.verdict] - RANK[b.verdict] ||
      satisfied(b) - satisfied(a) ||
      (b.decision?.verdictProbabilities.買い ?? 0) - (a.decision?.verdictProbabilities.買い ?? 0),
  );
}

// Codex に渡す銘柄の上限。候補が多いときは sortResults の上位だけをランク付けし、残りはその後ろに並べる
const RANK_LIMIT = 30;

type Judged = Awaited<ReturnType<typeof judge>> & { sector?: string };
type RankingInfo = Omit<Ranking, "items"> & { ranked: number; error: string | null };

// Codex App Server で判定済みの銘柄をランク付けし、その順に並べ替える。
// Codex を使えない・失敗したときは sortResults の順のまま返す
async function rankResults<T extends Judged>(strategy: Strategy, judged: T[]): Promise<{ results: T[]; ranking: RankingInfo | null }> {
  const sorted = sortResults(judged);
  if (sorted.length < 2 || !(await codexAvailable())) return { results: sorted, ranking: null };

  const head = sorted.slice(0, RANK_LIMIT);
  try {
    const r = await rankStocks(strategy.rules, head.map(rankInput));
    const byCode = new Map(r.items.map((i) => [i.code, i]));
    for (const x of head) x.ranking = byCode.get(x.code) ?? null;
    head.sort((a, b) => (a.ranking?.rank ?? Infinity) - (b.ranking?.rank ?? Infinity));
    return {
      results: [...head, ...sorted.slice(RANK_LIMIT)],
      ranking: { model: r.model, summary: r.summary, ranked: head.length, error: null },
    };
  } catch (e) {
    console.error(`Codex のランク付けに失敗: ${e}`);
    return { results: sorted, ranking: { model: "", summary: "", ranked: 0, error: String(e) } };
  }
}

// Codex に渡す1銘柄分の材料。トークンを抑えるため、判定に効く値だけに絞る
function rankInput(r: Judged): { code: string; [key: string]: JsonValue } {
  const next = r.materials.earnings?.next;
  return {
    code: r.code,
    name: r.name,
    ...(r.sector ? { sector: r.sector } : {}),
    verdict: r.verdict,
    reason: r.reason,
    satisfied: r.satisfied,
    checks: r.checks.map((c) => `${c.ok ? "○" : "×"} ${c.label}: ${c.value}`),
    technicals: r.technicals,
    riskReward: r.sellPlan.riskReward,
    decision: r.decision
      ? {
          verdictProbabilities: r.decision.verdictProbabilities,
          [r.decision.qualitative.label]: r.decision.qualitative.probability,
          badNews: r.decision.badNews,
        }
      : null,
    nextEarnings: next ? { date: next.date, businessDays: next.businessDays, confirmed: next.confirmed } : null,
    news: r.materials.news?.slice(0, 5).map((n) => n.title) ?? null,
  };
}

// 同時に投げるリクエスト数を抑えて map する。Yahoo Finance のレート制限対策
const CONCURRENCY = 8;
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
  onProgress?: (done: number, total: number) => Promise<void>,
) {
  const out: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = { status: "fulfilled", value: await fn(items[i]!) };
      } catch (reason) {
        out[i] = { status: "rejected", reason };
      }
      await onProgress?.(++done, items.length);
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  return out;
}
