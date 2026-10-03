// 関心銘柄タブ: ウォッチリストの銘柄のチャートを行列に並べる。
// 1行の表示数(1〜5)と並び順はサーバーの data/watchlist.json に保存する(保存は main.js の setWatch)。
import * as LWC from "lightweight-charts";
import { CloudPrimitive, SHIFT } from "./ichimoku.js";

// 1行の表示数ごとの段の高さ(px)。列が少ないほど1枚が横に広いので高くする
const ROW_HEIGHT = { 1: 440, 2: 340, 3: 280, 4: 240, 5: 220 };
// 最初に見せる本数。小さいチャートに半年分を詰めると読めないので、4列以上は3ヶ月
const visibleBars = (columns) => (columns >= 4 ? 66 : 132);

export function createGridView(ctx) {
  const { state, C, esc, num, signed, cls, tagClass } = ctx;
  const $ = (sel) => document.querySelector(sel);
  const grid = $("#grid");
  const cells = new Map(); // code -> { el, chart, candle, markers, lines, loading }
  let dragCode = null;

  // 画面に入った(入りそうな)セルだけチャートを作る。銘柄が多くても最初の表示を軽くする
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) ensureChart(e.target.dataset.code);
    },
    { root: $("#grid-scroll"), rootMargin: "400px 0px" },
  );

  function createCell(code) {
    const el = document.createElement("div");
    el.className = "cell";
    el.dataset.code = code;
    el.innerHTML = `
      <div class="cell-head" draggable="true" title="ドラッグで並べ替え">
        <span class="grip" aria-hidden="true">⋮⋮</span>
        <span class="cell-info"></span>
        <button type="button" class="c-btn" data-act="judge" title="今の売買ルールで判定">判定</button>
        <button type="button" class="c-btn buy" data-act="buy" title="シミュレーターで仮想売買する">買う</button>
        <button type="button" class="c-btn" data-act="open" title="チャートタブで開く">↗</button>
        <button type="button" class="c-btn del" data-act="remove" title="関心銘柄から外す">×</button>
      </div>
      <div class="cell-chart"><div class="cell-msg"><div class="spinner"></div></div></div>`;

    const head = el.querySelector(".cell-head");
    head.addEventListener("dragstart", (e) => {
      dragCode = code;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", code);
      el.classList.add("dragging");
    });
    head.addEventListener("dragend", () => {
      dragCode = null;
      for (const c of cells.values()) c.el.classList.remove("dragging", "drop-target");
    });
    el.addEventListener("dragover", (e) => {
      if (!dragCode || dragCode === code) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el.classList.add("drop-target");
    });
    el.addEventListener("dragleave", (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove("drop-target");
    });
    el.addEventListener("drop", (e) => {
      e.preventDefault();
      el.classList.remove("drop-target");
      if (dragCode && dragCode !== code) move(dragCode, code);
    });
    el.querySelector(".cell-chart").addEventListener("dblclick", () => ctx.openChart(code));

    cells.set(code, { el, chart: null, candle: null, markers: null, lines: [], loading: false });
    io.observe(el);
    return el;
  }

  // ドラッグした銘柄を、落とした銘柄の位置に移す
  function move(from, to) {
    const list = [...state.watch];
    const j = list.indexOf(to);
    list.splice(list.indexOf(from), 1);
    list.splice(j, 0, from);
    ctx.setWatch(list);
  }

  async function ensureChart(code) {
    const cell = cells.get(code);
    if (!cell || cell.chart || cell.loading) return;
    cell.loading = true;
    try {
      await ctx.loadBars(code);
    } catch (e) {
      cell.el.querySelector(".cell-chart").innerHTML = `<div class="cell-msg error">${esc(e.message ?? e)}</div>`;
      return;
    } finally {
      cell.loading = false;
    }
    if (cells.get(code) !== cell) return; // 読み込み中に外された
    buildChart(cell, code);
    update(code);
    ctx.onBarsLoaded(code);
  }

  function buildChart(cell, code) {
    const bars = state.bars.get(code).bars;
    const box = cell.el.querySelector(".cell-chart");
    box.innerHTML = "";
    const chart = LWC.createChart(box, {
      autoSize: true,
      layout: {
        background: { type: "solid", color: C.bg },
        textColor: C.text,
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 10,
        // 帰属表示はツールバー下のリンクで行う(セルごとにロゴを出すと邪魔)
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: C.grid } },
      crosshair: {
        vertLine: { color: C.muted, labelBackgroundColor: "#363a45" },
        horzLine: { color: C.muted, labelBackgroundColor: "#363a45" },
      },
      rightPriceScale: { borderColor: C.border },
      timeScale: { borderColor: C.border, rightOffset: 3 },
      localization: { locale: "ja-JP", dateFormat: "yyyy/MM/dd" },
      // ホイールは一覧のスクロールに使う。チャートの拡大・移動はドラッグとピンチで
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true, axisDoubleClickReset: true },
    });
    const price = { type: "price", precision: 1, minMove: 0.1 };
    const line = (color, opts = {}) =>
      chart.addSeries(LWC.LineSeries, { color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: price, ...opts });

    // チャートタブの価格の段と同じインジケーター・同じ線の表示設定で描く(RSI などの段は出さない)
    const on = ctx.indicators();
    const s = {};
    if (on.has("vol")) {
      s.vol = chart.addSeries(LWC.HistogramSeries, { priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      s.vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }
    const ind = ctx.computeIndicators(bars);
    if (on.has("bb")) {
      for (const [key, id, , color, dotted] of ctx.bbLines(ind)) if (ctx.lineOn(id)) s[key] = line(color, dotted ? { lineStyle: LWC.LineStyle.Dotted } : {});
    }
    const candle = chart.addSeries(LWC.CandlestickSeries, {
      upColor: C.up,
      downColor: C.down,
      borderVisible: false,
      wickUpColor: C.up,
      wickDownColor: C.down,
      priceFormat: price,
    });
    for (const id of ctx.MA_IDS) if (on.has(id)) s[id] = line(ctx.maColor(id));
    let cloud = null;
    if (on.has("ichimoku")) {
      for (const id of ["spanA", "spanB", "tenkan", "kijun", "chikou"]) if (ctx.lineOn(id)) s[id] = line(ctx.ICHI[id]);
      if (ctx.lineOn("cloud")) {
        cloud = new CloudPrimitive({ up: ctx.ICHI.cloudUp, down: ctx.ICHI.cloudDown });
        candle.attachPrimitive(cloud);
      }
    }

    cell.chart = chart;
    cell.candle = candle;
    cell.series = s;
    cell.cloud = cloud;
    cell.ichimoku = on.has("ichimoku");
    cell.markers = LWC.createSeriesMarkers(candle, []);
    cell.lines = [];
    fill(cell, bars, ind);
    setRange(cell, bars.length);

    // データ表示: カーソルの左隣(入らなければ右隣)にカードを浮かせる
    chart.subscribeCrosshairMove((param) => showDataCard(code, box, param));
  }

  // 系列にデータを入れる。リアルタイム更新でも呼ぶ(一目均衡表は最新の足以外の日付にも効くので、全部入れ直す)
  function fill(cell, bars, ind = ctx.computeIndicators(bars)) {
    const s = cell.series;
    cell.candle.setData(bars.map(({ date, open, high, low, close }) => ({ time: date, open, high, low, close })));
    s.vol?.setData(
      bars.map((b, i) => ({
        time: b.date,
        value: b.volume,
        color: i > 0 && b.close < bars[i - 1].close ? "rgba(242, 54, 69, 0.3)" : "rgba(8, 153, 129, 0.3)",
      })),
    );
    const toLine = (values, times = bars.map((b) => b.date)) =>
      times.flatMap((time, k) => (values[k] == null ? [] : [{ time, value: values[k] }]));
    for (const [key, , values] of ctx.bbLines(ind)) s[key]?.setData(toLine(values));
    for (const id of ctx.MA_IDS) s[id]?.setData(toLine(ind[id]));
    if (cell.ichimoku) {
      const g = ind.ichimoku;
      for (const id of ["tenkan", "kijun", "chikou", "spanA", "spanB"]) s[id]?.setData(toLine(g[id], g.times));
      cell.cloud?.setPoints(g.times.flatMap((time, k) => (g.spanA[k] == null || g.spanB[k] == null ? [] : [{ time, a: g.spanA[k], b: g.spanB[k] }])));
    }
  }

  // 一目均衡表を出しているときは、先の雲も見えるように右を空ける
  function setRange(cell, n) {
    cell.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - visibleBars(state.columns)), to: n + (cell.ichimoku ? SHIFT + 2 : 3) });
  }

  // リアルタイム更新で取り直した日足を反映する
  function applyBars(code) {
    const cell = cells.get(code);
    if (!cell) return;
    const bars = state.bars.get(code)?.bars;
    if (cell.chart && bars) fill(cell, bars);
    update(code);
  }

  // データ表示のカード(画面に1つだけ浮かせて使い回す)
  const card = document.querySelector("#grid-data-window");
  // 一覧をスクロールするとカードの位置がずれるので隠す
  $("#grid-scroll").addEventListener("scroll", () => (card.hidden = true), { passive: true });
  function showDataCard(code, box, param) {
    const bars = state.bars.get(code)?.bars;
    if (!state.dataWindow || !bars || !param?.point || param.logical == null) {
      card.hidden = true;
      return;
    }
    const i = Math.max(0, Math.min(bars.length - 1, Math.round(param.logical)));
    ctx.fillDataWindow(card, bars, i, ctx.dataWindowRows(bars, ctx.computeIndicators(bars), i, { code, pricePaneOnly: true }), ctx.displayName(code));
    const r = box.getBoundingClientRect();
    const x = r.left + param.point.x;
    const y = r.top + param.point.y;
    card.style.left = `${ctx.dataWindowLeft(card.offsetWidth, x, window.innerWidth)}px`;
    card.style.top = `${Math.max(4, Math.min(y - card.offsetHeight / 2, window.innerHeight - card.offsetHeight - 4))}px`;
  }

  // インジケーターや線の表示設定が変わったら、チャートを作り直す
  function rebuild() {
    card.hidden = true;
    for (const [code, cell] of cells) {
      if (!cell.chart) continue;
      cell.chart.remove();
      cell.chart = null;
      if (state.bars.has(code)) {
        buildChart(cell, code);
        update(code);
      }
    }
  }

  // 見出し(終値・前日比・判定)と、利確 / 損切りのライン
  function update(code) {
    const cell = cells.get(code);
    if (!cell) return;
    const bars = state.bars.get(code)?.bars;
    const last = bars?.at(-1);
    const prev = bars?.at(-2);
    const chg = last && prev ? (last.close / prev.close - 1) * 100 : null;
    const j = ctx.judgmentOf(code);
    const r = j?.result;
    const tag = j?.loading
      ? `<span class="tag pending">判定中…</span>`
      : r
        ? `<span class="tag ${tagClass(r.verdict)}" title="${esc(r.reason)}">${esc(r.verdict)} ${esc(r.satisfied)}</span>`
        : `<span class="tag pending">未判定</span>`;
    cell.el.querySelector(".cell-info").innerHTML = `
      <b class="c-code">${esc(code)}</b>
      <span class="c-name" title="${esc(ctx.displayName(code))}">${esc(ctx.displayName(code))}</span>
      <span class="c-price">${num(last?.close)}</span>
      <span class="c-chg ${cls(chg)}">${signed(chg)}</span>
      ${tag}`;
    cell.el.querySelector('[data-act="judge"]').disabled = Boolean(j?.loading);

    if (!cell.candle) return;
    for (const l of cell.lines) cell.candle.removePriceLine(l);
    cell.lines = [];
    cell.markers.setMarkers(
      r && r.verdict !== "見送り" && last
        ? [{ time: last.date, position: "belowBar", shape: "arrowUp", color: r.verdict === "買い" ? C.up : C.amber, text: r.verdict }]
        : [],
    );
    if (!r) return;
    const add = (price, color, title) =>
      price != null &&
      cell.lines.push(cell.candle.createPriceLine({ price, color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title }));
    for (const t of r.sellPlan.takeProfit) add(t.price, C.up, "利確");
    add(r.sellPlan.stopLoss.price, C.down, "損切り");
  }

  // state.watch(並び順)と state.columns に合わせて、セルを作る・消す・並べ直す
  function render() {
    for (const [code, cell] of cells) {
      if (state.watch.includes(code)) continue;
      io.unobserve(cell.el);
      cell.chart?.remove();
      cell.el.remove();
      cells.delete(code);
    }
    // 既存のセルは appendChild で動かすだけなので、チャートは作り直さない
    for (const code of state.watch) {
      grid.appendChild(cells.get(code)?.el ?? createCell(code));
      update(code);
    }
    grid.style.gridTemplateColumns = `repeat(${state.columns}, minmax(0, 1fr))`;
    grid.style.gridAutoRows = `${ROW_HEIGHT[state.columns]}px`;
    $("#grid-empty").hidden = state.watch.length > 0;
    $("#grid-count").textContent = `${state.watch.length}銘柄`;
    for (const b of document.querySelectorAll("#grid-cols button")) b.classList.toggle("active", Number(b.dataset.cols) === state.columns);
  }

  function setColumns(n) {
    if (n === state.columns) return;
    state.columns = n;
    ctx.saveWatch();
    render();
    // チャートは幅が変わっても足の間隔を保つので、リサイズが済んでから表示範囲を合わせ直す
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        for (const [code, cell] of cells) {
          const n = state.bars.get(code)?.bars.length;
          if (cell.chart && n) setRange(cell, n);
        }
      }),
    );
  }

  // 並べ替え(一度だけ並べ直して保存する。その後はドラッグで自由に動かせる)
  const change = (code) => {
    const b = state.bars.get(code)?.bars;
    return b && b.length > 1 ? b.at(-1).close / b.at(-2).close - 1 : -Infinity;
  };
  const verdictRank = (code) => {
    const r = ctx.judgmentOf(code)?.result;
    return r ? { 買い: 0, 打診買い: 1, 見送り: 2 }[r.verdict] * 10 - Number(r.satisfied.split("/")[0]) : 99;
  };
  const SORTS = {
    verdict: (a, b) => verdictRank(a) - verdictRank(b),
    changeDesc: (a, b) => change(b) - change(a),
    changeAsc: (a, b) => change(a) - change(b),
    code: (a, b) => a.localeCompare(b),
  };

  $("#grid-cols").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-cols]");
    if (b) setColumns(Number(b.dataset.cols));
  });
  $("#grid-sort").addEventListener("change", (e) => {
    const sort = SORTS[e.target.value];
    e.target.value = "";
    if (sort) ctx.setWatch([...state.watch].sort(sort));
  });
  $("#grid-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("#grid-add input");
    if (ctx.addToWatch(input.value)) input.value = "";
  });
  grid.addEventListener("click", (e) => {
    const b = e.target.closest("button[data-act]");
    if (!b) return;
    const code = b.closest(".cell").dataset.code;
    if (b.dataset.act === "open") ctx.openChart(code);
    else if (b.dataset.act === "judge") ctx.runJudge(code);
    else if (b.dataset.act === "buy") ctx.openSim(code);
    else if (b.dataset.act === "remove") ctx.removeFromWatch(code);
  });

  return {
    render,
    update,
    applyBars,
    rebuild,
    updateAll: () => {
      for (const code of cells.keys()) update(code);
    },
  };
}
