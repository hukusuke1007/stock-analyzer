import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { type FormEvent, useId, useState } from "react";
import { errorMessage } from "../../lib/api";
import {
  changePercent,
  formatNumber,
  formatSigned,
  formatSignedYen,
  formatYen,
  isStockCode,
  normalizeCode,
  signClass,
  verdictClass,
} from "../../lib/format";
import { simQuery, useBars, useJudgeStock, useJudgment, useNameLookup } from "../../lib/queries";
import type { JudgeResult, SimPosition } from "../../lib/types";
import { closeTradeDialog, setOrderCode, showFlash, uiStore } from "../../lib/ui-store";
import {
  buildSimPlan,
  computeMaxBuyableShares,
  findPosition,
  formatPrice,
  LOT,
  orderStore,
  readJudgment,
  useOrderBusy,
  usePlaceOrder,
  useShortStrategyLabel,
} from "./order-state";

/**
 * 注文欄を描く。シミュレーター タブの左側と売買ダイアログの中で、同じものを使う。
 * 銘柄は uiStore の orderCode で、どちらから開いても同じ銘柄を指す。
 */
export function OrderPanel() {
  const code = useSelector(uiStore, (s) => s.orderCode);

  return (
    <section className="sim-order">
      <h4 className="sim-h">注文</h4>
      {/* 銘柄が変わったら入力欄を今の銘柄で作り直す(株価の更新では作り直さないので、入力中は途切れない) */}
      <OrderCodeForm key={code ?? ""} code={code} />

      {code ? (
        <OrderDetail code={code} />
      ) : (
        <div className="muted sim-note">証券コードを入れるか、チャートタブで銘柄を開いてから来てください</div>
      )}
    </section>
  );
}

/**
 * 証券コードを入れて注文欄の銘柄を切り替えるフォームを描く。
 */
function OrderCodeForm({ code }: { code: string | null }) {
  const [input, setInput] = useState(code ?? "");

  /**
   * 入れたコードを注文欄の銘柄にする。コードの形でなければ上部バーで知らせる。
   */
  const selectInputCode = (e: FormEvent) => {
    e.preventDefault();

    const next = normalizeCode(input);
    if (!isStockCode(next)) {
      showFlash(`証券コードの形式ではありません: ${next}`);
      return;
    }

    setOrderCode(next);
  };

  return (
    <form className="sim-code" autoComplete="off" onSubmit={selectInputCode}>
      <input
        className="filter"
        placeholder="証券コード (例: 7203)"
        value={input}
        spellCheck={false}
        onChange={(e) => setInput(e.target.value)}
      />
      <button className="tb-btn small" type="submit">
        表示
      </button>
    </form>
  );
}

/**
 * 銘柄を選んだあとの注文欄(株価・判定・株数・計算・買う / 売る)を描く。
 */
function OrderDetail({ code }: { code: string }) {
  const navigate = useNavigate();
  const sharesId = useId();
  const bars = useBars(code);
  const { data: account } = useQuery(simQuery);
  const judgment = readJudgment(useJudgment(code));
  const judgeStock = useJudgeStock();
  const displayName = useNameLookup();
  const strategyLabel = useShortStrategyLabel();
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const message = useSelector(orderStore, (s) => s.message);
  const busy = useOrderBusy();
  const placeOrder = usePlaceOrder();
  // 株数は入力のまま持つ。数値にそろえると、消して打ち直す途中の空欄が 0 に変わってしまう
  const [sharesInput, setSharesInput] = useState(String(LOT));

  // 最新の足を今の株価として計算に使う
  const bar = bars.data?.bars.at(-1) ?? null;
  const price = bar?.close ?? null;
  const chg = changePercent(bars.data?.bars);
  const position = findPosition(account, code);
  const shares = Number(sharesInput);
  const valid = Number.isInteger(shares) && shares > 0 && shares % LOT === 0;
  const amount = price && valid ? price * shares : null;
  const cashAfter = amount != null && account ? account.cash - amount : null;

  // 直前の結果がこの銘柄のものなら出す。なければ株価を取れなかったことを出す
  const shownMessage =
    message && message.code === code ? message : bars.error ? { ok: false, text: errorMessage(bars.error) } : null;

  /**
   * 株数のボタン(100 / 最大 / 保有)の株数を入れる。0 株になるときは100株にする。
   */
  const fillShares = (kind: "lot" | "max" | "held") => {
    const next = kind === "max" ? computeMaxBuyableShares(account?.cash, price) : kind === "held" ? (position?.shares ?? LOT) : LOT;

    setSharesInput(String(next || LOT));
  };

  /**
   * チャートタブで銘柄を開く。売買ダイアログから押したときは、ダイアログを閉じてから移る。
   */
  const openChart = () => {
    closeTradeDialog();
    void navigate({ to: "/", search: { code } });
  };

  return (
    <>
      <div className="sim-quote">
        <div>
          <b className="c-code">{code}</b> <span className="muted">{displayName(code)}</span>{" "}
          <button className="c-btn" type="button" title="チャートタブで開く" onClick={openChart}>
            ↗
          </button>
        </div>
        <div className="d-price">
          <span className="last">{formatPrice(price)}</span>{" "}
          <span className={`chg ${signClass(chg)}`}>{chg == null ? "" : formatSigned(chg)}</span>{" "}
          <span className="muted small-label">{bar?.date ?? ""}</span>
        </div>
      </div>

      {judgment.loading ? (
        <div className="loading muted">
          <div className="spinner" />
          判定中…
        </div>
      ) : judgment.result ? (
        <div className="sim-judge">
          <span className={`tag ${verdictClass(judgment.result.verdict)}`}>{judgment.result.verdict}</span>{" "}
          <span className="muted">
            {strategyLabel} · 条件 {judgment.result.satisfied} · {judgment.result.asOf} 終値で判定
          </span>
        </div>
      ) : (
        <div className="sim-judge">
          <span className="muted">{strategyLabel}の判定がありません。利確・損切りラインは判定から出します</span>{" "}
          <button className="tb-btn small primary" type="button" onClick={() => void judgeStock(code)}>
            判定する
          </button>
        </div>
      )}

      <div className="sim-qty-row">
        <label className="muted small-label" htmlFor={sharesId}>
          株数
        </label>
        <input
          id={sharesId}
          className="filter num"
          type="number"
          min={LOT}
          step={LOT}
          value={sharesInput}
          onChange={(e) => setSharesInput(e.target.value)}
        />
        <span className="muted small-label">株</span>
        <button className="c-btn" type="button" onClick={() => fillShares("lot")}>
          100
        </button>
        <button className="c-btn" type="button" title="現金で買える最大の株数" onClick={() => fillShares("max")}>
          最大
        </button>
        {position && (
          <button className="c-btn" type="button" title="保有している株数" onClick={() => fillShares("held")}>
            保有 {formatNumber(position.shares, 0)}
          </button>
        )}
      </div>

      <div className="sim-calc">
        <div className="row">
          <span className="k">約定代金(概算)</span>
          <b>{formatYen(amount)}</b>
        </div>
        <div className="row">
          <span className="k">買った後の現金</span>
          <b className={cashAfter != null && cashAfter < 0 ? "down" : ""}>{formatYen(cashAfter)}</b>
        </div>
        <div className="row">
          <span className="k">現金で買える最大</span>
          <b>{formatNumber(computeMaxBuyableShares(account?.cash, price), 0)}株</b>
        </div>
        {!valid && <div className="error">株数は{LOT}株単位で入れてください</div>}
      </div>

      {judgment.result && price && valid && <PlanBoxes result={judgment.result} price={price} shares={shares} />}
      {position && <HoldingRows position={position} price={price} shares={valid ? shares : null} />}

      <div className="sim-actions">
        <button
          className="tb-btn primary buy"
          type="button"
          disabled={busy || !valid || !price || cashAfter == null || cashAfter < 0}
          onClick={() => void placeOrder({ code, side: "buy", shares, plan: buildSimPlan(judgment.result, strategy) })}
        >
          買う
        </button>
        <button
          className="tb-btn primary sell"
          type="button"
          disabled={busy || !valid || !position || shares > position.shares}
          onClick={() => void placeOrder({ code, side: "sell", shares })}
        >
          売る
        </button>
      </div>

      {shownMessage && <div className={`sim-msg ${shownMessage.ok ? "ok" : "error"}`}>{shownMessage.text}</div>}
    </>
  );
}

