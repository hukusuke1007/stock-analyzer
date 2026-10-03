// stock-analyzer のブラウザ UI。TradingView 風のチャート(lightweight-charts)で
// /bars の日足を描き、/judge と /screen の判定結果を重ねて表示する。
import * as LWC from "lightweight-charts";
import { createGridView } from "./grid.js";
import { initSettings } from "./settings.js";
import { CloudPrimitive, ichimoku, SHIFT } from "./ichimoku.js";
import { createSimView } from "./sim.js";
import "./style.css";

const C = {
  bg: "#131722",
  grid: "rgba(42, 46, 57, 0.6)",
  border: "#2a2e39",
  text: "#d1d4dc",
  muted: "#787b86",
  up: "#089981",
  down: "#f23645",
  amber: "#f7a600",
  blue: "#2962ff",
};

// インジケーター。既定の表示は売買ルールが見ている指標に合わせる
const INDICATORS = [
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
const DEFAULT_INDICATORS = {
  rebound: ["ma25", "ma100", "bb", "ichimoku", "vol", "rci"],
  swing: ["ma25", "ma75", "ma100", "bb", "ichimoku", "vol", "rsi", "macd"],
};
// 一目均衡表の色(TradingView の配色に寄せる。転換線は MA25 の青と区別するため水色)
const ICHI = {
  tenkan: "#40c4ff",
  kijun: "#e53935",
  chikou: "#66bb6a",
  spanA: "rgba(129, 199, 132, 0.8)",
  spanB: "rgba(229, 115, 115, 0.8)",
  cloudUp: "rgba(8, 153, 129, 0.12)",
  cloudDown: "rgba(242, 54, 69, 0.12)",
};
const RANK = { 買い: 0, 打診買い: 1, 見送り: 2 };
const LARGE = new Set(["TOPIX Core30", "TOPIX Large70"]);
const DEFAULT_WATCH = ["7203", "6758", "8306", "9432", "6857"];
const MAX_WATCH = 200; // サーバー(PUT /watchlist)の上限と同じ
const PHASES = {
  listing: ["銘柄一覧", 0, 5],
  analyze: ["テクニカル計算", 5, 60],
  judge: ["材料の取得と Decisions 判定", 60, 92],
  rank: ["Codex でランク付け", 92, 100],
};

// 判定に使った Decisions の答え。Jev 時代に保存した結果(r.jev)も同じ形なので読めるようにしておく
const decisionOf = (r) => r?.decision ?? (r?.jev ? { ...r.jev, provider: "jev" } : null);

// ---------- 状態 ----------
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 容量超過やプライベートモードでは保存しない
    }
  },
};

const state = {
  strategies: [],
  strategy: store.get("strategy", "swing"),
  decisions: false, // /health の結果。判定(Decisions)の AI を使えるか
  code: null,
  bars: new Map(), // code -> { name, bars }
  names: new Map(), // code -> JPX の和名(銘柄検索で分かったもの)
  judgments: new Map(), // `${strategy}:${code}` -> { loading } | { result } | { error }
  screens: {}, // strategy -> /screen の result
  scanning: null, // スキャン中の strategy
  watch: [], // 関心銘柄。起動時にサーバーから読む(loadWatch)
  columns: 3, // 関心銘柄タブの1行の表示数(1〜5)
  view: store.get("view", "chart"), // タブ: chart / grid / sim
  news: store.get("news", {}),
  tools: { magnet: false, lines: true },
  showPrice: store.get("showPrice", true), // 価格の段(下の段はインジケーターの選択で決まる)
  range: store.get("range", 132), // 期間ボタン(1M=22 / 3M=66 / 6M=132 / 1Y=0 本)
  options: { earnings: false, news: false, ...store.get("options", {}) }, // テクニカル以外の材料(決算・ニュース)
  hiddenLines: new Set(store.get("hiddenLines", ["bbMid", "bb1"])), // 非表示にした線(SUBLINES の id)
  dataWindow: store.get("dataWindow", true), // カーソル位置の値を一覧する「データ表示」
  sort: { key: null, asc: false },
  filter: { verdicts: new Set(["買い", "打診買い"]), large: false, text: "" },
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const num = (v, d = 1) =>
  v == null || Number.isNaN(v) ? "—" : Number(v).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v, d = 2, unit = "%") => (v == null ? "—" : `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}${unit}`);
