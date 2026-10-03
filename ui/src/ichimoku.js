// 一目均衡表(転換線 9 / 基準線 26 / 先行スパンB 52)。
// 先行スパンは当日を含めて26日先(25本先)、遅行スパンは26日前(25本前)に描く(TradingView と同じ)。
export const SHIFT = 25;

// n 本の (最高値 + 最安値) / 2
function midpoint(bars, n) {
  return bars.map((_, i) => {
    if (i < n - 1) return null;
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      hi = Math.max(hi, bars[k].high);
      lo = Math.min(lo, bars[k].low);
    }
    return (hi + lo) / 2;
  });
}

// 最後の足の翌日から count 営業日(土日を除く。祝日は考慮しない)の日付
function futureDates(last, count) {
  const out = [];
  const d = new Date(`${last}T00:00:00Z`);
  while (out.length < count) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// times は足の日付に未来の SHIFT 本を足したもの。spanA / spanB / chikou は times と同じ長さ
export function ichimoku(bars) {
  const n = bars.length;
  const tenkan = midpoint(bars, 9);
  const kijun = midpoint(bars, 26);
  const spanB0 = midpoint(bars, 52);
  const times = [...bars.map((b) => b.date), ...futureDates(bars[n - 1].date, SHIFT)];
  const at = (k, base) => (k >= SHIFT && k - SHIFT < n ? base[k - SHIFT] : null);
  const spanA0 = tenkan.map((t, i) => (t === null || kijun[i] === null ? null : (t + kijun[i]) / 2));
  return {
    times,
    tenkan,
    kijun,
    spanA: times.map((_, k) => at(k, spanA0)),
    spanB: times.map((_, k) => at(k, spanB0)),
    chikou: times.map((_, k) => (k + SHIFT < n ? bars[k + SHIFT].close : null)),
  };
}

// 先行スパンA・Bの間(雲)を塗る。A が上なら陽の雲(緑)、B が上なら陰の雲(赤)
export class CloudPrimitive {
  constructor(colors) {
    this.colors = colors;
    this.points = [];
  }

  setPoints(points) {
    this.points = points;
    this.requestUpdate?.();
  }

  attached({ chart, series, requestUpdate }) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = this.series = this.requestUpdate = undefined;
  }

  updateAllViews() {}

  paneViews() {
    return [{ zOrder: () => "bottom", renderer: () => ({ draw: (target) => this.draw(target) }) }];
  }

  draw(target) {
    if (!this.chart || !this.series) return;
    const ts = this.chart.timeScale();
    const pts = [];
    for (const p of this.points) {
      const x = ts.timeToCoordinate(p.time);
      const a = this.series.priceToCoordinate(p.a);
      const b = this.series.priceToCoordinate(p.b);
      if (x !== null && a !== null && b !== null) pts.push({ x, a, b, up: p.a >= p.b });
    }
    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        ctx.fillStyle = p1.up ? this.colors.up : this.colors.down;
        ctx.beginPath();
        ctx.moveTo(p0.x * hr, p0.a * vr);
        ctx.lineTo(p1.x * hr, p1.a * vr);
        ctx.lineTo(p1.x * hr, p1.b * vr);
        ctx.lineTo(p0.x * hr, p0.b * vr);
        ctx.closePath();
        ctx.fill();
      }
    });
  }
}
