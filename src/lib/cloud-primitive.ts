import type {
  IChartApi,
  IPrimitivePaneRenderer,
  IPrimitivePaneView,
  ISeriesApi,
  ISeriesPrimitive,
  SeriesAttachedParameter,
  SeriesType,
  Time,
} from "lightweight-charts";

type CloudPoint = { time: string; a: number; b: number };
type DrawTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];

/**
 * 一目均衡表の雲(先行スパン1・2の間)を塗る。スパン1が上なら陽の雲、スパン2が上なら陰の雲の色にする。
 * lightweight-charts には2本の線の間を塗る系列がないので、ローソク足の系列に付ける primitive として描く。
 */
export class CloudPrimitive implements ISeriesPrimitive<Time> {
  private points: CloudPoint[] = [];
  private chart: IChartApi | undefined;
  private series: ISeriesApi<SeriesType> | undefined;
  private requestUpdate: (() => void) | undefined;

  constructor(private readonly colors: { up: string; down: string }) {}

  /**
   * 雲の点を入れ替えて、描き直しを頼む。
   */
  setPoints(points: CloudPoint[]) {
    this.points = points;
    this.requestUpdate?.();
  }

  attached({ chart, series, requestUpdate }: SeriesAttachedParameter<Time>) {
    this.chart = chart;
    this.series = series;
    this.requestUpdate = requestUpdate;
  }

  detached() {
    this.chart = undefined;
    this.series = undefined;
    this.requestUpdate = undefined;
  }

  updateAllViews() {}

  paneViews(): IPrimitivePaneView[] {
    // ローソク足や線の下に塗る
    return [{ zOrder: () => "bottom", renderer: () => ({ draw: (target) => this.drawCloud(target) }) }];
  }

  /**
   * 隣り合う点の間を台形で塗る。画面外の点(座標が null)は飛ばす。
   */
  private drawCloud(target: DrawTarget) {
    const chart = this.chart;
    const series = this.series;
    if (!chart || !series) {
      return;
    }

    const timeScale = chart.timeScale();
    const pts: { x: number; a: number; b: number; up: boolean }[] = [];
    for (const p of this.points) {
      const x = timeScale.timeToCoordinate(p.time);
      const a = series.priceToCoordinate(p.a);
      const b = series.priceToCoordinate(p.b);
      if (x !== null && a !== null && b !== null) {
        pts.push({ x, a, b, up: p.a >= p.b });
      }
    }

    target.useBitmapCoordinateSpace(({ context: ctx, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1]!;
        const p1 = pts[i]!;
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