const cls = (v) => (v == null || v === 0 ? "" : v > 0 ? "up" : "down");
const tagClass = (v) => ({ 買い: "buy", 打診買い: "probe", 見送り: "pass" })[v] ?? "pending";
const key = (code, strategy = state.strategy) => `${strategy}:${code}`;
const normalizeCode = (s) => s.trim().toUpperCase().replace(/\.T$/, "");
// ボリンジャーバンドの線の色
const BB = { mid: "#f48fb1", s1: "#bcaaa4", s2: "#9c27b0", s3: "rgba(156, 39, 176, 0.55)" };
// インジケーターのうち、1本ずつ表示 / 非表示を選べる線
const SUBLINES = {
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
const lineOn = (id) => !state.hiddenLines.has(id);

// 保存済みのインジケーターの選択に、あとから追加したもの(MA25・MA100・ボリンジャー・一目)を一度だけ足す
const ADDED_2026_09 = ["ma25", "ma100", "bb", "ichimoku"];
function indicatorsFor(strategy) {
  const saved = store.get(`indicators:${strategy}`, null);
  const set = new Set(saved ?? DEFAULT_INDICATORS[strategy] ?? ["ma25", "vol"]);
  if (saved && !store.get(`indicators:${strategy}:added-2026-09`, false)) {
    for (const id of ADDED_2026_09) set.add(id);
    store.set(`indicators:${strategy}`, [...set]);
    store.set(`indicators:${strategy}:added-2026-09`, true);
  }
  return set;
}
let indicators = indicatorsFor(state.strategy);

// 判定結果を探す。/judge と /screen の両方にあれば、新しく判定した方を使う
function judgmentOf(code, strategy = state.strategy) {
  const j = state.judgments.get(key(code, strategy));
  if (j && !j.result) return j; // 判定中 / エラー
  const screen = state.screens[strategy];
  const hit = screen?.results.find((r) => r.code === code);
  if (!hit) return j ?? null;
  const screened = { result: { ...hit, judgedAt: hit.judgedAt ?? screen.scannedAt }, fromScreen: true };
  if (!j) return screened;
  return (j.result.judgedAt ?? "") >= screened.result.judgedAt ? j : screened;
}

// サーバーに保存してある判定結果を読み込む
async function loadSaved(strategy) {
  const saved = await api(`/results?strategy=${encodeURIComponent(strategy)}`);
  for (const r of saved.judgments) {
    const k = key(r.code, strategy);
    if (!state.judgments.has(k)) state.judgments.set(k, { result: r });
  }
  if (saved.screen) state.screens[strategy] = saved.screen;
}

// ---------- API ----------
async function api(path, init) {
  const res = await fetch(path, init);
  // API のパスが開発サーバー(vite.config.ts)のプロキシから漏れていると、JSON でなく index.html が返る
  if (res.ok && !res.headers.get("content-type")?.includes("application/json")) {
    throw new Error(`${path} から JSON が返りませんでした。API サーバーを再起動してください`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

async function loadBars(code) {
  if (!state.bars.has(code)) state.bars.set(code, await api(`/bars/${encodeURIComponent(code)}`));
  return state.bars.get(code);
}

async function runJudge(code, strategy = state.strategy) {
  const k = key(code, strategy);
  state.judgments.set(k, { loading: true });
  refresh(code);
  const news = state.news[code]?.trim();
  try {
    const data = await api("/judge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy, codes: [code], options: state.options, ...(news ? { news: { [code]: news } } : {}) }),
    });
    const result = data.results[0];
    state.judgments.set(k, result ? { result } : { error: data.errors[0]?.error ?? "判定できませんでした" });
  } catch (e) {
    state.judgments.set(k, { error: String(e.message ?? e) });
  }
  refresh(code);
}

// 判定が変わった銘柄に関わる表示だけ描き直す
function refresh(code) {
  renderWatchlist();
  grid.update(code);
  sim.update(code);
  if (code === state.code) {
    renderDetail();
    applyTradeLines();
    updateLegend();
  }
}

// ---------- チャート ----------
const series = {};
let chart = null;
let candle = null;
let markers = null;
let priceLines = [];
let cloud = null; // 一目均衡表の雲
const MA_IDS = ["ma5", "ma25", "ma75", "ma100"];

const sma = (v, n) =>
  v.map((_, i) => (i < n - 1 ? null : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));

function stdev(v, n) {
  const m = sma(v, n);
  return v.map((_, i) => (m[i] === null ? null : Math.sqrt(v.slice(i - n + 1, i + 1).reduce((a, x) => a + (x - m[i]) ** 2, 0) / n)));
}

// サーバー(src/technicals.ts)と同じ定義: 先頭 n 本の単純平均を初期値にした EMA
function ema(v, n, start = 0) {
  const out = new Array(v.length).fill(null);
  if (v.length - start < n) return out;
  const k = 2 / (n + 1);
  out[start + n - 1] = v.slice(start, start + n).reduce((a, b) => a + b, 0) / n;
  for (let i = start + n; i < v.length; i++) out[i] = v[i] * k + out[i - 1] * (1 - k);
  return out;
}

function rsiSeries(v, n = 14) {
  const out = new Array(v.length).fill(null);
  if (v.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i] - v[i - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < v.length; i++) {
    const d = v[i] - v[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function rciSeries(v, n) {
  return v.map((_, end) => {
    if (end < n - 1) return null;
    const w = v.slice(end - n + 1, end + 1);
    const order = w.map((x, i) => ({ x, i })).sort((a, b) => b.x - a.x || a.i - b.i);
    let d2 = 0;
    order.forEach(({ i }, rank) => (d2 += (n - i - (rank + 1)) ** 2));
    return (1 - (6 * d2) / (n ** 3 - n)) * 100;
  });
}

function macdSeries(v) {
  const fast = ema(v, 12);
  const slow = ema(v, 26);
  const line = v.map((_, i) => (slow[i] === null ? null : fast[i] - slow[i]));
  const signal = ema(line.map((x) => x ?? 0), 9, 25);
  return { line, signal, hist: line.map((m, i) => (m === null || signal[i] === null ? null : m - signal[i])) };
}

function computeIndicators(bars) {
  const close = bars.map((b) => b.close);
  const ma25 = sma(close, 25);
  const sd25 = stdev(close, 25);
  const band = (k) => ma25.map((m, i) => (m === null ? null : m + k * sd25[i]));
  return {
    ma5: sma(close, 5),
    ma25,
    ma75: sma(close, 75),
    ma100: sma(close, 100),
    ichimoku: ichimoku(bars),
    bb: { mid: ma25, p1: band(1), m1: band(-1), p2: band(2), m2: band(-2), p3: band(3), m3: band(-3) },
    rsi: rsiSeries(close),
    rci10: rciSeries(close, 10),
    rci26: rciSeries(close, 26),
    macd: macdSeries(close),
  };
}

const toLine = (bars, values) =>
  bars.flatMap((b, i) => (values[i] === null || values[i] === undefined ? [] : [{ time: b.date, value: values[i] }]));

function buildChart() {
  const el = $("#chart");
  const bars = state.bars.get(state.code)?.bars;
  const prevRange = chart?.timeScale().getVisibleLogicalRange();
  chart?.remove();
  chart = null;
  candle = null;
  markers = null;
  cloud = null;
  priceLines = [];
  for (const k of Object.keys(series)) delete series[k];
  $("#chart-empty").hidden = Boolean(bars);
  if (!bars) return;

  chart = LWC.createChart(el, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: C.bg },
      textColor: C.text,
      fontFamily: getComputedStyle(document.body).fontFamily,
      fontSize: 11,
      // ロゴは出さない。帰属表示は期間ボタンの並びの右端のリンクで行う(ライセンス上ページのどこかに必要)
      attributionLogo: false,
      panes: { separatorColor: C.border, separatorHoverColor: "rgba(41, 98, 255, 0.3)" },
    },
    grid: { vertLines: { color: C.grid }, horzLines: { color: C.grid } },
    crosshair: {
      mode: state.tools.magnet ? LWC.CrosshairMode.MagnetOHLC : LWC.CrosshairMode.Normal,
      vertLine: { color: C.muted, labelBackgroundColor: "#363a45" },
      horzLine: { color: C.muted, labelBackgroundColor: "#363a45" },
    },
    rightPriceScale: { borderColor: C.border },
    timeScale: { borderColor: C.border, rightOffset: 6 },
    localization: { locale: "ja-JP", dateFormat: "yyyy/MM/dd" },
  });

  const ind = computeIndicators(bars);
  const price = { type: "price", precision: 1, minMove: 0.1 };
  const line = (color, opts = {}, pane = 0) =>
    chart.addSeries(
      LWC.LineSeries,
      { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: price, ...opts },
      pane,
    );

  // 価格の段(ローソク足・移動平均・ボリンジャーバンド・出来高)。非表示なら下の段だけ描く
  if (state.showPrice) buildPricePane(bars, ind, price, line);

  // 下の段(RSI / RCI / MACD)
  let pane = state.showPrice ? 0 : -1;
  const level = (s, value, color, style = LWC.LineStyle.Dashed) =>
    s.createPriceLine({ price: value, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false });
  if (indicators.has("rsi")) {
    pane++;
    series.rsi = line("#7e57c2", { lineWidth: 2, lastValueVisible: true, priceFormat: { type: "price", precision: 1, minMove: 0.1 } }, pane);
    series.rsi.setData(toLine(bars, ind.rsi));
    level(series.rsi, 70, C.muted);
    level(series.rsi, 30, C.muted);
    if (state.strategy === "swing") {
      level(series.rsi, 60, "rgba(41, 98, 255, 0.5)", LWC.LineStyle.Dotted);
      level(series.rsi, 40, "rgba(41, 98, 255, 0.5)", LWC.LineStyle.Dotted);
    }
  }
  if (indicators.has("rci")) {
    pane++;
    series.rci10 = line("#00bcd4", { lineWidth: 2, lastValueVisible: true }, pane);
    series.rci26 = line("#ff9800", {}, pane);
    series.rci10.setData(toLine(bars, ind.rci10));
    series.rci26.setData(toLine(bars, ind.rci26));
    level(series.rci10, 80, C.muted);
    level(series.rci10, -80, C.muted);
    level(series.rci10, -90, "rgba(242, 54, 69, 0.6)", LWC.LineStyle.Dotted);
  }
  if (indicators.has("macd")) {
    pane++;
    const m = ind.macd;
    series.macdHist = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false, priceFormat: { type: "price", precision: 2, minMove: 0.01 } }, pane);
    series.macdHist.setData(
      bars.flatMap((b, i) =>
        m.hist[i] === null
          ? []
          : [{ time: b.date, value: m.hist[i], color: m.hist[i] >= 0 ? "rgba(8, 153, 129, 0.55)" : "rgba(242, 54, 69, 0.55)" }],
      ),
    );
    series.macd = line("#2962ff", { lineWidth: 2, lastValueVisible: true, priceFormat: { type: "price", precision: 2, minMove: 0.01 } }, pane);
    series.macdSignal = line("#ff6d00", { priceFormat: { type: "price", precision: 2, minMove: 0.01 } }, pane);
    series.macd.setData(toLine(bars, m.line));
    series.macdSignal.setData(toLine(bars, m.signal));
  }
  // 価格の段を広めに取る。下の段どうしは同じ高さ
  const panes = chart.panes();
  for (const p of panes) p.setStretchFactor(1);
  if (state.showPrice) panes[0]?.setStretchFactor(pane === 0 ? 1 : pane === 1 ? 3 : 2.4);

  chart.subscribeCrosshairMove((param) => {
    updateLegend(param.logical);
    updateDataWindow(param);
  });
  if (prevRange && prevRange.from !== undefined && state.lastCode === state.code) {
    chart.timeScale().setVisibleLogicalRange(prevRange);
  } else {
    applyRange();
  }
  state.lastCode = state.code;
  applyTradeLines();
  updateLegend();
}

function buildPricePane(bars, ind, price, line) {
  if (indicators.has("vol")) {
    series.vol = chart.addSeries(LWC.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false }, 0);
    series.vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    series.vol.setData(
      bars.map((b, i) => ({
        time: b.date,
        value: b.volume,
        color: i > 0 && b.close < bars[i - 1].close ? "rgba(242, 54, 69, 0.35)" : "rgba(8, 153, 129, 0.35)",
      })),
    );
  }
  if (indicators.has("bb")) {
    for (const [key, id, values, color, dotted] of bbLines(ind)) {
      if (!lineOn(id)) continue;
      series[key] = line(color, dotted ? { lineStyle: LWC.LineStyle.Dotted } : {});
      series[key].setData(toLine(bars, values));
    }
  }

  candle = chart.addSeries(LWC.CandlestickSeries, {
    upColor: C.up,
    downColor: C.down,
    borderVisible: false,
    wickUpColor: C.up,
    wickDownColor: C.down,
    priceFormat: price,
  });
  candle.setData(bars.map(({ date, open, high, low, close }) => ({ time: date, open, high, low, close })));
  markers = LWC.createSeriesMarkers(candle, []);

  for (const id of MA_IDS) {
    if (!indicators.has(id)) continue;
    series[id] = line(INDICATORS.find((x) => x.id === id).color, { lineWidth: 2 });
    series[id].setData(toLine(bars, ind[id]));
  }

  if (indicators.has("ichimoku")) {
    for (const id of ["spanA", "spanB", "tenkan", "kijun", "chikou"]) if (lineOn(id)) series[id] = line(ICHI[id]);
    // 雲は先行スパンを隠していても塗れるよう、ローソク足に付ける
    if (lineOn("cloud")) {
      cloud = new CloudPrimitive({ up: ICHI.cloudUp, down: ICHI.cloudDown });
      candle.attachPrimitive(cloud);
    }
    setIchimokuData(ind.ichimoku);
  }
}

// ボリンジャーバンドの線: [series のキー, 表示切り替えの id, 値, 色, 点線か]
const bbLines = (ind) => [
  ["bbP3", "bb3", ind.bb.p3, BB.s3, true],
  ["bbP2", "bb2", ind.bb.p2, BB.s2, false],
  ["bbP1", "bb1", ind.bb.p1, BB.s1, false],
  ["bbMid", "bbMid", ind.bb.mid, BB.mid, false],
  ["bbM1", "bb1", ind.bb.m1, BB.s1, false],
  ["bbM2", "bb2", ind.bb.m2, BB.s2, false],
  ["bbM3", "bb3", ind.bb.m3, BB.s3, true],
];

// 一目均衡表は先行スパン(未来)と遅行スパン(過去)があるので、足の日付に未来の日付を足した times で描く
function setIchimokuData(ichi) {
  const toExt = (values) => ichi.times.flatMap((time, k) => (values[k] == null ? [] : [{ time, value: values[k] }]));
  for (const id of ["tenkan", "kijun", "chikou", "spanA", "spanB"]) series[id]?.setData(toExt(ichi[id]));
  cloud?.setPoints(
    ichi.times.flatMap((time, k) => (ichi.spanA[k] == null || ichi.spanB[k] == null ? [] : [{ time, a: ichi.spanA[k], b: ichi.spanB[k] }])),
  );
}

function applyRange() {
  const n = state.bars.get(state.code)?.bars.length;
  if (!chart || !n) return;
  if (state.range === 0) chart.timeScale().fitContent();
  // 一目均衡表を出しているときは、先の雲も見えるように右を空ける
  else chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - state.range), to: n + (indicators.has("ichimoku") ? SHIFT + 2 : 5) });
}

// 利確・損切りのラインと、判定のマーカーを重ねる
function applyTradeLines() {
  if (!candle) return;
  for (const l of priceLines) candle.removePriceLine(l);
  priceLines = [];
  const bars = state.bars.get(state.code)?.bars;
  const r = judgmentOf(state.code)?.result;
  markers?.setMarkers(
    r && r.verdict !== "見送り" && bars
      ? [{ time: bars.at(-1).date, position: "belowBar", shape: "arrowUp", color: r.verdict === "買い" ? C.up : C.amber, text: r.verdict }]
      : [],
  );
  if (!r || !state.tools.lines) return;
  const add = (price, color, title) =>
    price != null &&
    priceLines.push(candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title }));
  r.sellPlan.takeProfit.forEach((t, i) => add(t.price, C.up, r.sellPlan.takeProfit.length > 1 ? `利確${i + 1}` : "利確"));
  add(r.sellPlan.stopLoss.price, C.down, "損切り");
}

