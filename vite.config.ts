import { defineConfig } from "vite";

// ブラウザ UI(ui/)。開発時は API(pnpm dev の :3000)へプロキシし、
// ビルド結果(ui/dist)は API サーバーがそのまま配信する。
const API = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: "ui",
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: Object.fromEntries(["/health", "/strategies", "/bars", "/judge", "/screen", "/results", "/watchlist", "/search", "/sim", "/settings"].map((p) => [p, API])),
  },
});
