// API(/api/*)を呼ぶ。応答はすべて JSON で、失敗したときは { error } が返る

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * API を呼び、JSON の応答を返す。失敗したら ApiError を投げる。
 * body を渡したときは JSON にして送る。
 */
export async function requestApi<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    ...(init.body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new ApiError(data.error ?? `HTTP ${res.status}`, res.status);
  }

  return data;
}

/**
 * ログインが切れたことによる失敗かどうかを返す。
 */
export function isUnauthorized(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

/**
 * 例外を画面に出す文言にする。
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