function updateLegend(logical) {
  const el = $("#legend");
  const data = state.bars.get(state.code);
  if (!data) {
    el.innerHTML = "";
    return;
  }
  const { bars } = data;
  const i = logical == null ? bars.length - 1 : Math.max(0, Math.min(bars.length - 1, Math.round(logical)));
  const b = bars[i];
  const prev = bars[i - 1];
  const chg = prev ? (b.close / prev.close - 1) * 100 : null;
  const c = cls(chg);
  const j = judgmentOf(state.code);
  const ind = indicatorsCached(bars);
  const val = (label, color, v, d = 1) => `<span><b>${label}</b><span style="color:${color}">${num(v, d)}</span></span>`;
  const rows = [];
  // データ表示がオンのときは、指標の値はそちらに出すので凡例は四本値まで
  if (!state.dataWindow) legendRows(rows, ind, i, b, val);

  const verdict = j?.result ? `<span class="tag ${tagClass(j.result.verdict)} verdict-tag">${esc(j.result.verdict)}</span>` : "";
  el.innerHTML = `
    <div class="title">${esc(state.code)}<small>${esc(displayName(state.code))} · 日足 · 東証</small>${verdict}</div>
    <div class="row ${c}">
      <span><b>日付</b>${esc(b.date)}</span>
      <span><b>始</b>${num(b.open)}</span><span><b>高</b>${num(b.high)}</span>
      <span><b>安</b>${num(b.low)}</span><span><b>終</b>${num(b.close)}</span>
      <span>${chg == null ? "" : `${signed(b.close - prev.close, 1, "")} (${signed(chg)})`}</span>
    </div>
    ${rows.map((r) => `<div class="row">${r}</div>`).join("")}`;
}

// ---------- データ表示 ----------
// 十字線の日の値を、指標ごとに線と同じ色の名前で一覧する。表示している線の値だけを出す
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

// code: 利確 / 損切りを出す銘柄。pricePaneOnly: 関心銘柄タブのチャートは価格の段だけなので、RSI などを出さない
function dataWindowRows(bars, ind, i, { code = state.code, pricePaneOnly = false } = {}) {
  const b = bars[i];
  const rows = [];
  const sec = (label) => rows.push({ sec: label });
  const add = (label, color, value, digits = 1) => rows.push({ label, color, value, digits });

  add("始値", C.text, b.open);
  add("高値", C.text, b.high);
  add("安値", C.text, b.low);
  add("終値", C.text, b.close);
  if (i > 0) add("前日比", b.close >= bars[i - 1].close ? C.up : C.down, b.close - bars[i - 1].close);
  if (state.showPrice || pricePaneOnly) {
    if (indicators.has("ichimoku")) {
      sec("一目均衡表");
      const g = ind.ichimoku;
      for (const l of SUBLINES.ichimoku) if (l.id !== "cloud" && lineOn(l.id)) add(l.label, ICHI[l.id], g[l.id][i]);
    }
    const mas = MA_IDS.filter((id) => indicators.has(id));
    if (mas.length) sec("移動平均");
    for (const id of mas) add(`移動平均 (${id.slice(2)})`, INDICATORS.find((d) => d.id === id).color, ind[id][i]);
    if (indicators.has("bb")) {
      sec("ボリンジャーバンド");
      for (const [key, id, values, color] of bbLines(ind)) {
        if (!lineOn(id)) continue;
        const label = { bbP3: "+3σ", bbP2: "+2σ", bbP1: "+1σ", bbMid: "中バンド", bbM1: "−1σ", bbM2: "−2σ", bbM3: "−3σ" }[key];
        add(label, color.replace(/0\.55\)$/, "1)"), values[i]);
      }
    }
    if (indicators.has("vol")) add("出来高", C.muted, b.volume, 0);
    // 判定の利確 / 損切りライン
    const r = judgmentOf(code)?.result;
    if (r && state.tools.lines) {
      sec("売り方");
      r.sellPlan.takeProfit.forEach((t, k) => add(r.sellPlan.takeProfit.length > 1 ? `利確${k + 1}` : "利確", C.up, t.price));
      add("損切り", C.down, r.sellPlan.stopLoss.price);
    }
  }
  if (pricePaneOnly) return rows;
  if (indicators.has("rsi")) {
    sec("RSI (14)");
    add("買われ過ぎ", C.down, 70, 0);
    add("売られ過ぎ", C.blue, 30, 0);
    add("RSI", "#7e57c2", ind.rsi[i]);
  }
  if (indicators.has("rci")) {
    sec("RCI");
    add("買われ過ぎ", C.down, 80, 0);
    add("売られ過ぎ", C.blue, -80, 0);
    add("RCI (10)", "#00bcd4", ind.rci10[i]);
    add("RCI (26)", "#ff9800", ind.rci26[i]);
  }
  if (indicators.has("macd")) {
    sec("MACD (12, 26, 9)");
    add("MACD", "#2962ff", ind.macd.line[i], 2);
    add("シグナル", "#ff6d00", ind.macd.signal[i], 2);
    add("MACD差", C.muted, ind.macd.hist[i], 2);
  }
  return rows;
}

function updateDataWindow(param) {
  const el = $("#data-window");
  const bars = state.bars.get(state.code)?.bars;
  if (!state.dataWindow || !bars || !param?.point || param.logical == null) {
    el.hidden = true;
    $("#legend").classList.remove("covered");
    return;
  }
  const i = Math.max(0, Math.min(bars.length - 1, Math.round(param.logical)));
  // 出しているあいだは日付・四本値もこちらにあるので、左上の凡例は隠して上端から使う
  $("#legend").classList.add("covered");
  fillDataWindow(el, bars, i, dataWindowRows(bars, indicatorsCached(bars), i), displayName(state.code));
  el.style.left = `${dataWindowLeft(el.offsetWidth, param.point.x, $(".chart-wrap").clientWidth)}px`;
}

// カードの中身を入れて表示する。縦に収まらないときは、名前と値の組を2列(それでも収まらなければ3列)に並べる
function fillDataWindow(el, bars, i, rows, name) {
  const d = new Date(`${bars[i].date}T00:00:00Z`);
  el.innerHTML = `
    <div class="dw-date"><span class="dw-name">${esc(name)}</span>${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEK[d.getUTCDay()]})</div>
    <div class="dw-grid">${rows
      .map((r) =>
        r.sec
          ? `<div class="dw-sec">${esc(r.sec)}</div>`
          : `<span class="dw-k" style="color:${r.color}">${esc(r.label)}</span><span class="dw-v">${num(r.value, r.digits)}</span>`,
      )
      .join("")}</div>`;
  el.hidden = false;
  const grid = el.querySelector(".dw-grid");
  if (el.scrollHeight > el.clientHeight) grid.classList.add("wide");
  if (el.scrollHeight > el.clientHeight) grid.classList.replace("wide", "wide3");
}

// カードはカーソルの左隣に出す。左に入りきらなければ右隣に出す
const DW_GAP = 16; // カーソルとカードの間
const DW_MARGIN = 4; // 端との間
function dataWindowLeft(width, x, bound) {
  let left = x - DW_GAP - width;
  if (left < DW_MARGIN) left = x + DW_GAP;
  // 右隣でもはみ出すとき(カードが広すぎるとき)は、右端に寄せる
  return Math.max(DW_MARGIN, Math.min(left, bound - width - DW_MARGIN));
}

function renderDataWindowToggle() {
  for (const b of document.querySelectorAll(".dw-toggle")) b.classList.toggle("active", state.dataWindow);
}

// 表示中の銘柄のインジケーター(十字線を動かすたびに計算し直さないよう、日足が変わるまで使い回す)
function indicatorsCached(bars) {
  if (state.legendCache?.code === state.code && state.legendCache.len === bars.length) return state.legendCache;
  return (state.legendCache = { code: state.code, len: bars.length, ...computeIndicators(bars) });
}

function legendRows(rows, ind, i, b, val) {
  const ma = MA_IDS.filter((x) => indicators.has(x)).map((x) => {
    const def = INDICATORS.find((d) => d.id === x);
    return val(def.label, def.color, ind[x][i]);
  });
  if (indicators.has("bb")) ma.push(val("BB +2σ", "#9c27b0", ind.bb.p2[i]), val("−2σ", "#9c27b0", ind.bb.m2[i]));
  if (state.showPrice && ma.length) rows.push(ma.join(""));
  if (state.showPrice && indicators.has("ichimoku")) {
    const g = ind.ichimoku;
    rows.push(
      [
        ["tenkan", "転換"],
        ["kijun", "基準"],
        ["spanA", "先行1"],
        ["spanB", "先行2"],
        ["chikou", "遅行"],
      ]
        .filter(([id]) => lineOn(id))
        .map(([id, label]) => val(label, ICHI[id], g[id][i]))
        .join(""),
    );
  }
  const sub = [];
  if (indicators.has("rsi")) sub.push(val("RSI", "#7e57c2", ind.rsi[i]));
  if (indicators.has("rci")) sub.push(val("RCI10", "#00bcd4", ind.rci10[i]), val("RCI26", "#ff9800", ind.rci26[i]));
  if (indicators.has("macd")) sub.push(val("MACD", "#2962ff", ind.macd.line[i], 2), val("Signal", "#ff6d00", ind.macd.signal[i], 2));
  if (state.showPrice && indicators.has("vol")) sub.push(`<span><b>Vol</b>${b.volume.toLocaleString("ja-JP")}</span>`);
  if (sub.length) rows.push(sub.join(""));
}

// 銘柄名はスクリーナーの結果(JPX の和名)を優先し、なければ Yahoo の英名
function displayName(code) {
  for (const s of Object.values(state.screens)) {
    const hit = s.results.find((r) => r.code === code);
    if (hit) return hit.name;
  }
  if (state.names.has(code)) return state.names.get(code);
  return state.bars.get(code)?.name ?? judgmentOf(code)?.result?.name ?? "";
}

// ---------- 銘柄の選択 ----------
async function select(code) {
  code = normalizeCode(code);
  if (!/^[0-9A-Z]{4}$/.test(code)) {
    flash(`証券コードの形式ではありません: ${code}`);
    return;
  }
  state.code = code;
  history.replaceState(null, "", `#${code}`);
  syncStar();
  renderWatchlist();
  renderDetail();
  highlightScreenRow();
  try {
    await loadBars(code);
  } catch (e) {
    if (state.code !== code) return;
    state.bars.delete(code);
    buildChart();
    renderDetail(String(e.message ?? e));
    return;
  }
  if (state.code !== code) return;
  buildChart();
  renderWatchlist();
  // 保存済みの判定がない、または前の営業日の終値で判定したものなら判定し直す
  const j = judgmentOf(code);
  const latest = state.bars.get(code).bars.at(-1).date;
  if (!j || (j.result && j.result.asOf < latest)) runJudge(code);
  else renderDetail();
}