/**
 * 今の株価で買って、判定の利確・損切りラインで売ったときの損益を箱で並べる。
 */
function PlanBoxes({ result, price, shares }: { result: JudgeResult; price: number; shares: number }) {
  const plan = result.sellPlan;
  // 価格が出ていない利確ライン(条件だけのもの)は損益を計算できないので出さない
  const takeProfits = plan.takeProfit.filter((t): t is { price: number; pct: number | null; when: string } => t.price != null);
  const stopLoss = plan.stopLoss.price;

  return (
    <>
      <h4 className="sim-h">今の株価で{formatNumber(shares, 0)}株買って、ラインで売ったら</h4>
      <div className="plan">
        {takeProfits.length ? (
          takeProfits.map((t, i) => (
            <div key={i} className="box tp">
              <div className="k">
                利確{plan.takeProfit.length > 1 ? i + 1 : ""} {formatPrice(t.price)}円 ({formatSigned((t.price / price - 1) * 100)})
              </div>
              <div className="p">{formatSignedYen((t.price - price) * shares)}</div>
              <div className="w">{t.when}</div>
            </div>
          ))
        ) : (
          <div className="box">
            <div className="w">利確ラインがありません</div>
          </div>
        )}

        {stopLoss != null && (
          <div className="box sl">
            <div className="k">
              損切り {formatPrice(stopLoss)}円 ({formatSigned((stopLoss / price - 1) * 100)})
            </div>
            <div className="p">{formatSignedYen((stopLoss - price) * shares)}</div>
            <div className="w">{plan.stopLoss.when}</div>
          </div>
        )}
      </div>

      {plan.riskReward != null && (
        <div className="plan-meta">
          <span>
            R/R <b>{plan.riskReward}</b>
          </span>
          <span>
            保有 <b>{plan.holdingPeriod}</b>
          </span>
        </div>
      )}
    </>
  );
}

/**
 * 保有中の銘柄について、取得単価と、入れた株数を今売ったときの損益を出す。
 * shares が null(株数が100株単位でない)なら損益は出さない。
 */
function HoldingRows({ position, price, shares }: { position: SimPosition; price: number | null; shares: number | null }) {
  // 持っている株数より多くは売れないので、保有株数で頭打ちにして計算する
  const sellShares = shares == null ? null : Math.min(shares, position.shares);
  const pnl = price && sellShares != null ? (price - position.avgPrice) * sellShares : null;

  return (
    <>
      <h4 className="sim-h">保有中</h4>
      <div className="row">
        <span className="k">{formatNumber(position.shares, 0)}株 · 取得単価</span>
        <b>{formatPrice(position.avgPrice)}円</b>
      </div>
      <div className="row">
        <span className="k">{sellShares == null ? "今売ったら" : `${formatNumber(sellShares, 0)}株を今売ったら`}</span>
        <b className={signClass(price == null ? null : price - position.avgPrice)}>{pnl == null ? "—" : formatSignedYen(pnl)}</b>
      </div>
    </>
  );
}
