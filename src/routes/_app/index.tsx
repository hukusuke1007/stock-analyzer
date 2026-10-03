import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import type * as LWC from "lightweight-charts";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { ChartArea } from "../../components/chart/ChartArea";
import { ChartToolbar } from "../../components/chart/ChartToolbar";
import { DetailPanel } from "../../components/chart/DetailPanel";
import { RangeBar } from "../../components/chart/RangeBar";
import { ScreenerPanel } from "../../components/chart/ScreenerPanel";
import { useDragResize } from "../../components/chart/useDragResize";
import { WatchlistPanel } from "../../components/chart/WatchlistPanel";
import { errorMessage } from "../../lib/api";
import { isStockCode, normalizeCode } from "../../lib/format";
import { readLocal, writeLocal } from "../../lib/local-storage";
import { useBars, useJudgeStock, useJudgment, useWatchlist } from "../../lib/queries";
import { setChartCode, showFlash, uiStore } from "../../lib/ui-store";

type ChartSearch = { code?: string };

// チャート画面。開く銘柄は ?code=7203 で指定する(ブックマーク・戻る用)
export const Route = createFileRoute("/_app/")({
  // ?code=7203 は URL から読むと数値になるので、文字列にそろえる(英字を含むコードは文字列のまま届く)
  validateSearch: (search: Record<string, unknown>): ChartSearch =>
    (typeof search.code === "string" || typeof search.code === "number") && search.code !== "" ? { code: String(search.code) } : {},
  component: ChartPage,
});

// スクリーナーの高さ・右パネルの幅・ウォッチリストの高さの既定と下限
const PANEL_DEFAULT = 300;
const PANEL_MIN = 120;
const CHART_MIN = 200; // チャートは最低これだけ残す
const RANGEBAR_HEIGHT = 34;
const SIDE_DEFAULT = 340;
const WATCH_DEFAULT = 300;

/**
 * チャート画面。左にツールバー、中央にチャートとスクリーナー、右にウォッチリストと判定の詳細を並べる。
 */
function ChartPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const watch = useWatchlist();
  const lastCode = useSelector(uiStore, (s) => s.chartCode);
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const code = search.code ? normalizeCode(search.code) : null;
  const validCode = code && isStockCode(code) ? code : null;
  const { data: barsData, error: barsError } = useBars(validCode);
  const judgment = useJudgment(validCode);
  const judgeStock = useJudgeStock();
  const chartRef = useRef<LWC.IChartApi | null>(null);
  const centerRef = useRef<HTMLElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(() => readLocal("panelCollapsed", false));

  // URL に銘柄がなければ、最後に開いた銘柄(なければ関心銘柄の先頭)を開く
  useEffect(() => {
    if (search.code) {
      return;
    }

    const initial = lastCode ?? watch.codes[0];
    if (initial) {
      void navigate({ to: "/", search: { code: initial }, replace: true });
    }
  }, [search.code, lastCode, watch.codes, navigate]);

  // 開いている銘柄を、上部の「判定」とライブ更新の対象にする
  useEffect(() => {
    if (code && !validCode) {
      showFlash(`証券コードの形式ではありません: ${code}`);
    }
    if (validCode) {
      setChartCode(validCode);
    }
  }, [code, validCode]);

  // 保存済みの判定がない、または前の営業日の終値で判定したものなら判定し直す
  const latestDate = barsData?.bars.at(-1)?.date;
  useEffect(() => {
    if (!validCode || !latestDate) {
      return;
    }

    const needsJudge = judgment === null || ("result" in judgment && judgment.result.asOf < latestDate);
    if (needsJudge) {
      void judgeStock(validCode);
    }
    // 判定の結果が入るたびに走らないよう、銘柄・売買ルール・最新の足の日付が変わったときだけ確かめる
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validCode, strategy, latestDate]);

  const clampPanelHeight = useCallback((h: number) => {
    const max = (centerRef.current?.clientHeight ?? 800) - RANGEBAR_HEIGHT - CHART_MIN;

    return Math.round(Math.max(PANEL_MIN, Math.min(h, Math.max(PANEL_MIN, max))));
  }, []);
  // 右パネルは左端を左へ引くほど広がる。チャートは最低 480px 残す
  const clampSideWidth = useCallback((w: number) => Math.round(Math.max(260, Math.min(w, Math.max(260, window.innerWidth - 48 - 480)))), []);
  // ウォッチリストは下端を下へ引くほど高くなる。判定の詳細は最低 150px 残す
  const clampWatchHeight = useCallback(
    (h: number) => Math.round(Math.max(100, Math.min(h, Math.max(100, (sidebarRef.current?.clientHeight ?? 800) - 150)))),
    [],
  );

  const panel = useDragResize({ axis: "y", storageKey: "panelHeight", fallback: PANEL_DEFAULT, sizeFromDrag: (s, d) => s - d, clampSize: clampPanelHeight });
  const side = useDragResize({ axis: "x", storageKey: "sideWidth", fallback: SIDE_DEFAULT, sizeFromDrag: (s, d) => s - d, clampSize: clampSideWidth });
  const watchSize = useDragResize({ axis: "y", storageKey: "watchHeight", fallback: WATCH_DEFAULT, sizeFromDrag: (s, d) => s + d, clampSize: clampWatchHeight });

  /**
   * スクリーナーを畳む / 開く。状態はブラウザに覚えておく。
   */
  const togglePanel = () => {
    writeLocal("panelCollapsed", !panelCollapsed);
    setPanelCollapsed(!panelCollapsed);
  };

  const lastBar = barsData?.bars.at(-1);

  return (
    <main className="layout" style={{ "--side-w": `${side.size}px` } as CSSProperties}>
      <ChartToolbar chartRef={chartRef} screenshotName={`${validCode ?? ""}_${strategy}_${lastBar?.date ?? ""}.png`} />

      <section className="center" ref={centerRef}>
        <ChartArea code={validCode} bars={barsData?.bars} judgment={judgment} chartRef={chartRef} />
        <RangeBar lastBar={lastBar} panelCollapsed={panelCollapsed} onTogglePanel={togglePanel} />
        <ScreenerPanel
          selectedCode={validCode}
          height={panel.size}
          collapsed={panelCollapsed}
          resizer={<div className={`resizer ${panel.dragging ? "dragging" : ""}`} title="ドラッグで高さを変更(ダブルクリックで元に戻す)" {...panel.handleProps} />}
        />
      </section>

      <aside className="sidebar" ref={sidebarRef}>
        <div className={`v-resizer ${side.dragging ? "dragging" : ""}`} title="ドラッグで幅を変更(ダブルクリックで元に戻す)" {...side.handleProps} />
        <WatchlistPanel
          selectedCode={validCode}
          height={watchSize.size}
          resizer={<div className={`h-resizer ${watchSize.dragging ? "dragging" : ""}`} title="ドラッグで高さを変更(ダブルクリックで元に戻す)" {...watchSize.handleProps} />}
        />
        <DetailPanel code={validCode} barsData={barsData} loadError={barsError ? errorMessage(barsError) : null} judgment={judgment} />
      </aside>
    </main>
  );
}