// ---------- リアルタイム更新 ----------
// 取引時間中は1分ごとに日足を取り直し、当日の足(と、それから計算するインジケーター)を差し替える。
// Yahoo Finance の東証の株価は約20分遅れ。判定(利確 / 損切りライン)は自動では出し直さない
const LIVE_INTERVAL = 60_000;
let liveBusy = false;
let liveAt = null;

// 東証の取引時間(平日 9:00〜15:30)。引け後の確定値も拾えるよう少し余裕を持たせる
function marketOpen(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const day = jst.getUTCDay();
  const m = jst.getUTCHours() * 60 + jst.getUTCMinutes();
  return day !== 0 && day !== 6 && m >= 9 * 60 && m <= 15 * 60 + 45;
}

// 取り直して、最新の足が変わっていたら true
async function refreshBars(code) {
  const fresh = await api(`/bars/${encodeURIComponent(code)}`);
  const a = state.bars.get(code)?.bars.at(-1);
  const b = fresh.bars.at(-1);
  state.bars.set(code, fresh);
  return !a || a.date !== b.date || a.close !== b.close || a.high !== b.high || a.low !== b.low || a.volume !== b.volume;
}

async function liveTick(force = false) {
  if (liveBusy || document.hidden || (!force && !marketOpen())) {
    renderLiveStatus();
    return;
  }
  liveBusy = true;
  renderLiveStatus();
  // チャートの銘柄・シミュレーターの注文欄の銘柄・関心銘柄
  const queue = [...new Set([state.code, sim.orderCode(), ...state.watch].filter(Boolean))];
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift();
      try {
        if (await refreshBars(code)) onBarsUpdated(code);
      } catch {
        // 取れなかった銘柄は前の値のまま
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  liveBusy = false;
  liveAt = new Date();
  renderLiveStatus();
  if (state.view === "sim") sim.load(); // 保有株の現在値と含み損益を出し直す
}

function onBarsUpdated(code) {
  renderWatchlist();
  grid.applyBars(code);
  sim.update(code);
  if (code !== state.code) return;
  updateChartLast();
  state.legendCache = null;
  updateLegend();
  updateDetailPrice();
}

// メインチャートの最新の足だけを差し替える(作り直すと表示位置や十字線がリセットされるため)
function updateChartLast() {
  const bars = state.bars.get(state.code)?.bars;
  if (!chart || !bars) return;
  const i = bars.length - 1;
  const b = bars[i];
  const time = b.date;
  const ind = computeIndicators(bars);
  const put = (s, value, extra = {}) => s && value != null && s.update({ time, value, ...extra });
  candle?.update({ time, open: b.open, high: b.high, low: b.low, close: b.close });
  put(series.vol, b.volume, {
    color: i > 0 && b.close < bars[i - 1].close ? "rgba(242, 54, 69, 0.35)" : "rgba(8, 153, 129, 0.35)",
  });
  for (const id of MA_IDS) put(series[id], ind[id][i]);
  // 一目均衡表は先行・遅行スパンが最新の足以外の日付にも効くので、まとめて描き直す
  if (indicators.has("ichimoku") && state.showPrice) setIchimokuData(ind.ichimoku);
  for (const [key, , values] of bbLines(ind)) put(series[key], values[i]);
  put(series.rsi, ind.rsi[i]);
  put(series.rci10, ind.rci10[i]);
  put(series.rci26, ind.rci26[i]);
  put(series.macd, ind.macd.line[i]);
  put(series.macdSignal, ind.macd.signal[i]);
  const h = ind.macd.hist[i];
  put(series.macdHist, h, { color: h >= 0 ? "rgba(8, 153, 129, 0.55)" : "rgba(242, 54, 69, 0.55)" });
}

// 判定の詳細は描き直すとニュースの入力中の文字が消えるので、価格の部分だけ書き換える
function updateDetailPrice() {
  const bars = state.bars.get(state.code)?.bars;
  const last = bars?.at(-1);
  const prev = bars?.at(-2);
  if (!last || !prev) return;
  const chg = (last.close / prev.close - 1) * 100;
  const lastEl = document.querySelector(".d-price .last");
  const chgEl = document.querySelector(".d-price .chg");
  if (!lastEl || !chgEl) return;
  lastEl.textContent = num(last.close);
  chgEl.textContent = `${signed(last.close - prev.close, 1, "")} (${signed(chg)})`;
  chgEl.className = `chg ${cls(chg)}`;
  $("#asof").textContent = `${last.date} ${marketOpen() ? "現在値" : "終値"} · 日足`;
}

function renderLiveStatus() {
  const el = $("#live-status");
  const at = liveAt ? liveAt.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : null;
  if (marketOpen()) {
    el.className = "status live";
    el.textContent = liveBusy ? "● 更新中…" : `● ライブ${at ? ` ${at} 更新` : ""}`;
  } else {
    el.className = "status";
    el.textContent = `取引時間外${at ? ` · ${at} 更新` : ""}`;
  }
}

function startLive() {
  setInterval(liveTick, LIVE_INTERVAL);
  // 別のタブから戻ってきたら、すぐに取り直す
  document.addEventListener("visibilitychange", () => !document.hidden && liveTick());
  $("#live-status").addEventListener("click", () => liveTick(true));
  renderLiveStatus();
}

function flash(msg) {
  const el = $("#ai-status");
  const prev = [el.textContent, el.className];
  el.textContent = msg;
  el.className = "status err";
  setTimeout(() => ([el.textContent, el.className] = prev), 2500);
}

// ---------- AI の状態(上部バー) ----------
// 判定に使う AI とランク付けの Codex が使えるか。設定を変えたら取り直す
async function loadHealth() {
  try {
    const h = await api("/health");
    const d = h.decisions;
    state.decisions = d.available;
    $("#ai-status").textContent = `判定: ${d.provider === "jev" ? "Jev" : "Codex"}${d.available ? "" : "(未接続)"} / ランク: Codex${h.codex ? "" : "(未接続)"}`;
    $("#ai-status").title = [
      `判定(Decisions): ${d.label}${d.provider === "codex" ? ` ${h.codexModel}` : ""}${d.available ? "" : " — 使えないので数値条件だけで判定"}`,
      `ランク付け: Codex ${h.codexModel}${h.codex ? "" : " — 使えないので判定順に並べる"}`,
      "クリックで設定を開く",
    ].join("\n");
    $("#ai-status").className = `status ${d.available && h.codex ? "on" : "off"}`;
  } catch {
    $("#ai-status").textContent = "サーバーに接続できません";
    $("#ai-status").className = "status err";
  }
}

// ---------- 右パネル: 判定の詳細 ----------
function renderDetail(loadError) {
  const el = $("#detail");
  const code = state.code;
  if (!code) {
    el.innerHTML = `<div class="empty">銘柄を選ぶと、${esc(strategyLabel())}の判定が表示されます</div>`;
    return;
  }
  const data = state.bars.get(code);
  const bars = data?.bars;
  const last = bars?.at(-1);
  const prev = bars?.at(-2);
  const chg = last && prev ? (last.close / prev.close - 1) * 100 : null;
  const j = judgmentOf(code);
  const r = j?.result;

  let verdictHtml;
  if (loadError) verdictHtml = `<div class="verdict-card"><div class="error">${esc(loadError)}</div></div>`;
  else if (!j && data)
    // 結果をクリアした直後など。日足は取れているが判定がない
    verdictHtml = `<div class="verdict-card"><div class="reason">判定結果はありません。上の「判定」で調べます</div></div>`;
  else if (!j || j.loading)
    verdictHtml = `<div class="verdict-card"><div class="loading"><div class="spinner"></div>${state.decisions ? "AI に判定を問い合わせ中…" : "判定中…"}</div></div>`;
  else if (j.error) verdictHtml = `<div class="verdict-card"><div class="error">${esc(j.error)}</div></div>`;
  else
    verdictHtml = `
      <div class="verdict-card ${tagClass(r.verdict)}">
        <div class="v"><strong>${esc(r.verdict)}</strong><span class="sat">条件 ${esc(r.satisfied)} · ${esc(r.asOf)} 終値</span></div>
        <div class="reason">${esc(r.reason)}${j.fromScreen ? "(スクリーナーの結果)" : ""}</div>
        ${r.judgedAt ? `<div class="reason">${esc(new Date(r.judgedAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }))} に判定・保存</div>` : ""}
        <div class="reason">材料: ${esc(optionsLabel(r.options))}${
          sameOptions(r.options) ? "" : ` <span class="warn">(今の材料の設定と違います。「判定」で出し直せます)</span>`
        }</div>
      </div>`;

  const checks = r
    ? `<div class="d-sec"><h4>買いの条件</h4><ul class="checks">${r.checks
        .map(
          (c) => `<li class="${c.ok ? "ok" : "ng"}"><span class="mark">${c.ok ? "✓" : "✗"}</span><div>
            <div class="lbl">${esc(c.label)}</div><div class="val">${esc(c.value)}</div><div class="crit">基準 ${esc(c.criterion)}</div></div></li>`,
        )
        .join("")}</ul></div>`
    : "";

  const plan = r?.sellPlan;
  const planHtml = plan
    ? `<div class="d-sec"><h4>売り方</h4>
        <div class="plan">
          ${plan.takeProfit
            .map(
              (t, i) => `<div class="box tp"><div class="k">利確${plan.takeProfit.length > 1 ? i + 1 : ""}</div>
                <div class="p">${num(t.price)}</div><div class="w"><span class="${cls(t.pct)}">${signed(t.pct)}</span> ${esc(t.when)}</div></div>`,
            )
            .join("")}
          <div class="box sl"><div class="k">損切り</div><div class="p">${num(plan.stopLoss.price)}</div>
            <div class="w"><span class="${cls(plan.stopLoss.pct)}">${signed(plan.stopLoss.pct)}</span> ${esc(plan.stopLoss.when)}</div></div>
        </div>
        <div class="plan-meta"><span>R/R <b>${plan.riskReward ?? "—"}</b></span><span>保有 <b>${esc(plan.holdingPeriod)}</b></span>
          <span>100株 <b>${num(r.technicals.costFor100Shares, 0)}円</b></span></div>
        <ul class="signals">${plan.signals.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
      </div>`
    : "";

  const dec = decisionOf(r);
  const bar = (label, p, color) =>
    `<div class="pr"><span>${esc(label)}</span><div class="track"><div class="fill" style="width:${Math.round(p * 100)}%;background:${color}"></div></div><span class="pv">${Math.round(p * 100)}%</span></div>`;
  const decisionHtml = r
    ? `<div class="d-sec probs"><h4>Decisions</h4>${
        dec
          ? bar("買い", dec.verdictProbabilities.買い, C.up) +
            bar("打診買い", dec.verdictProbabilities.打診買い, C.amber) +
            bar("見送り", dec.verdictProbabilities.見送り, C.muted) +
            bar(dec.qualitative.label, dec.qualitative.probability, C.blue) +
            (dec.badNews == null ? "" : bar("悪材料", dec.badNews, C.down)) +
            `<div class="model">${esc(dec.provider === "jev" ? "Jev" : "Codex")} / model: ${esc(dec.model)}</div>`
          : `<div class="muted" style="font-size:12px">Decisions を使えないため、数値条件だけで判定しています</div>`
      }</div>`
    : "";
  // Codex App Server のランク付け(複数銘柄をまとめて判定・スキャンしたときだけ付く)
  const rankHtml = r?.ranking
    ? `<div class="d-sec"><h4>Codex ランキング</h4>
        <div class="plan-meta"><span>順位 <b>${r.ranking.rank}位</b></span><span>スコア <b>${Math.round(r.ranking.score)}</b></span></div>
        <div class="reason">${esc(r.ranking.reason)}</div></div>`
    : "";

  const materialsHtml = r ? renderMaterials(r) : "";

  const concerns = r?.concerns?.length
    ? `<div class="d-sec"><h4>懸念点</h4><ul class="signals">${r.concerns.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
    : "";

  const chartUrl = r?.chartUrl ?? `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T/chart`;
  el.innerHTML = `
    <div class="d-head"><span class="code">${esc(code)}</span><span class="tag pass">${esc(strategyLabel(true))}</span>
      <div class="spacer"></div><button id="sim-btn" class="star" type="button" title="株シミュレーターでこの銘柄を仮想売買します(売買ダイアログ)">売買</button>
      <button id="watch-star" class="star" type="button"></button></div>
    <div class="d-name">${esc(displayName(code))}</div>
    <div class="d-price"><span class="last">${num(last?.close)}</span><span class="chg ${cls(chg)}">${
      last && prev ? `${signed(last.close - prev.close, 1, "")} (${signed(chg)})` : ""
    }</span></div>
    ${verdictHtml}
    ${checks}
    ${planHtml}
    ${materialsHtml}
    ${rankHtml}
    ${decisionHtml}
    ${concerns}
    <div class="d-sec news"><h4>ニュース(材料)</h4>
      <textarea id="news-input" placeholder="調べたニュースを貼ると、Decisions が悪材料かどうかも判定します">${esc(state.news[code] ?? "")}</textarea>
      <div class="row">
        <button id="rejudge" class="tb-btn primary small" type="button" ${j?.loading ? "disabled" : ""}>${
          state.news[code]?.trim() ? "ニュース込みで再判定" : "再判定"
        }</button>
        <div class="spacer"></div>
        <a href="${esc(chartUrl)}" target="_blank" rel="noopener">Yahoo!ファイナンス ↗</a>
      </div>
    </div>
    <div class="disclaimer">選択した売買ルールに照らした機械的な判定のサンプルであり、投資助言ではありません。株価は ${esc(
      data?.source ?? "Yahoo Finance",
    )}。</div>`;

  $("#news-input").addEventListener("input", (e) => {
    state.news[code] = e.target.value;
    if (!e.target.value.trim()) delete state.news[code];
    store.set("news", state.news);
    $("#rejudge").textContent = e.target.value.trim() ? "ニュース込みで再判定" : "再判定";
  });
  $("#rejudge").addEventListener("click", () => runJudge(code));
  $("#watch-star").addEventListener("click", () => toggleWatch(code));
  $("#sim-btn").addEventListener("click", () => sim.openTrade(code));
  syncStar();
  $("#asof").textContent = last ? `${last.date} ${marketOpen() ? "現在値" : "終値"} · 日足` : "";
}

// ---------- テクニカル以外の材料(決算・ニュース) ----------
const optionsLabel = (o) =>
  o?.earnings || o?.news ? `テクニカル + ${[o.earnings && "決算", o.news && "ニュース"].filter(Boolean).join("・")}` : "テクニカルのみ";
const sameOptions = (o) => Boolean(o?.earnings) === state.options.earnings && Boolean(o?.news) === state.options.news;
const maxHoldingDays = () => state.strategies.find((s) => s.id === state.strategy)?.maxHoldingDays ?? 10;
const EARNINGS_BLOCK_DAYS = 5; // サーバー(src/server.ts)と同じ。これ以内の決算は「見送り」
const safeUrl = (u) => (/^https:\/\//.test(u ?? "") ? u : null);

// 決算の近さで色を変える: 見送りになる近さは赤、保有期間中なら黄
function earningsClass(next) {
  if (!next) return "";
  if (next.businessDays <= EARNINGS_BLOCK_DAYS) return "down";
  return next.businessDays <= maxHoldingDays() ? "warn" : "";
}

function renderMaterials(r) {
  const m = r.materials;
  if (!m || (m.earnings == null && m.news == null)) return "";
  const parts = [];
  if (m.earnings) {
    const n = m.earnings.next;
    parts.push(
      n
        ? `<div class="mat-row"><span class="k">次回決算</span><span class="${earningsClass(n)}"><b>${esc(n.date)}</b> あと${n.businessDays}営業日</span>
            <span class="muted">${esc(n.source)}${n.confirmed ? "(確定)" : "(推定)"}${n.period ? ` · ${esc(n.period)}` : ""}</span></div>`
        : `<div class="mat-row"><span class="k">次回決算</span><span class="muted">不明(JPX・Yahoo に予定日がない)</span></div>`,
    );
    if (m.earnings.exDividend) parts.push(`<div class="mat-row"><span class="k">権利落ち日</span><span>${esc(m.earnings.exDividend)}</span></div>`);
  }
  if (m.news) {
    parts.push(
      m.news.length
        ? `<ul class="news-list">${m.news
            .map((n) => {
              const url = safeUrl(n.link);
              const title = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a>` : esc(n.title);
              return `<li>${title}<small>${esc(n.source)} · ${esc(n.published)}</small></li>`;
            })
            .join("")}</ul>`
        : `<div class="muted" style="font-size:12px">直近7日のニュースは見つかりませんでした</div>`,
    );
  }
  return `<div class="d-sec materials"><h4>決算・ニュース</h4>${parts.join("")}</div>`;
}

// スクリーナーの「決算」列。決算オプションなしでスキャンした結果は「—」
function earningsCell(r) {
  const e = r.materials?.earnings;
  if (!e) return "—";
  if (!e.next) return `<span class="muted">不明</span>`;
  return `${esc(e.next.date.slice(5).replace("-", "/"))}${e.next.confirmed ? "" : "?"}`;
}
function earningsTitle(r) {
  const n = r.materials?.earnings?.next;
  if (!r.materials?.earnings) return "決算オプションなしでスキャン";
  return n ? `${n.date} あと${n.businessDays}営業日 · ${n.source}${n.confirmed ? "(確定)" : "(推定)"}` : "次回の決算発表日は不明";
}

function renderRanges() {
  for (const x of document.querySelectorAll("#ranges button")) x.classList.toggle("active", Number(x.dataset.range) === state.range);
}

function renderOptions() {
  for (const b of document.querySelectorAll(".materials-toggle button[data-opt]")) b.classList.toggle("active", state.options[b.dataset.opt]);
}

function strategyLabel(short = false) {
  const s = state.strategies.find((x) => x.id === state.strategy);
  if (!s) return state.strategy;
  return short ? s.label.replace(/[((].*$/, "") : s.label;
}

// ---------- ウォッチリスト ----------
function renderWatchlist() {
  $("#watchlist").innerHTML = state.watch
    .map((code) => {
      const bars = state.bars.get(code)?.bars;
      const last = bars?.at(-1);
      const prev = bars?.at(-2);
      const chg = last && prev ? (last.close / prev.close - 1) * 100 : null;
      const j = judgmentOf(code);
      const tag = j?.loading
        ? `<span class="tag pending">…</span>`
        : j?.result
          ? `<span class="tag ${tagClass(j.result.verdict)}">${esc(j.result.verdict)}</span>`
          : `<span class="tag pending">—</span>`;
      return `<li data-code="${esc(code)}" class="${code === state.code ? "selected" : ""}">
        <button class="del" data-del="${esc(code)}" title="削除">×</button>
        <span class="sym"><b>${esc(code)}</b><small>${esc(displayName(code))}</small></span>
        <span>${num(last?.close)}</span>
        <span class="${cls(chg)}">${signed(chg)}</span>
        <span>${tag}</span></li>`;
    })
    .join("");
}

// 関心銘柄(ウォッチリスト)の並び順と1行の表示数は、サーバーの data/watchlist.json に保存する。
// 並べ替えのドラッグなどで続けて変わるので、少し待ってからまとめて送る
let saveTimer = null;
function saveWatch() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await api("/watchlist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes: state.watch, columns: state.columns }),
      });
    } catch (e) {
      flash(`関心銘柄を保存できませんでした: ${e.message ?? e}`);
    }
  }, 300);
}

