import { type Store, useSelector } from "@tanstack/react-store";
import { useLayoutEffect, useRef } from "react";
import { type DataWindowRow, dataWindowLeft } from "../../lib/chart-theme";
import { DataWindowBody, fitDataWindowColumns } from "../common/DataWindowBody";

// 関心銘柄タブのデータ表示。画面に1つだけ浮かせ、十字線を動かしたセルの値を出す

export type DataCardState = {
  name: string;
  date: string; // 十字線の日(YYYY-MM-DD)
  rows: DataWindowRow[];
  x: number; // カーソルの位置(画面の座標)
  y: number;
} | null;

/**
 * データ表示のカードを、カーソルの左隣(入らなければ右隣)に浮かせて描く。
 * 中身はセルが cardStore に入れ、null なら隠す。
 */
export function DataWindowCard({ cardStore }: { cardStore: Store<DataCardState> }) {
  const card = useSelector(cardStore, (s) => s);
  const el = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);

  // 描いた後の大きさで、列の数と位置を決める
  useLayoutEffect(() => {
    const box = el.current;
    const rows = grid.current;
    if (!card || !box || !rows) {
      return;
    }

    fitDataWindowColumns(box, rows);
    box.style.left = `${dataWindowLeft(box.offsetWidth, card.x, window.innerWidth)}px`;
    box.style.top = `${Math.max(4, Math.min(card.y - box.offsetHeight / 2, window.innerHeight - box.offsetHeight - 4))}px`;
  }, [card]);

  return (
    <div id="grid-data-window" className="data-window floating" ref={el} hidden={!card}>
      {card && <DataWindowBody name={card.name} date={card.date} rows={card.rows} gridRef={grid} />}
    </div>
  );
}
