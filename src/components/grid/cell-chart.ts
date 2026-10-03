import * as LWC from "lightweight-charts";
import { bbLines, C, ICHI, ICHI_LINES, type IndicatorId, MA_IDS, maColor, toLinePoints } from "../../lib/chart-theme";
import { CloudPrimitive } from "../../lib/cloud-primitive";
import { type Indicators, SHIFT } from "../../lib/indicators";
import type { Bar, JudgeResult } from "../../lib/types";

// 関心銘柄タブの1枚分のチャート(価格の段だけ)を作り、日足・判定を描き込む。
// React の描画とは切り離し、GridCell の effect から呼ぶ

// 1行の表示数ごとの段の高さ(px)。列が少ないほど1枚が横に広いので高くする
export const ROW_HEIGHT: Record<number, number> = { 1: 440, 2: 340, 3: 280, 4: 240, 5: 220 };

export type CellChart = {
  chart: LWC.IChartApi;
  candle: LWC.ISeriesApi<"Candlestick">;
  vol: LWC.ISeriesApi<"Histogram"> | null;
  lines: Map<string, LWC.ISeriesApi<"Line">>; // 系列の名前(MA・ボリンジャー・一目の線) → 線
  cloud: CloudPrimitive | null;
  ichimoku: boolean;
  markers: LWC.ISeriesMarkersPluginApi<LWC.Time>;
  priceLines: LWC.IPriceLine[]; // 判定の利確 / 損切りのライン
  ranged: boolean; // 最初の表示範囲を合わせたか
};

const PRICE_FORMAT = { type: "price", precision: 1, minMove: 0.1 } as const;

/**
 * 最初に見せる足の本数を返す。
 * 小さいチャートに半年分を詰めると読めないので、4列以上は3ヶ月にする。
 */
function countVisibleBars(columns: number): number {
  return columns >= 4 ? 66 : 132;
}

/**
 * 関心銘柄のチャートを1枚作る(系列は空のまま)。
 * チャートタブの価格の段と同じインジケーター・同じ線の表示設定で描き、RSI などの段は出さない。
 */