function setWatch(codes) {
  state.watch = codes;
  saveWatch();
  renderWatchlist();
  grid.render();
  sim.renderWatch();
  syncScreenChecks();
  syncStar();
  if (search.results.length) renderSearch();
}

function toggleWatch(code) {
  if (state.watch.includes(code)) removeFromWatch(code);
  else addToWatch(code);
}

// 表示中の銘柄の「関心銘柄」ボタン(上部の「判定」の隣と、判定の詳細の見出し)
function syncStar() {
  const on = Boolean(state.code) && state.watch.includes(state.code);
  $("#trade-btn").hidden = !state.code;
  for (const btn of document.querySelectorAll("#watch-star, #star-btn")) {
    btn.hidden = !state.code;
    btn.classList.toggle("on", on);
    btn.textContent = on ? "★ 関心銘柄" : "☆ 関心銘柄に追加";
    btn.title = on ? "クリックで関心銘柄から外す" : "関心銘柄(ウォッチリスト)に追加";
  }
}

// スクリーナーの「関心」チェックを関心銘柄に合わせる(ウォッチリスト側で外したときなど)
function syncScreenChecks() {
  for (const box of document.querySelectorAll("#screen-table input[data-watch]")) {
    const watched = state.watch.includes(box.dataset.watch);
    box.checked = watched;
    box.title = watched ? "関心銘柄から外す" : "関心銘柄に追加";
  }
}

