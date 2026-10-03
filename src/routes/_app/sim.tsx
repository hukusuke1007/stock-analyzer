import { createFileRoute } from "@tanstack/react-router";
import { SimView } from "../../components/sim/SimView";

// 株シミュレーター(仮想売買)の画面
export const Route = createFileRoute("/_app/sim")({
  component: SimView,
});
