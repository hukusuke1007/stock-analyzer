import { createStart } from "@tanstack/react-start";

// 画面はブラウザで描画する。チャートの描画と localStorage に残す表示設定がブラウザ前提のため、
// サーバーは HTML の枠(__root.tsx の shellComponent)だけを返す
export const startInstance = createStart(() => ({
  defaultSsr: false,
}));
