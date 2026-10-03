import type { Check } from "../technicals.js";
import { rebound } from "./rebound.js";
import { swing } from "./swing.js";

export type Verdict = "買い" | "打診買い" | "見送り";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// 1銘柄を売買ルールに照らして計算した結果
export type Analysis = {
  code: string;
  symbol: string;
  name: string;
  asOf: string;
  checks: Check[];
  technicals: Record<string, number | string | null>; // レスポンスに出す値
  aiState: { [key: string]: JsonValue }; // AI(Codex App Server)に渡す値(直近の値動きなど)
  sellPlan: SellPlan;
};

// 売り方。価格の pct は現在値(終値)からの変化率
export type SellPlan = {
  takeProfit: { price: number | null; pct: number | null; when: string }[];
  stopLoss: { price: number | null; pct: number | null; when: string };
  signals: string[]; // 売るタイミングの指標(現在値つき)
  holdingPeriod: string;
  riskReward: number | null; // 第1目標までの値幅 ÷ 損切り幅
};

export type Strategy = {
  id: string;
  label: string;
  rules: string; // AI に渡すルールの要約
  verdicts: Record<Verdict, string>; // AI に渡す判定ごとの説明
  // 数値だけでは決まらない条件。Decisions の答えで checks[checkIndex] を補う
  qualitative: { checkIndex: number; label: string; instructions: string; criteria: { true: string; false: string } };
  analyze(code: string): Promise<Analysis>;
  // /screen で AI に聞く銘柄。明らかに見送りの銘柄は聞かない
  isCandidate(checks: Check[]): boolean;
  // Decisions が使えないときの判定
  fallbackVerdict(checks: Check[]): Verdict;
  // 最長の保有期間(営業日)。この間に決算発表があれば「決算前に手仕舞う」を懸念点に出す
  maxHoldingDays: number;
};

// 並び順は UI の切り替えボタンの順。先頭が既定
export const STRATEGIES: Record<string, Strategy> = { swing, rebound };
