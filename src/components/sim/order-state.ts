import { useQueryClient } from "@tanstack/react-query";
import { Store, useSelector } from "@tanstack/react-store";
import { useCallback } from "react";
import { errorMessage, requestApi } from "../../lib/api";
import { formatNumber, formatSignedYen, formatYen } from "../../lib/format";
import { type JudgmentState, queryKeys, useStrategies } from "../../lib/queries";
import type { JudgeResult, SimOrderResponse, SimPlan, SimPosition, SimSnapshot, Trade } from "../../lib/types";
import { uiStore } from "../../lib/ui-store";

// シミュレーターの注文の状態と計算。注文欄はシミュレーター タブと売買ダイアログの両方に出し、
// 関心銘柄の表・保有株の表からも注文するので、注文中の印と直前の結果はここに1つだけ持つ

export const LOT = 100; // サーバー(src/server/simulator.ts)と同じ。100株単位
export const DEFAULT_INITIAL_CASH = 1_000_000;

// 直前の約定・エラー。どの銘柄の注文の結果かを持ち、注文欄の銘柄が変わったら出さない
export type OrderMessage = { ok: boolean; text: string; code: string | null };

type OrderState = {
  busy: boolean; // 注文中。二重に発注しないよう、どの画面の買う / 売るボタンも止める
  message: OrderMessage | null;
};

export const orderStore = new Store<OrderState>({ busy: false, message: null });

export type SimOrder = { code: string; side: "buy" | "sell"; shares: number; plan?: SimPlan | null };

/**
 * 注文欄に直前の結果を出す。
 */
export function showOrderMessage(message: OrderMessage) {
  orderStore.setState((s) => ({ ...s, message }));
}

/**
 * 株価を小数1桁で書く(チャートや判定の詳細の株価と同じ桁にそろえる)。
 */
export function formatPrice(v: number | null | undefined): string {
  return formatNumber(v, 1);
}

/**
 * 今の現金で買える最大の株数を100株単位で返す。株価が分からなければ 0。
 */
export function computeMaxBuyableShares(cash: number | undefined, price: number | null | undefined): number {
  if (!price) {
    return 0;
  }

  return Math.floor((cash ?? 0) / (price * LOT)) * LOT;
}

/**
 * 保有株の中から銘柄を探す。持っていなければ null。
 */
export function findPosition(account: SimSnapshot | undefined, code: string): SimPosition | null {
  return account?.positions.find((p) => p.code === code) ?? null;
}

/**
 * 判定の売り方から、買い注文と一緒にサーバーへ保存する利確・損切りラインを作る。
 * 判定がなければ null(ラインなしで買う)。
 */
export function buildSimPlan(result: JudgeResult | null, strategy: string): SimPlan | null {
  if (!result?.sellPlan) {
    return null;
  }

  // 価格が出ていないライン(条件だけのもの)は、保有株の表で損益を出せないので送らない
  const toLine = (l: { price: number | null; when: string } | null | undefined) => (l?.price == null ? null : { price: l.price, when: l.when });

  return {
    strategy,
    verdict: result.verdict,
    takeProfit: result.sellPlan.takeProfit.map(toLine).filter((l): l is { price: number; when: string } => l !== null),
    stopLoss: toLine(result.sellPlan.stopLoss),
  };
}

/**
 * 判定の状態から、判定結果と判定中かどうかを取り出す。
 * 判定の失敗は「判定なし」と同じに扱う(注文欄では「判定する」ボタンを出して、もう一度判定できるようにするため)。
 */
export function readJudgment(j: JudgmentState): { result: JudgeResult | null; loading: boolean } {
  if (!j) {
    return { result: null, loading: false };
  }

  if ("result" in j) {
    return { result: j.result, loading: false };
  }

  return { result: null, loading: "loading" in j };
}

/**
 * 約定した内容を、注文欄に出す1行の文にする。
 */
function describeTrade(t: Trade): string {
  const realized = t.realized == null ? "" : ` · 実現損益 ${formatSignedYen(t.realized)}`;

  return `${t.side === "buy" ? "買い" : "売り"}: ${t.code} ${formatNumber(t.shares, 0)}株 × ${formatPrice(t.price)}円 = ${formatYen(t.amount)}${realized}`;
}

/**
 * 仮想売買の注文を出す関数を返す。約定したら口座のキャッシュを応答の口座で置き換え、結果を注文欄に出す。
 */
export function usePlaceOrder() {
  const queryClient = useQueryClient();

  return useCallback(
    async (order: SimOrder) => {
      // 注文中にもう一度押されても、前の注文が終わるまでは受け付けない
      if (orderStore.state.busy) {
        return;
      }

      orderStore.setState((s) => ({ ...s, busy: true }));

      try {
        const body = { code: order.code, side: order.side, shares: order.shares, ...(order.side === "buy" ? { plan: order.plan ?? null } : {}) };
        const data = await requestApi<SimOrderResponse>("/sim/orders", { method: "POST", body });

        queryClient.setQueryData(queryKeys.sim, data.account);
        showOrderMessage({ ok: true, text: describeTrade(data.trade), code: order.code });
      } catch (e) {
        showOrderMessage({ ok: false, text: errorMessage(e), code: order.code });
      } finally {
        orderStore.setState((s) => ({ ...s, busy: false }));
      }
    },
    [queryClient],
  );
}

/**
 * 注文中かどうかを返す。
 */
export function useOrderBusy(): boolean {
  return useSelector(orderStore, (s) => s.busy);
}

/**
 * 今選んでいる売買ルールの短い名前(括弧の補足を外したもの)を返す。判定の行に出す。
 */
export function useShortStrategyLabel(): string {
  const strategies = useStrategies();
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const found = strategies.find((s) => s.id === strategy);

  if (!found) {
    return strategy;
  }

  return found.label.replace(/[(（].*$/, "");
}
