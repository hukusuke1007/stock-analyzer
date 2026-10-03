import { readLocal, writeLocal } from "./local-storage";
import type { SimPosition } from "./types";

// シミュレーターの保有株が利確ライン・損切りラインに届いたときのブラウザ通知。
// 同じラインでは1回だけ知らせるよう、知らせたラインをブラウザに覚えておく

export type LineKind = "takeProfit" | "stopLoss";

const NOTIFIED_KEY = "notifiedLines";

/**
 * このブラウザで通知を出せるか(Notification API があり、許可されているか)を返す。
 */
export function canNotify(): boolean {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

/**
 * ブラウザに通知の許可を求め、許可されたかを返す。すでに決まっていれば聞き直さない。
 */
export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === "undefined") {
    return false;
  }
  if (Notification.permission !== "default") {
    return Notification.permission === "granted";
  }

  return (await Notification.requestPermission()) === "granted";
}

/**
 * 通知済みかどうかを見分けるキー。ユーザー・銘柄・ラインの種類・価格ごとに分ける
 * (買い増しなどでラインが変わったら、新しいラインとしてもう一度知らせる)。
 */
function notifiedKeyFor(userId: string, position: SimPosition, kind: LineKind, price: number): string {
  return `${userId}:${position.code}:${kind}:${price}`;
}

/**
 * 保有株のうち、ラインに届いていてまだ知らせていないものを返す。
 * 利確ラインが複数あるときは、サーバーと同じく一番近い(低い)ラインで判断する。
 */
export function findUnnotifiedHits(
  userId: string,
  positions: SimPosition[],
  enabled: Record<LineKind, boolean>,
): { position: SimPosition; kind: LineKind; price: number; key: string }[] {
  const notified = new Set(readLocal<string[]>(NOTIFIED_KEY, []));
  const hits: { position: SimPosition; kind: LineKind; price: number; key: string }[] = [];

  for (const p of positions) {
    if (enabled.takeProfit && p.status === "利確ライン到達" && p.takeProfit.length) {
      const price = Math.min(...p.takeProfit.map((t) => t.price));
      hits.push({ position: p, kind: "takeProfit", price, key: notifiedKeyFor(userId, p, "takeProfit", price) });
    }
    if (enabled.stopLoss && p.status === "損切りライン到達" && p.stopLoss) {
      const price = p.stopLoss.price;
      hits.push({ position: p, kind: "stopLoss", price, key: notifiedKeyFor(userId, p, "stopLoss", price) });
    }
  }

  return hits.filter((h) => !notified.has(h.key));
}

// 覚えておく件数の上限。売った銘柄のキーが溜まり続けないよう、古いものから捨てる
const MAX_NOTIFIED = 500;

/**
 * 保有株がラインに届いたことをブラウザ通知で知らせ、知らせたことを覚えておく。
 */
export function notifyLineHit(hit: { position: SimPosition; kind: LineKind; price: number; key: string }) {
  const p = hit.position;
  const label = hit.kind === "takeProfit" ? "利確" : "損切り";
  const pnl = hit.kind === "takeProfit" ? p.takeProfit.find((t) => t.price === hit.price)?.pnl : p.stopLoss?.pnl;

  new Notification(`${label}ラインに到達: ${p.code} ${p.name}`, {
    body: `現在値 ${p.price.toLocaleString("ja-JP")}円 / ${label}ライン ${hit.price.toLocaleString("ja-JP")}円${
      pnl == null ? "" : ` / ラインで売ったら ${pnl > 0 ? "+" : ""}${pnl.toLocaleString("ja-JP")}円`
    }(株シミュレーター・仮想売買)`,
    // 同じ銘柄・同じラインの通知は、通知センターで1つにまとめる
    tag: hit.key,
  });

  const notified = [...readLocal<string[]>(NOTIFIED_KEY, []), hit.key].slice(-MAX_NOTIFIED);
  writeLocal(NOTIFIED_KEY, notified);
}
