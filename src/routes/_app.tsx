import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { isUnauthorized } from "../lib/api";
import { LIVE_INTERVAL, refreshLiveBars } from "../lib/live";
import { meQuery } from "../lib/queries";
import { LineNotifier } from "../components/layout/LineNotifier";
import { SettingsDialog } from "../components/layout/SettingsDialog";
import { TopBar } from "../components/layout/TopBar";
import { TradeDialog } from "../components/sim/TradeDialog";

// ログインが要る画面の枠。ログインしていなければログイン画面へ移す
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context }) => {
    try {
      await context.queryClient.ensureQueryData(meQuery);
    } catch (e) {
      if (isUnauthorized(e)) {
        throw redirect({ to: "/login" });
      }

      throw e;
    }
  },
  component: AppLayout,
});

// 画面ごとに body に付ける data-view。CSS(app.css)が画面ごとの表示 / 非表示に使う
const VIEW_OF_PATH: Record<string, string> = { "/": "chart", "/watchlist": "grid", "/sim": "sim" };

/**
 * 上部バー・画面・ダイアログを並べ、取引時間中のライブ更新を回す。
 */
function AppLayout() {
  const queryClient = useQueryClient();
  const pathname = useLocation({ select: (l) => l.pathname });

  useEffect(() => {
    document.body.dataset.view = VIEW_OF_PATH[pathname] ?? "chart";
  }, [pathname]);

  // 取引時間中は1分ごとに株価を取り直す。別のタブから戻ってきたら、すぐに取り直す
  useEffect(() => {
    const timer = setInterval(() => refreshLiveBars(queryClient), LIVE_INTERVAL);
    const refreshOnVisible = () => {
      if (!document.hidden) {
        void refreshLiveBars(queryClient);
      }
    };
    document.addEventListener("visibilitychange", refreshOnVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshOnVisible);
    };
  }, [queryClient]);

  return (
    <>
      <TopBar />
      <Outlet />
      <TradeDialog />
      <SettingsDialog />
      <LineNotifier />
    </>
  );
}
