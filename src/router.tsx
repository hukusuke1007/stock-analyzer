import { QueryClient } from "@tanstack/react-query";
import { createRouter, stringifySearchWith } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

/**
 * ルーターを作る。TanStack Start がリクエスト(またはブラウザの起動)ごとに呼ぶ。
 * QueryClient はルーターのコンテキストに入れ、ルートと画面の両方から同じキャッシュを使う。
 */
export function getRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      // 株価は1分ごとのライブ更新で取り直すので、画面を戻っただけでは取り直さない
      queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: 1 },
    },
  });

  return createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // 文字列の検索パラメータはそのまま URL に書く。既定の直列化だと、数字だけの証券コードが
    // 数値と区別するための引用符付き(?code="7203")で URL に出るため。読むときに数値になる分は validateSearch で文字列に戻す
    stringifySearch: stringifySearchWith(JSON.stringify),
  });
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
