import type { WorkersAiBinding } from "./workers-ai";

// Node で動かすとき(ローカル・Docker・Cloud Run・ECS)の Workers AI のバインディング。
// Workers AI は Cloudflare Workers のバインディングでしか呼ばないので、Node では常にない。
// vite.config.ts と tsconfig.json の "#workers-ai-binding" がこのファイルを指す(Workers 向けのビルドでは workers-ai-binding.cloudflare.ts)

/**
 * Workers AI のバインディングを返す。Node では常に null。
 */
export function getWorkersAiBinding(): WorkersAiBinding | null {
  return null;
}
