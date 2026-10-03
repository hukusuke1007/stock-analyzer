import type * as LWC from "lightweight-charts";
import { useSelector } from "@tanstack/react-store";
import { type RefObject, useCallback, useMemo, useRef, useState } from "react";
import { dataWindowRows } from "../../lib/chart-theme";
import { computeIndicators } from "../../lib/indicators";
import { type JudgmentState, useNameLookup, useWatchActions, useWatchlist } from "../../lib/queries";
import type { Bar } from "../../lib/types";
import { openTradeDialog, uiStore } from "../../lib/ui-store";
import { DataWindowCard } from "./DataWindowCard";
import { Legend } from "./Legend";
import { type CrosshairPosition, MainChart } from "./MainChart";

type Props = {
  code: string | null;
  bars: Bar[] | undefined;
  judgment: JudgmentState;
  chartRef: RefObject<LWC.IChartApi | null>;
};

/**
 * チャートの領域。メインチャートに、凡例・データ表示・関心銘柄 / 売買ボタンを重ねる。
 * 十字線の位置はこのコンポーネントの状態に持ち、凡例とデータ表示だけを描き直す。
 */
export function ChartArea({ code, bars, judgment, chartRef }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [crosshair, setCrosshair] = useState<CrosshairPosition>(null);
  const indicators = useSelector(uiStore, (s) => s.indicators);
  const hiddenLines = useSelector(uiStore, (s) => s.hiddenLines);
  const showPrice = useSelector(uiStore, (s) => s.showPrice);
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const range = useSelector(uiStore, (s) => s.range);
  const tools = useSelector(uiStore, (s) => s.tools);
  const dataWindow = useSelector(uiStore, (s) => s.dataWindow);
  const watch = useWatchlist();
  const watchActions = useWatchActions();
  const nameOf = useNameLookup();
  const result = judgment && "result" in judgment ? judgment.result : null;

  // 十字線を動かすたびに計算し直さないよう、日足が変わるまで使い回す
  const ind = useMemo(() => (bars ? computeIndicators(bars) : null), [bars]);
  const settings = useMemo(() => ({ indicators, hiddenLines, showPrice, strategy }), [indicators, hiddenLines, showPrice, strategy]);
  const onCrosshairMove = useCallback((position: CrosshairPosition) => setCrosshair(position), []);

  // 銘柄が変わったら、前の銘柄の十字線の位置は捨てる
  const [crosshairCode, setCrosshairCode] = useState(code);
  if (crosshairCode !== code) {
    setCrosshairCode(code);
    setCrosshair(null);
  }

  const indicatorSet = new Set(indicators);
  const isLineVisible = (id: string) => !hiddenLines.includes(id);
  const watched = code ? watch.codes.includes(code) : false;
  const name = code ? nameOf(code) : "";
  const showCard = dataWindow && crosshair && bars && ind;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      {code && bars && ind && (
        <Legend
          code={code}
          name={name}
          bars={bars}
          index={crosshair?.index ?? bars.length - 1}
          ind={ind}
          indicators={indicatorSet}
          isLineVisible={isLineVisible}
          showPrice={showPrice}
          dataWindow={dataWindow}
          // データ表示を出しているあいだは日付・四本値もそちらにあるので、左上の凡例は隠す
          covered={Boolean(showCard)}
          result={result}
        />
      )}
      {showCard && (
        <DataWindowCard
          bar={bars[crosshair.index]!}
          name={name}
          rows={dataWindowRows(bars, ind, crosshair.index, {
            indicators: indicatorSet,
            isLineVisible,
            showPrice,
            showTradeLines: tools.lines,
            result,
          })}
          cursorX={crosshair.x}
          boundWidth={wrapRef.current?.clientWidth ?? 0}
        />
      )}
      {code && (
        <div className="chart-actions">
          <button
            className={`star chart-star ${watched ? "on" : ""}`}
            type="button"
            title={watched ? "クリックで関心銘柄から外す" : "関心銘柄(ウォッチリスト)に追加"}
            onClick={() => watchActions.toggle(code)}
          >
            {watched ? "★ 関心銘柄" : "☆ 関心銘柄に追加"}
          </button>
          {/* タブを移らずに、売買ダイアログで仮想売買する */}
          <button className="star chart-star chart-trade" type="button" title="この銘柄を株シミュレーターで仮想売買します" onClick={() => openTradeDialog(code)}>
            売買
          </button>
        </div>
      )}
      {code && bars ? (
        <MainChart
          code={code}
          bars={bars}
          settings={settings}
          range={range}
          magnet={tools.magnet}
          showTradeLines={tools.lines}
          result={result}
          chartRef={chartRef}
          onCrosshairMove={onCrosshairMove}
        />
      ) : (
        <div id="chart" className="chart" />
      )}
      {!bars && <div className="chart-empty">証券コードを入力するか、ウォッチリスト / スクリーナーから銘柄を選んでください</div>}
    </div>
  );
}
