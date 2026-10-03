import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactElement, type ReactNode, useState } from "react";
import { changePercent, formatNumber, formatSigned, signClass, verdictClass } from "../../lib/format";
import { useBars, useJudgment, useNameLookup, useWatchActions, useWatchlist } from "../../lib/queries";

/**
 * 右パネル上段のウォッチリスト。関心銘柄の終値・前日比・判定を並べ、クリックでチャートを開く。
 */
export function WatchlistPanel({ selectedCode, height, resizer }: { selectedCode: string | null; height: number; resizer: ReactNode }) {
  const watch = useWatchlist();
  const watchActions = useWatchActions();
  const [input, setInput] = useState("");

  const addCode = (e: FormEvent) => {
    e.preventDefault();
    if (watchActions.add(input)) {
      setInput("");
    }
  };

  return (
    <section className="watch" style={{ height }}>
      {resizer}
      <div className="side-head">
        <span>ウォッチリスト</span>
        <form className="watch-add" onSubmit={addCode}>
          <input placeholder="+ コード" spellCheck={false} value={input} onChange={(e) => setInput(e.target.value)} />
        </form>
      </div>
      <div className="watch-cols">
        <span>銘柄</span>
        <span>終値</span>
        <span>前日比</span>
        <span>判定</span>
      </div>
      <ul id="watchlist">
        {watch.codes.map((code) => (
          <WatchRow key={code} code={code} selected={code === selectedCode} onRemove={() => watchActions.remove(code)} />
        ))}
      </ul>
    </section>
  );
}

/**
 * ウォッチリストの1行。
 */
function WatchRow({ code, selected, onRemove }: { code: string; selected: boolean; onRemove: () => void }) {
  const navigate = useNavigate();
  const { data } = useBars(code);
  const judgment = useJudgment(code);
  const nameOf = useNameLookup();
  const last = data?.bars.at(-1);
  const chg = changePercent(data?.bars);

  let tag: ReactElement;
  if (judgment && "loading" in judgment) {
    tag = <span className="tag pending">…</span>;
  } else if (judgment && "result" in judgment) {
    tag = <span className={`tag ${verdictClass(judgment.result.verdict)}`}>{judgment.result.verdict}</span>;
  } else {
    tag = <span className="tag pending">—</span>;
  }

  return (
    <li className={selected ? "selected" : ""} onClick={() => navigate({ to: "/", search: { code } })}>
      <button
        className="del"
        title="削除"
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        ×
      </button>
      <span className="sym">
        <b>{code}</b>
        <small>{nameOf(code)}</small>
      </span>
      <span>{formatNumber(last?.close)}</span>
      <span className={signClass(chg)}>{formatSigned(chg)}</span>
      <span>{tag}</span>
    </li>
  );
}
