import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { errorMessage, requestApi } from "../../lib/api";
import { formatDateTime, formatNumber, formatSigned, signClass, VERDICT_RANK, verdictClass } from "../../lib/format";
import { decisionOf, MAX_WATCH, queryKeys, resultsQuery, useStrategies, useWatchActions, useWatchlist } from "../../lib/queries";
import type { JudgeResult, SavedResults, ScreenResult, Verdict } from "../../lib/types";
import { clearPendingJudgments, openTradeDialog, showFlash, uiStore } from "../../lib/ui-store";
import { MaterialsToggle } from "../layout/MaterialsToggle";
import { describeOptions, earningsClass } from "./DetailPanel";

// スキャンの段階ごとの表示名と、進捗バーの範囲(%)
const PHASES: Record<string, [string, number, number]> = {
  listing: ["銘柄一覧", 0, 5],
  analyze: ["テクニカル計算", 5, 60],
  judge: ["材料の取得と Decisions 判定", 60, 92],
  rank: ["Codex でランク付け", 92, 100],
};

const LARGE = new Set(["TOPIX Core30", "TOPIX Large70"]);

type SortKey = "rank" | "code" | "name" | "sector" | "scale" | "verdict" | "sat" | "close" | "chg" | "tp" | "sl" | "earn" | "rr" | "buy";

// 並べ替えに使う値。順位は降順(初回クリック)で1位が上になるよう、符号を反転する
const ROW_VALUE: Record<SortKey, (r: JudgeResult) => string | number | null | undefined> = {
  rank: (r) => (r.ranking ? -r.ranking.rank : null),
  code: (r) => r.code,
  name: (r) => r.name,
  sector: (r) => r.sector ?? "",
  scale: (r) => r.scale ?? "",
  verdict: (r) => -VERDICT_RANK[r.verdict],
  sat: (r) => r.checks.filter((c) => c.ok).length,
  close: (r) => r.technicals.close as number | null,
  chg: (r) => r.technicals.changePct as number | null,
  tp: (r) => r.sellPlan.takeProfit[0]?.pct,
  sl: (r) => r.sellPlan.stopLoss.pct,
  earn: (r) => r.materials?.earnings?.next?.date,
  rr: (r) => r.sellPlan.riskReward,
  buy: (r) => decisionOf(r)?.verdictProbabilities.買い,
};

// 文字の列は初回クリックで昇順、数値の列は降順
const TEXT_KEYS: SortKey[] = ["code", "name", "sector", "scale"];

const COLUMNS: { key: SortKey | null; label: string; className?: string; title?: string }[] = [
  { key: "rank", label: "順位", className: "num", title: "AI(Codex か Workers AI)のランキング(上位30件、Workers AI は15件)" },
  { key: "code", label: "コード" },
  { key: "name", label: "銘柄" },
  { key: "sector", label: "業種" },
  { key: "scale", label: "規模" },
  { key: "verdict", label: "判定" },
  { key: "sat", label: "条件", className: "num" },
  { key: "close", label: "終値", className: "num" },
  { key: "chg", label: "前日比", className: "num" },
  { key: "tp", label: "利確", className: "num" },
  { key: "sl", label: "損切り", className: "num" },
  { key: "earn", label: "決算", className: "num", title: "次回の決算発表日(「決算」オプションでスキャンしたとき)" },
  { key: "rr", label: "R/R", className: "num" },
  { key: "buy", label: "買い確率", className: "num", title: "Decisions の「買い」確率" },
];

type Progress = { phase: string; done: number; total: number };

/**
 * 全銘柄スキャンを SSE(/api/screen)で受け、終わったら保存済みの判定結果のキャッシュに入れる。
 * 進んだ分は onProgress、エラーは onError に渡す。
 */
