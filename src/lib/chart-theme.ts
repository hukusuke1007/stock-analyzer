import type { Indicators } from "./indicators";
import type { Bar, JudgeResult } from "./types";

// チャートの色とインジケーターの定義。メインチャートと関心銘柄タブのチャートで共通に使う

export const C = {
  bg: "#000000",
  grid: "rgba(42, 46, 57, 0.6)",
  border: "#26262b",
  text: "#d1d4dc",
  muted: "#787b86",
  up: "#089981",
  down: "#f23645",
  amber: "#f7a600",
  blue: "#2962ff",
  crosshairLabel: "#363a45",
};

export type IndicatorId = "ma5" | "ma25" | "ma75" | "ma100" | "bb" | "ichimoku" | "vol" | "rsi" | "rci" | "macd";

// インジケーター。既定の表示は売買ルールが見ている指標に合わせる
export const INDICATORS: { id: IndicatorId; label: string; color: string }[] = [
  { id: "ma5", label: "MA 5", color: "#f7a600" },
  { id: "ma25", label: "MA 25", color: "#2962ff" },
  { id: "ma75", label: "MA 75", color: "#e91e63" },
  { id: "ma100", label: "MA 100", color: "#fdd835" },
  { id: "bb", label: "ボリンジャーバンド (25)", color: "#9c27b0" },
  { id: "ichimoku", label: "一目均衡表 (9, 26, 52)", color: "#26a69a" },
  { id: "vol", label: "出来高", color: "#5d606b" },
  { id: "rsi", label: "RSI (14)", color: "#7e57c2" },
  { id: "rci", label: "RCI (10 / 26)", color: "#00bcd4" },
  { id: "macd", label: "MACD (12, 26, 9)", color: "#2962ff" },
];

export const DEFAULT_INDICATORS: Record<string, IndicatorId[]> = {
  rebound: ["ma25", "ma100", "bb", "ichimoku", "vol", "rci"],
  swing: ["ma25", "ma75", "ma100", "bb", "ichimoku", "vol", "rsi", "macd"],
};

export const MA_IDS = ["ma5", "ma25", "ma75", "ma100"] as const;
export type MaId = (typeof MA_IDS)[number];

/**
 * 移動平均の線の色を返す。
 */
export function maColor(id: MaId): string {
  return INDICATORS.find((d) => d.id === id)!.color;
}

// 一目均衡表の色(TradingView の配色に寄せる。転換線は MA25 の青と区別するため水色)
export const ICHI = {
  tenkan: "#40c4ff",
  kijun: "#e53935",
  chikou: "#66bb6a",
  spanA: "rgba(129, 199, 132, 0.8)",
  spanB: "rgba(229, 115, 115, 0.8)",
  cloudUp: "rgba(8, 153, 129, 0.12)",
  cloudDown: "rgba(242, 54, 69, 0.12)",
};

export const ICHI_LINES = ["spanA", "spanB", "tenkan", "kijun", "chikou"] as const;

// ボリンジャーバンドの線の色
const BB = { mid: "#f48fb1", s1: "#bcaaa4", s2: "#9c27b0", s3: "rgba(156, 39, 176, 0.55)" };

// インジケーターのうち、1本ずつ表示 / 非表示を選べる線
export const SUBLINES: Partial<Record<IndicatorId, { id: string; label: string; color: string }[]>> = {
  bb: [
    { id: "bbMid", label: "中バンド", color: BB.mid },
    { id: "bb1", label: "±1σ", color: BB.s1 },
    { id: "bb2", label: "±2σ", color: BB.s2 },
    { id: "bb3", label: "±3σ", color: BB.s3 },
  ],
  ichimoku: [
    { id: "tenkan", label: "転換線", color: ICHI.tenkan },
    { id: "kijun", label: "基準線", color: ICHI.kijun },
    { id: "spanA", label: "先行スパン1", color: ICHI.spanA },
    { id: "spanB", label: "先行スパン2", color: ICHI.spanB },
    { id: "chikou", label: "遅行スパン", color: ICHI.chikou },
    { id: "cloud", label: "雲", color: "rgba(8, 153, 129, 0.5)" },
  ],
};

// 中バンドは MA25 と同じ線、±1σ は線が多くなるので、最初は隠しておく
export const DEFAULT_HIDDEN_LINES = ["bbMid", "bb1"];

export type BbLine = { key: string; lineId: string; label: string; values: (number | null)[]; color: string; dotted: boolean };

/**
 * ボリンジャーバンドの線を上から順に返す。key は系列の名前、lineId は表示切り替えの id。
 */
export function bbLines(ind: Indicators): BbLine[] {
  return [
    { key: "bbP3", lineId: "bb3", label: "+3σ", values: ind.bb.p3, color: BB.s3, dotted: true },
    { key: "bbP2", lineId: "bb2", label: "+2σ", values: ind.bb.p2, color: BB.s2, dotted: false },
    { key: "bbP1", lineId: "bb1", label: "+1σ", values: ind.bb.p1, color: BB.s1, dotted: false },
    { key: "bbMid", lineId: "bbMid", label: "中バンド", values: ind.bb.mid, color: BB.mid, dotted: false },
    { key: "bbM1", lineId: "bb1", label: "−1σ", values: ind.bb.m1, color: BB.s1, dotted: false },
    { key: "bbM2", lineId: "bb2", label: "−2σ", values: ind.bb.m2, color: BB.s2, dotted: false },
    { key: "bbM3", lineId: "bb3", label: "−3σ", values: ind.bb.m3, color: BB.s3, dotted: true },
  ];
}

