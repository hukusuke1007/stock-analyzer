import { env } from "cloudflare:workers";
import type { WorkersAiBinding } from "./workers-ai";

// Cloudflare Workers で動かすときの Workers AI のバインディング(wrangler.jsonc の "ai": { "binding": "AI" })

/**
 * Workers AI のバインディングを返す。wrangler.jsonc で設定していなければ null。
 */
export function getWorkersAiBinding(): WorkersAiBinding | null {
  return (env.AI as WorkersAiBinding | undefined) ?? null;
}
