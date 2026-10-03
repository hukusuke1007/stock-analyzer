import type { Verdict } from "./types";

// 数値・判定の表示の書式。チャート・関心銘柄・シミュレーターで同じ見た目にそろえる

/**
 * 数値を桁区切りと小数 d 桁で書く。値がなければ「—」。
 */
export function formatNumber(v: number | null | undefined, d = 1): string {
  if (v == null || Number.isNaN(v)) {
    return "—";
  }

  return Number(v).toLocaleString("ja-JP", { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * 符号付きで書く(既定は %)。値がなければ「—」。
 */
export function formatSigned(v: number | null | undefined, d = 2, unit = "%"): string {
  if (v == null) {
    return "—";
  }

  return `${v >= 0 ? "+" : ""}${Number(v).toFixed(d)}${unit}`;
}

/**
 * 金額を「1,234円」と書く。
 */
export function formatYen(v: number | null | undefined): string {
  return v == null ? "—" : `${formatNumber(v, 0)}円`;
}

/**
 * 損益を符号付きの金額で書く。
 */
export function formatSignedYen(v: number | null | undefined): string {
  return v == null ? "—" : `${v > 0 ? "+" : ""}${formatNumber(v, 0)}円`;
}

/**
 * 値の正負に応じた色のクラス(上昇 up / 下落 down)を返す。
 */
export function signClass(v: number | null | undefined): string {
  if (v == null || v === 0) {
    return "";
  }

  return v > 0 ? "up" : "down";
}

const VERDICT_CLASS: Record<Verdict, string> = { 買い: "buy", 打診買い: "probe", 見送り: "pass" };

/**
 * 判定のタグのクラスを返す。判定がなければ pending。
 */
export function verdictClass(v: Verdict | null | undefined): string {
  return v ? VERDICT_CLASS[v] : "pending";
}

export const VERDICT_RANK: Record<Verdict, number> = { 買い: 0, 打診買い: 1, 見送り: 2 };

/**
 * 入力された証券コードを、大文字にして末尾の .T を外した形にそろえる。
 */
export function normalizeCode(s: string): string {
  return s.trim().toUpperCase().replace(/\.T$/, "");
}

/**
 * 4桁の証券コードの形かどうかを返す。
 */
export function isStockCode(code: string): boolean {
  return /^[0-9A-Z]{4}$/.test(code);
}

/**
 * 日時を「2026/10/03 12:34」の形で書く。
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("ja-JP", { dateStyle: "short", timeStyle: "short" });
}

/**
 * 最後の足と前日の足から、前日比(%)を返す。足が足りなければ null。
 */
export function changePercent(bars: { close: number }[] | undefined): number | null {
  const last = bars?.at(-1);
  const prev = bars?.at(-2);
  if (!last || !prev) {
    return null;
  }

  return (last.close / prev.close - 1) * 100;
}
