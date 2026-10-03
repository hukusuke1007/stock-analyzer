import { useSelector } from "@tanstack/react-store";
import { C } from "../../lib/chart-theme";
import { changePercent, formatDateTime, formatNumber, formatSigned, signClass, verdictClass } from "../../lib/format";
import { decisionOf, type JudgmentState, useHealth, useJudgeStock, useNameLookup, useStrategies, useWatchActions, useWatchlist } from "../../lib/queries";
import type { BarsResponse, JudgeResult, Options } from "../../lib/types";
import { openTradeDialog, setNewsDraft, uiStore } from "../../lib/ui-store";

// 決算発表までこの営業日数以内なら「見送り」(サーバーの src/server/api.ts と同じ)
const EARNINGS_BLOCK_DAYS = 5;

/**
 * 判定に使った材料の説明(テクニカルのみ / テクニカル + 決算・ニュース)。
 */
export function describeOptions(o: Partial<Options> | undefined): string {
  if (!o?.earnings && !o?.news) {
    return "テクニカルのみ";
  }

  return `テクニカル + ${[o.earnings && "決算", o.news && "ニュース"].filter(Boolean).join("・")}`;
}

/**
 * 決算の近さで色を変えるクラス。見送りになる近さは赤、保有期間中なら黄。
 */
export function earningsClass(next: { businessDays: number } | null | undefined, maxHoldingDays: number): string {
  if (!next) {
    return "";
  }
  if (next.businessDays <= EARNINGS_BLOCK_DAYS) {
    return "down";
  }

  return next.businessDays <= maxHoldingDays ? "warn" : "";
}

