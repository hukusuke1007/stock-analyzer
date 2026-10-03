// 日足の取得とテクニカル指標の計算。各売買ルール(src/strategies/)から使う。
// 日足の終値ベースなので、場中のリアルタイム判定には使えない。

const API = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}?range=1y&interval=1d";

export type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

type ChartResponse = {
  chart: {
    result: {
      meta: { longName?: string; shortName?: string };
      timestamp: number[];
      indicators: {
        quote: {
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }[];
      };
    }[];
  };
};

export async function fetchDaily(code: string) {
  const sym = code.includes(".") ? code : `${code}.T`;
  const res = await fetch(API.replace("{sym}", sym), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`${code}: Yahoo Finance から取得できない (HTTP ${res.status})`);
  const data = (await res.json()) as ChartResponse;
  const result = data.chart.result[0];
  const q = result?.indicators.quote[0];
  if (!result || !q) throw new Error(`${code}: 日足データがない`);

  const bars: Bar[] = result.timestamp.flatMap((t, i) => {
    const [open, high, low, close, volume] = [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i]];
    if (open == null || high == null || low == null || close == null || volume == null) return [];
    const date = new Date((t + 9 * 3600) * 1000).toISOString().slice(0, 10); // JST
    return [{ date, open, high, low, close, volume }];
  });
  if (bars.length < 2) throw new Error(`${code}: 終値の系列が足りない`);
  const name = result.meta.longName ?? result.meta.shortName ?? sym;
  return { code, symbol: sym, name, bars };
}

export function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  return values.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// 母標準偏差(ddof=0)。ボリンジャーバンドの一般的な定義に合わせる。
export function stdev(values: number[], n: number): number | null {
  const m = sma(values, n);
  if (m === null) return null;
  return Math.sqrt(values.slice(-n).reduce((a, v) => a + (v - m) ** 2, 0) / n);
}

// 順位相関指数。直近を1位、最高値を1位として順位差から算出する。
// RCI = (1 - 6 * Σd^2 / (n^3 - n)) * 100
export function rci(values: number[], n: number): number | null {
  if (values.length < n) return null;
  const window = values.slice(-n);
  const order = window.map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v || a.i - b.i);
  let d2 = 0;
  order.forEach(({ i }, rank) => {
    const dateRank = n - i;
    d2 += (dateRank - (rank + 1)) ** 2;
  });
  return (1 - (6 * d2) / (n ** 3 - n)) * 100;
}

// 指数移動平均の系列。先頭 n 本の単純平均を初期値にする。
function emaSeries(values: number[], n: number): number[] {
  if (values.length < n) return [];
  const k = 2 / (n + 1);
  const out = [values.slice(0, n).reduce((a, b) => a + b, 0) / n];
  for (const v of values.slice(n)) out.push(v * k + out.at(-1)! * (1 - k));
  return out;
}

// RSI(ワイルダーの平滑化)
export function rsi(values: number[], n = 14): number | null {
  if (values.length <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
}

// MACD(12,26,9)。直近 days 本の MACD 線とシグナル線を返す(古い順)。
export function macd(values: number[], days: number) {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  const line = slow.map((s, i) => fast[i + 14]! - s); // fast は slow より 14 本長い
  const signal = emaSeries(line, 9);
  const aligned = line.slice(8); // signal と同じ長さにそろえる
  return aligned.slice(-days).map((m, i) => ({ macd: m, signal: signal.slice(-days)[i]! }));
}

// ATR(真の値幅の単純平均)
export function atr(bars: Bar[], n = 14): number | null {
  if (bars.length <= n) return null;
  const tr = bars.slice(-n).map((b, i, arr) => {
    const prevClose = (i === 0 ? bars[bars.length - n - 1]! : arr[i - 1]!).close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  return tr.reduce((a, b) => a + b, 0) / n;
}

export type Check = { label: string; criterion: string; value: string; ok: boolean };

export const fmt = (v: number | null, unit: string, digits = 2) =>
  v === null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}${unit}`;

export const round = (v: number | null, digits = 1) => (v === null ? null : Number(v.toFixed(digits)));

// 現在値から price までの変化率(%)
export const pctFrom = (close: number, price: number | null) =>
  price === null ? null : round((price / close - 1) * 100, 2);
