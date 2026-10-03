// 株シミュレーター(仮想売買)。実際には発注せず、Yahoo Finance の最新の株価で約定したことにして
// 現金・保有株・売買履歴を data/simulator.json に記録する。
// 手数料・税金は含めない。株数は100株(1単元)単位。
import { loadSim, saveSim } from "./storage.js";
import { fetchDaily } from "./technicals.js";

export const DEFAULT_INITIAL_CASH = 1_000_000;
export const LOT = 100;
const MAX_INITIAL_CASH = 1_000_000_000_000;

// 買ったときの判定の売り方。利確・損切りの金額を出すのに使う
export type SimPlan = {
  strategy: string | null;
  verdict: string | null;
  takeProfit: { price: number; when: string }[];
  stopLoss: { price: number; when: string } | null;
};

export type Position = {
  code: string;
  name: string;
  shares: number;
  avgPrice: number; // 平均取得単価
  openedAt: string;
  plan: SimPlan | null;
};

export type Trade = {
  id: string;
  at: string;
  side: "buy" | "sell";
  code: string;
  name: string;
  shares: number;
  price: number; // 約定単価
  priceDate: string; // 約定単価にした日足の日付
  amount: number; // 約定代金
  realized: number | null; // 売りのときの実現損益
};

export type Account = {
  initialCash: number;
  cash: number;
  positions: Position[];
  trades: Trade[];
  createdAt: string;
};

export class SimError extends Error {}

function newAccount(initialCash = DEFAULT_INITIAL_CASH): Account {
  return { initialCash, cash: initialCash, positions: [], trades: [], createdAt: new Date().toISOString() };
}

// 注文を同時に受けても現金・株数の計算が食い違わないよう、読み書きを1件ずつ順に行う
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function load(): Promise<Account> {
  return (await loadSim<Account>()) ?? newAccount();
}

// 最新の日足の終値(取引時間中は現在値。東証は約20分遅れ)
async function quote(code: string) {
  const { name, bars } = await fetchDaily(code);
  const last = bars.at(-1)!;
  const prev = bars.at(-2)!;
  return { name, price: last.close, prevClose: prev.close, date: last.date };
}

const yen = (v: number) => Math.round(v);

// 口座の状態に、保有株の現在値と損益を足して返す
export async function snapshot() {
  const account = await load();
  const positions = await Promise.all(
    account.positions.map(async (p) => {
      const q = await quote(p.code).catch((e) => ({ error: String(e) }));
      const price = "error" in q ? p.avgPrice : q.price;
      const cost = p.avgPrice * p.shares;
      const value = price * p.shares;
      const tp = p.plan?.takeProfit ?? [];
      const sl = p.plan?.stopLoss ?? null;
      return {
        ...p,
        price,
        priceDate: "error" in q ? null : q.date,
        prevClose: "error" in q ? null : q.prevClose,
        priceError: "error" in q ? q.error : null,
        cost: yen(cost),
        value: yen(value),
        unrealized: yen(value - cost),
        unrealizedPct: (price / p.avgPrice - 1) * 100,
        // 利確・損切りラインで売ったときの損益(今の株数ぶん)
        takeProfit: tp.map((t) => ({ ...t, pnl: yen((t.price - p.avgPrice) * p.shares) })),
        stopLoss: sl ? { ...sl, pnl: yen((sl.price - p.avgPrice) * p.shares) } : null,
        status:
          tp.length && price >= Math.min(...tp.map((t) => t.price))
            ? "利確ライン到達"
            : sl && price <= sl.price
              ? "損切りライン到達"
              : "保有中",
      };
    }),
  );
  const marketValue = positions.reduce((a, p) => a + p.value, 0);
  const unrealized = positions.reduce((a, p) => a + p.unrealized, 0);
  const realized = account.trades.reduce((a, t) => a + (t.realized ?? 0), 0);
  const total = account.cash + marketValue;
  return {
    initialCash: account.initialCash,
    cash: account.cash,
    createdAt: account.createdAt,
    summary: {
      total: yen(total),
      marketValue: yen(marketValue),
      unrealized: yen(unrealized),
      realized: yen(realized),
      pnl: yen(total - account.initialCash),
      pnlPct: (total / account.initialCash - 1) * 100,
    },
    positions,
    trades: [...account.trades].reverse(), // 新しい順
  };
}

