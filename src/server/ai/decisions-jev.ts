import { choice, noul, TypeSafeClient } from "@typesafe-ai/sdk";
import { type DecisionInput, type DecisionResult, normalize } from "./decisions.js";

// Decisions を TypeSafe AI の Jev(Decision API)に聞く(設定の判定 AI が jev のとき)。
// TYPESAFE_API_KEY(https://console.typesafe.ai/keys で発行)が要る。
// 選択肢の決まった問いに速く答える API なので、1銘柄ずつ1リクエストで聞く。

let client: TypeSafeClient | undefined;

export async function askJev(input: DecisionInput): Promise<DecisionResult> {
  client ??= new TypeSafeClient();
  const { strategy } = input;
  const q = strategy.qualitative;
  const questions = {
    qualitative: noul(q.instructions, q.criteria),
    verdict: choice(`${strategy.label}のルールに照らした、この銘柄の今日時点の総合判断`, strategy.verdicts),
    badNews: noul("news に、この銘柄の明確な悪材料(不祥事・業績下方修正・事故など)が含まれているか"),
  };

  const { model, answers } = await client.systemOne({ state: { rules: input.rules, ...input.state }, questions });
  return {
    provider: "jev",
    model,
    qualitative: { label: q.label, probability: answers.qualitative.noul },
    // ニュースを渡していないときの答えは根拠がないので捨てる
    badNews: input.hasNews ? answers.badNews.noul : null,
    verdict: answers.verdict.choice,
    verdictConfidence: answers.verdict.confidence,
    verdictProbabilities: normalize(answers.verdict.probabilities),
  };
}