// 日足の値を lightweight-charts の線の点にする。値のない足は飛ばす
export function toLinePoints(times: string[], values: (number | null)[]) {
  return times.flatMap((time, k) => {
    const value = values[k];

    return value == null ? [] : [{ time, value }];
  });
}

export type DataWindowRow = { sec: string } | { label: string; color: string; value: number | null | undefined; digits: number };

export type DataWindowOptions = {
  indicators: Set<IndicatorId>;
  isLineVisible: (id: string) => boolean;
  showPrice: boolean;
  showTradeLines: boolean;
  result: JudgeResult | null;
  // 関心銘柄タブのチャートは価格の段だけなので、RSI などは出さない
  pricePaneOnly?: boolean;
};

/**
 * 十字線の日の値を、指標ごとに線と同じ色の名前で一覧する(データ表示)。表示している線の値だけを出す。
 */
export function dataWindowRows(bars: Bar[], ind: Indicators, i: number, o: DataWindowOptions): DataWindowRow[] {
  const b = bars[i]!;
  const rows: DataWindowRow[] = [];
  const section = (label: string) => rows.push({ sec: label });
  const add = (label: string, color: string, value: number | null | undefined, digits = 1) => rows.push({ label, color, value, digits });

  add("始値", C.text, b.open);
  add("高値", C.text, b.high);
  add("安値", C.text, b.low);
  add("終値", C.text, b.close);
  if (i > 0) {
    const prevClose = bars[i - 1]!.close;
    add("前日比", b.close >= prevClose ? C.up : C.down, b.close - prevClose);
  }

  if (o.showPrice || o.pricePaneOnly) {
    if (o.indicators.has("ichimoku")) {
      section("一目均衡表");
      for (const l of SUBLINES.ichimoku!) {
        if (l.id !== "cloud" && o.isLineVisible(l.id)) {
          add(l.label, ICHI[l.id as keyof typeof ICHI], ind.ichimoku[l.id as (typeof ICHI_LINES)[number]][i]);
        }
      }
    }

    const mas = MA_IDS.filter((id) => o.indicators.has(id));
    if (mas.length) {
      section("移動平均");
    }
    for (const id of mas) {
      add(`移動平均 (${id.slice(2)})`, maColor(id), ind[id][i]);
    }

    if (o.indicators.has("bb")) {
      section("ボリンジャーバンド");
      for (const l of bbLines(ind)) {
        if (o.isLineVisible(l.lineId)) {
          // ±3σ の線は半透明なので、文字は不透明にして読めるようにする
          add(l.label, l.color.replace(/0\.55\)$/, "1)"), l.values[i]);
        }
      }
    }

    if (o.indicators.has("vol")) {
      add("出来高", C.muted, b.volume, 0);
    }

    // 判定の利確 / 損切りライン
    const r = o.result;
    if (r && o.showTradeLines) {
      section("売り方");
      r.sellPlan.takeProfit.forEach((t, k) => add(r.sellPlan.takeProfit.length > 1 ? `利確${k + 1}` : "利確", C.up, t.price));
      add("損切り", C.down, r.sellPlan.stopLoss.price);
    }
  }

  if (o.pricePaneOnly) {
    return rows;
  }

  if (o.indicators.has("rsi")) {
    section("RSI (14)");
    add("買われ過ぎ", C.down, 70, 0);
    add("売られ過ぎ", C.blue, 30, 0);
    add("RSI", "#7e57c2", ind.rsi[i]);
  }
  if (o.indicators.has("rci")) {
    section("RCI");
    add("買われ過ぎ", C.down, 80, 0);
    add("売られ過ぎ", C.blue, -80, 0);
    add("RCI (10)", "#00bcd4", ind.rci10[i]);
    add("RCI (26)", "#ff9800", ind.rci26[i]);
  }
  if (o.indicators.has("macd")) {
    section("MACD (12, 26, 9)");
    add("MACD", "#2962ff", ind.macd.line[i], 2);
    add("シグナル", "#ff6d00", ind.macd.signal[i], 2);
    add("MACD差", C.muted, ind.macd.hist[i], 2);
  }

  return rows;
}

// データ表示のカードは、カーソルの左隣に出す。左に入りきらなければ右隣に出す
const DW_GAP = 16; // カーソルとカードの間
const DW_MARGIN = 4; // 端との間

/**
 * データ表示のカードの左端の位置を返す。
 */
export function dataWindowLeft(width: number, x: number, bound: number): number {
  let left = x - DW_GAP - width;
  if (left < DW_MARGIN) {
    left = x + DW_GAP;
  }

  // 右隣でもはみ出すとき(カードが広すぎるとき)は、右端に寄せる
  return Math.max(DW_MARGIN, Math.min(left, bound - width - DW_MARGIN));
}
