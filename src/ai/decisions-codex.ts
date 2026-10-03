import type { Strategy, Verdict } from "../strategies/index.js";
import { codexModel, runTurn } from "./codex.js";
import { type DecisionInput, type DecisionResult, normalize, VERDICTS } from "./decisions.js";

// Decisions を Codex App Server 経由で聞く(設定の判定 AI が codex のとき。既定)。モデルは設定の codexModel(既定 gpt-6-luna)。
// 認証は Codex CLI のログインを使うので API キーは要らない。
// 1銘柄ずつ1ターン回すと、スキャンの候補(数百件)で時間がかかりすぎる。
// そこで呼ばれた銘柄をためておき、BATCH_SIZE 件(または少し待って集まった分)を1ターンでまとめて聞く。

const EFFORT = process.env.DECISIONS_EFFORT ?? "low";
const BATCH_SIZE = 20; // 1ターンで聞く銘柄数
const BATCH_WAIT_MS = 300; // 銘柄が集まるのを待つ時間
const PARALLEL = 6; // 同時に回すターン数

const prob = { type: "number", minimum: 0, maximum: 1 };

type Answer = { id: string; verdict: Verdict; verdictProbabilities: Record<Verdict, number>; qualitative: number; badNews: number };
type Item = DecisionInput & { id: string; resolve: (r: DecisionResult) => void; reject: (e: Error) => void };

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

async function runBatch(items: Item[]) {
  const { strategy, rules } = items[0]!;
  try {
    const { model, output } = await runTurn<{ decisions: Answer[] }>({
      instructions: instructions(strategy, rules),
      prompt: JSON.stringify(items.map((i) => ({ id: i.id, ...i.state }))),
      schema: schema(items.map((i) => i.id)),
      model: codexModel(),
      effort: EFFORT,
    });
    const byId = new Map(output.decisions.map((d) => [d.id, d]));
    for (const i of items) {
      const answer = byId.get(i.id);
      if (!answer) {
        i.reject(new Error("Decisions の答えにこの銘柄が含まれなかった"));
        continue;
      }
      const verdictProbabilities = normalize(answer.verdictProbabilities);
      i.resolve({
        provider: "codex",
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

// 同時に回すターン数を PARALLEL までに抑える
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

// 指示(売買ルールと、決算・ニュースの扱い)が同じ銘柄どうしをためて、まとめて聞く
const queues = new Map<string, { items: Item[]; timer: NodeJS.Timeout | null }>();

function flush(key: string) {
  const q = queues.get(key);
  if (!q || q.items.length === 0) return;
  if (q.timer) clearTimeout(q.timer);
  const items = q.items.splice(0, BATCH_SIZE);
  q.timer = q.items.length ? setTimeout(() => flush(key), BATCH_WAIT_MS) : null;
  void withSlot(() => runBatch(items));
}

let seq = 0;

export function askCodex(input: DecisionInput): Promise<DecisionResult> {
  const key = `${input.strategy.id}\n${input.rules}`;
  return new Promise((resolve, reject) => {
    let q = queues.get(key);
    if (!q) queues.set(key, (q = { items: [], timer: null }));
    // 同じ銘柄が同じ回に2度来ても取り違えないよう、id は通し番号にする
    q.items.push({ ...input, id: `s${++seq}`, resolve, reject });
    if (q.items.length >= BATCH_SIZE) flush(key);
    else q.timer ??= setTimeout(() => flush(key), BATCH_WAIT_MS);
  });
}
