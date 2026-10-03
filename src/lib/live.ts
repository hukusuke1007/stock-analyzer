import type { QueryClient } from "@tanstack/react-query";
import { fetchBars, queryKeys } from "./queries";
import type { BarsResponse } from "./types";
import { setLiveStatus, uiStore } from "./ui-store";

// 取引時間中のライブ更新。1分ごとに日足を取り直し、当日の足(と、それから計算するインジケーター)を差し替える。
// Yahoo Finance の東証の株価は約20分遅れ。判定(利確 / 損切りライン)は自動では出し直さない

export const LIVE_INTERVAL = 60_000;

/**
 * 東証の取引時間(平日 9:00〜15:30)かどうかを返す。引け後の確定値も拾えるよう少し余裕を持たせる。
 */
export function isMarketOpen(now = new Date()): boolean {
  const jst = new Date(now.getTime() + 9 * 3600_000);
  const day = jst.getUTCDay();
  const minutes = jst.getUTCHours() * 60 + jst.getUTCMinutes();

  return day !== 0 && day !== 6 && minutes >= 9 * 60 && minutes <= 15 * 60 + 45;
}

/**
 * 最新の足が変わったかどうかを返す。
 */
function hasLastBarChanged(before: BarsResponse | undefined, after: BarsResponse): boolean {
  const a = before?.bars.at(-1);
  const b = after.bars.at(-1);
  if (!a || !b) {
    return true;
  }

  return a.date !== b.date || a.close !== b.close || a.high !== b.high || a.low !== b.low || a.volume !== b.volume;
}

/**
 * 1回分のライブ更新。チャートの銘柄・注文欄の銘柄・関心銘柄の日足を取り直す。
 * force が false なら、取引時間外と、タブが裏にあるときは何もしない。
 */
export async function refreshLiveBars(queryClient: QueryClient, force = false) {
  const s = uiStore.state;
  if (s.live.busy || (typeof document !== "undefined" && document.hidden) || (!force && !isMarketOpen())) {
    return;
  }

  setLiveStatus({ busy: true, at: s.live.at });

  const watch = queryClient.getQueryData<{ codes: string[] }>(queryKeys.watchlist)?.codes ?? [];
  const codes = [...new Set([s.chartCode, s.orderCode, ...watch].filter((c): c is string => Boolean(c)))];

  // 取得の同時数は fetchBars が絞るので、ここでは全部を投げてよい
  await Promise.all(
    codes.map(async (code) => {
      try {
        const before = queryClient.getQueryData<BarsResponse>(queryKeys.bars(code));
        const after = await fetchBars(code);
        // 変わっていないときにキャッシュを置き換えると、チャートが描き直されて十字線が飛ぶ
        if (hasLastBarChanged(before, after)) {
          queryClient.setQueryData(queryKeys.bars(code), after);
        }
      } catch {
        // 取れなかった銘柄は前の値のまま
      }
    }),
  );

  setLiveStatus({ busy: false, at: new Date().toISOString() });
  // 保有株の現在値と含み損益を出し直す(シミュレーターを開いていなければ取り直さない)
  await queryClient.invalidateQueries({ queryKey: queryKeys.sim });
}
