import type { Ref } from "react";
import type { DataWindowRow } from "../../lib/chart-theme";
import { formatNumber } from "../../lib/format";

// データ表示のカードの中身。チャート画面と関心銘柄タブで共通に使い、カードの置き場所だけをそれぞれで決める

const WEEK = ["日", "月", "火", "水", "木", "金", "土"];

/**
 * 日付を「2026年10月3日(土)」の形で書く。
 */
function formatCardDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);

  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日(${WEEK[d.getUTCDay()]})`;
}

/**
 * カードの中身(銘柄名と日付の見出し、指標ごとの線と同じ色の名前と値)を描く。
 */
export function DataWindowBody({ name, date, rows, gridRef }: { name: string; date: string; rows: DataWindowRow[]; gridRef: Ref<HTMLDivElement> }) {
  return (
    <>
      <div className="dw-date">
        <span className="dw-name">{name}</span>
        {formatCardDate(date)}
      </div>
      <div className="dw-grid" ref={gridRef}>
        {rows.map((r, k) =>
          "sec" in r ? (
            <div key={k} className="dw-sec">
              {r.sec}
            </div>
          ) : (
            [
              <span key={`${k}k`} className="dw-k" style={{ color: r.color }}>
                {r.label}
              </span>,
              <span key={`${k}v`} className="dw-v">
                {formatNumber(r.value, r.digits)}
              </span>,
            ]
          ),
        )}
      </div>
    </>
  );
}

/**
 * カードが縦に収まらないとき、名前と値の組を2列(それでも収まらなければ3列)に並べる。
 * 描いた後でないと高さが分からないので、useLayoutEffect の中から呼ぶ。
 */
export function fitDataWindowColumns(box: HTMLElement, grid: HTMLElement) {
  // 前の銘柄・前の日で付けた列の指定が残らないよう、1列から測り直す
  grid.classList.remove("wide", "wide3");
  if (box.scrollHeight > box.clientHeight) {
    grid.classList.add("wide");
  }
  if (box.scrollHeight > box.clientHeight) {
    grid.classList.replace("wide", "wide3");
  }
}