export function createCellChart(box: HTMLElement, indicators: IndicatorId[], hiddenLines: string[], ind: Indicators): CellChart {
  const on = new Set(indicators);
  const isLineVisible = (id: string) => !hiddenLines.includes(id);

  const chart = LWC.createChart(box, {
    autoSize: true,
    layout: {
      background: { type: LWC.ColorType.Solid, color: C.bg },
      textColor: C.text,
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: 10,
      // 帰属表示はツールバー下のリンクで行う(セルごとにロゴを出すと邪魔)
      attributionLogo: false,
    },
    grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
    crosshair: {
      vertLine: { color: C.muted, labelBackgroundColor: C.crosshairLabel },
      horzLine: { color: C.muted, labelBackgroundColor: C.crosshairLabel },
    },
    rightPriceScale: { borderColor: C.border },
    timeScale: { borderColor: C.border, rightOffset: 3 },
    localization: { locale: "ja-JP", dateFormat: "yyyy/MM/dd" },
    // ホイールは一覧のスクロールに使う。チャートの拡大・移動はドラッグとピンチで
    handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
  });

  const addLine = (color: string, dotted = false) =>
    chart.addSeries(LWC.LineSeries, {
      color,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
      priceFormat: PRICE_FORMAT,
      ...(dotted ? { lineStyle: LWC.LineStyle.Dotted } : {}),
    });
  const lines = new Map<string, LWC.ISeriesApi<"Line">>();

  // 出来高とボリンジャーバンドはローソク足より先に足し、ローソク足の後ろに描かせる
  let vol: LWC.ISeriesApi<"Histogram"> | null = null;
  if (on.has("vol")) {
    vol = chart.addSeries(LWC.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  }

  if (on.has("bb")) {
    for (const l of bbLines(ind)) {
      if (isLineVisible(l.lineId)) {
        lines.set(l.key, addLine(l.color, l.dotted));
      }
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

  for (const id of MA_IDS) {
    if (on.has(id)) {
      lines.set(id, addLine(maColor(id)));
    }
  }

  let cloud: CloudPrimitive | null = null;
  if (on.has("ichimoku")) {
    for (const id of ICHI_LINES) {
      if (isLineVisible(id)) {
        lines.set(id, addLine(ICHI[id]));
      }
    }

    if (isLineVisible("cloud")) {
      cloud = new CloudPrimitive({ up: ICHI.cloudUp, down: ICHI.cloudDown });
      candle.attachPrimitive(cloud);
    }
  }

  return {
    chart,
    candle,
    vol,
    lines,
    cloud,
    ichimoku: on.has("ichimoku"),
    markers: LWC.createSeriesMarkers(candle, []),
    priceLines: [],
    ranged: false,
  };
}

/**
 * チャートの系列に日足とインジケーターを入れる。
 * ライブ更新でも呼ぶ。一目均衡表は最新の足以外の日付にも効くので、部分更新せずに全部入れ直す。
 */
export function fillCellSeries(cell: CellChart, bars: Bar[], ind: Indicators) {
  const times = bars.map((b) => b.date);

  cell.candle.setData(bars.map(({ date, open, high, low, close }) => ({ time: date, open, high, low, close })));

  // 前日より下げた日の出来高は赤、それ以外は緑で塗る
  cell.vol?.setData(
    bars.map((b, i) => {
      const prev = bars[i - 1];

      return { time: b.date, value: b.volume, color: prev && b.close < prev.close ? "rgba(242, 54, 69, 0.3)" : "rgba(8, 153, 129, 0.3)" };
    }),
  );

  for (const l of bbLines(ind)) {
    cell.lines.get(l.key)?.setData(toLinePoints(times, l.values));
  }
  for (const id of MA_IDS) {
    cell.lines.get(id)?.setData(toLinePoints(times, ind[id]));
  }

  if (cell.ichimoku) {
    const g = ind.ichimoku;
    cell.lines.get("tenkan")?.setData(toLinePoints(times, g.tenkan));
    cell.lines.get("kijun")?.setData(toLinePoints(times, g.kijun));

    // 遅行スパン・先行スパンは未来の日付まで伸びるので、一目均衡表の日付で並べる
    for (const id of ["chikou", "spanA", "spanB"] as const) {
      cell.lines.get(id)?.setData(toLinePoints(g.times, g[id]));
    }

    cell.cloud?.setPoints(
      g.times.flatMap((time, k) => {
        const a = g.spanA[k];
        const b = g.spanB[k];

        return a == null || b == null ? [] : [{ time, a, b }];
      }),
    );
  }
}

/**
 * 表示範囲を、1行の表示数に応じた本数の直近の足に合わせる。
 * 一目均衡表を出しているときは、先の雲も見えるように右を空ける。
 */
export function applyVisibleRange(cell: CellChart, barCount: number, columns: number) {
  cell.chart.timeScale().setVisibleLogicalRange({
    from: Math.max(0, barCount - countVisibleBars(columns)),
    to: barCount + (cell.ichimoku ? SHIFT + 2 : 3),
  });
}

/**
 * 判定の印(買い・打診買いの矢印)と、利確 / 損切りの破線を描き直す。
 */
export function applyTradeMarks(cell: CellChart, bars: Bar[], result: JudgeResult | null) {
  const last = bars.at(-1);

  for (const l of cell.priceLines) {
    cell.candle.removePriceLine(l);
  }
  cell.priceLines = [];

  cell.markers.setMarkers(
    result && result.verdict !== "見送り" && last
      ? [{ time: last.date, position: "belowBar", shape: "arrowUp", color: result.verdict === "買い" ? C.up : C.amber, text: result.verdict }]
      : [],
  );

  if (!result) {
    return;
  }

  const addPriceLine = (price: number | null | undefined, color: string, title: string) => {
    if (price == null) {
      return;
    }

    cell.priceLines.push(cell.candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title }));
  };
  for (const t of result.sellPlan.takeProfit) {
    addPriceLine(t.price, C.up, "利確");
  }
  addPriceLine(result.sellPlan.stopLoss.price, C.down, "損切り");
}
