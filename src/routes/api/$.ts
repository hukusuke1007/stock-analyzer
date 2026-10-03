import { createFileRoute } from "@tanstack/react-router";
import { app } from "../../server/api";

/**
 * /api/* へのリクエストを Hono の API に渡す。
 * エンドポイントの定義は Hono 側(src/server/api.ts)にまとめ、ここは受け渡しだけにする。
 */
const forwardToApi = ({ request }: { request: Request }) => app.fetch(request);

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      GET: forwardToApi,
      POST: forwardToApi,
      PUT: forwardToApi,
      DELETE: forwardToApi,
    },
  },
});
