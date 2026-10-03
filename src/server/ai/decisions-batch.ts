import type { Strategy, Verdict } from "../strategies/index.js";
import { getRequestUserId } from "../settings.js";
import { codexModel, runTurn } from "./codex.js";
import { type DecisionInput, type DecisionResult, normalize, VERDICTS } from "./decisions.js";
import { runWorkersAiTurn } from "./workers-ai.js";

// Decisions を、銘柄をまとめて1回で聞く AI に聞く(設定の判定 AI が codex か workers-ai のとき)。
// - codex: Codex App Server 経由。モデルは設定の codexModel(既定 gpt-6-luna)
// - workers-ai: Cloudflare Workers AI(Codex を起動できない Workers 向け)。モデルは workers-ai.ts
// 1銘柄ずつ1回ずつ聞くと、スキャンの候補(数百件)で時間がかかりすぎる。
// そこで呼ばれた銘柄をためておき、BATCH_SIZE 件(または少し待って集まった分)を1回でまとめて聞く。

export type BatchBackend = "codex" | "workers-ai";

const EFFORT = process.env.DECISIONS_EFFORT ?? "low";
// 1回で聞く銘柄数。Workers AI のモデルは文脈の長さ(24,000 トークン)が短く、答えも崩れやすいので少なくする
const BATCH_SIZE: Record<BatchBackend, number> = { codex: 20, "workers-ai": 5 };
const BATCH_WAIT_MS = 300; // 銘柄が集まるのを待つ時間
const PARALLEL = 6; // 同時に回す問い合わせの数

const prob = { type: "number", minimum: 0, maximum: 1 };

type Answer = { id: string; verdict: Verdict; verdictProbabilities: Record<Verdict, number>; qualitative: number; badNews: number };
// backend と model は問い合わせを受けた時点の設定。まとめて聞くときに、別のユーザーの設定で聞かないよう銘柄ごとに持つ
type Item = DecisionInput & { id: string; backend: BatchBackend; model: string; resolve: (r: DecisionResult) => void; reject: (e: Error) => void };

function instructions(strategy: Strategy, rules: string) {
  const q = strategy.qualitative;
  return [
    "株の売買ルールに照らして、渡された銘柄それぞれについて次の問いに答える。渡したデータだけで判断し、ツールやコマンドは使わない。",
    `# 売買ルール(${strategy.label})`,
    rules,
    "# 問い",
    `verdict: このルールに照らした、今日時点の総合判断。選択肢の意味: ${VERDICTS.map((v) => `${v}=${strategy.verdicts[v]}`).join(" / ")}。verdictProbabilities には各選択肢の確率(合計1)を入れる`,
    `qualitative: ${q.instructions}。true=${q.criteria.true} / false=${q.criteria.false}。true である確率を入れる`,
    "badNews: news に、その銘柄の明確な悪材料(不祥事・業績下方修正・事故など)が含まれている確率。news が「未確認」なら0",
    "各銘柄の答えには、渡した id をそのまま入れる。",
  ].join("\n");
}

function schema(ids: string[]) {
  return {
    type: "object",
    properties: {
      decisions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string", enum: ids },
            verdict: { type: "string", enum: VERDICTS },
            verdictProbabilities: {
              type: "object",
              properties: Object.fromEntries(VERDICTS.map((v) => [v, prob])),
              required: VERDICTS,
              additionalProperties: false,
            },
            qualitative: prob,
            badNews: prob,
          },
          required: ["id", "verdict", "verdictProbabilities", "qualitative", "badNews"],
          additionalProperties: false,
        },
      },
    },
    required: ["decisions"],
    additionalProperties: false,
  };
}

/**
 * まとめた銘柄を1回で聞き、銘柄ごとの答えを返す(呼び出し元の Promise を解決する)。
 * 答えに含まれなかった銘柄や、形の崩れた答えの銘柄だけを失敗にし、呼び出し元で数値条件だけの判定に切り替えさせる。
 */
