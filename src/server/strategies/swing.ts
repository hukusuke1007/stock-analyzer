// スイングトレード(保有3日〜2週間): 上昇トレンド中の押し目買い(順張り)。
// 急落リバウンド(急落の逆張り)より条件が揃いやすい。ルールの出典:
// - 20 Moving Average Pullback Strategy(TradingSim): 平均線の傾き、押し目での反転、損切り、時間切れ
// - 株のスイングトレードで勝つための10の必須ルール(証券会社比較なび): パーフェクトオーダー、リスクリワード
// - RSI(14)・MACD(12,26,9)の一般的な売買シグナル。下落トレンドでは買わない
import { atr, fetchDaily, fmt, macd, pctFrom, round, rsi, sma } from "../technicals.js";
import type { Strategy } from "./index.js";

export const swing: Strategy = {
  id: "swing",
  label: "スイング(上昇トレンドの押し目買い・3日〜2週間)",
  rules: [
    "スイングトレード(保有3日〜2週間): 上昇トレンド中の一時的な押し目で、反転を確認してから買う順張り。",
    "買いの5条件: 上昇トレンド(終値>75日線、25日線>75日線、25日線が上向き) / 25日線付近までの押し目 / RSI(14)が40〜60 / 反転シグナル(終値が前日高値を上抜く、または直近3日でMACDゴールデンクロス) / 押しの出来高が普段より少ない(売り崩しではなく利益確定の押し)。",
    "下落トレンドの銘柄は、RSIが低くても買わない。上昇の勢いだけで飛び乗らず、押し目を待つ。",
    "シグナルが1つだけのときはダマシを警戒して見送る。",
    "損切りは押し目の安値の下。直近高値までの値幅が損切り幅の1.5倍以上あるのが望ましい。",
  ].join("\n"),
  verdicts: {
    買い: "上昇トレンド中の押し目で反転も確認でき、条件がほぼ揃っている",
    打診買い: "トレンドと押し目は揃っているが、反転や出来高の確認が弱い。少量で試す程度",
    見送り: "上昇トレンドでない、押し目になっていない、または反転していない",
  },
  qualitative: {
    checkIndex: 1, // 押し目の条件は「25日線付近までの押し目」かつ「トレンドが崩れていない」
    label: "トレンド中の押し目",
    instructions:
      "直近20営業日の値動きから見て、今の下げは上昇トレンド中の一時的な押し目か(高値・安値の切り上げが崩れていないか)",
    criteria: {
      true: "高値と安値を切り上げてきた流れが続いており、押しは浅い",
      false: "安値を切り下げている、急落している、またはそもそも上昇トレンドではない",
    },
  },

  async analyze(code) {
    const { symbol, name, bars } = await fetchDaily(code);
    const closes = bars.map((b) => b.close);
    const volumes = bars.map((b) => b.volume);
    const last = bars.at(-1)!;
    const prev = bars.at(-2)!;

    const ma25 = sma(closes, 25);
    const ma75 = sma(closes, 75);
    const ma25Before = closes.length >= 30 ? sma(closes.slice(0, -5), 25) : null;
    const rsi14 = rsi(closes, 14);
    const recentMacd = macd(closes, 4);
    const atr14 = atr(bars, 14);
    const low5 = Math.min(...bars.slice(-5).map((b) => b.low));
    const high20 = Math.max(...bars.slice(-20).map((b) => b.high));
    const vol5 = sma(volumes, 5);
    const vol25 = sma(volumes, 25);

    const uptrend = ma25 !== null && ma75 !== null && ma25Before !== null && last.close > ma75 && ma25 > ma75 && ma25 > ma25Before;
    // 直近5日の安値が25日線の+2%以内まで下がり、終値は25日線の-2%以内にとどまっている
    const low5GapPct = ma25 ? (low5 / ma25 - 1) * 100 : null;
    const closeGapPct = ma25 ? (last.close / ma25 - 1) * 100 : null;
    const pullback = low5GapPct !== null && closeGapPct !== null && low5GapPct <= 2 && closeGapPct >= -2;
    // 直近3日のうちに MACD がシグナルを下から上抜いたか
    const goldenCross = recentMacd.some((d, i) => i > 0 && recentMacd[i - 1]!.macd <= recentMacd[i - 1]!.signal && d.macd > d.signal);
    const brokePrevHigh = last.close > prev.high;

    // 損切り: 押し目の安値と「25日線 - 0.5ATR」のうち近い方(高い方)。ただし現在値より下にあるものだけ
    const atrStop = ma25 !== null && atr14 !== null ? ma25 - 0.5 * atr14 : null;
    let stop = atrStop !== null && atrStop < last.close ? Math.max(low5, atrStop) : low5;
    // 今日の終値が5日安値そのもののときは損切り幅がゼロになるので、1ATR 下に置く
    if (stop >= last.close && atr14 !== null) stop = last.close - atr14;
    const risk = last.close - stop;
    const riskReward = risk > 0 ? (high20 - last.close) / risk : null;

    const technicals = {
      close: last.close,
      changePct: round((last.close / prev.close - 1) * 100, 2),
      ma5: round(sma(closes, 5)),
      ma25: round(ma25),
      ma75: round(ma75),
      ma25Slope: ma25 !== null && ma25Before !== null ? (ma25 > ma25Before ? "上向き" : "下向き") : null,
      rsi14: round(rsi14),
      macd: round(recentMacd.at(-1)?.macd ?? null, 2),
      macdSignal: round(recentMacd.at(-1)?.signal ?? null, 2),
      atr14: round(atr14),
      low5,
      high20,
      volumeRatio: round(vol5 !== null && vol25 ? vol5 / vol25 : null, 2),
      riskReward: round(riskReward, 2),
      costFor100Shares: Math.round(last.close * 100),
    };

    // 第1目標は直近20日の高値。そこまでの値幅が損切り幅の1.5倍に届かないときは「損切り幅の1.5倍」を目標にする
    const useHigh = riskReward !== null && riskReward >= 1.5;
    const target = useHigh ? high20 : round(last.close + 1.5 * risk);
    const takeProfit = [
      {
        price: target,
        pct: pctFrom(last.close, target),
        when: useHigh
          ? "第1目標: 直近20日の高値に届いたら半分を利確"
          : `第1目標: 直近20日の高値(${high20}円)が近すぎるので、損切り幅の1.5倍に届いたら半分を利確`,
      },
    ];
    const m = recentMacd.at(-1);

    return {
      code,
      symbol,
      name,
      asOf: last.date,
      checks: [
        {
          label: "上昇トレンド",
          criterion: "終値>75日線、25日線>75日線、25日線が上向き",
          value: `75日線 ${technicals.ma75 ?? "—"} / 25日線 ${technicals.ma25 ?? "—"}(${technicals.ma25Slope ?? "—"})`,
          ok: uptrend,
        },
        {
          label: "25日線への押し目",
          criterion: "直近5日の安値が25日線+2%以内、終値が25日線-2%以上",
          value: `安値 ${fmt(low5GapPct, "%")} / 終値 ${fmt(closeGapPct, "%")}`,
          ok: pullback,
        },
        {
          label: "RSI(14)",
          criterion: "40〜60",
          value: rsi14 === null ? "—" : rsi14.toFixed(1),
          ok: rsi14 !== null && rsi14 >= 40 && rsi14 <= 60,
        },
        {
          label: "反転シグナル",
          criterion: "終値が前日高値を上抜く、または直近3日でMACDゴールデンクロス",
          value: [brokePrevHigh ? "前日高値を上抜き" : null, goldenCross ? "MACD GC" : null].filter(Boolean).join(" / ") || "なし",
          ok: brokePrevHigh || goldenCross,
        },
        {
          label: "押しの出来高",
          criterion: "直近5日平均が25日平均を下回る",
          value: `${technicals.volumeRatio ?? "—"}倍`,
          ok: vol5 !== null && vol25 !== null && vol5 < vol25,
        },
      ],
      technicals,
      aiState: {
        ...technicals,
        recentBars: bars.slice(-20).map(({ date, high, low, close, volume }) => ({ date, high, low, close, volume })),
      },
      sellPlan: {
        takeProfit,
        stopLoss: {
          price: round(stop),
          pct: pctFrom(last.close, stop),
          when: "押し目の安値、または25日線-0.5ATRのうち近い方を終値で割ったら損切り",
        },
        signals: [
          `第2目標: 終値で25日線(現在 ${technicals.ma25 ?? "—"}円)を割ったら残りを手仕舞い`,
          `RSI(14)が70以上で過熱、80以上なら利確を検討(現在 ${technicals.rsi14 ?? "—"})`,
          `MACDがシグナルを上から下抜いたら(デッドクロス)利確を検討(現在 MACD ${round(m?.macd ?? null, 2) ?? "—"} / シグナル ${round(m?.signal ?? null, 2) ?? "—"})`,
          "5営業日たっても損切り幅ぶん上がらなければ建値で撤退。最長10営業日で手仕舞い",
          "決算発表をまたぐかどうかは買う前に確認する",
        ],
        holdingPeriod: "3日〜2週間",
        riskReward: useHigh ? round(riskReward, 2) : risk > 0 ? 1.5 : null,
      },
    };
  },

  // 上昇トレンドが前提。そのうえで5条件のうち3つ以上
  isCandidate: (checks) => checks[0]!.ok && checks.filter((c) => c.ok).length >= 3,

  maxHoldingDays: 10, // 最長10営業日

  fallbackVerdict: (checks) => {
    const n = checks.filter((c) => c.ok).length;
    return n === 5 ? "買い" : n === 4 && checks[0]!.ok ? "打診買い" : "見送り";
  },
};
