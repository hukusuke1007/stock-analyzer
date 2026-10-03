import { useSelector } from "@tanstack/react-store";
import type * as LWC from "lightweight-charts";
import type { RefObject } from "react";
import { setSettingsOpen, setTools, uiStore } from "../../lib/ui-store";

/**
 * チャートの左のツールバー(十字線 / マグネット・利確損切りライン・全体表示・スクリーンショット・設定)。
 */
export function ChartToolbar({ chartRef, screenshotName }: { chartRef: RefObject<LWC.IChartApi | null>; screenshotName: string }) {
  const tools = useSelector(uiStore, (s) => s.tools);

  /**
   * チャートの画像を PNG で保存する。
   */
  const saveScreenshot = () => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    const a = document.createElement("a");
    a.href = chart.takeScreenshot().toDataURL("image/png");
    a.download = screenshotName;
    a.click();
  };

  return (
    <nav className="toolbar" aria-label="チャートツール">
      <button className={`tool ${tools.magnet ? "" : "active"}`} title="十字線" onClick={() => setTools({ magnet: false })}>
        <svg viewBox="0 0 20 20">
          <path d="M10 2v16M2 10h16" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <button className={`tool ${tools.magnet ? "active" : ""}`} title="マグネット(終値に吸着)" onClick={() => setTools({ magnet: true })}>
        <svg viewBox="0 0 20 20">
          <path d="M5 3v7a5 5 0 0 0 10 0V3h-3v7a2 2 0 0 1-4 0V3Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <div className="tool-sep" />
      <button className={`tool ${tools.lines ? "active" : ""}`} title="利確・損切りラインを表示" onClick={() => setTools({ lines: !tools.lines })}>
        <svg viewBox="0 0 20 20">
          <path d="M2 6h16M2 14h16" stroke="currentColor" strokeWidth="1.3" strokeDasharray="3 2" />
        </svg>
      </button>
      <button className="tool" title="全体を表示" onClick={() => chartRef.current?.timeScale().fitContent()}>
        <svg viewBox="0 0 20 20">
          <path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <button className="tool" title="スクリーンショットを保存" onClick={saveScreenshot}>
        <svg viewBox="0 0 20 20">
          <path d="M3 6h3l1.5-2h5L14 6h3v10H3Z" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="10" cy="11" r="3" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <button className="tool tool-bottom" type="button" title="設定" aria-label="設定" onClick={() => setSettingsOpen(true)}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M8.6 2h2.8l.4 2.2 1.5.8 2.1-.8 1.4 2.4-1.7 1.5v1.8l1.7 1.5-1.4 2.4-2.1-.8-1.5.8-.4 2.2H8.6l-.4-2.2-1.5-.8-2.1.8-1.4-2.4 1.7-1.5V8.1L3.2 6.6l1.4-2.4 2.1.8 1.5-.8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
          />
          <circle cx="10" cy="10" r="2.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
    </nav>
  );
}
