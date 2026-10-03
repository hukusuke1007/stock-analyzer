import type { Analysis, JsonValue, Strategy, Verdict } from "../strategies/index.js";
import { getSettings, PROVIDERS, type Provider } from "../settings.js";
import { codexAvailable } from "./codex.js";
import { workersAiAvailable } from "./workers-ai.js";

export { PROVIDERS, type Provider };

// 売買ルールのうち、数値だけでは決まらない判断(Decisions)を AI に聞く。
// - qualitative: 値動きの形の読み取り(急落リバウンドは下げ止まり、スイングはトレンド中の押し目か)
// - badNews: 明確な悪材料があるか(ニュースが渡されたときだけ使う)
// - verdict: 総合判断(買い / 打診買い / 見送り)
//
// 聞く先は UI の設定ダイアログで切り替える(settings.ts の decisionsProvider)。
// - codex(Node の既定): Codex App Server 経由。モデルは設定の codexModel(既定 gpt-6-luna)。Codex CLI のログインで動く(decisions-batch.ts)
// - workers-ai(Cloudflare Workers の既定): Cloudflare Workers AI。Workers の AI のバインディングで動く(decisions-batch.ts)
// - jev: TypeSafe AI の Jev(Decision API)。TYPESAFE_API_KEY が要る(decisions-jev.ts)

export type DecisionResult = {
  provider: Provider;
  model: string;
  qualitative: { label: string; probability: number };
  badNews: number | null; // 悪材料がある確率(ニュースなしなら null)
  verdict: Verdict;
  verdictConfidence: number;
  verdictProbabilities: Record<Verdict, number>;
};

// 1銘柄分の問い合わせ。どの AI にも同じものを渡す
export type DecisionInput = {
  strategy: Strategy;
  rules: string; // ルールの要約(決算・ニュースを渡すときは、その使い方も足す)
  state: { [key: string]: JsonValue };
  hasNews: boolean;
};

export const VERDICTS: Verdict[] = ["買い", "打診買い", "見送り"];

const EARNINGS_RULE =
  "決算はまたがない。earnings(次回の決算発表)の businessDaysUntil が maxHoldingDays 以下なら、保有期間中に決算が来るので、決算の前に利確できる見込みがあるときだけ入り、見込みが薄ければ見送る。confirmed が false の日付は推定で前後にずれうるので、慎重に判断する。";
const NEWS_RULE =
  "news(直近のニュースの見出し)に悪材料(不祥事・業績下方修正・事故・行政処分など)があれば、テクニカルの条件が揃っていても見送る。値動きの理由になる材料がはっきり出ているときは需給の歪みではないので、テクニカルは効きにくいと考える。関係の薄い見出しは無視する。";

export function decisionsProvider(): Provider {
  return getSettings().decisionsProvider;
}

export function jevAvailable(): boolean {
  return Boolean(process.env.TYPESAFE_API_KEY?.trim());
}

export async function decisionsAvailable(): Promise<boolean> {
  const provider = decisionsProvider();
  if (provider === "jev") {
    return jevAvailable();
  }

  return provider === "workers-ai" ? workersAiAvailable() : codexAvailable();
}

// 同時に投げると無駄なく詰められる件数。Codex はまとめて(20件ずつ)聞くので多め、
// Workers AI は5件ずつまとめるので中くらい、Jev は1件ずつなので少なめ
const CAPACITY: Record<Provider, number> = { codex: 120, "workers-ai": 30, jev: 8 };

export function decisionCapacity(): number {
  return CAPACITY[decisionsProvider()];
}

// 確率を合計1に揃える(モデルの出す値はずれることがある)
export function normalize(p: Record<Verdict, number>): Record<Verdict, number> {
  const sum = VERDICTS.reduce((s, v) => s + (p[v] ?? 0), 0) || 1;
  return Object.fromEntries(VERDICTS.map((v) => [v, (p[v] ?? 0) / sum])) as Record<Verdict, number>;
}

export async function askDecision(
  strategy: Strategy,
  a: Analysis,
  news: string | undefined,
  earnings?: JsonValue, // 次回の決算発表(オプション)
): Promise<DecisionResult> {
  const input: DecisionInput = {
    strategy,
    // 決算・ニュースを渡すときは、その使い方もルールとして伝える(両ルール共通)
    rules: [strategy.rules, ...(earnings === undefined ? [] : [EARNINGS_RULE]), ...(news === undefined ? [] : [NEWS_RULE])].join("\n"),
    state: {
      stock: { code: a.code, name: a.name, asOf: a.asOf },
      technicals: a.aiState,
      numericChecks: a.checks.map((c) => ({ ...c })),
      news: news ?? "ニュースは未確認",
      ...(earnings === undefined ? {} : { earnings }),
    },
    hasNews: news !== undefined,
  };
  // 使わない方の SDK は読み込まない
  const provider = decisionsProvider();
  if (provider === "jev") {
    return (await import("./decisions-jev.js")).askJev(input);
  }

  return (await import("./decisions-batch.js")).askBatchedDecision(input, provider);
}
