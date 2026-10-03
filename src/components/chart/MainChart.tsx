import * as LWC from "lightweight-charts";
import { memo, type RefObject, useEffect, useRef } from "react";
import { bbLines, C, ICHI, ICHI_LINES, type IndicatorId, MA_IDS, maColor, toLinePoints } from "../../lib/chart-theme";
import { CloudPrimitive } from "../../lib/cloud-primitive";
import { computeIndicators, type Indicators, SHIFT } from "../../lib/indicators";
import type { Bar, JudgeResult } from "../../lib/types";

// メインチャート(lightweight-charts)。価格の段(ローソク足・移動平均・ボリンジャーバンド・一目均衡表・出来高)と、
// 下の段(RSI / RCI / MACD)を描き、判定の利確 / 損切りラインとマーカーを重ねる。
// 十字線を動かすたびに React で描き直すと重いので、チャートの操作は命令的に行い、
// 十字線の位置だけを onCrosshairMove で親(凡例・データ表示)に渡す

type SeriesMap = Record<string, LWC.ISeriesApi<LWC.SeriesType>>;

export type CrosshairPosition = { index: number; x: number } | null;

export type ChartSettings = {
  indicators: IndicatorId[];
  hiddenLines: string[];
  showPrice: boolean;
  strategy: string; // スイングでは RSI の 40 / 60 の補助線も引く
};

type Props = {
  code: string;
  bars: Bar[];
  settings: ChartSettings;
  range: number;
  magnet: boolean;
  showTradeLines: boolean;
  result: JudgeResult | null;
  chartRef: RefObject<LWC.IChartApi | null>;
  onCrosshairMove: (position: CrosshairPosition) => void;
};

const PRICE_FORMAT = { type: "price", precision: 1, minMove: 0.1 } as const;
const SUB_PRICE_FORMAT = { type: "price", precision: 2, minMove: 0.01 } as const;

/**
 * 出来高の棒の色。前日より下げた日は赤、それ以外は緑。
 */
function volumeColor(bars: Bar[], i: number): string {
  return i > 0 && bars[i]!.close < bars[i - 1]!.close ? "rgba(242, 54, 69, 0.35)" : "rgba(8, 153, 129, 0.35)";
}

/**
 * MACD のヒストグラムの色。0 以上は緑、未満は赤。
 */
function macdHistColor(value: number): string {
  return value >= 0 ? "rgba(8, 153, 129, 0.55)" : "rgba(242, 54, 69, 0.55)";
}

/**
 * メインチャートを描く。memo で包み、十字線の位置で親が描き直されてもチャートは作り直さない。
 */
