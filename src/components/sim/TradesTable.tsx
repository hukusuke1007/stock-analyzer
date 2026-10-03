import { formatDateTime, formatNumber, formatSignedYen, formatYen, signClass } from "../../lib/format";
import { useNameLookup } from "../../lib/queries";
import type { Trade } from "../../lib/types";
import { setOrderCode } from "../../lib/ui-store";
import { formatPrice } from "./order-state";

/**
 * 売買履歴の表を描く。行をクリックすると、その銘柄を注文欄に入れる。
 */
export function TradesTable({ trades }: { trades: Trade[] }) {
  const displayName = useNameLookup();

  return (
    <table id="sim-trades">
      <thead>
        <tr>
          <th>日時</th>
          <th>売買</th>
          <th>銘柄</th>
          <th className="num">株数</th>
          <th className="num">約定単価</th>
          <th className="num">約定代金</th>
          <th className="num">実現損益</th>
        </tr>
      </thead>
      <tbody>
        {trades.length ? (
          trades.map((t) => (
            <tr key={t.id} onClick={() => setOrderCode(t.code)}>
              <td>{formatDateTime(t.at)}</td>
              <td>
                <span className={`tag ${t.side === "buy" ? "buy" : "sell-alert"}`}>{t.side === "buy" ? "買い" : "売り"}</span>
              </td>
              <td>
                <span className="c-code">{t.code}</span> <span className="muted">{displayName(t.code) || t.name}</span>
              </td>
              <td className="num">{formatNumber(t.shares, 0)}</td>
              <td className="num" title={`${t.priceDate} の日足`}>
                {formatPrice(t.price)}
              </td>
              <td className="num">{formatYen(t.amount)}</td>
              <td className={`num ${signClass(t.realized)}`}>{t.realized == null ? "—" : formatSignedYen(t.realized)}</td>
            </tr>
          ))
        ) : (
          <tr className="empty">
            <td colSpan={7} className="muted">
              まだ売買していません
            </td>
          </tr>
        )}
      </tbody>
    </table>
  );
}
