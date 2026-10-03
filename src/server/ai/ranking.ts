import type { JsonValue } from "../strategies/index.js";
import { codexAvailable, codexModel, runTurn } from "./codex.js";
import type { BatchBackend } from "./decisions-batch.js";
import { runWorkersAiTurn, workersAiAvailable, workersAiModel } from "./workers-ai.js";

// 判定済みの銘柄を AI に見比べさせ、有望な順に並べる(ランク付け)。
// Codex を使えれば Codex(設定の Codex のモデル)、使えなければ Workers AI(Cloudflare Workers)で行う。どちらもなければ行わない

export type RankItem = { code: string; rank: number; score: number; reason: string };
export type Ranking = { model: string; summary: string; items: RankItem[] };

const RANK_EFFORT = process.env.RANK_EFFORT ?? "medium";

// 1回でランク付けする銘柄の上限。候補が多いときは判定順の上位だけを渡す(全件だと時間とトークンがかかりすぎる)。
// Workers AI のモデルは文脈の長さ(24,000 トークン)が短いので少なくする
export const RANK_LIMIT: Record<BatchBackend, number> = { codex: 30, "workers-ai": 15 };

const RANK_INSTRUCTIONS = [
  "あなたは日本株のスイングトレードの判断材料を整理するアナリスト。",
  "渡された銘柄はすべて、売買ルールの数値条件と Decisions(または数値条件だけ)で判定済み。",
  "ルールに照らして、今日買うならどれが有望かを1位から順に並べる。",
  "重視する順: ルールの条件の充足度 > 判定(買い > 打診買い > 見送り)と判定の確率 > 悪材料・決算の近さなどのリスク > 損切り幅に対する利確幅(riskReward)。",
  "渡したデータだけで判断し、ツールやコマンドは使わない。reason は日本語で、根拠になった数値を入れて80字以内。",
].join("\n");

const LABELS: Record<BatchBackend, string> = { codex: "Codex", "workers-ai": "Workers AI" };

/**
 * ランク付けに使う AI を返す。Codex を優先し、使えなければ Workers AI。どちらも使えなければ null。
 */
export async function rankingBackend(): Promise<BatchBackend | null> {
  if (await codexAvailable()) {
    return "codex";
  }

  return workersAiAvailable() ? "workers-ai" : null;
}

/**
 * ランク付けに使う AI の表示名とモデル(上部バーの表示に使う)。
 */
export function describeRankingBackend(backend: BatchBackend): { label: string; model: string } {
  return { label: LABELS[backend], model: backend === "codex" ? codexModel() : workersAiModel() };
}

/**
 * 判定済みの銘柄をランク付けする。stocks の code が全部そろって返るように補う。
 */
export async function rankStocks(strategyRules: string, stocks: { code: string; [key: string]: JsonValue }[], backend: BatchBackend): Promise<Ranking> {
  const codes = stocks.map((s) => s.code);
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      ranking: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", enum: codes },
            score: { type: "number", minimum: 0, maximum: 100 },
            reason: { type: "string" },
          },
          required: ["code", "score", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "ranking"],
    additionalProperties: false,
  };
  const prompt = [
    "# 売買ルール",
    strategyRules,
    "",
    `# 判定済みの銘柄(${stocks.length}件)`,
    JSON.stringify(stocks),
    "",
    "全銘柄を有望な順に ranking に並べ、score(0〜100、高いほど有望)と reason を付ける。summary には上位の傾向を2〜3文で書く。",
  ].join("\n");

  type Output = { summary: string; ranking: { code: string; score: number; reason: string }[] };
  const turn = { instructions: RANK_INSTRUCTIONS, prompt, schema };
  const { model, output } =
    backend === "codex"
      ? await runTurn<Output>({ ...turn, model: codexModel(), effort: RANK_EFFORT })
      : await runWorkersAiTurn<Output>(turn);

  // Workers AI は JSON Schema どおりに答える保証がないので、渡した銘柄で数値のスコアが付いたものだけを使う。
  // 重複を除き、抜けた銘柄は最後に回す
  const known = new Set(codes);
  const seen = new Set<string>();
  const ordered = (Array.isArray(output?.ranking) ? output.ranking : []).filter(
    (r) => known.has(r.code) && typeof r.score === "number" && !seen.has(r.code) && seen.add(r.code),
  );
  const missing = stocks
    .filter((s) => !seen.has(s.code))
    .map((s) => ({ code: s.code, score: 0, reason: `${LABELS[backend]} のランキングに含まれなかった` }));

  return {
    model,
    summary: typeof output?.summary === "string" ? output.summary : "",
    items: [...ordered, ...missing].map((r, i) => ({ code: r.code, score: r.score, reason: String(r.reason ?? ""), rank: i + 1 })),
  };
}
