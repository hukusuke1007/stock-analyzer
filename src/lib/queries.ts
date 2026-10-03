import { type QueryClient, queryOptions, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useCallback, useMemo } from "react";
import { requestApi } from "./api";
import { isStockCode, normalizeCode } from "./format";
import { readLocal } from "./local-storage";
import type {
  BarsResponse,
  DecisionResult,
  Health,
  JudgeResponse,
  JudgeResult,
  Listing,
  Options,
  SavedResults,
  SettingsPayload,
  SimSnapshot,
  StrategyInfo,
  User,
  Watchlist,
} from "./types";
import { judgmentKey, type PendingJudgment, setPendingJudgment, showFlash, uiStore } from "./ui-store";

// サーバーのデータ(TanStack Query のキャッシュ)の読み書き。
// クエリのキーと取得処理をここにまとめ、画面からはフックと関数だけを使う

export const queryKeys = {
  me: ["me"] as const,
  strategies: ["strategies"] as const,
  health: ["health"] as const,
  settings: ["settings"] as const,
  results: (strategy: string) => ["results", strategy] as const,
  bars: (code: string) => ["bars", code] as const,
  watchlist: ["watchlist"] as const,
  sim: ["sim"] as const,
  search: (q: string) => ["search", q] as const,
};

export const meQuery = queryOptions({
  queryKey: queryKeys.me,
  queryFn: () => requestApi<{ user: User }>("/auth/me").then((d) => d.user),
  // ログイン状態はログイン・ログアウトの操作で入れ替えるので、自動では取り直さない
  staleTime: Infinity,
  retry: false,
});

// 売買ルールの一覧を取れないときも画面を使えるよう、サーバーにある2つの売買ルールを既定にする
const FALLBACK_STRATEGIES: StrategyInfo[] = [
  { id: "swing", label: "スイング", maxHoldingDays: 10 },
  { id: "rebound", label: "急落リバウンド", maxHoldingDays: 10 },
];

/**
 * 売買ルールの一覧。
 */
export function useStrategies(): StrategyInfo[] {
  const { data } = useQuery({
    queryKey: queryKeys.strategies,
    queryFn: () => requestApi<StrategyInfo[]>("/strategies").catch(() => FALLBACK_STRATEGIES),
    staleTime: Infinity,
  });

  return data ?? FALLBACK_STRATEGIES;
}

/**
 * 判定に使う AI とランク付けの Codex が使えるか(上部バーの表示)。
 */
export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: () => requestApi<Health>("/health") });
}

export const settingsQuery = queryOptions({
  queryKey: queryKeys.settings,
  queryFn: () => requestApi<SettingsPayload>("/settings"),
  staleTime: 0,
});

/**
 * 売買ルール1つ分の保存済みの判定結果(/judge の銘柄ごとの最新と、/screen の最新1回分)。
 */
export function resultsQuery(strategy: string) {
  return queryOptions({
    queryKey: queryKeys.results(strategy),
    queryFn: () => requestApi<SavedResults>(`/results?strategy=${encodeURIComponent(strategy)}`),
    staleTime: Infinity,
  });
}

// 日足を同時に取りに行く数。関心銘柄が多いと一度に数百件になり、サーバーから Yahoo Finance への
// リクエストがレート制限に掛かるので、ブラウザ側で絞る
const BARS_CONCURRENCY = 3;
let barsRunning = 0;
const barsWaiting: (() => void)[] = [];

/**
 * 日足を取る。同時に取りに行くのは BARS_CONCURRENCY 件までにし、残りは順番を待つ。
 */
export async function fetchBars(code: string): Promise<BarsResponse> {
  if (barsRunning >= BARS_CONCURRENCY) {
    await new Promise<void>((resolve) => barsWaiting.push(resolve));
  }

  barsRunning++;
  try {
    return await requestApi<BarsResponse>(`/bars/${encodeURIComponent(code)}`);
  } finally {
    barsRunning--;
    barsWaiting.shift()?.();
  }
}

/**
 * 日足(1年分)。取引時間中のライブ更新が取り直すので、画面を開き直しただけでは取り直さない。
 */
