import { useQuery } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useState } from "react";
import { changePercent, formatNumber, formatSigned, formatSignedYen, formatYen, signClass, verdictClass } from "../../lib/format";
import { readLocal, writeLocal } from "../../lib/local-storage";
import { simQuery, useBars, useJudgment, useNameLookup, useWatchActions, useWatchlist } from "../../lib/queries";
import type { SimSnapshot } from "../../lib/types";
import { setOrderCode, uiStore } from "../../lib/ui-store";
import { buildSimPlan, findPosition, formatPrice, LOT, readJudgment, useOrderBusy, usePlaceOrder } from "./order-state";

/**
 * 「関心銘柄から買う」の見出しと表を描く。関心銘柄を、その場で100株買えるように並べる。
 * 開閉はブラウザに覚えておく(キー simWatchCollapsed は以前の版と同じにして、保存済みの開閉を引き継ぐ)。
 */
export function WatchBuySection() {
  const { codes } = useWatchlist();
  const { data: account } = useQuery(simQuery);
  const orderCode = useSelector(uiStore, (s) => s.orderCode);
  const [collapsed, setCollapsed] = useState(() => readLocal("simWatchCollapsed", false));

  /**
   * 表を開く / 閉じるを切り替え、次に開いたときも同じ状態にする。
   */
  const toggleCollapsed = () => {
    writeLocal("simWatchCollapsed", !collapsed);
    setCollapsed(!collapsed);
  };

  return (
    <>
      <h4 className="sim-h">
        <button
          className="sim-toggle"
          type="button"
          aria-controls="sim-watch-wrap"
          aria-expanded={!collapsed}
          title={collapsed ? "クリックで開く" : "クリックで閉じる"}
          onClick={toggleCollapsed}
        >
          {collapsed ? `▸ 関心銘柄から買う(${codes.length}銘柄)` : "▾ 関心銘柄から買う"}
        </button>{" "}
        <span className="muted">(行をクリックすると注文欄に入れます)</span>
      </h4>

      <div id="sim-watch-wrap" className="table-wrap" hidden={collapsed}>
        <table id="sim-watch">
          <thead>
            <tr>
              <th>銘柄</th>
              <th className="num">現在値</th>
              <th className="num">前日比</th>
              <th>判定</th>
              <th className="num">100株の約定代金</th>
              <th className="num">利確で売ったら</th>
              <th className="num">損切りで売ったら</th>
              <th className="num">保有</th>
              <th className="num">買う</th>
              <th className="unwatch-col" />
            </tr>
          </thead>
          <tbody>
            {codes.length ? (
              codes.map((code) => <WatchBuyRow key={code} code={code} account={account} selected={code === orderCode} />)
            ) : (
              <tr className="empty">
                <td colSpan={10} className="muted">
                  関心銘柄がありません。チャートタブの ☆ や関心銘柄タブで追加できます
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * 関心銘柄の1行を描く。100株を今の株価で買ったときの代金と、利確・損切りラインで売ったときの損益を出す。
 */
function WatchBuyRow({ code, account, selected }: { code: string; account: SimSnapshot | undefined; selected: boolean }) {
  const bars = useBars(code);
  const judgment = readJudgment(useJudgment(code));
  const displayName = useNameLookup();
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const busy = useOrderBusy();
  const placeOrder = usePlaceOrder();
  const { remove } = useWatchActions();

  // 100株を今の株価で買ったときの代金
  const price = bars.data?.bars.at(-1)?.close ?? null;
  const chg = changePercent(bars.data?.bars);
  const amount = price ? price * LOT : null;
  const cash = account?.cash;
  const position = findPosition(account, code);
  const shortOfCash = amount != null && cash != null && amount > cash;

  // 利確ラインが複数あるときは近い方(先に届く方)で計算する
  const sellPlan = judgment.result?.sellPlan;
  const takeProfit = sellPlan?.takeProfit
    .flatMap((t) => (t.price == null ? [] : [t.price]))
    .sort((a, b) => a - b)[0];
  const stopLoss = sellPlan?.stopLoss.price ?? null;

  /**
   * この銘柄を注文欄に入れ、今の株価で100株買う。
   */
  const buyLot = () => {
    setOrderCode(code);
    void placeOrder({ code, side: "buy", shares: LOT, plan: buildSimPlan(judgment.result, strategy) });
  };

  return (
    <tr className={selected ? "selected" : ""} onClick={() => setOrderCode(code)}>
      <td>
        <span className="c-code">{code}</span> <span className="muted">{displayName(code)}</span>
      </td>
      <td className="num">{formatPrice(price)}</td>
      <td className={`num ${signClass(chg)}`}>{formatSigned(chg)}</td>
      <td>
        {judgment.loading ? (
          <span className="tag pending">…</span>
        ) : judgment.result ? (
          <span className={`tag ${verdictClass(judgment.result.verdict)}`}>{judgment.result.verdict}</span>
        ) : (
          <span className="tag pending">—</span>
        )}
      </td>
      <td className="num">{formatYen(amount)}</td>
      <td className="num">
        {takeProfit != null && price ? (
          <>
            {formatPrice(takeProfit)} → <span className={signClass(takeProfit - price)}>{formatSignedYen((takeProfit - price) * LOT)}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="num">
        {stopLoss != null && price ? (
          <>
            {formatPrice(stopLoss)} → <span className={signClass(stopLoss - price)}>{formatSignedYen((stopLoss - price) * LOT)}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="num">{position ? `${formatNumber(position.shares, 0)}株` : "—"}</td>
      <td className="num">
        <button
          className="tb-btn small primary buy"
          type="button"
          disabled={busy || !account || amount == null || shortOfCash}
          title={shortOfCash ? "現金が足りません" : "今の株価で100株買います"}
          onClick={(e) => {
            // 行のクリック(注文欄に入れるだけ)と二重に動かないよう止める
            e.stopPropagation();
            buyLot();
          }}
        >
          100株買う
        </button>
      </td>
      <td className="unwatch-col">
        <button
          className="c-btn del"
          type="button"
          title="関心銘柄から外す(保有株はそのまま)"
          onClick={(e) => {
            e.stopPropagation();
            remove(code);
          }}
        >
          ×
        </button>
      </td>
    </tr>
  );
}
