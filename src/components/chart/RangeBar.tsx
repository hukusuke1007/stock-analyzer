import { useSelector } from "@tanstack/react-store";
import { isMarketOpen } from "../../lib/live";
import { isPaneVisible, PANES, setRange, toggleDataWindow, togglePane, uiStore } from "../../lib/ui-store";
import type { Bar } from "../../lib/types";

const RANGES = [
  { label: "1M", bars: 22 },
  { label: "3M", bars: 66 },
  { label: "6M", bars: 132 },
  { label: "1Y", bars: 0 },
];

/**
 * チャートの下の帯。期間ボタン・段の表示切り替え・データ表示・基準日・スクリーナーの開閉。
 */
export function RangeBar({ lastBar, panelCollapsed, onTogglePanel }: { lastBar: Bar | undefined; panelCollapsed: boolean; onTogglePanel: () => void }) {
  const range = useSelector(uiStore, (s) => s.range);
  const dataWindow = useSelector(uiStore, (s) => s.dataWindow);
  const showPrice = useSelector(uiStore, (s) => s.showPrice);
  const indicators = useSelector(uiStore, (s) => s.indicators);
  const panes = PANES.map((p) => ({ ...p, visible: isPaneVisible({ showPrice, indicators }, p.id) }));

  return (
    <div className="rangebar">
      <div className="ranges">
        {RANGES.map((r) => (
          <button key={r.label} className={range === r.bars ? "active" : ""} onClick={() => setRange(r.bars)}>
            {r.label}
          </button>
        ))}
      </div>
      <div className="sep" />
      <div className="ranges" title="チャートの段の表示 / 非表示">
        {panes.map((p) => (
          <button key={p.id} type="button" className={p.visible ? "active" : ""} title={`${p.label}の段を${p.visible ? "隠す" : "表示する"}`} onClick={() => togglePane(p.id)}>
            {p.label}
          </button>
        ))}
      </div>
      <div className="sep" />
      <button className={`dw-toggle ${dataWindow ? "active" : ""}`} type="button" title="十字線の日の値を指標ごとに一覧表示します" onClick={toggleDataWindow}>
        データ表示
      </button>
      <span className="muted">{lastBar ? `${lastBar.date} ${isMarketOpen() ? "現在値" : "終値"} · 日足` : ""}</span>
      <div className="spacer" />
      <a className="credit" href="https://www.tradingview.com/" target="_blank" rel="noopener">
        Charts by TradingView
      </a>
      <button className="tb-btn small" type="button" onClick={onTogglePanel}>
        {panelCollapsed ? "スクリーナー ▴" : "スクリーナー ▾"}
      </button>
    </div>
  );
}