export function barsQuery(code: string) {
  return queryOptions({
    queryKey: queryKeys.bars(code),
    queryFn: () => fetchBars(code),
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * 日足を読む。code が null なら読まない。
 */
export function useBars(code: string | null) {
  return useQuery({ ...barsQuery(code ?? ""), enabled: Boolean(code) });
}

export const simQuery = queryOptions({
  queryKey: queryKeys.sim,
  queryFn: () => requestApi<SimSnapshot>("/sim"),
  staleTime: 0,
});

/**
 * 銘柄検索(証券コードの前方一致・銘柄名の部分一致)。
 */
export function searchQuery(q: string) {
  return queryOptions({
    queryKey: queryKeys.search(q),
    queryFn: ({ signal }) => requestApi<{ results: Listing[] }>(`/search?q=${encodeURIComponent(q)}`, { signal }).then((d) => d.results),
    staleTime: 5 * 60_000,
    enabled: q.trim() !== "",
  });
}

// ---------- 判定結果 ----------

export type JudgmentState = PendingJudgment | { result: JudgeResult; fromScreen: boolean } | null;

/**
 * 銘柄の判定結果を探す。判定中・判定の失敗の印があればそれを返す。
 * /judge と /screen の両方に結果があれば、新しく判定した方を使う。
 */
export function findJudgment(saved: SavedResults | undefined, pending: PendingJudgment | undefined, code: string): JudgmentState {
  if (pending) {
    return pending;
  }

  const judged = saved?.judgments.find((r) => r.code === code);
  const screen = saved?.screen;
  const hit = screen?.results.find((r) => r.code === code);
  if (!hit) {
    return judged ? { result: judged, fromScreen: false } : null;
  }

  // スクリーニングの結果には判定日時がないものがあるので、スキャンした日時で比べる
  const screened = { result: { ...hit, judgedAt: hit.judgedAt ?? screen!.scannedAt }, fromScreen: true };
  if (!judged) {
    return screened;
  }

  return (judged.judgedAt ?? "") >= screened.result.judgedAt ? { result: judged, fromScreen: false } : screened;
}

/**
 * 銘柄の判定結果を返す。strategy を省略したら、今選んでいる売買ルール。
 */
export function useJudgment(code: string | null, strategy?: string): JudgmentState {
  const current = useSelector(uiStore, (s) => s.strategy);
  const id = strategy ?? current;
  const { data } = useQuery(resultsQuery(id));
  const pending = useSelector(uiStore, (s) => (code ? s.pending[judgmentKey(code, id)] : undefined));

  return code ? findJudgment(data, pending, code) : null;
}

/**
 * 判定に使った Decisions の答え。Jev だけを使っていた頃に保存した結果(r.jev)も同じ形で読む。
 */
export function decisionOf(r: JudgeResult | null | undefined): DecisionResult | null {
  if (r?.decision) {
    return r.decision;
  }

  return r?.jev ? { ...r.jev, provider: "jev" } : null;
}

/**
 * 銘柄を判定し、結果を保存済みの判定結果のキャッシュに入れる。
 * サーバーも結果を保存するので、次に開いたときはキャッシュがなくても同じ結果が出る。
 */
export async function judgeStock(queryClient: QueryClient, code: string, strategy: string, options: Options, news?: string) {
  const key = judgmentKey(code, strategy);
  setPendingJudgment(key, { loading: true });

  try {
    const data = await requestApi<JudgeResponse>("/judge", {
      method: "POST",
      body: { strategy, codes: [code], options, ...(news ? { news: { [code]: news } } : {}) },
    });
    const result = data.results[0];
    if (!result) {
      setPendingJudgment(key, { error: data.errors[0]?.error ?? "判定できませんでした" });
      return;
    }

    // 保存済みの結果をまだ読んでいなければ、次に読んだときにサーバーから入る
    queryClient.setQueryData<SavedResults>(queryKeys.results(strategy), (old) =>
      old ? { ...old, judgments: [...old.judgments.filter((j) => j.code !== code), result] } : old,
    );
    setPendingJudgment(key, null);
  } catch (e) {
    setPendingJudgment(key, { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * 今の売買ルール・材料・ニュースの下書きで銘柄を判定する関数を返す。
 */
export function useJudgeStock() {
  const queryClient = useQueryClient();

  return useCallback(
    (code: string, strategy?: string) => {
      const s = uiStore.state;
      const news = s.news[code]?.trim();

      return judgeStock(queryClient, code, strategy ?? s.strategy, s.options, news);
    },
    [queryClient],
  );
}

/**
 * 銘柄名を返す関数。スクリーナーの結果(JPX の和名)を優先し、なければ銘柄検索の和名、Yahoo の英名の順。
 */
export function useNameLookup() {
  const queryClient = useQueryClient();
  const strategies = useStrategies();
  const names = useSelector(uiStore, (s) => s.names);
  const saved = useQueries({ queries: strategies.map((s) => resultsQuery(s.id)) });

  return useCallback(
    (code: string): string => {
      for (const q of saved) {
        const hit = q.data?.screen?.results.find((r) => r.code === code);
        if (hit) {
          return hit.name;
        }
      }
      if (names[code]) {
        return names[code];
      }

      const bars = queryClient.getQueryData<BarsResponse>(queryKeys.bars(code));
      const judged = saved.flatMap((q) => q.data?.judgments ?? []).find((r) => r.code === code);

      return bars?.name ?? judged?.name ?? "";
    },
    [saved, names, queryClient],
  );
}

// ---------- 関心銘柄 ----------

const DEFAULT_WATCH = ["7203", "6758", "8306", "9432", "6857"];
export const MAX_WATCH = 200; // サーバー(PUT /watchlist)の上限と同じ

export const watchlistQuery = queryOptions({
  queryKey: queryKeys.watchlist,
  queryFn: async (): Promise<{ codes: string[]; columns: number }> => {
    const saved = await requestApi<Watchlist>("/watchlist");
    if (saved.codes) {
      return { codes: saved.codes, columns: saved.columns };
    }

    // まだ保存していなければ、旧 UI がブラウザに保存していたもの(なければ既定の銘柄)から始めて保存する
    const initial = { codes: readLocal("watchlist", DEFAULT_WATCH), columns: saved.columns };
    await requestApi("/watchlist", { method: "PUT", body: initial });

    return initial;
  },
  staleTime: Infinity,
});

/**
 * 関心銘柄の証券コード(並び順どおり)と、関心銘柄タブの1行の表示数。
 */
export function useWatchlist() {
  const { data } = useQuery(watchlistQuery);

  return { codes: data?.codes ?? [], columns: data?.columns ?? 3, loaded: Boolean(data) };
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 関心銘柄を書き換える。画面にはすぐ反映し、保存は少し待ってからまとめて送る
 * (並べ替えのドラッグなどで続けて変わるため)。
 */
export function updateWatchlist(queryClient: QueryClient, patch: Partial<{ codes: string[]; columns: number }>) {
  const current = queryClient.getQueryData<{ codes: string[]; columns: number }>(queryKeys.watchlist) ?? { codes: [], columns: 3 };
  const next = { ...current, ...patch };
  queryClient.setQueryData(queryKeys.watchlist, next);

  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    requestApi("/watchlist", { method: "PUT", body: next }).catch((e: Error) => showFlash(`関心銘柄を保存できませんでした: ${e.message}`));
  }, 300);
}

/**
 * 関心銘柄を足す・外す操作をまとめて返す。
 */
export function useWatchActions() {
  const queryClient = useQueryClient();

  return useMemo(() => {
    const codes = () => queryClient.getQueryData<{ codes: string[] }>(queryKeys.watchlist)?.codes ?? [];

    /**
     * 関心銘柄に足す。コードの形でなければ知らせて false を返す。
     */
    const add = (input: string): boolean => {
      const code = normalizeCode(input);
      if (!isStockCode(code)) {
        showFlash(`証券コードの形式ではありません: ${code}`);
        return false;
      }
      if (codes().includes(code)) {
        return true;
      }
      if (codes().length >= MAX_WATCH) {
        showFlash(`関心銘柄は${MAX_WATCH}件までです`);
        return false;
      }

      updateWatchlist(queryClient, { codes: [...codes(), code] });

      return true;
    };

    const remove = (code: string) => updateWatchlist(queryClient, { codes: codes().filter((c) => c !== code) });

    const toggle = (code: string) => (codes().includes(code) ? remove(code) : add(code));

    const reorder = (next: string[]) => updateWatchlist(queryClient, { codes: next });

    const setColumns = (columns: number) => updateWatchlist(queryClient, { columns });

    return { add, remove, toggle, reorder, setColumns };
  }, [queryClient]);
}
