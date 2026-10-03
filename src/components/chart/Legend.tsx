import { ICHI, INDICATORS, type IndicatorId, MA_IDS } from "../../lib/chart-theme";
import { formatNumber, formatSigned, signClass, verdictClass } from "../../lib/format";
import type { Indicators } from "../../lib/indicators";
import type { Bar, JudgeResult } from "../../lib/types";

type Props = {
  code: string;
  name: string;
  bars: Bar[];
  index: number;
  ind: Indicators;
  indicators: Set<IndicatorId>;
  isLineVisible: (id: string) => boolean;
  showPrice: boolean;
  dataWindow: boolean;
  covered: boolean;
  result: JudgeResult | null;
};

/**
 * 指標の名前と値を、線と同じ色で1つ書く。
 */
function LegendValue({ label, color, value, digits = 1 }: { label: string; color: string; value: number | null | undefined; digits?: number }) {
  return (
    <span>
      <b>{label}</b>
      <span style={{ color }}>{formatNumber(value, digits)}</span>
    </span>
  );
}

/**
 * チャート左上の凡例。十字線の日(なければ最新の足)の四本値と、表示中の指標の値を出す。
 * データ表示がオンのときは指標の値はそちらに出すので、凡例は四本値までにする。
 */
export function Legend({ code, name, bars, index, ind, indicators, isLineVisible, showPrice, dataWindow, covered, result }: Props) {
  const b = bars[index]!;
  const prev = bars[index - 1];
  const chg = prev ? (b.close / prev.close - 1) * 100 : null;

  const maValues = MA_IDS.filter((id) => indicators.has(id)).map((id) => {
    const def = INDICATORS.find((d) => d.id === id)!;

    return <LegendValue key={id} label={def.label} color={def.color} value={ind[id][index]} />;
  });
  if (indicators.has("bb")) {
    maValues.push(<LegendValue key="bbp2" label="BB +2σ" color="#9c27b0" value={ind.bb.p2[index]} />);
    maValues.push(<LegendValue key="bbm2" label="−2σ" color="#9c27b0" value={ind.bb.m2[index]} />);
  }

  const ichimokuValues = (
    [
      ["tenkan", "転換"],
      ["kijun", "基準"],
      ["spanA", "先行1"],
      ["spanB", "先行2"],
      ["chikou", "遅行"],
    ] as const
  )
    .filter(([id]) => isLineVisible(id))
    .map(([id, label]) => <LegendValue key={id} label={label} color={ICHI[id]} value={ind.ichimoku[id][index]} />);

  const subValues = [];
  if (indicators.has("rsi")) {
    subValues.push(<LegendValue key="rsi" label="RSI" color="#7e57c2" value={ind.rsi[index]} />);
  }
  if (indicators.has("rci")) {
    subValues.push(<LegendValue key="rci10" label="RCI10" color="#00bcd4" value={ind.rci10[index]} />);
    subValues.push(<LegendValue key="rci26" label="RCI26" color="#ff9800" value={ind.rci26[index]} />);
  }
  if (indicators.has("macd")) {
    subValues.push(<LegendValue key="macd" label="MACD" color="#2962ff" value={ind.macd.line[index]} digits={2} />);
    subValues.push(<LegendValue key="signal" label="Signal" color="#ff6d00" value={ind.macd.signal[index]} digits={2} />);
  }
  if (showPrice && indicators.has("vol")) {
    subValues.push(
      <span key="vol">
        <b>Vol</b>
        {b.volume.toLocaleString("ja-JP")}
      </span>,
    );
  }

  return (
    <div id="legend" className={`legend ${covered ? "covered" : ""}`}>
      <div className="title">
        {code}
        <small>{name} · 日足 · 東証</small>
        {result && <span className={`tag ${verdictClass(result.verdict)} verdict-tag`}>{result.verdict}</span>}
      </div>
      <div className={`row ${signClass(chg)}`}>
        <span>
          <b>日付</b>
          {b.date}
        </span>
        <span>
          <b>始</b>
          {formatNumber(b.open)}
        </span>
        <span>
          <b>高</b>
          {formatNumber(b.high)}
        </span>
        <span>
          <b>安</b>
          {formatNumber(b.low)}
        </span>
        <span>
          <b>終</b>
          {formatNumber(b.close)}
        </span>
        <span>{chg == null || !prev ? "" : `${formatSigned(b.close - prev.close, 1, "")} (${formatSigned(chg)})`}</span>
      </div>
      {!dataWindow && showPrice && maValues.length > 0 && <div className="row">{maValues}</div>}
      {!dataWindow && showPrice && indicators.has("ichimoku") && <div className="row">{ichimokuValues}</div>}
      {!dataWindow && subValues.length > 0 && <div className="row">{subValues}</div>}
    </div>
  );
}
