import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { formatNumber, formatYen } from "../../lib/format";
import { simQuery } from "../../lib/queries";
import { closeTradeDialog, uiStore } from "../../lib/ui-store";
import { Modal } from "../common/Modal";
import { findPosition } from "./order-state";
import { OrderPanel } from "./OrderPanel";

/**
 * 売買ダイアログを描く。チャートやスクリーナーから、タブを移らずに仮想売買する。
 * 計算と約定の処理を二重に持たないよう、中身はシミュレーター タブと同じ注文欄(OrderPanel)を使う。
 */
export function TradeDialog() {
  const open = useSelector(uiStore, (s) => s.trade.open);

  return (
    <Modal open={open} onClose={closeTradeDialog} className="settings-dialog trade-dialog" labelledBy="trade-title">
      <div className="settings-head trade-head">
        <h2 id="trade-title">
          売買 <span className="tag pending">仮想売買・実際には発注しません</span>
        </h2>
        <button type="button" className="settings-close" aria-label="閉じる" onClick={closeTradeDialog}>
          ×
        </button>
      </div>
      <div className="trade-body">
        <OrderPanel />
      </div>
      <TradeFoot />
    </Modal>
  );
}

/**
 * ダイアログの下に、今の現金と注文欄の銘柄の保有株数、シミュレーター タブへのリンクを出す。
 */
function TradeFoot() {
  const navigate = useNavigate();
  const { data: account } = useQuery(simQuery);
  const code = useSelector(uiStore, (s) => s.orderCode);
  const position = code ? findPosition(account, code) : null;

  /**
   * ダイアログを閉じて、同じ銘柄を注文欄に入れたままシミュレーター タブを開く。
   */
  const openSimulator = () => {
    closeTradeDialog();
    void navigate({ to: "/sim" });
  };

  return (
    <div className="trade-foot">
      <span className="muted">
        {account ? `現金(買付余力) ${formatYen(account.cash)}${position ? ` · ${code} を ${formatNumber(position.shares, 0)}株保有` : ""}` : ""}
      </span>
      <button type="button" className="tb-btn small" onClick={openSimulator}>
        シミュレーターを開く ↗
      </button>
    </div>
  );
}