function addToWatch(code) {
  code = normalizeCode(code);
  if (!/^[0-9A-Z]{4}$/.test(code)) {
    flash(`証券コードの形式ではありません: ${code}`);
    return false;
  }
  if (!state.watch.includes(code)) {
    setWatch([...state.watch, code]);
    loadBars(code).then(() => refresh(code), () => {});
  }
  return true;
}

function removeFromWatch(code) {
  setWatch(state.watch.filter((c) => c !== code));
}

// サーバーに保存した関心銘柄を読む。まだなければ、以前ブラウザに保存していたものを移す
async function loadWatch() {
  try {
    const saved = await api("/watchlist");
    state.columns = saved.columns;
    if (saved.codes) {
      state.watch = saved.codes;
      return;
    }
    state.watch = store.get("watchlist", DEFAULT_WATCH);
    saveWatch();
  } catch {
    state.watch = store.get("watchlist", DEFAULT_WATCH);
  }
}

async function loadWatchQuotes() {
  // 同時に投げすぎない(Yahoo Finance のレート制限対策)
  const queue = [...state.watch];
  const worker = async () => {
    while (queue.length) {
      const code = queue.shift();
      try {
        await loadBars(code);
      } catch {
        // 取得できない銘柄は「—」のまま
      }
      renderWatchlist();
      grid.update(code);
      sim.update(code);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
}

// ---------- スクリーナー ----------
function scan() {
  if (state.scanning) return;
  const strategy = state.strategy;
  state.scanning = strategy;
  $("#scan-btn").disabled = true;
  $("#scan-btn").textContent = "スキャン中…";
  $("#progress").hidden = false;
  setProgress("listing", 0, 1);

  const opts = `${state.options.earnings ? "&earnings=1" : ""}${state.options.news ? "&news=1" : ""}`;
  const es = new EventSource(`/screen?strategy=${encodeURIComponent(strategy)}${opts}`);
  const finish = () => {
    // 閉じないと EventSource が自動で再接続し、スキャンをやり直してしまう
    es.close();
    state.scanning = null;
    $("#scan-btn").disabled = false;
    $("#scan-btn").textContent = "全銘柄スキャン";
    $("#progress").hidden = true;
  };
  es.addEventListener("progress", (e) => {
    const p = JSON.parse(e.data);
    setProgress(p.phase, p.done, p.total);
  });
  es.addEventListener("result", (e) => {
    // サーバー側で data/screens/ に保存済み
    state.screens[strategy] = JSON.parse(e.data);
    finish();
    renderScreen();
    renderWatchlist();
    if (state.code) refresh(state.code);
  });
  es.addEventListener("error", (e) => {
    let msg = "スキャンに失敗しました(サーバーとの接続が切れました)";
    try {
      if (e.data) msg = JSON.parse(e.data).error;
    } catch {}
    finish();
    $("#screen-summary").innerHTML = `<span class="error">${esc(msg)}</span>`;
  });
}

// 今の売買ルールで保存した調査結果(スクリーニング・個別の判定)をサーバーから消す
async function clearResults() {
  const strategy = state.strategy;
  if (state.scanning === strategy) {
    flash("スキャン中はクリアできません");
    return;
  }
  const judged = [...state.judgments.entries()].filter(([k, j]) => k.startsWith(`${strategy}:`) && j.result).length;
  const screened = state.screens[strategy]?.results.length ?? 0;
  const ok = confirm(
    `${strategyLabel()}の調査結果を削除します。\n\n` +
      `・スクリーニング結果(過去の実行分も含む)${screened ? `: 最新 ${screened}件` : ""}\n` +
      `・個別の判定結果: ${judged}銘柄\n\n` +
      "もう一方の売買ルールの結果、ウォッチリスト、ニュースの下書きは残ります。元に戻せません。",
  );
  if (!ok) return;

  const btn = $("#clear-btn");
  btn.disabled = true;
  try {
    await api(`/results?strategy=${encodeURIComponent(strategy)}`, { method: "DELETE" });
    for (const k of [...state.judgments.keys()]) if (k.startsWith(`${strategy}:`)) state.judgments.delete(k);
    delete state.screens[strategy];
    renderScreen();
    renderWatchlist();
    if (state.code) refresh(state.code);
  } catch (e) {
    flash(`クリアできませんでした: ${e.message ?? e}`);
  } finally {
    btn.disabled = false;
  }
}

function setProgress(phase, done, total) {
  const [label, from, to] = PHASES[phase] ?? [phase, 0, 100];
  const pct = from + ((to - from) * done) / Math.max(total, 1);
  $("#progress-fill").style.width = `${pct}%`;
  $("#progress-text").textContent = phase === "listing" ? `${label}を取得中` : `${label} ${done.toLocaleString()} / ${total.toLocaleString()}`;
}

const rowValue = {
  code: (r) => r.code,
  name: (r) => r.name,
  sector: (r) => r.sector ?? "",
  scale: (r) => r.scale ?? "",
  verdict: (r) => -RANK[r.verdict],
  sat: (r) => r.checks.filter((c) => c.ok).length,
  close: (r) => r.technicals.close,
  chg: (r) => r.technicals.changePct,
  tp: (r) => r.sellPlan.takeProfit[0]?.pct,
  sl: (r) => r.sellPlan.stopLoss.pct,
  rr: (r) => r.sellPlan.riskReward,
  earn: (r) => r.materials?.earnings?.next?.date,
  buy: (r) => decisionOf(r)?.verdictProbabilities.買い,
  rank: (r) => (r.ranking ? -r.ranking.rank : null), // 降順(初回クリック)で1位が上
};

function renderScreen() {
  const data = state.screens[state.strategy];
  const tbody = $("#screen-table tbody");
  for (const th of document.querySelectorAll("#screen-table th")) {
    th.classList.toggle("sorted", th.dataset.k === state.sort.key);
    th.classList.toggle("asc", th.dataset.k === state.sort.key && state.sort.asc);
  }
  if (!data) {
    $("#screen-summary").textContent = `${strategyLabel()}で東証プライム約1,560銘柄を判定します(約40〜50秒)`;
    tbody.innerHTML = "";
    return;
  }
  const s = data.summary;
  const at = data.scannedAt ? new Date(data.scannedAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }) : "";
  $("#screen-summary").innerHTML = `${esc(s.market)} ${s.listed.toLocaleString()}銘柄 → 候補 ${s.candidates.toLocaleString()}件:
    <span class="tag buy">買い ${s.byVerdict.買い}</span> <span class="tag probe">打診買い ${s.byVerdict.打診買い}</span>
    <span class="tag pass">見送り ${s.byVerdict.見送り}</span>${data.errors.length ? ` · 取得エラー ${data.errors.length}件` : ""} · ${esc(at)} にスキャン · 材料: ${esc(optionsLabel(data.options))}${
    data.ranking?.error
      ? ` · <span class="error">Codex のランク付けに失敗: ${esc(data.ranking.error)}</span>`
      : data.ranking
        ? `<div class="rank-summary">Codex(${esc(data.ranking.model)})上位${data.ranking.ranked}件をランク付け: ${esc(data.ranking.summary)}</div>`
        : ""
  }`;

  const f = state.filter;
  const text = f.text.trim().toLowerCase();
  let rows = data.results.filter(
    (r) =>
      f.verdicts.has(r.verdict) &&
      (!f.large || LARGE.has(r.scale)) &&
      (!text || `${r.code} ${r.name} ${r.sector ?? ""}`.toLowerCase().includes(text)),
  );
  if (state.sort.key) {
    const get = rowValue[state.sort.key];
    const dir = state.sort.asc ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const x = get(a);
      const y = get(b);
      if (x == null) return 1;
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y, "ja") : x - y) * dir;
    });
  }
  tbody.innerHTML = rows
    .map((r) => {
      const t = r.technicals;
      const tp = r.sellPlan.takeProfit[0];
      const sl = r.sellPlan.stopLoss;
      const buy = decisionOf(r)?.verdictProbabilities.買い;
      const watched = state.watch.includes(r.code);
      return `<tr data-code="${esc(r.code)}" class="${r.code === state.code ? "selected" : ""}">
        <td class="pick"><input type="checkbox" data-watch="${esc(r.code)}" ${watched ? "checked" : ""}
          title="${watched ? "関心銘柄から外す" : "関心銘柄に追加"}" aria-label="${esc(r.code)} を関心銘柄に追加" /></td>
        <td class="trade-col"><button class="tb-btn small trade-row-btn" type="button" data-trade="${esc(r.code)}"
          title="${esc(r.code)} を株シミュレーターで仮想売買します">売買</button></td>
        <td class="num" title="${esc(r.ranking?.reason ?? "")}">${r.ranking ? r.ranking.rank : "—"}</td>
        <td class="code">${esc(r.code)}</td>
        <td class="name" title="${esc(r.name)}">${esc(r.name)}</td>
        <td class="muted">${esc(r.sector ?? "")}</td>
        <td class="muted">${esc(r.scale ?? "")}</td>
        <td><span class="tag ${tagClass(r.verdict)}">${esc(r.verdict)}</span></td>
        <td class="num">${esc(r.satisfied)}</td>
        <td class="num">${num(t.close)}</td>
        <td class="num ${cls(t.changePct)}">${signed(t.changePct)}</td>
        <td class="num">${tp ? `${num(tp.price)} <span class="up">${signed(tp.pct, 1)}</span>` : "—"}</td>
        <td class="num">${sl.price == null ? "—" : `${num(sl.price)} <span class="down">${signed(sl.pct, 1)}</span>`}</td>
        <td class="num ${earningsClass(r.materials?.earnings?.next)}" title="${esc(earningsTitle(r))}">${earningsCell(r)}</td>
        <td class="num">${r.sellPlan.riskReward ?? "—"}</td>
        <td class="num">${buy == null ? "—" : `${Math.round(buy * 100)}%`}</td>
      </tr>`;
    })
    .join("");
  if (!rows.length) tbody.innerHTML = `<tr><td colspan="16" class="muted" style="text-align:center;padding:20px">条件に合う銘柄はありません</td></tr>`;
}

