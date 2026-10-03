// 株シミュレーター(仮想売買)。実際には発注せず、Yahoo Finance の最新の株価で約定したことにして
// 現金・保有株・売買履歴をユーザーごとに DB(sim_accounts / sim_positions / sim_trades)に記録する。
// 手数料・税金は含めない。株数は100株(1単元)単位。
import { getRepository, type SimAccountRecord, type SimPositionChange } from "./db/repository";
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

/**
 * 新しい口座を作る(保存はしない)。revision は空にしておき、最初の書き込みで新しい値にする。
 */
function newAccount(initialCash = DEFAULT_INITIAL_CASH): SimAccountRecord {
  return { initialCash, cash: initialCash, positions: [], trades: [], revision: "", createdAt: new Date().toISOString() };
}

/**
 * 口座を返す。まだ始めていなければ、既定の元金の新しい口座(保存はしない)を返す。
 */
async function load(userId: string): Promise<Account> {
  return (await getRepository().readSimAccount(userId)) ?? newAccount();
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
export async function snapshot(userId: string) {
  const account = await load(userId);
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

/**
 * 元金を指定して口座を始め直す。保有株と売買履歴は消える。
 */
export async function reset(userId: string, initialCash: unknown) {
  const v = initialCash === undefined ? DEFAULT_INITIAL_CASH : initialCash;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_INITIAL_CASH) {
    throw new SimError(`元金は1円〜${MAX_INITIAL_CASH.toLocaleString("ja-JP")}円の整数で指定してください`);
  }

  // revision も新しくして、リセットの前の口座を読んで進めていた注文が書き込めないようにする
  await getRepository().replaceSimAccount(userId, { ...newAccount(v), revision: crypto.randomUUID() });
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

// 同時に来た別の注文と書き込みがぶつかったときに、口座を読み直してやり直す回数
const MAX_ORDER_ATTEMPTS = 5;

/**
 * 最新の株価で注文を約定したことにして、口座に記録する。
 * 株価の取得は時間がかかるので先に済ませ、口座の読み書きだけをやり直しの対象にする。
 * D1 では BEGIN によるトランザクションを使えないので、口座を読んだときの revision のままのときだけ書き込み、
 * 別の注文が先に書き込んでいたら読み直して計算し直す(別のサーバーで受けた注文どうしでも食い違わない)。
 */
export async function execute(userId: string, order: Order): Promise<Trade> {
  const q = await quote(order.code);
  const repository = getRepository();

  await repository.createSimAccountIfMissing(userId, newAccount());

  for (let attempt = 0; attempt < MAX_ORDER_ATTEMPTS; attempt++) {
    const account = (await repository.readSimAccount(userId))!;
    const { change, trade } = planOrder(account, order, q);

    if (await repository.commitSimOrder(userId, account.revision, crypto.randomUUID(), change)) {
      return trade;
    }
  }

  throw new SimError("ほかの注文と重なったため約定できませんでした。もう一度注文してください");
}

/**
 * 口座と株価から、注文で加える変更(現金・保有株・売買履歴)を計算する。現金や株数が足りなければ SimError を投げる。
 */
function planOrder(account: Account, order: Order, q: { name: string; price: number; date: string }) {
  const amount = q.price * order.shares;
  const pos = account.positions.find((p) => p.code === order.code);
  let cash = account.cash;
  let position: SimPositionChange;
  let realized: number | null = null;

  if (order.side === "buy") {
    if (amount > account.cash) {
      throw new SimError(
        `現金が足りません(約定代金 ${yen(amount).toLocaleString("ja-JP")}円 / 現金 ${yen(account.cash).toLocaleString("ja-JP")}円)`,
      );
    }

    cash -= amount;
    if (pos) {
      const shares = pos.shares + order.shares;
      // 買い増したら、そのときの判定の売り方に置き換える
      position = { kind: "update", code: order.code, shares, avgPrice: (pos.avgPrice * pos.shares + amount) / shares, plan: order.plan ?? pos.plan };
    } else {
      position = {
        kind: "insert",
        position: { code: order.code, name: q.name, shares: order.shares, avgPrice: q.price, openedAt: new Date().toISOString(), plan: order.plan ?? null },
      };
    }
  } else {
    if (!pos || pos.shares < order.shares) {
      throw new SimError(`${order.code} の保有株数(${pos?.shares ?? 0}株)を超えて売れません`);
    }

    realized = yen((q.price - pos.avgPrice) * order.shares);
    cash += amount;
    position =
      pos.shares === order.shares
        ? { kind: "delete", code: order.code }
        : { kind: "update", code: order.code, shares: pos.shares - order.shares, avgPrice: pos.avgPrice, plan: pos.plan };
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

  return { change: { cash, position, trade }, trade };
}