async function runBatch(items: Item[]) {
  const { strategy, rules, backend, model: requestedModel } = items[0]!;
  try {
    const turn = {
      instructions: instructions(strategy, rules),
      prompt: JSON.stringify(items.map((i) => ({ id: i.id, ...i.state }))),
      schema: schema(items.map((i) => i.id)),
    };
    const { model, output } =
      backend === "codex"
        ? await runTurn<{ decisions: Answer[] }>({ ...turn, model: requestedModel, effort: EFFORT })
        : await runWorkersAiTurn<{ decisions: Answer[] }>(turn);
    const byId = new Map((Array.isArray(output?.decisions) ? output.decisions : []).map((d) => [d.id, d]));
    for (const i of items) {
      const answer = byId.get(i.id);
      if (!answer || !isAnswerComplete(answer)) {
        i.reject(new Error("Decisions の答えにこの銘柄が含まれなかった(または答えの形が崩れていた)"));
        continue;
      }
      const verdictProbabilities = normalize(answer.verdictProbabilities);
      i.resolve({
        provider: backend,
        model,
        qualitative: { label: strategy.qualitative.label, probability: answer.qualitative },
        // ニュースを渡していないときの答えは根拠がないので捨てる
        badNews: i.hasNews ? answer.badNews : null,
        verdict: answer.verdict,
        verdictConfidence: verdictProbabilities[answer.verdict],
        verdictProbabilities,
      });
    }
  } catch (e) {
    for (const i of items) i.reject(e instanceof Error ? e : new Error(String(e)));
  }
}

/**
 * 答えが判定に使える形かを返す。Workers AI は JSON Schema どおりに答える保証がないので、値の型と範囲を確かめる。
 */
function isAnswerComplete(a: Answer): boolean {
  const isProbability = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;

  return (
    VERDICTS.includes(a.verdict) &&
    typeof a.verdictProbabilities === "object" &&
    a.verdictProbabilities !== null &&
    VERDICTS.every((v) => isProbability(a.verdictProbabilities[v])) &&
    isProbability(a.qualitative) &&
    isProbability(a.badNews)
  );
}

// 同時に回す問い合わせの数を PARALLEL までに抑える
let running = 0;
const waiting: (() => void)[] = [];
async function withSlot(fn: () => Promise<void>) {
  if (running >= PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try {
    await fn();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

// 指示(売買ルールと、決算・ニュースの扱い)とモデルが同じ銘柄どうしをためて、まとめて聞く。
// ユーザーごとにも分ける。銘柄の材料にはユーザーが貼ったニュースの文が入るので、別のユーザーの銘柄と同じ問い合わせに入れると、
// その文に紛れ込ませた指示が別のユーザーの判定を左右しうるため
const queues = new Map<string, { backend: BatchBackend; items: Item[]; timer: ReturnType<typeof setTimeout> | null }>();

function flush(key: string) {
  const q = queues.get(key);
  if (!q || q.items.length === 0) return;
  if (q.timer) clearTimeout(q.timer);
  const items = q.items.splice(0, BATCH_SIZE[q.backend]);
  q.timer = q.items.length ? setTimeout(() => flush(key), BATCH_WAIT_MS) : null;
  void withSlot(() => runBatch(items));
}

let seq = 0;

/**
 * 銘柄1件の Decisions を、backend の AI にまとめて聞く列に入れ、答えを待つ。
 */
export function askBatchedDecision(input: DecisionInput, backend: BatchBackend): Promise<DecisionResult> {
  const model = backend === "codex" ? codexModel() : "";
  const key = `${getRequestUserId() ?? ""}\n${backend}\n${model}\n${input.strategy.id}\n${input.rules}`;
  return new Promise((resolve, reject) => {
    let q = queues.get(key);
    if (!q) queues.set(key, (q = { backend, items: [], timer: null }));
    // 同じ銘柄が同じ回に2度来ても取り違えないよう、id は通し番号にする
    q.items.push({ ...input, id: `s${++seq}`, backend, model, resolve, reject });
    if (q.items.length >= BATCH_SIZE[backend]) flush(key);
    else q.timer ??= setTimeout(() => flush(key), BATCH_WAIT_MS);
  });
}