function highlightScreenRow() {
  for (const tr of document.querySelectorAll("#screen-table tbody tr")) tr.classList.toggle("selected", tr.dataset.code === state.code);
}

// ---------- ツールバー・メニュー ----------
function renderStrategies() {
  $("#strategy").innerHTML = state.strategies
    .map(
      (s) =>
        `<button type="button" data-id="${esc(s.id)}" title="${esc(s.label)}" class="${s.id === state.strategy ? "active" : ""}">${esc(
          s.label.replace(/[((].*$/, ""),
        )}</button>`,
    )
    .join("");
}

function renderIndicatorMenu() {
  $("#ind-menu").innerHTML = INDICATORS.map((d) => {
    const on = indicators.has(d.id);
    const main = `<label><input type="checkbox" data-ind="${d.id}" ${on ? "checked" : ""} />
      <span class="swatch" style="background:${d.color}"></span>${esc(d.label)}</label>`;
    // 1本ずつ選べる線(インジケーター自体がオフのときは選べない)
    const subs = (SUBLINES[d.id] ?? [])
      .map(
        (l) => `<label class="sub ${on ? "" : "disabled"}"><input type="checkbox" data-line="${l.id}" ${lineOn(l.id) ? "checked" : ""} ${on ? "" : "disabled"} />
          <span class="swatch" style="background:${l.color}"></span>${esc(l.label)}</label>`,
      )
      .join("");
    return main + subs;
  }).join("");
  renderPaneToggles();
}

// チャートの段(価格 / RSI / RCI / MACD)の表示切り替え。
// 下の段はインジケーターの選択と同じもので、売買ルールごとに localStorage に保存する
const PANES = [
  { id: "price", label: "価格" },
  { id: "rsi", label: "RSI" },
  { id: "rci", label: "RCI" },
  { id: "macd", label: "MACD" },
];
const paneVisible = (id) => (id === "price" ? state.showPrice : indicators.has(id));

function renderPaneToggles() {
  $("#pane-toggles").innerHTML = PANES.map(
    (p) =>
      `<button type="button" data-pane="${p.id}" class="${paneVisible(p.id) ? "active" : ""}" title="${esc(p.label)}の段を${
        paneVisible(p.id) ? "隠す" : "表示する"
      }">${esc(p.label)}</button>`,
  ).join("");
}

function togglePane(id) {
  // 全部の段を消すとチャートが空になるので、最後の1つは消さない
  if (paneVisible(id) && PANES.filter((p) => paneVisible(p.id)).length === 1) {
    flash("少なくとも1つの段は表示してください");
    return;
  }
  if (id === "price") {
    state.showPrice = !state.showPrice;
    store.set("showPrice", state.showPrice);
  } else {
    if (indicators.has(id)) indicators.delete(id);
    else indicators.add(id);
    store.set(`indicators:${state.strategy}`, [...indicators]);
  }
  renderIndicatorMenu();
  buildChart();
}

function setStrategy(id) {
  if (id === state.strategy) return;
  state.strategy = id;
  store.set("strategy", id);
  indicators = indicatorsFor(id);
  state.sort = { key: null, asc: false };
  renderStrategies();
  renderIndicatorMenu();
  renderScreen();
  renderWatchlist();
  buildChart();
  renderDetail();
  grid.rebuild(); // 売買ルールごとにインジケーターの選択が違う
  grid.updateAll();
  if (state.view === "chart" && state.code && state.bars.has(state.code) && !judgmentOf(state.code)) runJudge(state.code);
}

// タブ(チャート / 関心銘柄)。選んだタブはブラウザに覚えておく
function setView(view) {
  state.view = view;
  store.set("view", view);
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll("#views button")) b.classList.toggle("active", b.dataset.view === view);
  if (view === "grid") grid.render();
  if (view === "sim") sim.show();
}

function openChart(code) {
  setView("chart");
  select(code);
}

// 判定の詳細・関心銘柄タブの「買う」。銘柄を注文欄に入れてシミュレーターを開く
function openSim(code = state.code) {
  sim.setCode(code);
  setView("sim");
}

function bindEvents() {
  bindSearch();
  $("#star-btn").addEventListener("click", () => state.code && toggleWatch(state.code));
  // チャート右上の「売買」。タブを移らずに、売買ダイアログで仮想売買する
  $("#trade-btn").addEventListener("click", () => state.code && sim.openTrade(state.code));
  $("#watch-form").addEventListener("submit", (e) => {
    e.preventDefault();
    if (addToWatch($("#watch-input").value)) $("#watch-input").value = "";
  });
  $("#watchlist").addEventListener("click", (e) => {
    const del = e.target.closest("[data-del]");
    if (del) {
      e.stopPropagation();
      removeFromWatch(del.dataset.del);
      return;
    }
    const li = e.target.closest("li[data-code]");
    if (li) select(li.dataset.code);
  });
  $("#views").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-view]");
    if (b) setView(b.dataset.view);
  });
  $("#strategy").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-id]");
    if (b) setStrategy(b.dataset.id);
  });
  $("#judge-btn").addEventListener("click", () => state.code && runJudge(state.code));

  $("#ind-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("#ind-menu").hidden = !$("#ind-menu").hidden;
  });
  $("#ind-menu").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => ($("#ind-menu").hidden = true));
  $("#ind-menu").addEventListener("change", (e) => {
    const lineId = e.target.dataset.line;
    if (lineId) {
      if (e.target.checked) state.hiddenLines.delete(lineId);
      else state.hiddenLines.add(lineId);
      store.set("hiddenLines", [...state.hiddenLines]);
      buildChart();
      grid.rebuild();
      return;
    }
    const id = e.target.dataset.ind;
    if (e.target.checked) indicators.add(id);
    else indicators.delete(id);
    store.set(`indicators:${state.strategy}`, [...indicators]);
    renderIndicatorMenu(); // 線ごとのチェックを選べる / 選べないに切り替える
    buildChart();
    grid.rebuild();
  });
  for (const btn of document.querySelectorAll(".dw-toggle")) btn.addEventListener("click", () => {
    state.dataWindow = !state.dataWindow;
    store.set("dataWindow", state.dataWindow);
    renderDataWindowToggle();
    if (!state.dataWindow) {
      $("#data-window").hidden = true;
      $("#grid-data-window").hidden = true;
      $("#legend").classList.remove("covered");
    }
    updateLegend();
  });
  $("#pane-toggles").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-pane]");
    if (b) togglePane(b.dataset.pane);
  });

  $(".toolbar").addEventListener("click", (e) => {
    const t = e.target.closest("[data-tool]");
    if (!t) return;
    const tool = t.dataset.tool;
    if (tool === "crosshair" || tool === "magnet") {
      state.tools.magnet = tool === "magnet";
      document.querySelector('[data-tool="crosshair"]').classList.toggle("active", !state.tools.magnet);
      document.querySelector('[data-tool="magnet"]').classList.toggle("active", state.tools.magnet);
      chart?.applyOptions({ crosshair: { mode: state.tools.magnet ? LWC.CrosshairMode.MagnetOHLC : LWC.CrosshairMode.Normal } });
    } else if (tool === "lines") {
      state.tools.lines = !state.tools.lines;
      t.classList.toggle("active", state.tools.lines);
      applyTradeLines();
    } else if (tool === "fit") {
      chart?.timeScale().fitContent();
    } else if (tool === "shot" && chart) {
      const a = document.createElement("a");
      a.href = chart.takeScreenshot().toDataURL("image/png");
      a.download = `${state.code}_${state.strategy}_${state.bars.get(state.code)?.bars.at(-1)?.date ?? ""}.png`;
      a.click();
    }
  });

  $("#ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (!b) return;
    state.range = Number(b.dataset.range);
    store.set("range", state.range);
    renderRanges();
    applyRange();
  });
  // 材料のボタンは上部とスクリーナーの2か所。どちらを押しても同じ設定を切り替える
  for (const group of document.querySelectorAll(".materials-toggle")) {
    group.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-opt]");
      if (!b) return;
      state.options = { ...state.options, [b.dataset.opt]: !state.options[b.dataset.opt] };
      store.set("options", state.options);
      renderOptions();
      // 判定済みの結果に「今の設定と違う」の注記を出す
      if (state.code) renderDetail();
    });
  }

  $("#panel-toggle").addEventListener("click", () => {
    const collapsed = $("#panel").classList.toggle("collapsed");
    $("#panel-toggle").textContent = collapsed ? "スクリーナー ▴" : "スクリーナー ▾";
    store.set("panelCollapsed", collapsed);
  });
  if (store.get("panelCollapsed", false)) {
    $("#panel").classList.add("collapsed");
    $("#panel-toggle").textContent = "スクリーナー ▴";
  }
  bindPanelResizer();
  bindSideResizers();

  $("#scan-btn").addEventListener("click", scan);
  $("#clear-btn").addEventListener("click", clearResults);
  $("#verdict-filter").addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (!b) return;
    const v = b.dataset.v;
    if (state.filter.verdicts.has(v)) state.filter.verdicts.delete(v);
    else state.filter.verdicts.add(v);
    b.classList.toggle("active", state.filter.verdicts.has(v));
    renderScreen();
  });
  $("#large-only").addEventListener("change", (e) => {
    state.filter.large = e.target.checked;
    renderScreen();
  });
  $("#screen-filter").addEventListener("input", (e) => {
    state.filter.text = e.target.value;
    renderScreen();
  });
  $("#screen-table thead").addEventListener("click", (e) => {
    const th = e.target.closest("th[data-k]");
    if (!th) return;
    const k = th.dataset.k;
    state.sort = state.sort.key === k ? { key: k, asc: !state.sort.asc } : { key: k, asc: ["code", "name", "sector", "scale"].includes(k) };
    renderScreen();
  });
  $("#screen-table tbody").addEventListener("click", (e) => {
    // チェック欄のクリックは関心銘柄の記録だけにして、チャートは切り替えない
    if (e.target.closest("td.pick")) return;
    // 「売買」は売買ダイアログを開くだけ(チャートは切り替えない)
    const trade = e.target.closest("[data-trade]");
    if (trade) {
      sim.openTrade(trade.dataset.trade);
      return;
    }
    const tr = e.target.closest("tr[data-code]");
    if (tr) select(tr.dataset.code);
  });
  // チェックで関心銘柄に記録、外すと削除(data/watchlist.json に保存される)
  $("#screen-table tbody").addEventListener("change", (e) => {
    const box = e.target.closest("input[data-watch]");
    if (!box) return;
    const code = box.dataset.watch;
    if (box.checked) {
      if (state.watch.length >= MAX_WATCH) {
        box.checked = false;
        flash(`関心銘柄は${MAX_WATCH}件までです`);
        return;
      }
      addToWatch(code);
    } else {
      removeFromWatch(code);
    }
  });

  // URL の #7203 で銘柄を開けるようにする(ブックマーク・戻る用)
  window.addEventListener("hashchange", () => {
    const code = decodeURIComponent(location.hash.slice(1));
    if (code && normalizeCode(code) !== state.code) select(code);
  });

  // TradingView と同じく、どこでも英数字を打てば銘柄検索に入る
  document.addEventListener("keydown", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || e.metaKey || e.ctrlKey || e.altKey) return;
    if (/^[0-9a-zA-Z]$/.test(e.key)) {
      $("#search").focus();
    } else if (e.key === "Escape") {
      $("#ind-menu").hidden = true;
    }
  });
}