// ニュースのリンクは https のものだけを開けるようにする(javascript: などを踏ませない)
const safeUrl = (u: string | undefined) => (/^https:\/\//.test(u ?? "") ? u : null);

type Props = { code: string | null; barsData: BarsResponse | undefined; loadError: string | null; judgment: JudgmentState };

/**
 * 右パネル下段の判定の詳細。判定・買いの条件・売り方・材料・ランキング・Decisions・懸念点と、ニュースの入力欄。
 */
export function DetailPanel({ code, barsData, loadError, judgment }: Props) {
  const strategies = useStrategies();
  const strategyId = useSelector(uiStore, (s) => s.strategy);
  const options = useSelector(uiStore, (s) => s.options);
  const news = useSelector(uiStore, (s) => (code ? (s.news[code] ?? "") : ""));
  const { data: health } = useHealth();
  const judgeStock = useJudgeStock();
  const watch = useWatchlist();
  const watchActions = useWatchActions();
  const nameOf = useNameLookup();
  const strategy = strategies.find((s) => s.id === strategyId);
  const strategyLabel = strategy?.label ?? strategyId;

  if (!code) {
    return (
      <section id="detail" className="detail">
        <div className="empty">銘柄を選ぶと、{strategyLabel}の判定が表示されます</div>
      </section>
    );
  }

  const bars = barsData?.bars;
  const last = bars?.at(-1);
  const prev = bars?.at(-2);
  const chg = changePercent(bars);
  const r = judgment && "result" in judgment ? judgment.result : null;
  const watched = watch.codes.includes(code);
  const chartUrl = r?.chartUrl ?? `https://finance.yahoo.co.jp/quote/${encodeURIComponent(code)}.T/chart`;
  const loading = judgment !== null && "loading" in judgment;

  return (
    <section id="detail" className="detail">
      <div className="d-head">
        <span className="code">{code}</span>
        <span className="tag pass">{strategyLabel.replace(/[((].*$/, "")}</span>
        <div className="spacer" />
        <button id="sim-btn" className="star" type="button" title="株シミュレーターでこの銘柄を仮想売買します(売買ダイアログ)" onClick={() => openTradeDialog(code)}>
          売買
        </button>
        <button className={`star ${watched ? "on" : ""}`} type="button" title={watched ? "クリックで関心銘柄から外す" : "関心銘柄(ウォッチリスト)に追加"} onClick={() => watchActions.toggle(code)}>
          {watched ? "★ 関心銘柄" : "☆ 関心銘柄に追加"}
        </button>
      </div>
      <div className="d-name">{nameOf(code)}</div>
      <div className="d-price">
        <span className="last">{formatNumber(last?.close)}</span>
        <span className={`chg ${signClass(chg)}`}>{last && prev ? `${formatSigned(last.close - prev.close, 1, "")} (${formatSigned(chg)})` : ""}</span>
      </div>

      <VerdictCard judgment={judgment} hasBars={Boolean(barsData)} loadError={loadError} decisionsAvailable={health?.decisions.available ?? false} options={options} />

      {r && <ChecksSection result={r} />}
      {r && <SellPlanSection result={r} />}
      {r && <MaterialsSection result={r} maxHoldingDays={strategy?.maxHoldingDays ?? 10} />}
      {r?.ranking && (
        <div className="d-sec">
          <h4>AI ランキング</h4>
          <div className="plan-meta">
            <span>
              順位 <b>{r.ranking.rank}位</b>
            </span>
            <span>
              スコア <b>{Math.round(r.ranking.score)}</b>
            </span>
          </div>
          <div className="reason">{r.ranking.reason}</div>
        </div>
      )}
      {r && <DecisionSection result={r} />}
      {r && r.concerns.length > 0 && (
        <div className="d-sec">
          <h4>懸念点</h4>
          <ul className="signals">
            {r.concerns.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="d-sec news">
        <h4>ニュース(材料)</h4>
        <textarea placeholder="調べたニュースを貼ると、Decisions が悪材料かどうかも判定します" value={news} onChange={(e) => setNewsDraft(code, e.target.value)} />
        <div className="row">
          <button className="tb-btn primary small" type="button" disabled={loading} onClick={() => judgeStock(code)}>
            {news.trim() ? "ニュース込みで再判定" : "再判定"}
          </button>
          <div className="spacer" />
          <a href={chartUrl} target="_blank" rel="noopener">
            Yahoo!ファイナンス ↗
          </a>
        </div>
      </div>
      <div className="disclaimer">選択した売買ルールに照らした機械的な判定のサンプルであり、投資助言ではありません。株価は {barsData?.source ?? "Yahoo Finance"}。</div>
    </section>
  );
}

/**
 * 判定の見出しのカード。読み込み中・失敗・判定なしもここに出す。
 */
function VerdictCard({ judgment, hasBars, loadError, decisionsAvailable, options }: {
  judgment: JudgmentState;
  hasBars: boolean;
  loadError: string | null;
  decisionsAvailable: boolean;
  options: Options;
}) {
  if (loadError) {
    return (
      <div className="verdict-card">
        <div className="error">{loadError}</div>
      </div>
    );
  }
  // 結果をクリアした直後など。日足は取れているが判定がない
  if (!judgment && hasBars) {
    return (
      <div className="verdict-card">
        <div className="reason">判定結果はありません。上の「判定」で調べます</div>
      </div>
    );
  }
  if (!judgment || "loading" in judgment) {
    return (
      <div className="verdict-card">
        <div className="loading">
          <div className="spinner" />
          {decisionsAvailable ? "AI に判定を問い合わせ中…" : "判定中…"}
        </div>
      </div>
    );
  }
  if ("error" in judgment) {
    return (
      <div className="verdict-card">
        <div className="error">{judgment.error}</div>
      </div>
    );
  }

  const r = judgment.result;
  const sameOptions = Boolean(r.options?.earnings) === options.earnings && Boolean(r.options?.news) === options.news;

  return (
    <div className={`verdict-card ${verdictClass(r.verdict)}`}>
      <div className="v">
        <strong>{r.verdict}</strong>
        <span className="sat">
          条件 {r.satisfied} · {r.asOf} 終値
        </span>
      </div>
      <div className="reason">
        {r.reason}
        {judgment.fromScreen ? "(スクリーナーの結果)" : ""}
      </div>
      {r.judgedAt && <div className="reason">{formatDateTime(r.judgedAt)} に判定・保存</div>}
      <div className="reason">
        材料: {describeOptions(r.options)}
        {!sameOptions && <span className="warn">(今の材料の設定と違います。「判定」で出し直せます)</span>}
      </div>
    </div>
  );
}

/**
 * 買いの条件の一覧(満たした / 満たしていない)。
 */
function ChecksSection({ result }: { result: JudgeResult }) {
  return (
    <div className="d-sec">
      <h4>買いの条件</h4>
      <ul className="checks">
        {result.checks.map((c, i) => (
          <li key={i} className={c.ok ? "ok" : "ng"}>
            <span className="mark">{c.ok ? "✓" : "✗"}</span>
            <div>
              <div className="lbl">{c.label}</div>
              <div className="val">{c.value}</div>
              <div className="crit">基準 {c.criterion}</div>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 売り方(利確・損切りライン、R/R、保有期間、売るタイミングの指標)。
 */
function SellPlanSection({ result }: { result: JudgeResult }) {
  const plan = result.sellPlan;
  const cost = result.technicals.costFor100Shares;

  return (
    <div className="d-sec">
      <h4>売り方</h4>
      <div className="plan">
        {plan.takeProfit.map((t, i) => (
          <div key={i} className="box tp">
            <div className="k">利確{plan.takeProfit.length > 1 ? i + 1 : ""}</div>
            <div className="p">{formatNumber(t.price)}</div>
            <div className="w">
              <span className={signClass(t.pct)}>{formatSigned(t.pct)}</span> {t.when}
            </div>
          </div>
        ))}
        <div className="box sl">
          <div className="k">損切り</div>
          <div className="p">{formatNumber(plan.stopLoss.price)}</div>
          <div className="w">
            <span className={signClass(plan.stopLoss.pct)}>{formatSigned(plan.stopLoss.pct)}</span> {plan.stopLoss.when}
          </div>
        </div>
      </div>
      <div className="plan-meta">
        <span>
          R/R <b>{plan.riskReward ?? "—"}</b>
        </span>
        <span>
          保有 <b>{plan.holdingPeriod}</b>
        </span>
        <span>
          100株 <b>{formatNumber(typeof cost === "number" ? cost : null, 0)}円</b>
        </span>
      </div>
      <ul className="signals">
        {plan.signals.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 決算(次回の発表日・権利落ち日)とニュースの見出し。材料のオプションで調べたときだけ出す。
 */
function MaterialsSection({ result, maxHoldingDays }: { result: JudgeResult; maxHoldingDays: number }) {
  const m = result.materials;
  if (!m || (m.earnings == null && m.news == null)) {
    return null;
  }

  const next = m.earnings?.next;

  return (
    <div className="d-sec materials">
      <h4>決算・ニュース</h4>
      {m.earnings &&
        (next ? (
          <div className="mat-row">
            <span className="k">次回決算</span>
            <span className={earningsClass(next, maxHoldingDays)}>
              <b>{next.date}</b> あと{next.businessDays}営業日
            </span>
            <span className="muted">
              {next.source}
              {next.confirmed ? "(確定)" : "(推定)"}
              {next.period ? ` · ${next.period}` : ""}
            </span>
          </div>
        ) : (
          <div className="mat-row">
            <span className="k">次回決算</span>
            <span className="muted">不明(JPX・Yahoo に予定日がない)</span>
          </div>
        ))}
      {m.earnings?.exDividend && (
        <div className="mat-row">
          <span className="k">権利落ち日</span>
          <span>{m.earnings.exDividend}</span>
        </div>
      )}
      {m.news &&
        (m.news.length ? (
          <ul className="news-list">
            {m.news.map((n, i) => {
              const url = safeUrl(n.link);

              return (
                <li key={i}>
                  {url ? (
                    <a href={url} target="_blank" rel="noopener noreferrer">
                      {n.title}
                    </a>
                  ) : (
                    n.title
                  )}
                  <small>
                    {n.source} · {n.published}
                  </small>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="muted" style={{ fontSize: 12 }}>
            直近7日のニュースは見つかりませんでした
          </div>
        ))}
    </div>
  );
}

/**
 * Decisions の答え(判定ごとの確率・値動きの読み取り・悪材料)を棒で出す。
 */
function DecisionSection({ result }: { result: JudgeResult }) {
  const dec = decisionOf(result);
  const bar = (label: string, p: number, color: string) => (
    <div className="pr" key={label}>
      <span>{label}</span>
      <div className="track">
        <div className="fill" style={{ width: `${Math.round(p * 100)}%`, background: color }} />
      </div>
      <span className="pv">{Math.round(p * 100)}%</span>
    </div>
  );

  return (
    <div className="d-sec probs">
      <h4>Decisions</h4>
      {dec ? (
        <>
          {bar("買い", dec.verdictProbabilities.買い, C.up)}
          {bar("打診買い", dec.verdictProbabilities.打診買い, C.amber)}
          {bar("見送り", dec.verdictProbabilities.見送り, C.muted)}
          {bar(dec.qualitative.label, dec.qualitative.probability, C.blue)}
          {dec.badNews != null && bar("悪材料", dec.badNews, C.down)}
          <div className="model">
            {{ jev: "Jev", codex: "Codex", "workers-ai": "Workers AI" }[dec.provider]} / model: {dec.model}
          </div>
        </>
      ) : (
        <div className="muted" style={{ fontSize: 12 }}>
          Decisions を使えないため、数値条件だけで判定しています
        </div>
      )}
    </div>
  );
}