export const MainChart = memo(function MainChart(props: Props) {
  const { code, bars, settings, range, magnet, showTradeLines, result, chartRef, onCrosshairMove } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const candleRef = useRef<LWC.ISeriesApi<"Candlestick"> | null>(null);
  const markersRef = useRef<LWC.ISeriesMarkersPluginApi<LWC.Time> | null>(null);
  const priceLinesRef = useRef<LWC.IPriceLine[]>([]);
  const seriesRef = useRef<SeriesMap>({});
  const cloudRef = useRef<CloudPrimitive | null>(null);
  // 作ったときの銘柄と日足。日足だけが変わった(ライブ更新)ときに、作り直さず最新の足を差し替えるのに使う
  const builtRef = useRef<{ code: string; bars: Bar[] } | null>(null);
  const barsRef = useRef(bars);
  const rangeRef = useRef(range);
  const crosshairRef = useRef(onCrosshairMove);
  barsRef.current = bars;
  rangeRef.current = range;
  crosshairRef.current = onCrosshairMove;

  const indicatorsKey = settings.indicators.join(",");
  const hiddenKey = settings.hiddenLines.join(",");

  // チャートを作る。インジケーターや段の表示を変えたときも作り直す
  useEffect(() => {
    const el = containerRef.current;
    if (!el) {
      return;
    }

    const previous = builtRef.current;
    const prevRange = previous?.code === code ? chartRef.current?.timeScale().getVisibleLogicalRange() : null;
    const chart = LWC.createChart(el, {
      autoSize: true,
      layout: {
        background: { type: LWC.ColorType.Solid, color: C.bg },
        textColor: C.text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        // ロゴは出さない。帰属表示は期間ボタンの並びの右端のリンクで行う(ライセンス上ページのどこかに必要)
        attributionLogo: false,
        panes: { separatorColor: C.border, separatorHoverColor: "rgba(41, 98, 255, 0.3)" },
      },
      grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
      crosshair: {
        vertLine: { color: C.muted, labelBackgroundColor: C.crosshairLabel },
        horzLine: { color: C.muted, labelBackgroundColor: C.crosshairLabel },
      },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, rightOffset: 6 },
      localization: { locale: "ja-JP", dateFormat: "yyyy/MM/dd" },
    });
    chartRef.current = chart;
    seriesRef.current = {};
    candleRef.current = null;
    markersRef.current = null;
    cloudRef.current = null;
    priceLinesRef.current = [];

    const currentBars = barsRef.current;
    const ind = computeIndicators(currentBars);
    const on = new Set(settings.indicators);
    const isLineVisible = (id: string) => !settings.hiddenLines.includes(id);

    if (settings.showPrice) {
      buildPricePane(chart, currentBars, ind, on, isLineVisible);
    }
    const lowerPanes = buildLowerPanes(chart, currentBars, ind, on, settings.strategy, settings.showPrice);

    // 価格の段を広めに取る。下の段どうしは同じ高さ
    const panes = chart.panes();
    for (const p of panes) {
      p.setStretchFactor(1);
    }
    if (settings.showPrice) {
      panes[0]?.setStretchFactor(lowerPanes === 0 ? 1 : lowerPanes === 1 ? 3 : 2.4);
    }

    chart.subscribeCrosshairMove((param) => {
      if (!param.point || param.logical == null) {
        crosshairRef.current(null);
        return;
      }

      const index = Math.max(0, Math.min(barsRef.current.length - 1, Math.round(param.logical)));
      crosshairRef.current({ index, x: param.point.x });
    });

    // 同じ銘柄のまま作り直したときは、見ていた期間を保つ
    if (prevRange) {
      chart.timeScale().setVisibleLogicalRange(prevRange);
    } else {
      applyVisibleRange(chart, currentBars.length, rangeRef.current, on.has("ichimoku"));
    }
    builtRef.current = { code, bars: currentBars };

    return () => {
      chart.remove();
      chartRef.current = null;
    };

    /**
     * 価格の段(出来高・ボリンジャーバンド・ローソク足・移動平均・一目均衡表)を描く。
     */
    function buildPricePane(chart: LWC.IChartApi, bars: Bar[], ind: Indicators, on: Set<IndicatorId>, isLineVisible: (id: string) => boolean) {
      const series = seriesRef.current;
      const addLine = (color: string, opts: LWC.DeepPartial<LWC.LineStyleOptions & LWC.SeriesOptionsCommon> = {}) =>
        chart.addSeries(LWC.LineSeries, {
          color,
          lineWidth: 1,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
          priceFormat: PRICE_FORMAT,
          ...opts,
        });
      const times = bars.map((b) => b.date);

      if (on.has("vol")) {
        const vol = chart.addSeries(LWC.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
        vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(bars.map((b, i) => ({ time: b.date, value: b.volume, color: volumeColor(bars, i) })));
        series.vol = vol;
      }

      if (on.has("bb")) {
        for (const l of bbLines(ind)) {
          if (!isLineVisible(l.lineId)) {
            continue;
          }

          const line = addLine(l.color, l.dotted ? { lineStyle: LWC.LineStyle.Dotted } : {});
          line.setData(toLinePoints(times, l.values));
          series[l.key] = line;
        }
      }

      const candle = chart.addSeries(LWC.CandlestickSeries, {
        upColor: C.up,
        downColor: C.down,
        borderVisible: false,
        wickUpColor: C.up,
        wickDownColor: C.down,
        priceFormat: PRICE_FORMAT,
      });
      candle.setData(bars.map(({ date, open, high, low, close }) => ({ time: date, open, high, low, close })));
      candleRef.current = candle;
      markersRef.current = LWC.createSeriesMarkers(candle, []);

      for (const id of MA_IDS) {
        if (!on.has(id)) {
          continue;
        }

        const line = addLine(maColor(id), { lineWidth: 2 });
        line.setData(toLinePoints(times, ind[id]));
        series[id] = line;
      }

      if (on.has("ichimoku")) {
        for (const id of ICHI_LINES) {
          if (isLineVisible(id)) {
            series[id] = addLine(ICHI[id]);
          }
        }
        // 雲は先行スパンを隠していても塗れるよう、ローソク足に付ける
        if (isLineVisible("cloud")) {
          cloudRef.current = new CloudPrimitive({ up: ICHI.cloudUp, down: ICHI.cloudDown });
          candle.attachPrimitive(cloudRef.current);
        }
        setIchimokuData(ind);
      }
    }

    /**
     * 下の段(RSI / RCI / MACD)を描き、描いた段の数を返す。
     */
    function buildLowerPanes(chart: LWC.IChartApi, bars: Bar[], ind: Indicators, on: Set<IndicatorId>, strategy: string, showPrice: boolean): number {
      const series = seriesRef.current;
      const times = bars.map((b) => b.date);
      const addLine = (color: string, pane: number, opts: LWC.DeepPartial<LWC.LineStyleOptions & LWC.SeriesOptionsCommon> = {}) =>
        chart.addSeries(
          LWC.LineSeries,
          { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: PRICE_FORMAT, ...opts },
          pane,
        );
      const addLevel = (s: LWC.ISeriesApi<LWC.SeriesType>, price: number, color: string, style: LWC.LineStyle = LWC.LineStyle.Dashed) =>
        s.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false });

      // 価格の段を出していなければ、最初の下の段が一番上(0 番)になる
      let pane = showPrice ? 0 : -1;

      if (on.has("rsi")) {
        pane++;
        const rsi = addLine("#7e57c2", pane, { lineWidth: 2, lastValueVisible: true });
        rsi.setData(toLinePoints(times, ind.rsi));
        addLevel(rsi, 70, C.muted);
        addLevel(rsi, 30, C.muted);
        if (strategy === "swing") {
          addLevel(rsi, 60, "rgba(41, 98, 255, 0.5)", LWC.LineStyle.Dotted);
          addLevel(rsi, 40, "rgba(41, 98, 255, 0.5)", LWC.LineStyle.Dotted);
        }
        series.rsi = rsi;
      }

      if (on.has("rci")) {
        pane++;
        const rci10 = addLine("#00bcd4", pane, { lineWidth: 2, lastValueVisible: true });
        const rci26 = addLine("#ff9800", pane);
        rci10.setData(toLinePoints(times, ind.rci10));
        rci26.setData(toLinePoints(times, ind.rci26));
        addLevel(rci10, 80, C.muted);
        addLevel(rci10, -80, C.muted);
        addLevel(rci10, -90, "rgba(242, 54, 69, 0.6)", LWC.LineStyle.Dotted);
        series.rci10 = rci10;
        series.rci26 = rci26;
      }

      if (on.has("macd")) {
        pane++;
        const m = ind.macd;
        const hist = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: SUB_PRICE_FORMAT }, pane);
        hist.setData(
          bars.flatMap((b, i) => {
            const value = m.hist[i];

            return value == null ? [] : [{ time: b.date, value, color: macdHistColor(value) }];
          }),
        );
        const macd = addLine("#2962ff", pane, { lineWidth: 2, lastValueVisible: true, priceFormat: SUB_PRICE_FORMAT });
        const signal = addLine("#ff6d00", pane, { priceFormat: SUB_PRICE_FORMAT });
        macd.setData(toLinePoints(times, m.line));
        signal.setData(toLinePoints(times, m.signal));
        series.macdHist = hist;
        series.macd = macd;
        series.macdSignal = signal;
      }

      return showPrice ? pane : pane + 1;
    }
    // settings の中身は indicatorsKey・hiddenKey で比べる(配列は描き直しのたびに別物になるため)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, indicatorsKey, hiddenKey, settings.showPrice, settings.strategy, chartRef]);

  // ライブ更新で日足が変わったら、作り直さずに最新の足だけを差し替える(作り直すと表示位置や十字線がリセットされるため)
  useEffect(() => {
    const built = builtRef.current;
    if (!built || built.code !== code || built.bars === bars) {
      return;
    }

    updateLastBar(bars, new Set(settings.indicators), settings.showPrice);
    builtRef.current = { code, bars };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars]);

  // 期間ボタン
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      applyVisibleRange(chart, barsRef.current.length, range, settings.indicators.includes("ichimoku"));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // 十字線のマグネット(終値に吸着)
  useEffect(() => {
    chartRef.current?.applyOptions({ crosshair: { mode: magnet ? LWC.CrosshairMode.MagnetOHLC : LWC.CrosshairMode.Normal } });
  }, [magnet, chartRef, indicatorsKey, hiddenKey, settings.showPrice, code]);

  // 利確・損切りのラインと、判定のマーカー。チャートを作り直したときも付け直す
  useEffect(() => {
    applyTradeLines(result, showTradeLines);
  }, [result, showTradeLines, code, indicatorsKey, hiddenKey, settings.showPrice, settings.strategy]);

  /**
   * 一目均衡表の線と雲にデータを入れる。先行スパン(未来)と遅行スパン(過去)があるので、未来の日付を足した times で描く。
   */
  function setIchimokuData(ind: Indicators) {
    const g = ind.ichimoku;
    const series = seriesRef.current;

    for (const id of ICHI_LINES) {
      series[id]?.setData(toLinePoints(g.times, g[id]));
    }
    cloudRef.current?.setPoints(
      g.times.flatMap((time, k) => {
        const a = g.spanA[k];
        const b = g.spanB[k];

        return a == null || b == null ? [] : [{ time, a, b }];
      }),
    );
  }

  /**
   * 最新の足と、それから計算するインジケーターの最新の値だけを差し替える。
   */
  function updateLastBar(bars: Bar[], on: Set<IndicatorId>, showPrice: boolean) {
    const series = seriesRef.current;
    const i = bars.length - 1;
    const b = bars[i]!;
    const time = b.date;
    const ind = computeIndicators(bars);
    const putValue = (key: string, value: number | null | undefined, extra: { color?: string } = {}) => {
      const s = series[key];
      if (s && value != null) {
        s.update({ time, value, ...extra });
      }
    };

    candleRef.current?.update({ time, open: b.open, high: b.high, low: b.low, close: b.close });
    putValue("vol", b.volume, { color: volumeColor(bars, i) });
    for (const id of MA_IDS) {
      putValue(id, ind[id][i]);
    }

    // 一目均衡表は先行・遅行スパンが最新の足以外の日付にも効くので、まとめて描き直す
    if (on.has("ichimoku") && showPrice) {
      setIchimokuData(ind);
    }
    for (const l of bbLines(ind)) {
      putValue(l.key, l.values[i]);
    }

    putValue("rsi", ind.rsi[i]);
    putValue("rci10", ind.rci10[i]);
    putValue("rci26", ind.rci26[i]);
    putValue("macd", ind.macd.line[i]);
    putValue("macdSignal", ind.macd.signal[i]);
    const hist = ind.macd.hist[i];
    if (hist != null) {
      putValue("macdHist", hist, { color: macdHistColor(hist) });
    }
  }

  /**
   * 判定の利確・損切りラインと、買い / 打診買いのマーカーを付け直す。
   */
  function applyTradeLines(r: JudgeResult | null, visible: boolean) {
    const candle = candleRef.current;
    if (!candle) {
      return;
    }

    for (const l of priceLinesRef.current) {
      candle.removePriceLine(l);
    }
    priceLinesRef.current = [];

    const last = barsRef.current.at(-1);
    markersRef.current?.setMarkers(
      r && r.verdict !== "見送り" && last
        ? [{ time: last.date, position: "belowBar", shape: "arrowUp", color: r.verdict === "買い" ? C.up : C.amber, text: r.verdict }]
        : [],
    );
    if (!r || !visible) {
      return;
    }

    const addLine = (price: number | null, color: string, title: string) => {
      if (price != null) {
        priceLinesRef.current.push(candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title }));
      }
    };
    r.sellPlan.takeProfit.forEach((t, i) => addLine(t.price, C.up, r.sellPlan.takeProfit.length > 1 ? `利確${i + 1}` : "利確"));
    addLine(r.sellPlan.stopLoss.price, C.down, "損切り");
  }

  return <div id="chart" className="chart" ref={containerRef} />;
});

/**
 * 期間ボタンの本数ぶんを表示する(0 なら全体)。一目均衡表を出しているときは、先の雲も見えるように右を空ける。
 */
export function applyVisibleRange(chart: LWC.IChartApi, barCount: number, range: number, ichimoku: boolean) {
  if (!barCount) {
    return;
  }

  if (range === 0) {
    chart.timeScale().fitContent();
    return;
  }

  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, barCount - range), to: barCount + (ichimoku ? SHIFT + 2 : 5) });
}