// スクリーナーの高さ。上端のつまみをドラッグして変え、localStorage に保存する
const PANEL_DEFAULT = 300;
const PANEL_MIN = 120;
const CHART_MIN = 200; // チャートは最低これだけ残す

function clampPanelHeight(h) {
  const max = $(".center").clientHeight - $(".rangebar").offsetHeight - CHART_MIN;
  return Math.round(Math.max(PANEL_MIN, Math.min(h, Math.max(PANEL_MIN, max))));
}

function setPanelHeight(h) {
  $("#panel").style.height = `${clampPanelHeight(h)}px`;
}

function bindPanelResizer() {
  const panel = $("#panel");
  const handle = $("#panel-resizer");
  setPanelHeight(store.get("panelHeight", PANEL_DEFAULT));

  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add("resizing");
    const startY = e.clientY;
    const startH = panel.offsetHeight;
    const move = (ev) => setPanelHeight(startH - (ev.clientY - startY));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      store.set("panelHeight", panel.offsetHeight);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => {
    setPanelHeight(PANEL_DEFAULT);
    store.set("panelHeight", panel.offsetHeight);
  });
  // ウィンドウを縮めたときにチャートが潰れないよう、保存した高さから収め直す
  window.addEventListener("resize", () => setPanelHeight(store.get("panelHeight", PANEL_DEFAULT)));
}

// ---------- 銘柄検索 ----------
// 証券コードか銘柄名(ひらがな・カタカナ・半角カナどれでも)を打つと候補を出し、選ぶとチャートを開く
const search = { results: [], active: 0, timer: null, seq: 0 };

function bindSearch() {
  const input = $("#search");
  const list = $("#search-results");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", "search-results");

  input.addEventListener("input", () => {
    clearTimeout(search.timer);
    search.timer = setTimeout(() => runSearch(input.value), 120);
  });
  input.addEventListener("keydown", (e) => {
    if (e.isComposing) return; // 変換中の Enter などは IME に任せる
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!search.results.length) return;
      e.preventDefault();
      const n = search.results.length;
      search.active = (search.active + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
      renderSearch();
    } else if (e.key === "Escape") {
      closeSearch();
      input.blur();
    }
  });
  $("#search-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const hit = search.results[search.active];
    if (hit) return pickSearch(hit);
    // 候補がなくても、コードの形なら開いてみる
    const code = normalizeCode(input.value);
    if (/^[0-9A-Z]{4}$/.test(code)) {
      closeSearch();
      input.value = "";
      input.blur();
      openChart(code);
    }
  });
  // mousedown で選ぶ(click だと先に input の blur で候補が消える)
  list.addEventListener("mousedown", (e) => {
    // ☆ は関心銘柄の登録だけ。候補は開いたままにする
    const star = e.target.closest("button[data-star]");
    if (star) {
      e.preventDefault();
      const hit = search.results[Number(star.dataset.star)];
      state.names.set(hit.code, hit.name);
      toggleWatch(hit.code);
      return;
    }
    const li = e.target.closest("li[data-i]");
    if (!li) return;
    e.preventDefault();
    pickSearch(search.results[Number(li.dataset.i)]);
  });
  list.addEventListener("mousemove", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li && Number(li.dataset.i) !== search.active) {
      search.active = Number(li.dataset.i);
      renderSearch();
    }
  });
  input.addEventListener("blur", () => setTimeout(closeSearch, 100));
  input.addEventListener("focus", () => input.value.trim() && runSearch(input.value));
}

async function runSearch(q) {
  const seq = ++search.seq;
  if (!q.trim()) return closeSearch();
  try {
    const { results } = await api(`/search?q=${encodeURIComponent(q)}`);
    if (seq !== search.seq) return; // 打ち続けているあいだの古い結果は捨てる
    search.results = results;
    search.active = 0;
    renderSearch();
  } catch {
    closeSearch();
  }
}

function renderSearch() {
  const list = $("#search-results");
  if (!search.results.length) {
    list.innerHTML = `<li class="empty">該当する銘柄がありません</li>`;
    list.hidden = !$("#search").value.trim();
    return;
  }
  list.innerHTML = search.results
    .map(
      (r, i) => `<li role="option" data-i="${i}" class="${i === search.active ? "active" : ""}" aria-selected="${i === search.active}">
        <b class="s-code">${esc(r.code)}</b>
        <span class="s-name">${esc(r.name)}</span>
        <button type="button" class="s-star ${state.watch.includes(r.code) ? "on" : ""}" data-star="${i}"
          title="${state.watch.includes(r.code) ? "関心銘柄から外す" : "関心銘柄に追加(チャートは開かない)"}">${state.watch.includes(r.code) ? "★" : "☆"}</button>
        <span class="s-meta">${esc(r.market)} · ${esc(r.sector)}</span>
      </li>`,
    )
    .join("");
  list.hidden = false;
}

function closeSearch() {
  search.results = [];
  $("#search-results").hidden = true;
}

function pickSearch(hit) {
  state.names.set(hit.code, hit.name);
  const input = $("#search");
  input.value = "";
  closeSearch();
  input.blur();
  openChart(hit.code);
}

// ---------- 右パネルの幅・ウォッチリストの高さ ----------
// つまみをドラッグして変え、localStorage に保存する。ダブルクリックで元に戻す
function makeResizer(handle, { axis, read, apply, key, fallback }) {
  apply(store.get(key, fallback));
  handle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add("dragging");
    document.body.classList.add(axis === "x" ? "resizing-x" : "resizing");
    const start = axis === "x" ? e.clientX : e.clientY;
    const startSize = read();
    const move = (ev) => apply(startSize + (axis === "x" ? start - ev.clientX : ev.clientY - start));
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing", "resizing-x");
      store.set(key, read());
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", () => {
    apply(fallback);
    store.set(key, read());
  });
  // ウィンドウを縮めたときも、保存した大きさから収め直す
  window.addEventListener("resize", () => apply(store.get(key, fallback)));
}

const SIDE_DEFAULT = 340;
const WATCH_DEFAULT = 300;
function bindSideResizers() {
  const layout = $(".layout");
  const sidebar = $(".sidebar");
  const watch = $(".watch");
  // 右パネルの幅: 左端を左へ引くほど広がる。チャートは最低 480px 残す
  makeResizer($("#side-resizer"), {
    axis: "x",
    key: "sideWidth",
    fallback: SIDE_DEFAULT,
    read: () => sidebar.offsetWidth,
    apply: (w) => {
      const max = Math.max(260, window.innerWidth - 48 - 480);
      layout.style.setProperty("--side-w", `${Math.round(Math.max(260, Math.min(w, max)))}px`);
    },
  });
  // ウォッチリストの高さ: 下端を下へ引くほど高くなる。判定の詳細は最低 150px 残す
  makeResizer($("#watch-resizer"), {
    axis: "y",
    key: "watchHeight",
    fallback: WATCH_DEFAULT,
    read: () => watch.offsetHeight,
    apply: (h) => {
      const max = Math.max(100, sidebar.clientHeight - 150);
      watch.style.height = `${Math.round(Math.max(100, Math.min(h, max)))}px`;
    },
  });
}

// ---------- 起動 ----------
async function init() {
  bindEvents();
  try {
    state.strategies = await api("/strategies");
    if (!state.strategies.some((s) => s.id === state.strategy)) state.strategy = state.strategies[0]?.id ?? "swing";
    indicators = indicatorsFor(state.strategy);
  } catch {
    state.strategies = [{ id: "swing", label: "スイング" }, { id: "rebound", label: "急落リバウンド" }];
  }
  await Promise.all([loadWatch(), ...state.strategies.map((s) => loadSaved(s.id).catch(() => {}))]);
  await loadHealth();
  initSettings({ onSaved: loadHealth });
  renderStrategies();
  renderOptions();
  renderRanges();
  renderDataWindowToggle();
  renderIndicatorMenu();
  renderScreen();
  renderWatchlist();
  renderDetail();
  buildChart();
  setView(["grid", "sim"].includes(state.view) ? state.view : "chart");
  loadWatchQuotes();
  startLive();
  const initial = decodeURIComponent(location.hash.slice(1)) || state.watch[0];
  if (initial) select(initial);
}

const grid = createGridView({
  state,
  C,
  esc,
  num,
  signed,
  cls,
  tagClass,
  loadBars,
  judgmentOf,
  displayName,
  runJudge,
  openChart,
  openSim,
  setWatch,
  saveWatch,
  addToWatch,
  removeFromWatch,
  onBarsLoaded: renderWatchlist,
  // チャートタブと同じインジケーター・線の表示設定・データ表示を使う
  indicators: () => indicators,
  computeIndicators,
  lineOn,
  bbLines,
  ICHI,
  MA_IDS,
  maColor: (id) => INDICATORS.find((d) => d.id === id).color,
  dataWindowRows,
  fillDataWindow,
  dataWindowLeft,
});

const sim = createSimView({
  state,
  esc,
  num,
  signed,
  cls,
  tagClass,
  api,
  loadBars,
  judgmentOf,
  runJudge,
  displayName,
  openChart,
  normalizeCode,
  flash,
  strategyLabel,
  removeFromWatch,
  store,
  openSim,
});

init();