export function reset(initialCash: unknown) {
  const v = initialCash === undefined ? DEFAULT_INITIAL_CASH : initialCash;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_INITIAL_CASH) {
    throw new SimError(`元金は1円〜${MAX_INITIAL_CASH.toLocaleString("ja-JP")}円の整数で指定してください`);
  }
  return exclusive(() => saveSim(newAccount(v)));
}

export type Order = { code: string; side: "buy" | "sell"; shares: number; plan?: SimPlan | null };

export function parseOrder(body: unknown): Order {
  const b = (body ?? {}) as Record<string, unknown>;
  const code = typeof b.code === "string" ? b.code.trim().toUpperCase() : "";
  if (!/^[0-9A-Z]{4}$/.test(code)) throw new SimError("code に4桁の証券コードを指定してください");
  if (b.side !== "buy" && b.side !== "sell") throw new SimError('side は "buy" か "sell" を指定してください');
  const shares = b.shares;
  if (typeof shares !== "number" || !Number.isInteger(shares) || shares <= 0 || shares % LOT !== 0) {
    throw new SimError(`株数は${LOT}株単位で指定してください`);
  }
  return { code, side: b.side, shares, plan: parsePlan(b.plan) };
}

// UI から受け取る判定の売り方。数値として読めるものだけ残す
function parsePlan(x: unknown): SimPlan | null {
  if (!x || typeof x !== "object") return null;
  const p = x as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.slice(0, 300) : null);
  const line = (v: unknown) => {
    const l = v as { price?: unknown; when?: unknown } | null;
    return l && typeof l.price === "number" && Number.isFinite(l.price) && l.price > 0
      ? { price: l.price, when: str(l.when) ?? "" }
      : null;
  };
  const takeProfit = Array.isArray(p.takeProfit) ? p.takeProfit.map(line).filter((l) => l !== null) : [];
  return { strategy: str(p.strategy), verdict: str(p.verdict), takeProfit, stopLoss: line(p.stopLoss) };
}

export function execute(order: Order) {
  return exclusive(async () => {
    const q = await quote(order.code);
    const account = await load();
    const amount = q.price * order.shares;
    const pos = account.positions.find((p) => p.code === order.code);
    let realized: number | null = null;

    if (order.side === "buy") {
      if (amount > account.cash) {
        throw new SimError(
          `現金が足りません(約定代金 ${yen(amount).toLocaleString("ja-JP")}円 / 現金 ${yen(account.cash).toLocaleString("ja-JP")}円)`,
        );
      }
      account.cash -= amount;
      if (pos) {
        pos.avgPrice = (pos.avgPrice * pos.shares + amount) / (pos.shares + order.shares);
        pos.shares += order.shares;
        if (order.plan) pos.plan = order.plan; // 買い増したら、そのときの判定の売り方に置き換える
      } else {
        account.positions.push({
          code: order.code,
          name: q.name,
          shares: order.shares,
          avgPrice: q.price,
          openedAt: new Date().toISOString(),
          plan: order.plan ?? null,
        });
      }
    } else {
      if (!pos || pos.shares < order.shares) {
        throw new SimError(`${order.code} の保有株数(${pos?.shares ?? 0}株)を超えて売れません`);
      }
      realized = yen((q.price - pos.avgPrice) * order.shares);
      account.cash += amount;
      pos.shares -= order.shares;
      if (pos.shares === 0) account.positions = account.positions.filter((p) => p !== pos);
    }

    const trade: Trade = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      side: order.side,
      code: order.code,
      name: pos?.name ?? q.name,
      shares: order.shares,
      price: q.price,
      priceDate: q.date,
      amount: yen(amount),
      realized,
    };
    account.trades.push(trade);
    await saveSim(account);
    return trade;
  });
}
