import { type QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { FAVICON_SVG } from "../components/common/BrandLogo";
import appCss from "../styles/app.css?url";

export type RouterContext = { queryClient: QueryClient };


export const Route = createRootRouteWithContext<RouterContext>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "株分析シミュレーター" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: `data:image/svg+xml,${FAVICON_SVG}` },
      { rel: "stylesheet", href: appCss },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

/**
 * 画面全体に QueryClient を配る。
 */
function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <Outlet />
    </QueryClientProvider>
  );
}

/**
 * HTML の枠を描く。SSR を切っていても、この枠だけはサーバーで描かれる。
 */
function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="ja">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}
