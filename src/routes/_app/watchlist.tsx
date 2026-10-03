import { createFileRoute } from "@tanstack/react-router";
import { GridView } from "../../components/grid/GridView";

// 関心銘柄タブ。ウォッチリストの銘柄のチャートを行列に並べる
export const Route = createFileRoute("/_app/watchlist")({
  component: GridView,
});
