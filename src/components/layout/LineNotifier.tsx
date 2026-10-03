import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { isMarketOpen, LIVE_INTERVAL } from "../../lib/live";
import { canNotify, findUnnotifiedHits, notifyLineHit } from "../../lib/notifications";
import { meQuery, settingsQuery, simQuery } from "../../lib/queries";

/**
 * シミュレーターの保有株が利確ライン・損切りラインに届いたら、ブラウザ通知を出す(画面には何も描かない)。
 * 通知を ON にしているあいだは、どのタブを開いていても取引時間中は1分ごとに口座を取り直して確かめる。
 */
export function LineNotifier() {
  const { data: user } = useQuery(meQuery);
  const { data: settings } = useQuery(settingsQuery);
  const takeProfit = settings?.settings.notifyTakeProfit ?? false;
  const stopLoss = settings?.settings.notifyStopLoss ?? false;
  const enabled = takeProfit || stopLoss;
  const { data: sim } = useQuery({
    ...simQuery,
    enabled,
    // 取引時間外は株価が動かないので取り直さない
    refetchInterval: () => (isMarketOpen() ? LIVE_INTERVAL : false),
  });

  useEffect(() => {
    if (!user || !sim || !enabled || !canNotify()) {
      return;
    }

    for (const hit of findUnnotifiedHits(user.id, sim.positions, { takeProfit, stopLoss })) {
      notifyLineHit(hit);
    }
  }, [user, sim, enabled, takeProfit, stopLoss]);

  return null;
}
