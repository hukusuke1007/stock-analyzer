import { useQueryClient } from "@tanstack/react-query";
import { Store, useSelector } from "@tanstack/react-store";
import { type ChangeEvent, type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { VERDICT_RANK } from "../../lib/format";
import { findJudgment, queryKeys, resultsQuery, useWatchActions, useWatchlist } from "../../lib/queries";
import type { BarsResponse, SavedResults } from "../../lib/types";
import { judgmentKey, toggleDataWindow, uiStore } from "../../lib/ui-store";
import { ROW_HEIGHT } from "./cell-chart";
import { type DataCardState, DataWindowCard } from "./DataWindowCard";
import { GridCell } from "./GridCell";

// 関心銘柄タブ: ウォッチリストの銘柄のチャートを行列に並べる。
// 1行の表示数と並び順はサーバーに保存する(保存は useWatchActions が少し待ってまとめて送る)

const COLUMN_CHOICES = [1, 2, 3, 4, 5];

type SortKey = "verdict" | "changeDesc" | "changeAsc" | "code";

/**
 * 関心銘柄のチャートの一覧を描く。上のバーで追加・表示数・データ表示・並べ替えを操作する。
 */
export function GridView() {
  const queryClient = useQueryClient();
  const { codes, columns } = useWatchlist();
  const { add, reorder, setColumns } = useWatchActions();
  const dataWindow = useSelector(uiStore, (s) => s.dataWindow);
  const [input, setInput] = useState("");
  const [cardStore] = useState(() => new Store<DataCardState>(null));
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragCodeRef = useRef<string | null>(null);

  // 一覧をスクロールするとカードの位置がずれるので隠す
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }

    const hideDataCard = () => cardStore.setState(() => null);
    scroller.addEventListener("scroll", hideDataCard, { passive: true });

    return () => scroller.removeEventListener("scroll", hideDataCard);
  }, [cardStore]);

  /**
   * ドラッグした銘柄を、落とした銘柄の位置に移して保存する。
   */
  const moveWatchCode = useCallback(
    (from: string, to: string) => {
      const list = [...(queryClient.getQueryData<{ codes: string[] }>(queryKeys.watchlist)?.codes ?? [])];

      // 落とし先の位置は抜く前に測る。下へ動かせば落とし先の後ろ、上へ動かせば前に入る
      const target = list.indexOf(to);
      list.splice(list.indexOf(from), 1);
      list.splice(target, 0, from);

      reorder(list);
    },
    [queryClient, reorder],
  );

  /**
   * 前日比(比率)を返す。日足をまだ読んでいなければ最後に並べるため -Infinity。
   */
  const readChangeRatio = (code: string): number => {
    const bars = queryClient.getQueryData<BarsResponse>(queryKeys.bars(code))?.bars;
    const last = bars?.at(-1);
    const prev = bars?.at(-2);

    return last && prev ? last.close / prev.close - 1 : -Infinity;
  };

  /**
   * 判定の順位を返す。買い → 打診買い → 見送りの順で、同じ判定なら満たした条件が多い方を先にする。
   */
  const readVerdictRank = (code: string): number => {
    const { strategy, pending } = uiStore.state;
    const saved = queryClient.getQueryData<SavedResults>(resultsQuery(strategy).queryKey);
    const judgment = findJudgment(saved, pending[judgmentKey(code, strategy)], code);
    if (!judgment || !("result" in judgment)) {
      return 99;
    }

    const r = judgment.result;

    return VERDICT_RANK[r.verdict] * 10 - Number(r.satisfied.split("/")[0]);
  };

  /**
   * 選んだ順で一度だけ並べ直して保存する。その後はドラッグで自由に動かせるよう、選択は「並べ替え…」に戻す。
   */
  const sortWatchlist = (e: ChangeEvent<HTMLSelectElement>) => {
    const key = e.target.value as SortKey | "";
    if (!key) {
      return;
    }

    const compare: Record<SortKey, (a: string, b: string) => number> = {
      verdict: (a, b) => readVerdictRank(a) - readVerdictRank(b),
      changeDesc: (a, b) => readChangeRatio(b) - readChangeRatio(a),
      changeAsc: (a, b) => readChangeRatio(a) - readChangeRatio(b),
      code: (a, b) => a.localeCompare(b),
    };
    reorder([...codes].sort(compare[key]));
  };

  /**
   * 入力した証券コードを関心銘柄に足す。足せたら入力欄を空にする。
   */
  const addWatchCode = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (add(input)) {
      setInput("");
    }
  };

  return (
    <main id="grid-view" className="grid-view">
      <DataWindowCard cardStore={cardStore} />
      <div className="grid-bar">
        <span className="panel-title">関心銘柄</span>
        <span id="grid-count" className="muted">{`${codes.length}銘柄`}</span>
        <form id="grid-add" className="watch-add" autoComplete="off" onSubmit={addWatchCode}>
          <input placeholder="+ コード" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
        </form>
        <div className="spacer" />
        <span className="muted small-label">1行の表示数</span>
        <div id="grid-cols" className="segmented compact">
          {COLUMN_CHOICES.map((n) => (
            <button key={n} type="button" className={n === columns ? "active" : ""} onClick={() => setColumns(n)}>
              {n}
            </button>
          ))}
        </div>
        <button
          className={`dw-toggle${dataWindow ? " active" : ""}`}
          type="button"
          title="十字線の日の値をカーソルの横に一覧表示します(チャートタブと共通)"
          onClick={toggleDataWindow}
        >
          データ表示
        </button>
        <select id="grid-sort" className="select" title="並べ替えて保存します(その後はドラッグで自由に動かせます)" value="" onChange={sortWatchlist}>
          <option value="">並べ替え…</option>
          <option value="verdict">判定順(買い → 見送り)</option>
          <option value="changeDesc">前日比が高い順</option>
          <option value="changeAsc">前日比が低い順</option>
          <option value="code">コード順</option>
        </select>
      </div>
      <div id="grid-scroll" className="grid-scroll" ref={scrollRef}>
        <div
          id="grid"
          className="grid"
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gridAutoRows: `${ROW_HEIGHT[columns] ?? ROW_HEIGHT[3]}px` }}
        >
          {codes.map((code) => (
            <GridCell key={code} code={code} columns={columns} scrollRef={scrollRef} dragCodeRef={dragCodeRef} cardStore={cardStore} onMove={moveWatchCode} />
          ))}
        </div>
        <div id="grid-empty" className="chart-empty" hidden={codes.length > 0}>
          関心銘柄がありません。「+ コード」から追加してください
        </div>
      </div>
      <div className="grid-foot muted">
        見出しをドラッグで並べ替え · チャートをダブルクリックでチャートタブに表示 · ドラッグで期間を移動 · Charts by{" "}
        <a href="https://www.tradingview.com/" target="_blank" rel="noopener">
          TradingView
        </a>{" "}
        Lightweight Charts™
      </div>
    </main>
  );
}
