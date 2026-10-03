// 急落リバウンド: 大型株の逆張りスイング。
// 作者の個人用の調査メモにあった判定スクリプト(Python)を移植したもの。
import { fetchDaily, fmt, pctFrom, rci, round, sma, stdev } from "../technicals.js";
import type { Strategy } from "./index.js";

export const rebound: Strategy = {
  id: "rebound",
  label: "急落リバウンド(大型株の逆張り)",
  rules: [
    "急落リバウンド: 時価総額の大きい大型株が、明確な材料なしに急落したところを買い、歪みが解消したら売る逆張りスイング。",
    "買いの4条件: 前日比-2.5%以下の急落かつ明確な材料なし / 25日線から大きく下方乖離かつ下げ止まりの兆し / ボリンジャーバンド-2σ〜-3σに到達 / RCI(10)が-90%以下。",
    "4つ全部揃うことは稀。揃わないときは入らないのが正解。迷ったら入らない。",
    "どうしても入りたいなら、どちらに転んでも大怪我しないロット(100株の打診買い)で入る。",
    "エントリーは逆張りの中の順張り。急落後、底を打って反転してから買う。",
    "悪材料(不祥事・下方修正など)が出ている急落は対象外。テクニカルが効くのは材料がないときだけ。",
  ].join("\n"),
  verdicts: {
    買い: "買いの条件が十分に揃い、下げ止まりも見えている。悪材料もない",
    打診買い: "条件は一部しか揃わないが、売られすぎで反発が見込める。100株だけ試しに買う程度",
    見送り: "条件が揃わない、下げ止まっていない、または悪材料がある。入らないのが正解",
  },
  qualitative: {
    checkIndex: 1, // 25日線乖離の条件は「大きく下方乖離」かつ「下げ止まりの兆し」
    label: "下げ止まり",
    instructions: "直近10営業日の終値の推移から見て、下落が止まり反転しつつある(下げ止まりの兆しがある)か",
    criteria: {
      true: "安値を更新しなくなった、または直近で反発している",
      false: "まだ下落が続いている、または下落していない",
    },
  },

  async analyze(code) {
    const { symbol, name, bars } = await fetchDaily(code);
    const closes = bars.map((b) => b.close);
    const last = closes.at(-1)!;
    const prev = closes.at(-2)!;

    const ma25 = sma(closes, 25);
    const ma100 = sma(closes, 100);
    const sd25 = stdev(closes, 25);
    // 25日線の向き(直近5営業日で上昇したか)
    const prevMa25 = closes.length >= 30 ? sma(closes.slice(0, -5), 25) : null;
    const changePct = (last / prev - 1) * 100;
    const ma25GapPct = ma25 ? (last / ma25 - 1) * 100 : null;
    const sigma = ma25 !== null && sd25 ? (last - ma25) / sd25 : null;
    const rci10 = rci(closes, 10);
    const technicals = {
      close: last,
      changePct: round(changePct, 2),
      ma5: round(sma(closes, 5)),
      ma25: round(ma25),
      ma25GapPct: round(ma25GapPct, 2),
      ma25Slope: ma25 !== null && prevMa25 !== null ? (ma25 > prevMa25 ? "上向き" : "下向き") : null,
      ma100: round(ma100),
      ma100GapPct: round(ma100 ? (last / ma100 - 1) * 100 : null, 2),
      sigma: round(sigma, 2),
      rci10: round(rci10),
      rci26: round(rci(closes, 26)),
      costFor100Shares: Math.round(last * 100),
    };

    const checks = [
      { label: "前日比", criterion: "-2.5%以下", value: fmt(changePct, "%"), ok: changePct <= -2.5 },
      {
        label: "25日線乖離",
        criterion: "大きく下方乖離(-3%以下)",
        value: fmt(ma25GapPct, "%"),
        ok: ma25GapPct !== null && ma25GapPct <= -3,
      },
      { label: "ボリンジャーバンド", criterion: "-2σ以下", value: fmt(sigma, "σ"), ok: sigma !== null && sigma <= -2 },
      { label: "RCI(10)", criterion: "-90%以下", value: fmt(rci10, "%", 1), ok: rci10 !== null && rci10 <= -90 },
    ];

    // 利確は「買った理由の歪みが解消したとき」。満たした条件に対応する利確ラインだけを出す(買った理由と売る理由を一致させる)
    const dropLine = round(prev * 0.975);
    const takeProfit = [
      ...(checks[0]!.ok
        ? [{ price: dropLine, pct: pctFrom(last, dropLine), when: "前日比の急落で買った場合: 前日比-2.5%の水準まで戻したら" }]
        : []),
      ...(checks[1]!.ok || checks[2]!.ok || !checks[0]!.ok
        ? [
            {
              price: round(ma25),
              pct: pctFrom(last, ma25),
              when: "25日線乖離・-2σで買った場合: 当日の25日線にタッチしたら",
            },
          ]
        : []),
    ];
    const stop = ma25 !== null && sd25 !== null ? ma25 - 3 * sd25 : null;
    const firstTarget = takeProfit[0]?.price ?? null;

    return {
      code,
      symbol,
      name,
      asOf: bars.at(-1)!.date,
      checks,
      technicals,
      aiState: { ...technicals, recentCloses: bars.slice(-10).map((b) => ({ date: b.date, close: b.close })) },
      // 出口は買う前に決める。利確は買いの根拠となった歪みが解消したところ、損切りは -3σ 貫通。
      sellPlan: {
        takeProfit,
        stopLoss: {
          price: round(stop),
          pct: pctFrom(last, stop),
          when: "-3σを終値で割り込んだらシナリオ崩壊として損切り",
        },
        signals: [
          `25日線(現在 ${technicals.ma25 ?? "—"}円)は毎日動くので、利確の指値は毎朝出し直す`,
          `損切りは買った時点の-3σ(現在 ${round(stop) ?? "—"}円)で固定し、逆指値で置いておく`,
          "保有中に不祥事・下方修正などの悪材料が出たら、テクニカルに関係なく即撤退",
          "「まだ上がりそう」で持ち続けない。利確ラインに来たら機械的に売る",
          "決算はまたがない。次回決算発表の前に手仕舞う",
        ],
        holdingPeriod: "2〜3日〜数週間(最長1ヶ月)",
        riskReward:
          firstTarget !== null && stop !== null && last > stop ? round((firstTarget - last) / (last - stop), 2) : null,
      },
    };
  },

  // 4条件を1つも満たさない銘柄は明らかに見送り
  isCandidate: (checks) => checks.some((c) => c.ok),

  // AI の判定なしでは下げ止まりを確認できないので、4条件が揃っても打診買いまで
  maxHoldingDays: 20, // 最長1ヶ月

  fallbackVerdict: (checks) => (checks.every((c) => c.ok) ? "打診買い" : "見送り"),
};
