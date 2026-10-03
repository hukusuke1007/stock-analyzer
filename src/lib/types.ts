// API(/api/*)が返す JSON の型。サーバーの型を使えるものは import type で借り、画面にしかない形はここで定義する。
// import type はビルド時に消えるので、サーバーのコードがブラウザの bundle に入ることはない
import type { CodexModel, RankItem } from "../server/ai/codex";
import type { DecisionResult } from "../server/ai/decisions";
import type { EarningsInfo, NewsItem } from "../server/materials";
import type { Listing } from "../server/prime";
import type { Settings } from "../server/settings";
import type { Account, Position, SimPlan, Trade } from "../server/simulator";
import type { SellPlan, Verdict } from "../server/strategies/index";
import type { Bar, Check } from "../server/technicals";

export type { Bar, Check, DecisionResult, Listing, SellPlan, SimPlan, Trade, Verdict };

export type User = { id: string; email: string };

export type StrategyInfo = { id: string; label: string; maxHoldingDays: number };

export type Options = { earnings: boolean; news: boolean };

export type BarsResponse = { code: string; symbol: string; name: string; source: string; bars: Bar[] };

// /judge・/screen の1銘柄分の判定結果。スクリーニングの結果には業種と規模も付く
export type JudgeResult = {
  code: string;
  name: string;
  asOf: string;
  judgedAt: string;
  source: string;
  chartUrl: string;
  verdict: Verdict;
  reason: string;
  satisfied: string;
  rationale: string[];
  concerns: string[];
  sellPlan: SellPlan;
  checks: Check[];
  materialChecked: boolean;
  options: Options;
  materials: { earnings: EarningsInfo | null; news: NewsItem[] | null } | null;
  technicals: Record<string, number | string | null>;
  decision: DecisionResult | null;
  // 旧版(Jev だけを使っていた頃)に保存した結果は decision の代わりに jev を持つ
  jev?: Omit<DecisionResult, "provider">;
  ranking: RankItem | null;
  sector?: string;
  scale?: string;
};

export type RankingInfo = { model: string; summary: string; ranked: number; error: string | null };

export type JudgeResponse = {
  disclaimer: string;
  strategy: { id: string; label: string };
  ranking: RankingInfo | null;
  results: JudgeResult[];
  errors: { code: string; error: string }[];
};

export type ScreenResult = {
  disclaimer: string;
  strategy: { id: string; label: string };
  scannedAt: string;
  options: Options;
  summary: {
    market: string;
    listed: number;
    analyzed: number;
    candidates: number;
    byVerdict: Record<Verdict, number>;
  };
  ranking: RankingInfo | null;
  results: JudgeResult[];
  errors: { code: string; error: string }[];
};

export type SavedResults = {
  strategy: { id: string; label: string };
  judgments: JudgeResult[];
  screen: ScreenResult | null;
};

export type Health = {
  ok: boolean;
  decisions: { provider: Settings["decisionsProvider"]; label: string; available: boolean };
  codex: boolean;
  codexModel: string;
};

export type SettingsPayload = {
  settings: Settings;
  options: {
    providers: { id: Settings["decisionsProvider"]; label: string; available: boolean; note: string | null }[];
    codexModels: CodexModel[];
  };
  app: { name: string; version: string; license: string; author: string; x: string };
};

export type Watchlist = { codes: string[] | null; columns: number };

// GET /sim の保有株。現在値と、利確・損切りラインで売ったときの損益が付く
export type SimPosition = Position & {
  price: number;
  priceDate: string | null;
  prevClose: number | null;
  priceError: string | null;
  cost: number;
  value: number;
  unrealized: number;
  unrealizedPct: number;
  takeProfit: { price: number; when: string; pnl: number }[];
  stopLoss: { price: number; when: string; pnl: number } | null;
  status: "利確ライン到達" | "損切りライン到達" | "保有中";
};

export type SimSnapshot = Pick<Account, "initialCash" | "cash" | "createdAt"> & {
  summary: { total: number; marketValue: number; unrealized: number; realized: number; pnl: number; pnlPct: number };
  positions: SimPosition[];
  trades: Trade[];
};

export type SimOrderResponse = { trade: Trade; account: SimSnapshot };
