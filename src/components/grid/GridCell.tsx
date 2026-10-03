import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type Store, useSelector } from "@tanstack/react-store";
import type { MouseEventParams, Time } from "lightweight-charts";
import { type DragEvent, memo, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { dataWindowRows } from "../../lib/chart-theme";
import { changePercent, formatNumber, formatSigned, signClass, verdictClass } from "../../lib/format";
import { computeIndicators } from "../../lib/indicators";
import { barsQuery, useJudgeStock, useJudgment, useNameLookup, useWatchActions } from "../../lib/queries";
import { setOrderCode, uiStore } from "../../lib/ui-store";
import { applyTradeMarks, applyVisibleRange, type CellChart, createCellChart, fillCellSeries } from "./cell-chart";
import type { DataCardState } from "./DataWindowCard";

type GridCellProps = {
  code: string;
  columns: number;
  scrollRef: RefObject<HTMLDivElement | null>; // 画面に入ったかを見る基準(一覧のスクロール枠)
  dragCodeRef: RefObject<string | null>; // ドラッグ中の銘柄(セルをまたいで共有する)
  cardStore: Store<DataCardState>;
  onMove: (from: string, to: string) => void;
};

/**
 * 関心銘柄1つ分のセル(見出しとチャート)を描く。
 * チャートは画面に入りそうになってから日足を読んで作り、銘柄が多くても最初の表示を軽くする。
 */
export const GridCell = memo(function GridCell({ code, columns, scrollRef, dragCodeRef, cardStore, onMove }: GridCellProps) {
  const navigate = useNavigate();
  const { remove } = useWatchActions();
  const judgeStock = useJudgeStock();
  const lookupName = useNameLookup();
  const indicators = useSelector(uiStore, (s) => s.indicators);
  const hiddenLines = useSelector(uiStore, (s) => s.hiddenLines);
  const judgment = useJudgment(code);
  const [visible, setVisible] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isDropTarget, setIsDropTarget] = useState(false);
  const [cellChart, setCellChart] = useState<CellChart | null>(null);
  const cellRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  // 画面に入るまでは読みに行かない。ライブ更新などで先にキャッシュに入っていれば、それを使う
  const { data, error } = useQuery({ ...barsQuery(code), enabled: visible });
  const bars = data?.bars;
  const hasBars = Boolean(bars);
  const ind = useMemo(() => (bars ? computeIndicators(bars) : null), [bars]);

  const result = judgment && "result" in judgment ? judgment.result : null;
  const isJudging = Boolean(judgment && "loading" in judgment);
  const name = lookupName(code);
  const last = bars?.at(-1);
  const change = changePercent(bars);

  // 十字線の処理はチャートを作り直さずに最新の日足・判定を読みたいので、描くたびに入れ替える
  const showDataCardRef = useRef<(param: MouseEventParams<Time>) => void>(() => {});
  showDataCardRef.current = (param) => {
    const box = boxRef.current;
    if (!uiStore.state.dataWindow || !bars || !ind || !box || !param.point || param.logical == null) {
      cardStore.setState(() => null);
      return;
    }

    const i = Math.max(0, Math.min(bars.length - 1, Math.round(param.logical)));
    const rows = dataWindowRows(bars, ind, i, {
      indicators: new Set(indicators),
      isLineVisible: (id) => !hiddenLines.includes(id),
      showPrice: true,
      showTradeLines: uiStore.state.tools.lines,
      result,
      pricePaneOnly: true,
    });
    const r = box.getBoundingClientRect();

    cardStore.setState(() => ({ name, date: bars[i]!.date, rows, x: r.left + param.point!.x, y: r.top + param.point!.y }));
  };

  // 画面に入った(入りそうな)ら日足を読み始める。一度見えたら、その後は見張らない
  useEffect(() => {
    const el = cellRef.current;
    if (!el) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: scrollRef.current, rootMargin: "400px 0px" },
    );
    observer.observe(el);

    return () => observer.disconnect();
  }, [scrollRef]);

  // 日足が揃ったらチャートを作る。インジケーターや線の表示設定が変わったら作り直す
  useEffect(() => {
    const box = boxRef.current;
    if (!visible || !hasBars || !ind || !box) {
      return;
    }

    const built = createCellChart(box, indicators, hiddenLines, ind);
    const showDataCard = (param: MouseEventParams<Time>) => showDataCardRef.current(param);
    built.chart.subscribeCrosshairMove(showDataCard);
    setCellChart(built);

    // 作り直す前のチャートを指したカードが残らないよう、カードも隠す
    return () => {
      cardStore.setState(() => null);
      built.chart.remove();
      setCellChart(null);
    };
    // 日足の更新では作り直さず、下の effect で系列だけ入れ直す
  }, [visible, hasBars, indicators, hiddenLines, cardStore]);

  // 日足(ライブ更新を含む)を系列に入れる。作った直後だけ表示範囲を合わせ、その後はユーザーの拡大・移動を保つ
  useEffect(() => {
    if (!cellChart || !bars || !ind) {
      return;
    }

    fillCellSeries(cellChart, bars, ind);

    if (!cellChart.ranged) {
      applyVisibleRange(cellChart, bars.length, columns);
      cellChart.ranged = true;
    }
    // 表示数の変更は下の effect が合わせ直す
  }, [cellChart, bars, ind]);

  // 判定の印と利確 / 損切りの線を描き直す
  useEffect(() => {
    if (!cellChart || !bars) {
      return;
    }

    applyTradeMarks(cellChart, bars, result);
  }, [cellChart, bars, result]);

  // 1行の表示数が変わったら表示範囲を合わせ直す。
  // チャートは幅が変わっても足の間隔を保つので、リサイズが済んでから(2フレーム後に)合わせる
  useEffect(() => {
    if (!cellChart || !bars) {
      return;
    }

    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => applyVisibleRange(cellChart, bars.length, columns));
    });

    return () => cancelAnimationFrame(frame);
    // 日足やチャートが変わっただけでは、ユーザーが動かした表示範囲を戻さない
  }, [columns]);

  /**
   * 見出しのドラッグを始める。どの銘柄を動かすかを、落とす側のセルに伝えるため共有の ref に入れる。
   */
  const startHeadDrag = (e: DragEvent<HTMLDivElement>) => {
    dragCodeRef.current = code;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", code);
    setIsDragging(true);
  };

  /**
   * 見出しのドラッグを終える(落とした・やめた)。
   */
  const endHeadDrag = () => {
    dragCodeRef.current = null;
    setIsDragging(false);
  };

  /**
   * 別のセルを上に重ねたときに、落とせることを示す。
   */
  const allowDropOnCell = (e: DragEvent<HTMLDivElement>) => {
    const from = dragCodeRef.current;
    if (!from || from === code) {
      return;
    }

    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setIsDropTarget(true);
  };

  /**
   * セルの外へ出たら落とし先の印を外す。中の子要素に移っただけなら外さない。
   */
  const leaveDropTarget = (e: DragEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setIsDropTarget(false);
    }
  };

  /**
   * ドラッグした銘柄を、このセルの位置に移す。
   */
  const dropOnCell = (e: DragEvent<HTMLDivElement>) => {
    const from = dragCodeRef.current;

    e.preventDefault();
    setIsDropTarget(false);

    if (from && from !== code) {
      onMove(from, code);
    }
  };

  /**
   * チャートタブでこの銘柄を開く。
   */
  const openChartPage = () => {
    void navigate({ to: "/", search: { code } });
  };

  /**
   * 銘柄を注文欄に入れて、シミュレーターを開く。
   */
  const openSimPage = () => {
    setOrderCode(code);
    void navigate({ to: "/sim" });
  };

  const className = ["cell", isDragging ? "dragging" : "", isDropTarget ? "drop-target" : ""].filter(Boolean).join(" ");

  return (
    <div className={className} data-code={code} ref={cellRef} onDragOver={allowDropOnCell} onDragLeave={leaveDropTarget} onDrop={dropOnCell}>
      <div className="cell-head" draggable title="ドラッグで並べ替え" onDragStart={startHeadDrag} onDragEnd={endHeadDrag}>
        <span className="grip" aria-hidden="true">
          ⋮⋮
        </span>
        <span className="cell-info">
          <b className="c-code">{code}</b>
          <span className="c-name" title={name}>
            {name}
          </span>
          <span className="c-price">{formatNumber(last?.close)}</span>
          <span className={`c-chg ${signClass(change)}`}>{formatSigned(change)}</span>
          {isJudging ? (
            <span className="tag pending">判定中…</span>
          ) : result ? (
            <span className={`tag ${verdictClass(result.verdict)}`} title={result.reason}>
              {result.verdict} {result.satisfied}
            </span>
          ) : (
            <span className="tag pending">未判定</span>
          )}
        </span>
        <button type="button" className="c-btn" title="今の売買ルールで判定" disabled={isJudging} onClick={() => void judgeStock(code)}>
          判定
        </button>
        <button type="button" className="c-btn buy" title="シミュレーターで仮想売買する" onClick={openSimPage}>
          買う
        </button>
        <button type="button" className="c-btn" title="チャートタブで開く" onClick={openChartPage}>
          ↗
        </button>
        <button type="button" className="c-btn del" title="関心銘柄から外す" onClick={() => remove(code)}>
          ×
        </button>
      </div>
      <div className="cell-chart" ref={boxRef} onDoubleClick={openChartPage}>
        {error ? (
          <div className="cell-msg error">{error.message}</div>
        ) : (
          !cellChart && (
            <div className="cell-msg">
              <div className="spinner" />
            </div>
          )
        )}
      </div>
    </div>
  );
});
