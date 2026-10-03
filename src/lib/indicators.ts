import type { Bar } from "./types";

// チャートに描くインジケーターの計算。サーバー(src/server/technicals.ts)と同じ式で計算しているので、
// 式を変えたら両方を直す。値がまだ出せない足(期間に満たない最初の数本)は null にする

type Series = (number | null)[];

/**
 * 単純移動平均。
 */
export function sma(v: number[], n: number): Series {
  return v.map((_, i) => (i < n - 1 ? null : v.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n));
}

/**
 * n 本の標準偏差(母標準偏差。ボリンジャーバンドの定義に合わせる)。
 */
function stdev(v: number[], n: number): Series {
  const m = sma(v, n);

  return v.map((_, i) => {
    const mean = m[i];
    if (mean == null) {
      return null;
    }

    return Math.sqrt(v.slice(i - n + 1, i + 1).reduce((a, x) => a + (x - mean) ** 2, 0) / n);
  });
}

/**
 * 指数移動平均。サーバーと同じく、start から n 本の単純平均を初期値にする。
 */
function ema(v: number[], n: number, start = 0): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length - start < n) {
    return out;
  }

  const k = 2 / (n + 1);
  let prev = v.slice(start, start + n).reduce((a, b) => a + b, 0) / n;
  out[start + n - 1] = prev;
  for (let i = start + n; i < v.length; i++) {
    prev = v[i]! * k + prev * (1 - k);
    out[i] = prev;
  }

  return out;
}

/**
 * RSI(Wilder の平滑化)。
 */
function rsiSeries(v: number[], n = 14): Series {
  const out: Series = new Array(v.length).fill(null);
  if (v.length <= n) {
    return out;
  }

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = v[i]! - v[i - 1]!;
    if (d > 0) {
      gain += d;
    } else {
      loss -= d;
    }
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = n + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }

  return out;
}

/**
 * RCI(順位相関指数)。終値の順位と日付の順位の相関を -100〜100 で表す。
 */
function rciSeries(v: number[], n: number): Series {
  return v.map((_, end) => {
    if (end < n - 1) {
      return null;
    }

    const window = v.slice(end - n + 1, end + 1);
    // 同値は古い足を上の順位にする(サーバーと同じ)
    const order = window.map((x, i) => ({ x, i })).sort((a, b) => b.x - a.x || a.i - b.i);
    let d2 = 0;
    order.forEach(({ i }, rank) => {
      d2 += (n - i - (rank + 1)) ** 2;
    });

    return (1 - (6 * d2) / (n ** 3 - n)) * 100;
  });
}

/**
 * MACD(12, 26, 9)。シグナルは MACD が出始める足(26本目)から9本の EMA。
 */
function macdSeries(v: number[]) {
  const fast = ema(v, 12);
  const slow = ema(v, 26);
  const line: Series = v.map((_, i) => {
    const f = fast[i];
    const s = slow[i];

    return f == null || s == null ? null : f - s;
  });
  const signal = ema(
    line.map((x) => x ?? 0),
    9,
    25,
  );
  const hist: Series = line.map((m, i) => {
    const s = signal[i];

    return m == null || s == null ? null : m - s;
  });

  return { line, signal, hist };
}

// 一目均衡表(転換線 9 / 基準線 26 / 先行スパンB 52)。
// 先行スパンは当日を含めて26日先(25本先)、遅行スパンは26日前(25本前)に描く(TradingView と同じ)
export const SHIFT = 25;

/**
 * n 本の (最高値 + 最安値) / 2。
 */
function midpoint(bars: Bar[], n: number): Series {
  return bars.map((_, i) => {
    if (i < n - 1) {
      return null;
    }

    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      hi = Math.max(hi, bars[k]!.high);
      lo = Math.min(lo, bars[k]!.low);
    }

    return (hi + lo) / 2;
  });
}

/**
 * 最後の足の翌日から count 営業日分の日付を返す(土日を除く。祝日は考慮しない)。
 */
function futureDates(last: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${last}T00:00:00Z`);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) {
      out.push(d.toISOString().slice(0, 10));
    }
  }

  return out;
}

export type Ichimoku = {
  times: string[]; // 足の日付に未来の SHIFT 本を足したもの。spanA / spanB / chikou はこれと同じ長さ
  tenkan: Series;
  kijun: Series;
  spanA: Series;
  spanB: Series;
  chikou: Series;
};

/**
 * 一目均衡表を計算する。
 */
export function ichimoku(bars: Bar[]): Ichimoku {
  const n = bars.length;
  const tenkan = midpoint(bars, 9);
  const kijun = midpoint(bars, 26);
  const spanB0 = midpoint(bars, 52);
  const times = [...bars.map((b) => b.date), ...futureDates(bars[n - 1]!.date, SHIFT)];

  // 先行スパンは k 番目の時刻に、SHIFT 本前の足の値を置く
  const shifted = (k: number, base: Series) => (k >= SHIFT && k - SHIFT < n ? (base[k - SHIFT] ?? null) : null);
  const spanA0: Series = tenkan.map((t, i) => {
    const kj = kijun[i];

    return t == null || kj == null ? null : (t + kj) / 2;
  });

  return {
    times,
    tenkan,
    kijun,
    spanA: times.map((_, k) => shifted(k, spanA0)),
    spanB: times.map((_, k) => shifted(k, spanB0)),
    chikou: times.map((_, k) => (k + SHIFT < n ? bars[k + SHIFT]!.close : null)),
  };
}

export type Indicators = ReturnType<typeof computeIndicators>;

/**
 * 日足から、チャートに描くインジケーターをまとめて計算する。
 */
export function computeIndicators(bars: Bar[]) {
  const close = bars.map((b) => b.close);
  const ma25 = sma(close, 25);
  const sd25 = stdev(close, 25);
  const band = (k: number): Series =>
    ma25.map((m, i) => {
      const sd = sd25[i];

      return m == null || sd == null ? null : m + k * sd;
    });

  return {
    ma5: sma(close, 5),
    ma25,
    ma75: sma(close, 75),
    ma100: sma(close, 100),
    ichimoku: ichimoku(bars),
    bb: { mid: ma25, p1: band(1), m1: band(-1), p2: band(2), m2: band(-2), p3: band(3), m3: band(-3) },
    rsi: rsiSeries(close),
    rci10: rciSeries(close, 10),
    rci26: rciSeries(close, 26),
    macd: macdSeries(close),
  };
}
