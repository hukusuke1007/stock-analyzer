// 株シミュレーター(仮想売買)タブ。元金から銘柄を買い、利確・損切りラインで売ったときの損益を見ながら売買する。
// 口座はサーバーの data/simulator.json に保存する(GET /sim・POST /sim/orders・POST /sim/reset)。実際には発注しない。
const LOT = 100; // サーバー(src/simulator.ts)と同じ。100株単位
const DEFAULT_INITIAL_CASH = 1_000_000;

export function createSimView(ctx) {
  const { state, esc, num, signed, cls, tagClass, api } = ctx;
  const $ = (sel) => document.querySelector(sel);
  const sim = {
    account: null, // GET /sim の結果
    loading: false,
    error: null,
    code: null, // 注文欄の銘柄
    shares: LOT,
    busy: false, // 注文中
    message: null, // 直前の約定・エラー { ok, text }
    inDialog: false, // 売買ダイアログ(チャート・スクリーナーから開く)を開いているか
  };

  const yen = (v) => (v == null ? "—" : `${num(v, 0)}円`);
  const signedYen = (v) => (v == null ? "—" : `${v > 0 ? "+" : ""}${num(v, 0)}円`);
  const price = (v) => num(v, 1);

  // ---------- 口座の読み込み ----------
  async function load() {
    sim.loading = true;
    renderSummary();
    try {
      sim.account = await api("/sim");
      sim.error = null;
    } catch (e) {
      sim.error = String(e.message ?? e);
    }
    sim.loading = false;
    renderAll();
  }

  // タブを開いたとき。注文欄が空なら、チャートで見ていた銘柄を入れる
  function show() {
    if (!sim.code && state.code) setCode(state.code);
    load();
  }

  function setCode(code) {
    sim.code = code;
    sim.message = null;
    renderOrder();
    renderWatch();
    ctx.loadBars(code).then(
      () => sim.code === code && renderOrder(),
      (e) => {
        if (sim.code !== code) return;
        sim.message = { ok: false, text: String(e.message ?? e) };
        renderOrder();
      },
    );
  }

  // ---------- 注文の計算 ----------
  const held = (code) => sim.account?.positions.find((p) => p.code === code) ?? null;
  const lastBar = (code) => state.bars.get(code)?.bars.at(-1) ?? null;
  const judgmentResult = (code) => ctx.judgmentOf(code)?.result ?? null;

  // 判定の売り方から、サーバーに保存する利確・損切りライン
  function planOf(code) {
    const r = judgmentResult(code);
    if (!r?.sellPlan) return null;
    const line = (l) => (l?.price == null ? null : { price: l.price, when: l.when });
    return {
      strategy: state.strategy,
      verdict: r.verdict,
      takeProfit: r.sellPlan.takeProfit.map(line).filter(Boolean),
      stopLoss: line(r.sellPlan.stopLoss),
    };
  }

  function maxBuyable(p) {
    const cash = sim.account?.cash ?? 0;
    return p ? Math.floor(cash / (p * LOT)) * LOT : 0;
  }

  // ---------- 描画 ----------
  function renderAll() {
    renderTradeFoot();
    renderHead();
    renderSummary();
    refreshOrder();
    renderWatch();
    renderPositions();
    renderTrades();
  }

  // 売買ダイアログの下に出す、今の現金と保有株数
  function renderTradeFoot() {
    if (!sim.inDialog) return;
    const a = sim.account;
    const pos = sim.code ? held(sim.code) : null;
    $("#trade-cash").textContent = a
      ? `現金(買付余力) ${yen(a.cash)}${pos ? ` · ${sim.code} を ${num(pos.shares, 0)}株保有` : ""}`
      : "";
  }

  function renderHead() {
    const a = sim.account;
    const input = $("#sim-initial");
    if (a && document.activeElement !== input) input.value = num(a.initialCash, 0);
    $("#sim-since").textContent = a
      ? `${new Date(a.createdAt).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" })} から`
      : "";
  }

  // 上部の元金の右: 現金と保有株を合わせた今の資産額
  function renderTotal() {
    const el = $("#sim-total");
    const a = sim.account;
    if (!a) {
      el.innerHTML = "";
      return;
    }
    const s = a.summary;
    el.innerHTML = `<span class="k">資産</span><b>${yen(s.total)}</b>
      <span class="${cls(s.pnl)}">${signedYen(s.pnl)} (${signed(s.pnlPct)})</span>
      <span class="muted">現金 ${yen(a.cash)} + 株 ${yen(s.marketValue)}</span>`;
  }

  function renderSummary() {
    renderTotal();
    const el = $("#sim-summary");
    if (sim.error) {
      el.innerHTML = `<div class="error">口座を読み込めませんでした: ${esc(sim.error)}</div>`;
      return;
    }
    const a = sim.account;
    if (!a) {
      el.innerHTML = `<div class="loading muted"><div class="spinner"></div>読み込み中…</div>`;
      return;
    }
    const s = a.summary;
    const card = (k, v, sub = "", c = "") =>
      `<div class="s-card"><div class="k">${esc(k)}</div><div class="v ${c}">${v}</div><div class="sub">${sub}</div></div>`;
    el.innerHTML =
      card("総資産", yen(s.total), `元金 ${yen(a.initialCash)}`) +
      card("損益(元金比)", signedYen(s.pnl), `<span class="${cls(s.pnlPct)}">${signed(s.pnlPct)}</span>`, cls(s.pnl)) +
      card("現金(買付余力)", yen(a.cash)) +
      card("保有株の評価額", yen(s.marketValue), `${a.positions.length}銘柄`) +
      card("含み損益", signedYen(s.unrealized), "保有株を今の株価で売ったら", cls(s.unrealized)) +
      card("実現損益", signedYen(s.realized), "売却済みの損益の合計", cls(s.realized)) +
      (sim.loading ? `<div class="s-loading"><div class="spinner"></div></div>` : "");
  }

  function renderOrder() {
    const el = $("#sim-order");
    const code = sim.code;
    const head = `<h4 class="sim-h">注文</h4>
      <form id="sim-code-form" class="sim-code" autocomplete="off">
        <input id="sim-code" class="filter" placeholder="証券コード (例: 7203)" value="${esc(code ?? "")}" spellcheck="false" />
        <button class="tb-btn small" type="submit">表示</button>
      </form>`;
    if (!code) {
      el.innerHTML = `${head}<div class="muted sim-note">証券コードを入れるか、チャートタブで銘柄を開いてから来てください</div>`;
      bindOrder();
      return;
    }
    const bar = lastBar(code);
    const bars = state.bars.get(code)?.bars;
    const prev = bars?.at(-2);
    const chg = bar && prev ? (bar.close / prev.close - 1) * 100 : null;
    const j = ctx.judgmentOf(code);
    const r = j?.result;
    const pos = held(code);

    const judgeHtml = j?.loading
      ? `<div class="loading muted"><div class="spinner"></div>判定中…</div>`
      : r
        ? `<div class="sim-judge"><span class="tag ${tagClass(r.verdict)}">${esc(r.verdict)}</span>
            <span class="muted">${esc(ctx.strategyLabel(true))} · 条件 ${esc(r.satisfied)} · ${esc(r.asOf)} 終値で判定</span></div>`
        : `<div class="sim-judge"><span class="muted">${esc(ctx.strategyLabel(true))}の判定がありません。利確・損切りラインは判定から出します</span>
            <button id="sim-judge" class="tb-btn small primary" type="button">判定する</button></div>`;

    el.innerHTML = `${head}
      <div class="sim-quote">
        <div><b class="c-code">${esc(code)}</b> <span class="muted">${esc(ctx.displayName(code))}</span>
          <button id="sim-open" class="c-btn" type="button" title="チャートタブで開く">↗</button></div>
        <div class="d-price"><span id="sim-last" class="last">${price(bar?.close)}</span>
          <span id="sim-chg" class="chg ${cls(chg)}">${chg == null ? "" : signed(chg)}</span>
          <span id="sim-date" class="muted small-label">${bar ? esc(bar.date) : ""}</span></div>
      </div>
      ${judgeHtml}
      <div class="sim-qty-row">
        <label class="muted small-label" for="sim-shares">株数</label>
        <input id="sim-shares" class="filter num" type="number" min="${LOT}" step="${LOT}" value="${sim.shares}" />
        <span class="muted small-label">株</span>
        <button class="c-btn" type="button" data-qty="${LOT}">100</button>
        <button class="c-btn" type="button" data-qty="max" title="現金で買える最大の株数">最大</button>
        ${pos ? `<button class="c-btn" type="button" data-qty="held" title="保有している株数">保有 ${num(pos.shares, 0)}</button>` : ""}
      </div>
      <div id="sim-calc"></div>
      <div class="sim-actions">
        <button id="sim-buy" class="tb-btn primary buy" type="button">買う</button>
        <button id="sim-sell" class="tb-btn primary sell" type="button" ${pos ? "" : "disabled"}>売る</button>
      </div>
      ${sim.message ? `<div class="sim-msg ${sim.message.ok ? "ok" : "error"}">${esc(sim.message.text)}</div>` : ""}`;
    bindOrder();
    renderCalc();
  }

  // 注文欄を出し直す。株数・銘柄の入力中(リアルタイム更新が来たときなど)は入力欄を作り直さない
  function refreshOrder() {
    const typing = document.activeElement?.tagName === "INPUT" && $("#sim-order").contains(document.activeElement);
    if (typing) updateQuote();
    else renderOrder();
  }

  // 株価だけ変わったとき。株数の入力中に作り直すと入力が途切れるので、価格と計算の部分だけ書き換える
  function updateQuote() {
    const bars = state.bars.get(sim.code)?.bars;
    const bar = bars?.at(-1);
    const prev = bars?.at(-2);
    const last = $("#sim-last");
    if (!bar || !last) return renderOrder();
    const chg = prev ? (bar.close / prev.close - 1) * 100 : null;
    last.textContent = price(bar.close);
    $("#sim-chg").textContent = chg == null ? "" : signed(chg);
    $("#sim-chg").className = `chg ${cls(chg)}`;
    $("#sim-date").textContent = bar.date;
    renderCalc();
  }

  // 株数を変えたときに書き換える部分(入力欄は作り直さない)
  function renderCalc() {
    const el = $("#sim-calc");
    if (!el) return;
    const code = sim.code;
    const bar = lastBar(code);
    const p = bar?.close;
    const shares = sim.shares;
    const valid = Number.isInteger(shares) && shares > 0 && shares % LOT === 0;
    const amount = p && valid ? p * shares : null;
    const cash = sim.account?.cash;
    const after = amount != null && cash != null ? cash - amount : null;
    const r = judgmentResult(code);
    const plan = r?.sellPlan;
    const pos = held(code);

    const rows = [];
    rows.push(`<div class="row"><span class="k">約定代金(概算)</span><b>${yen(amount)}</b></div>`);
    rows.push(
      `<div class="row"><span class="k">買った後の現金</span><b class="${after != null && after < 0 ? "down" : ""}">${yen(after)}</b></div>`,
    );
    rows.push(`<div class="row"><span class="k">現金で買える最大</span><b>${num(maxBuyable(p), 0)}株</b></div>`);
    if (!valid) rows.push(`<div class="error">株数は${LOT}株単位で入れてください</div>`);

    // 利確・損切りラインで売ったときの損益(今の株価で買った場合)
    let planHtml = "";
    if (plan && p && valid) {
      const tp = plan.takeProfit
        .filter((t) => t.price != null)
        .map(
          (t, i) => `<div class="box tp"><div class="k">利確${plan.takeProfit.length > 1 ? i + 1 : ""} ${price(t.price)}円 (${signed((t.price / p - 1) * 100)})</div>
            <div class="p">${signedYen((t.price - p) * shares)}</div><div class="w">${esc(t.when)}</div></div>`,
        )
        .join("");
      const sl = plan.stopLoss?.price != null
        ? `<div class="box sl"><div class="k">損切り ${price(plan.stopLoss.price)}円 (${signed((plan.stopLoss.price / p - 1) * 100)})</div>
            <div class="p">${signedYen((plan.stopLoss.price - p) * shares)}</div><div class="w">${esc(plan.stopLoss.when)}</div></div>`
        : "";
      planHtml = `<h4 class="sim-h">今の株価で${num(shares, 0)}株買って、ラインで売ったら</h4>
        <div class="plan">${tp || `<div class="box"><div class="w">利確ラインがありません</div></div>`}${sl}</div>
        ${plan.riskReward != null ? `<div class="plan-meta"><span>R/R <b>${esc(plan.riskReward)}</b></span><span>保有 <b>${esc(plan.holdingPeriod)}</b></span></div>` : ""}`;
    }

    // 保有中なら、今売ったときの損益
    const posHtml = pos
      ? `<h4 class="sim-h">保有中</h4>
        <div class="row"><span class="k">${num(pos.shares, 0)}株 · 取得単価</span><b>${price(pos.avgPrice)}円</b></div>
        <div class="row"><span class="k">${valid ? `${num(Math.min(shares, pos.shares), 0)}株を今売ったら` : "今売ったら"}</span>
          <b class="${cls(p - pos.avgPrice)}">${p && valid ? signedYen((p - pos.avgPrice) * Math.min(shares, pos.shares)) : "—"}</b></div>`
      : "";

    el.innerHTML = `<div class="sim-calc">${rows.join("")}</div>${planHtml}${posHtml}`;
    const buy = $("#sim-buy");
    const sell = $("#sim-sell");
    if (buy) buy.disabled = sim.busy || !valid || !p || after == null || after < 0;
    if (sell) sell.disabled = sim.busy || !valid || !pos || shares > pos.shares;
  }

  function bindOrder() {
    $("#sim-code-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = ctx.normalizeCode($("#sim-code").value);
      if (!/^[0-9A-Z]{4}$/.test(code)) {
        ctx.flash(`証券コードの形式ではありません: ${code}`);
        return;
      }
      setCode(code);
    });
    if (!sim.code) return;
    const code = sim.code;
    $("#sim-open").addEventListener("click", () => ctx.openChart(code));
    $("#sim-judge")?.addEventListener("click", async () => {
      await ctx.runJudge(code);
      if (sim.code === code) renderOrder();
    });
    $("#sim-shares").addEventListener("input", (e) => {
      sim.shares = Number(e.target.value);
      renderCalc();
    });
    for (const b of document.querySelectorAll("#sim-order [data-qty]")) {
      b.addEventListener("click", () => {
        const q = b.dataset.qty;
        sim.shares = q === "max" ? maxBuyable(lastBar(code)?.close) : q === "held" ? (held(code)?.shares ?? LOT) : Number(q);
        if (!sim.shares) sim.shares = LOT;
        $("#sim-shares").value = sim.shares;
        renderCalc();
      });
    }
    $("#sim-buy").addEventListener("click", () => order(code, "buy", sim.shares));
    $("#sim-sell").addEventListener("click", () => order(code, "sell", sim.shares));
  }

  async function order(code, side, shares) {
    if (sim.busy) return;
    sim.busy = true;
    renderCalc();
    try {
      const data = await api("/sim/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, side, shares, ...(side === "buy" ? { plan: planOf(code) } : {}) }),
      });
      const t = data.trade;
      sim.account = data.account;
      sim.message = {
        ok: true,
        text: `${t.side === "buy" ? "買い" : "売り"}: ${t.code} ${num(t.shares, 0)}株 × ${price(t.price)}円 = ${yen(t.amount)}${
          t.realized == null ? "" : ` · 実現損益 ${signedYen(t.realized)}`
        }`,
      };
    } catch (e) {
      sim.message = { ok: false, text: String(e.message ?? e) };
    }
    sim.busy = false;
    renderAll();
  }

  // 関心銘柄(ウォッチリスト)から、その場で100株買えるようにする
  function renderWatch() {
    renderWatchToggle(); // 閉じているときの銘柄数
    const el = $("#sim-watch");
    const head = `<thead><tr><th>銘柄</th><th class="num">現在値</th><th class="num">前日比</th><th>判定</th>
      <th class="num">100株の約定代金</th><th class="num">利確で売ったら</th><th class="num">損切りで売ったら</th>
      <th class="num">保有</th><th class="num">買う</th><th class="unwatch-col"></th></tr></thead>`;
    if (!state.watch.length) {
      el.innerHTML = `${head}<tbody><tr class="empty"><td colspan="10" class="muted">関心銘柄がありません。チャートタブの ☆ や関心銘柄タブで追加できます</td></tr></tbody>`;
      return;
    }
    const cash = sim.account?.cash;
    el.innerHTML = `${head}<tbody>${state.watch
      .map((code) => {
        const bars = state.bars.get(code)?.bars;
        const last = bars?.at(-1);
        const prev = bars?.at(-2);
        const chg = last && prev ? (last.close / prev.close - 1) * 100 : null;
        const j = ctx.judgmentOf(code);
        const r = j?.result;
        const p = last?.close;
        const amount = p ? p * LOT : null;
        // 利確ラインが複数あるときは近い方(先に届く方)
        const tp = r?.sellPlan?.takeProfit.filter((t) => t.price != null).sort((a, b) => a.price - b.price)[0];
        const sl = r?.sellPlan?.stopLoss?.price;
        const pos = held(code);
        const tag = j?.loading
          ? `<span class="tag pending">…</span>`
          : r
            ? `<span class="tag ${tagClass(r.verdict)}">${esc(r.verdict)}</span>`
            : `<span class="tag pending">—</span>`;
        const disabled = sim.busy || !sim.account || amount == null || amount > cash;
        return `<tr data-code="${esc(code)}" class="${code === sim.code ? "selected" : ""}">
          <td><span class="c-code">${esc(code)}</span> <span class="muted">${esc(ctx.displayName(code))}</span></td>
          <td class="num">${price(p)}</td>
          <td class="num ${cls(chg)}">${signed(chg)}</td>
          <td>${tag}</td>
          <td class="num">${yen(amount)}</td>
          <td class="num">${tp && p ? `${price(tp.price)} → <span class="${cls(tp.price - p)}">${signedYen((tp.price - p) * LOT)}</span>` : "—"}</td>
          <td class="num">${sl != null && p ? `${price(sl)} → <span class="${cls(sl - p)}">${signedYen((sl - p) * LOT)}</span>` : "—"}</td>
          <td class="num">${pos ? `${num(pos.shares, 0)}株` : "—"}</td>
          <td class="num"><button class="tb-btn small primary buy" type="button" data-buy="${esc(code)}" ${disabled ? "disabled" : ""}
            title="${amount != null && cash != null && amount > cash ? "現金が足りません" : "今の株価で100株買います"}">100株買う</button></td>
          <td class="unwatch-col"><button class="c-btn del" type="button" data-unwatch="${esc(code)}"
            title="関心銘柄から外す(保有株はそのまま)">×</button></td></tr>`;
      })
      .join("")}</tbody>`;
  }

  function renderPositions() {
    const el = $("#sim-positions");
    const list = sim.account?.positions ?? [];
    const head = `<thead><tr><th>銘柄</th><th class="num">株数</th><th class="num">取得単価</th><th class="num">現在値</th>
      <th class="num">評価額</th><th class="num">含み損益</th><th class="num">利確ライン → 損益</th><th class="num">損切りライン → 損益</th>
      <th>状態</th><th class="num">売却</th></tr></thead>`;
    if (!list.length) {
      el.innerHTML = `${head}<tbody><tr class="empty"><td colspan="10" class="muted">保有株はありません。左の注文欄から買えます</td></tr></tbody>`;
      return;
    }
    const lines = (arr) =>
      arr.length
        ? arr.map((l) => `<div>${price(l.price)} → <span class="${cls(l.pnl)}">${signedYen(l.pnl)}</span></div>`).join("")
        : `<span class="muted">—</span>`;
    const statusClass = { 利確ライン到達: "buy", 損切りライン到達: "sell-alert", 保有中: "pending" };
    el.innerHTML = `${head}<tbody>${list
      .map((p) => {
        const title = [
          ...(p.plan?.takeProfit ?? []).map((t) => `利確 ${t.price}: ${t.when}`),
          ...(p.plan?.stopLoss ? [`損切り ${p.plan.stopLoss.price}: ${p.plan.stopLoss.when}`] : []),
          ...(p.plan?.verdict ? [`買ったときの判定: ${p.plan.verdict}(${p.plan.strategy})`] : []),
        ].join("\n");
        return `<tr data-code="${esc(p.code)}" title="${esc(title)}">
          <td><span class="c-code">${esc(p.code)}</span> <span class="muted">${esc(ctx.displayName(p.code) || p.name)}</span></td>
          <td class="num">${num(p.shares, 0)}</td>
          <td class="num">${price(p.avgPrice)}</td>
          <td class="num">${p.priceError ? `<span class="error" title="${esc(p.priceError)}">取得失敗</span>` : price(p.price)}</td>
          <td class="num">${yen(p.value)}</td>
          <td class="num ${cls(p.unrealized)}">${signedYen(p.unrealized)}<small> ${signed(p.unrealizedPct)}</small></td>
          <td class="num">${lines(p.takeProfit)}</td>
          <td class="num">${lines(p.stopLoss ? [p.stopLoss] : [])}</td>
          <td><span class="tag ${statusClass[p.status] ?? "pending"}">${esc(p.status)}</span></td>
          <td class="num"><div class="sell-cell">
            <input class="filter num sim-sell-qty" type="number" min="${LOT}" step="${LOT}" max="${p.shares}" value="${p.shares}" title="売る株数" />
            <button class="tb-btn small danger" type="button" data-sell="${esc(p.code)}">売る</button>
          </div></td></tr>`;
      })
      .join("")}</tbody>`;
  }

  function renderTrades() {
    const el = $("#sim-trades");
    const list = sim.account?.trades ?? [];
    const head = `<thead><tr><th>日時</th><th>売買</th><th>銘柄</th><th class="num">株数</th><th class="num">約定単価</th>
      <th class="num">約定代金</th><th class="num">実現損益</th></tr></thead>`;
    if (!list.length) {
      el.innerHTML = `${head}<tbody><tr class="empty"><td colspan="7" class="muted">まだ売買していません</td></tr></tbody>`;
      return;
    }
    el.innerHTML = `${head}<tbody>${list
      .map(
        (t) => `<tr data-code="${esc(t.code)}">
          <td>${esc(new Date(t.at).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" }))}</td>
          <td><span class="tag ${t.side === "buy" ? "buy" : "sell-alert"}">${t.side === "buy" ? "買い" : "売り"}</span></td>
          <td><span class="c-code">${esc(t.code)}</span> <span class="muted">${esc(ctx.displayName(t.code) || t.name)}</span></td>
          <td class="num">${num(t.shares, 0)}</td>
          <td class="num" title="${esc(t.priceDate)} の日足">${price(t.price)}</td>
          <td class="num">${yen(t.amount)}</td>
          <td class="num ${cls(t.realized)}">${t.realized == null ? "—" : signedYen(t.realized)}</td></tr>`,
      )
      .join("")}</tbody>`;
  }

  // 「関心銘柄から買う」の開閉。ブラウザに覚えておく
  function renderWatchToggle() {
    const open = !ctx.store.get("simWatchCollapsed", false);
    $("#sim-watch-wrap").hidden = !open;
    const btn = $("#sim-watch-toggle");
    btn.textContent = `${open ? "▾" : "▸"} 関心銘柄から買う${open ? "" : `(${state.watch.length}銘柄)`}`;
    btn.setAttribute("aria-expanded", String(open));
    btn.title = open ? "クリックで閉じる" : "クリックで開く";
  }

  // ---------- イベント ----------
  function bind() {
    renderWatchToggle();
    $("#sim-watch-toggle").addEventListener("click", () => {
      ctx.store.set("simWatchCollapsed", !ctx.store.get("simWatchCollapsed", false));
      renderWatchToggle();
    });
    $("#sim-refresh").addEventListener("click", load);
    $("#sim-reset").addEventListener("submit", async (e) => {
      e.preventDefault();
      const raw = $("#sim-initial").value.replace(/[,,円\s]/g, "");
      const initialCash = raw === "" ? DEFAULT_INITIAL_CASH : Number(raw);
      if (!Number.isInteger(initialCash) || initialCash < 1) {
        ctx.flash("元金は1円以上の整数で入れてください");
        return;
      }
      if (!confirm(`保有株と売買履歴を消して、元金 ${num(initialCash, 0)}円で始め直します。よろしいですか?`)) return;
      try {
        sim.account = await api("/sim/reset", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ initialCash }),
        });
        sim.message = { ok: true, text: `元金 ${yen(initialCash)}で始め直しました` };
        sim.error = null;
      } catch (err) {
        ctx.flash(`始め直せませんでした: ${err.message ?? err}`);
      }
      renderAll();
    });
    $("#sim-positions").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-sell]");
      if (btn) {
        const shares = Number(btn.closest("td").querySelector(".sim-sell-qty").value);
        order(btn.dataset.sell, "sell", shares);
        return;
      }
      if (e.target.closest("input")) return;
      const tr = e.target.closest("tr[data-code]");
      if (tr) setCode(tr.dataset.code);
    });
    $("#sim-watch").addEventListener("click", (e) => {
      const unwatch = e.target.closest("[data-unwatch]");
      if (unwatch) {
        ctx.removeFromWatch(unwatch.dataset.unwatch); // 関心銘柄タブ・ウォッチリストからも外れる
        return;
      }
      const btn = e.target.closest("[data-buy]");
      if (btn) {
        setCode(btn.dataset.buy);
        order(btn.dataset.buy, "buy", LOT);
        return;
      }
      const tr = e.target.closest("tr[data-code]");
      if (tr) setCode(tr.dataset.code);
    });
    $("#sim-trades").addEventListener("click", (e) => {
      const tr = e.target.closest("tr[data-code]");
      if (tr) setCode(tr.dataset.code);
    });
  }

  // ---------- 売買ダイアログ ----------
  // チャートやスクリーナーから、タブを移らずに仮想売買する。
  // 計算と約定の処理を二重に持たないよう、シミュレーター タブの注文欄(#sim-order)をダイアログに移して使い、閉じたら戻す
  const orderHome = { parent: null, next: null };
  function openTrade(code) {
    const dialog = $("#trade-dialog");
    const order = $("#sim-order");
    if (!sim.inDialog) {
      orderHome.parent = order.parentNode;
      orderHome.next = order.nextSibling;
      $("#trade-body").append(order);
      sim.inDialog = true;
    }
    setCode(code);
    load();
    if (!dialog.open) dialog.showModal();
  }

  function closeTrade() {
    if (!sim.inDialog) return;
    orderHome.parent.insertBefore($("#sim-order"), orderHome.next);
    sim.inDialog = false;
  }

  function bindTrade() {
    const dialog = $("#trade-dialog");
    dialog.addEventListener("close", closeTrade);
    // 枠の外(背景)をクリックしたら閉じる
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    $("#trade-close").addEventListener("click", () => dialog.close());
    $("#trade-open-sim").addEventListener("click", () => {
      dialog.close();
      ctx.openSim(sim.code);
    });
    // 注文欄の「チャートタブで開く」(↗)はダイアログを閉じてから開く
    $("#trade-body").addEventListener(
      "click",
      (e) => {
        if (e.target.closest("#sim-open")) dialog.close();
      },
      true,
    );
  }

  bind();
  bindTrade();
  return {
    openTrade,
    show,
    load,
    setCode,
    // 注文欄の銘柄。リアルタイム更新で株価を取り直す対象に入れる
    orderCode: () => sim.code,
    // 判定し直した・株価を取り直したときなど。注文欄と関心銘柄の表を出し直す
    update(code) {
      if (sim.inDialog) {
        if (code === sim.code) refreshOrder();
        return;
      }
      if (state.view !== "sim") return;
      // 起動直後にシミュレーターを開いていた場合は、あとから開いた銘柄を注文欄に入れる
      if (!sim.code && code === state.code) setCode(code);
      else if (code === sim.code) refreshOrder();
      if (state.watch.includes(code)) renderWatch();
    },
    // 関心銘柄を足した・外した・並べ替えたとき
    renderWatch() {
      if (state.view === "sim") renderWatch();
    },
  };
}
