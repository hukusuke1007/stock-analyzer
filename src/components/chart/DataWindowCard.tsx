import { useLayoutEffect, useRef } from "react";
import { type DataWindowRow, dataWindowLeft } from "../../lib/chart-theme";
import type { Bar } from "../../lib/types";
import { DataWindowBody, fitDataWindowColumns } from "../common/DataWindowBody";

type Props = {
  bar: Bar;
  name: string;
  rows: DataWindowRow[];
  cursorX: number; // 十字線の x 座標(チャートの左端から)
  boundWidth: number; // カードを収める幅(チャートの幅)
};

/**
 * チャート画面のデータ表示のカード。十字線の日の値を、カーソルの左隣(入らなければ右隣)に出す。
 */
export function DataWindowCard({ bar, name, rows, cursorX, boundWidth }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  // 描いた後の大きさで、列の数と位置を決める。十字線が動くたびに中身が変わるので、毎回測り直す
  useLayoutEffect(() => {
    const box = el.current;
    const rowsEl = grid.current;
    if (!box || !rowsEl) {
      return;
    }

    fitDataWindowColumns(box, rowsEl);
    box.style.left = `${dataWindowLeft(box.offsetWidth, cursorX, boundWidth)}px`;
  });

  return (
    <div ref={el} id="data-window" className="data-window">
      <DataWindowBody name={name} date={bar.date} rows={rows} gridRef={grid} />
    </div>
  );
}
