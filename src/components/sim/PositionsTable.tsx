import { useState } from "react";
import { formatNumber, formatSigned, formatSignedYen, formatYen, signClass } from "../../lib/format";
import { useNameLookup } from "../../lib/queries";
import type { SimPosition } from "../../lib/types";
import { setOrderCode } from "../../lib/ui-store";
import { formatPrice, LOT, usePlaceOrder } from "./order-state";

// 保有株の状態ごとのタグの色
const STATUS_CLASS: Record<SimPosition["status"], string> = { 利確ライン到達: "buy", 損切りライン到達: "sell-alert", 保有中: "pending" };

/**
 * 保有株の表を描く。行ごとに売る株数を入れて、その場で売れる。
 */
export function PositionsTable({ positions }: { positions: SimPosition[] }) {
  return (
    <table id="sim-positions">
      <thead>
        <tr>
          <th>銘柄</th>
          <th className="num">株数</th>
          <th className="num">取得単価</th>
          <th className="num">現在値</th>
          <th className="num">評価額</th>
          <th className="num">含み損益</th>
          <th className="num">利確ライン → 損益</th>
          <th className="num">損切りライン → 損益</th>
          <th>状態</th>
          <th className="num">売却</th>
        </tr>
      </thead>
      <tbody>
        {positions.length ? (
          // 株数が変わったら(一部を売ったら)売る株数の入力を今の保有株数に戻すため、キーに株数を含める
          positions.map((p) => <PositionRow key={`${p.code}:${p.shares}`} position={p} />)
        ) : (
          <tr className="empty">
            <td colSpan={10} className="muted">
              保有株はありません。左の注文欄から買えます
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

/**
 * 利確・損切りラインと、そこで売ったときの損益を縦に並べる。ラインがなければ「—」。
 */
function PlanLines({ lines }: { lines: { price: number; pnl: number }[] }) {
  if (!lines.length) {
    return <span className="muted">—</span>;
  }

  return (
    <>
      {lines.map((l, i) => (
        <div key={i}>
          {formatPrice(l.price)} → <span className={signClass(l.pnl)}>{formatSignedYen(l.pnl)}</span>
        </div>
      ))}
    </>
  );
}

/**
 * 保有株の1行を描く。行の上にカーソルを置くと、買ったときの利確・損切りラインと判定を出す。
 */
function PositionRow({ position: p }: { position: SimPosition }) {
  const displayName = useNameLookup();
  const placeOrder = usePlaceOrder();
  const [sellInput, setSellInput] = useState(String(p.shares));

  // 行の title(ツールチップ)に出す、買ったときの売り方
  const title = [
    ...(p.plan?.takeProfit ?? []).map((t) => `利確 ${t.price}: ${t.when}`),
    ...(p.plan?.stopLoss ? [`損切り ${p.plan.stopLoss.price}: ${p.plan.stopLoss.when}`] : []),
    ...(p.plan?.verdict ? [`買ったときの判定: ${p.plan.verdict}(${p.plan.strategy})`] : []),
  ].join("\n");

  return (
    <tr title={title} onClick={() => setOrderCode(p.code)}>
      <td>
        <span className="c-code">{p.code}</span> <span className="muted">{displayName(p.code) || p.name}</span>
      </td>
      <td className="num">{formatNumber(p.shares, 0)}</td>
      <td className="num">{formatPrice(p.avgPrice)}</td>
      <td className="num">
        {p.priceError ? (
          <span className="error" title={p.priceError}>
            取得失敗
          </span>
        ) : (
          formatPrice(p.price)
        )}
      </td>
      <td className="num">{formatYen(p.value)}</td>
      <td className={`num ${signClass(p.unrealized)}`}>
        {formatSignedYen(p.unrealized)}
        <small> {formatSigned(p.unrealizedPct)}</small>
      </td>
      <td className="num">
        <PlanLines lines={p.takeProfit} />
      </td>
      <td className="num">
        <PlanLines lines={p.stopLoss ? [p.stopLoss] : []} />
      </td>
      <td>
        <span className={`tag ${STATUS_CLASS[p.status] ?? "pending"}`}>{p.status}</span>
      </td>
      {/* 売る株数の入力・売るボタンのクリックで、行のクリック(注文欄に入れる)を動かさない */}
      <td className="num" onClick={(e) => e.stopPropagation()}>
        <div className="sell-cell">
          <input
            className="filter num sim-sell-qty"
            type="number"
            min={LOT}
            step={LOT}
            max={p.shares}
            value={sellInput}
            title="売る株数"
            onChange={(e) => setSellInput(e.target.value)}
          />
          <button
            className="tb-btn small danger"
            type="button"
            onClick={() => void placeOrder({ code: p.code, side: "sell", shares: Number(sellInput) })}
          >
            売る
          </button>
        </div>
      </td>
    </tr>
  );
}