function startScan(url: string, handlers: { onProgress: (p: Progress) => void; onResult: (r: ScreenResult) => void; onError: (msg: string) => void }) {
  const es = new EventSource(url);
  // 閉じないと EventSource が自動で再接続し、スキャンをやり直してしまう
  const finish = () => es.close();

  es.addEventListener("progress", (e) => {
    handlers.onProgress(JSON.parse((e as MessageEvent<string>).data) as Progress);
  });
  es.addEventListener("result", (e) => {
    finish();
    handlers.onResult(JSON.parse((e as MessageEvent<string>).data) as ScreenResult);
  });
  es.addEventListener("error", (e) => {
    finish();

    let message = "スキャンに失敗しました(サーバーとの接続が切れました)";
    const data = (e as MessageEvent<string>).data;
    if (data) {
      try {
        message = (JSON.parse(data) as { error: string }).error;
      } catch {
        // サーバーの送ったエラーが読めなければ、接続が切れた扱いにする
      }
    }
    handlers.onError(message);
  });

  return finish;
}

/**
 * スクリーナー(東証プライム全銘柄のスキャンと、結果の一覧)。
 */
export function ScreenerPanel({ selectedCode, height, collapsed, resizer }: { selectedCode: string | null; height: number; collapsed: boolean; resizer: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const strategies = useStrategies();
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const options = useSelector(uiStore, (s) => s.options);
  const { data: saved } = useQuery(resultsQuery(strategy));
  const watch = useWatchlist();
  const watchActions = useWatchActions();
  const [scanning, setScanning] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey | null; asc: boolean }>({ key: null, asc: false });
  const [verdicts, setVerdicts] = useState<Set<Verdict>>(new Set(["買い", "打診買い"]));
  const [largeOnly, setLargeOnly] = useState(false);
  const [text, setText] = useState("");
  const [clearing, setClearing] = useState(false);
  const stopScanRef = useRef<(() => void) | null>(null);
  const strategyLabel = strategies.find((s) => s.id === strategy)?.label ?? strategy;
  const maxHoldingDays = strategies.find((s) => s.id === strategy)?.maxHoldingDays ?? 10;

  // 売買ルールを変えたら並べ替えを戻す。画面を離れたらスキャンの接続を閉じる
  useEffect(() => setSort({ key: null, asc: false }), [strategy]);
  useEffect(() => () => stopScanRef.current?.(), []);

  /**
   * 今の売買ルールと材料で全銘柄をスキャンする。結果はサーバーが保存し、ここではキャッシュに入れる。
   */
  const scanAllStocks = () => {
    if (scanning) {
      return;
    }

    const target = strategy;
    const params = `strategy=${encodeURIComponent(target)}${options.earnings ? "&earnings=1" : ""}${options.news ? "&news=1" : ""}`;
    setScanning(target);
    setScanError(null);
    setProgress({ phase: "listing", done: 0, total: 1 });

    stopScanRef.current = startScan(`/api/screen?${params}`, {
      onProgress: setProgress,
      onResult: (result) => {
        queryClient.setQueryData<SavedResults>(queryKeys.results(target), (old) => (old ? { ...old, screen: result } : old));
        setScanning(null);
        setProgress(null);
      },
      onError: (message) => {
        setScanError(message);
        setScanning(null);
        setProgress(null);
      },
    });
  };

  /**
   * 今の売買ルールで保存した調査結果(スクリーニング・個別の判定)をサーバーから消す。
   */
  const clearSavedResults = async () => {
    if (scanning === strategy) {
      showFlash("スキャン中はクリアできません");
      return;
    }

    const judged = saved?.judgments.length ?? 0;
    const screened = saved?.screen?.results.length ?? 0;
    const ok = confirm(
      `${strategyLabel}の調査結果を削除します。\n\n` +
        `・スクリーニング結果(過去の実行分も含む)${screened ? `: 最新 ${screened}件` : ""}\n` +
        `・個別の判定結果: ${judged}銘柄\n\n` +
        "もう一方の売買ルールの結果、ウォッチリスト、ニュースの下書きは残ります。元に戻せません。",
    );
    if (!ok) {
      return;
    }

    setClearing(true);
    try {
      await requestApi(`/results?strategy=${encodeURIComponent(strategy)}`, { method: "DELETE" });

      queryClient.setQueryData<SavedResults>(queryKeys.results(strategy), (old) => (old ? { ...old, judgments: [], screen: null } : old));
      clearPendingJudgments(strategy);
    } catch (e) {
      showFlash(`クリアできませんでした: ${errorMessage(e)}`);
    } finally {
      setClearing(false);
    }
  };

  /**
   * 判定の絞り込みチップを切り替える。
   */
  const toggleVerdictFilter = (v: Verdict) => {
    const next = new Set(verdicts);
    if (next.has(v)) {
      next.delete(v);
    } else {
      next.add(v);
    }

    setVerdicts(next);
  };

  /**
   * 列の見出しで並べ替える。同じ列をもう一度押したら逆順にする。
   */
  const sortByColumn = (key: SortKey) => {
    setSort(sort.key === key ? { key, asc: !sort.asc } : { key, asc: TEXT_KEYS.includes(key) });
  };

  /**
   * 「関心」のチェックで関心銘柄に記録 / 削除する。
   */
  const toggleWatchByCheck = (code: string, checked: boolean) => {
    if (!checked) {
      watchActions.remove(code);
      return;
    }

    if (watch.codes.length >= MAX_WATCH) {
      showFlash(`関心銘柄は${MAX_WATCH}件までです`);
      return;
    }
    watchActions.add(code);
  };

  const rows = filterAndSortRows(saved?.screen ?? null, { verdicts, largeOnly, text, sort });
  const progressInfo = progress ? (PHASES[progress.phase] ?? [progress.phase, 0, 100]) : null;
  const progressPct = progress && progressInfo ? progressInfo[1] + ((progressInfo[2] - progressInfo[1]) * progress.done) / Math.max(progress.total, 1) : 0;

  return (
    <section id="panel" className={`panel ${collapsed ? "collapsed" : ""}`} style={{ height }}>
      {resizer}
      <div className="panel-head">
        <span className="panel-title">東証プライム スクリーナー</span>
        <button className="tb-btn primary small" type="button" disabled={Boolean(scanning)} onClick={scanAllStocks}>
          {scanning ? "スキャン中…" : "全銘柄スキャン"}
        </button>
        <MaterialsToggle
          compact
          titles={{
            group: "スキャンで調べるテクニカル以外の材料(上部の「材料」と連動)",
            earnings: "候補全部の次回決算日を調べる。近ければ見送り",
            news: "候補全部のニュースを調べて Decisions の判定に入れる。悪材料なら見送り(スキャンの時間が延びます)",
          }}
        />
        {progress && progressInfo && (
          <div className="progress">
            <div className="bar">
              <div id="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span>
              {progress.phase === "listing"
                ? `${progressInfo[0]}を取得中`
                : `${progressInfo[0]} ${progress.done.toLocaleString()} / ${progress.total.toLocaleString()}`}
            </span>
          </div>
        )}
        <button className="tb-btn danger small" type="button" disabled={clearing} title="この売買ルールで保存した調査結果を削除" onClick={clearSavedResults}>
          結果をクリア
        </button>
        <div className="spacer" />
        <div className="chips">
          {(["買い", "打診買い", "見送り"] as const).map((v) => (
            <button key={v} className={`chip ${verdicts.has(v) ? "active" : ""}`} onClick={() => toggleVerdictFilter(v)}>
              {v}
            </button>
          ))}
        </div>
        <label className="check">
          <input type="checkbox" checked={largeOnly} onChange={(e) => setLargeOnly(e.target.checked)} /> 大型株のみ
        </label>
        <input className="filter" placeholder="コード / 銘柄名 / 業種" value={text} onChange={(e) => setText(e.target.value)} />
      </div>

      <ScreenSummary screen={saved?.screen ?? null} strategyLabel={strategyLabel} error={scanError} />

      <div className="table-wrap">
        <table id="screen-table">
          <thead>
            <tr>
              <th className="pick" title="チェックすると関心銘柄に記録します">
                関心
              </th>
              <th className="trade-col" title="株シミュレーターで仮想売買します">
                売買
              </th>
              {COLUMNS.map((c) => (
                <th
                  key={c.label}
                  className={[c.className, sort.key === c.key ? "sorted" : "", sort.key === c.key && sort.asc ? "asc" : ""].filter(Boolean).join(" ")}
                  title={c.title}
                  onClick={() => c.key && sortByColumn(c.key)}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {saved?.screen && rows.length === 0 && (
              <tr>
                <td colSpan={16} className="muted" style={{ textAlign: "center", padding: 20 }}>
                  条件に合う銘柄はありません
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <ScreenRow
                key={r.code}
                result={r}
                selected={r.code === selectedCode}
                watched={watch.codes.includes(r.code)}
                maxHoldingDays={maxHoldingDays}
                onSelect={() => navigate({ to: "/", search: { code: r.code } })}
                onToggleWatch={(checked) => toggleWatchByCheck(r.code, checked)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * スキャン結果を絞り込み、指定の列で並べ替える。
 */
function filterAndSortRows(
  screen: ScreenResult | null,
  f: { verdicts: Set<Verdict>; largeOnly: boolean; text: string; sort: { key: SortKey | null; asc: boolean } },
): JudgeResult[] {
  if (!screen) {
    return [];
  }

  const text = f.text.trim().toLowerCase();
  const rows = screen.results.filter(
    (r) =>
      f.verdicts.has(r.verdict) &&
      (!f.largeOnly || LARGE.has(r.scale ?? "")) &&
      (!text || `${r.code} ${r.name} ${r.sector ?? ""}`.toLowerCase().includes(text)),
  );
  if (!f.sort.key) {
    return rows;
  }

  const valueOf = ROW_VALUE[f.sort.key];
  const dir = f.sort.asc ? 1 : -1;

  // 値のない行は向きに関係なく後ろに回す
  return [...rows].sort((a, b) => {
    const x = valueOf(a);
    const y = valueOf(b);
    if (x == null) {
      return 1;
    }
    if (y == null) {
      return -1;
    }

    return (typeof x === "string" ? x.localeCompare(String(y), "ja") : x - Number(y)) * dir;
  });
}

/**
 * スキャン結果の要約(銘柄数・判定ごとの件数・スキャン日時・材料・ランキングの概要)。
 */
function ScreenSummary({ screen, strategyLabel, error }: { screen: ScreenResult | null; strategyLabel: string; error: string | null }) {
  if (error) {
    return (
      <div className="summary muted">
        <span className="error">{error}</span>
      </div>
    );
  }
  if (!screen) {
    return <div className="summary muted">{strategyLabel}で東証プライム約1,560銘柄を判定します(約40〜50秒)</div>;
  }

  const s = screen.summary;

  return (
    <div className="summary muted">
      {s.market} {s.listed.toLocaleString()}銘柄 → 候補 {s.candidates.toLocaleString()}件: <span className="tag buy">買い {s.byVerdict.買い}</span>{" "}
      <span className="tag probe">打診買い {s.byVerdict.打診買い}</span> <span className="tag pass">見送り {s.byVerdict.見送り}</span>
      {screen.errors.length ? ` · 取得エラー ${screen.errors.length}件` : ""} · {screen.scannedAt ? formatDateTime(screen.scannedAt) : ""} にスキャン · 材料:{" "}
      {describeOptions(screen.options)}
      {screen.ranking?.error ? (
        <>
          {" · "}
          <span className="error">{screen.ranking.provider ?? "Codex"} のランク付けに失敗: {screen.ranking.error}</span>
        </>
      ) : screen.ranking ? (
        <div className="rank-summary">
          {screen.ranking.provider ?? "Codex"}({screen.ranking.model})上位{screen.ranking.ranked}件をランク付け: {screen.ranking.summary}
        </div>
      ) : null}
    </div>
  );
}

/**
 * スキャン結果の1行。チェックと「売買」はチャートを切り替えず、それ以外のクリックでチャートを開く。
 */
function ScreenRow({ result: r, selected, watched, maxHoldingDays, onSelect, onToggleWatch }: {
  result: JudgeResult;
  selected: boolean;
  watched: boolean;
  maxHoldingDays: number;
  onSelect: () => void;
  onToggleWatch: (checked: boolean) => void;
}) {
  const t = r.technicals;
  const tp = r.sellPlan.takeProfit[0];
  const sl = r.sellPlan.stopLoss;
  const buy = decisionOf(r)?.verdictProbabilities.買い;
  const earnings = r.materials?.earnings;
  const next = earnings?.next;
  const close = typeof t.close === "number" ? t.close : null;
  const changePct = typeof t.changePct === "number" ? t.changePct : null;

  let earningsTitle = "決算オプションなしでスキャン";
  if (earnings) {
    earningsTitle = next ? `${next.date} あと${next.businessDays}営業日 · ${next.source}${next.confirmed ? "(確定)" : "(推定)"}` : "次回の決算発表日は不明";
  }

  return (
    <tr className={selected ? "selected" : ""} onClick={onSelect}>
      <td className="pick" onClick={(e) => e.stopPropagation()}>
        <input
          type="checkbox"
          checked={watched}
          title={watched ? "関心銘柄から外す" : "関心銘柄に追加"}
          aria-label={`${r.code} を関心銘柄に追加`}
          onChange={(e) => onToggleWatch(e.target.checked)}
        />
      </td>
      <td className="trade-col">
        <button
          className="tb-btn small trade-row-btn"
          type="button"
          title={`${r.code} を株シミュレーターで仮想売買します`}
          onClick={(e) => {
            e.stopPropagation();
            openTradeDialog(r.code);
          }}
        >
          売買
        </button>
      </td>
      <td className="num" title={r.ranking?.reason ?? ""}>
        {r.ranking ? r.ranking.rank : "—"}
      </td>
      <td className="code">{r.code}</td>
      <td className="name" title={r.name}>
        {r.name}
      </td>
      <td className="muted">{r.sector ?? ""}</td>
      <td className="muted">{r.scale ?? ""}</td>
      <td>
        <span className={`tag ${verdictClass(r.verdict)}`}>{r.verdict}</span>
      </td>
      <td className="num">{r.satisfied}</td>
      <td className="num">{formatNumber(close)}</td>
      <td className={`num ${signClass(changePct)}`}>{formatSigned(changePct)}</td>
      <td className="num">
        {tp ? (
          <>
            {formatNumber(tp.price)} <span className="up">{formatSigned(tp.pct, 1)}</span>
          </>
        ) : (
          "—"
        )}
      </td>
      <td className="num">
        {sl.price == null ? (
          "—"
        ) : (
          <>
            {formatNumber(sl.price)} <span className="down">{formatSigned(sl.pct, 1)}</span>
          </>
        )}
      </td>
      <td className={`num ${earningsClass(next, maxHoldingDays)}`} title={earningsTitle}>
        {!earnings ? "—" : !next ? <span className="muted">不明</span> : `${next.date.slice(5).replace("-", "/")}${next.confirmed ? "" : "?"}`}
      </td>
      <td className="num">{r.sellPlan.riskReward ?? "—"}</td>
      <td className="num">{buy == null ? "—" : `${Math.round(buy * 100)}%`}</td>
    </tr>
  );
}
