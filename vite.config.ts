import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// TanStack Start のアプリ。画面と API(/api/*)を1つのサーバーで配信する。
// ビルドの出力先は DEPLOY_TARGET で切り替える(HOW_TO_DEPLOY.md)。
// - 既定: Nitro で Node のサーバー(.output/server/index.mjs)にする。Docker・Cloud Run・ECS 向け
// - cloudflare: Cloudflare Workers 向け(wrangler.jsonc)。dev でも Workers の実行環境(workerd)で動く
const target = process.env.DEPLOY_TARGET === "cloudflare" ? "cloudflare" : "node";

// DB の接続と Workers AI のバインディングはビルドの種類で差し替える。
// Workers では TCP の PostgreSQL のドライバーなどを bundle に入れず、Node では Workers 専用のモジュール(cloudflare:workers)を読まない
const dbConnection = fileURLToPath(new URL(`./src/server/db/connection.${target}.ts`, import.meta.url));
const workersAiBinding = fileURLToPath(new URL(`./src/server/ai/workers-ai-binding.${target}.ts`, import.meta.url));

export default defineConfig({
  server: { port: Number(process.env.PORT ?? 3000) },
  resolve: { alias: { "#db-connection": dbConnection, "#workers-ai-binding": workersAiBinding } },
  plugins: [
    // Cloudflare のプラグインは、TanStack Start のサーバー側(ssr)の環境を Workers で動かすので先に置く
    ...(target === "cloudflare" ? [cloudflare({ viteEnvironment: { name: "ssr" } })] : []),
    tanstackStart(),
    ...(target === "node" ? [nitro()] : []),
    viteReact(),
  ],
});
