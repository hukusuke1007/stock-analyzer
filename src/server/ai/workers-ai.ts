import { getWorkersAiBinding } from "#workers-ai-binding";
import type { JsonValue } from "../strategies/index.js";

// Cloudflare Workers AI のクライアント。Codex を起動できない Cloudflare Workers で、判定(Decisions)とランク付けに使う。
// Codex と同じ「指示・材料・答えの JSON Schema」を渡し、JSON Mode(response_format の json_schema)で答えさせる。
// Workers AI は答えが JSON Schema どおりになることを保証しないので、受け取った側で足りない答えを確かめる。
// https://developers.cloudflare.com/workers-ai/features/json-mode/

export type WorkersAiBinding = { run(model: string, input: object): Promise<unknown> };

// JSON Mode に対応したモデルのうち、いちばん大きいもの。環境変数(wrangler.jsonc の vars)で変えられる
const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// 答えの長さの上限。既定(256)ではまとめて聞いた銘柄の答えが途中で切れる
const MAX_TOKENS = 4096;

/**
 * 使うモデルの名前を返す。
 */
export function workersAiModel(): string {
  return process.env.WORKERS_AI_MODEL || DEFAULT_MODEL;
}

/**
 * Workers AI を使えるか(Workers で動いていて、AI のバインディングがあるか)を返す。
 */
export function workersAiAvailable(): boolean {
  return getWorkersAiBinding() !== null;
}

/**
 * 指示と材料を渡し、JSON Schema の形の答えを1つ受け取る。Codex の runTurn と同じ使い方にそろえている。
 */
export async function runWorkersAiTurn<T>(opts: { instructions: string; prompt: string; schema: JsonValue }): Promise<{ model: string; output: T }> {
  const ai = getWorkersAiBinding();
  if (!ai) {
    throw new Error("Workers AI のバインディング AI がありません。wrangler.jsonc の ai を確認してください");
  }

  const model = workersAiModel();
  const result = (await ai.run(model, {
    messages: [
      { role: "system", content: opts.instructions },
      { role: "user", content: opts.prompt },
    ],
    response_format: { type: "json_schema", json_schema: opts.schema },
    max_tokens: MAX_TOKENS,
  })) as { response?: unknown };

  // JSON Mode では、答えが文字列(JSON)でなく、読み取り済みのオブジェクトで返ることがある
  const response = result.response;
  if (response == null || response === "") {
    throw new Error("Workers AI の応答に答えがない");
  }

  return { model, output: (typeof response === "string" ? JSON.parse(response) : response) as T };
}
