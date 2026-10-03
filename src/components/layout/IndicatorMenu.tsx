import { useSelector } from "@tanstack/react-store";
import { useEffect, useRef, useState } from "react";
import { INDICATORS, SUBLINES } from "../../lib/chart-theme";
import { toggleIndicator, toggleLine, uiStore } from "../../lib/ui-store";

/**
 * インジケーターの選択メニュー。ボリンジャーバンドと一目均衡表は線を1本ずつ選べる。
 * 選択は売買ルールごとにブラウザに保存する。
 */
export function IndicatorMenu() {
  const indicators = useSelector(uiStore, (s) => s.indicators);
  const hiddenLines = useSelector(uiStore, (s) => s.hiddenLines);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // メニューの外のクリックと Esc で閉じる
  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsideClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("click", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("click", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="dropdown" ref={ref}>
      <button className="tb-btn" type="button" onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path d="M2 15l4-6 4 3 4-7 4 5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        インジケーター
      </button>
      {open && (
        <div className="menu">
          {INDICATORS.map((d) => {
            const on = indicators.includes(d.id);

            return (
              <div key={d.id}>
                <label>
                  <input type="checkbox" checked={on} onChange={() => toggleIndicator(d.id)} />
                  <span className="swatch" style={{ background: d.color }} />
                  {d.label}
                </label>
                {/* 1本ずつ選べる線(インジケーター自体がオフのときは選べない) */}
                {(SUBLINES[d.id] ?? []).map((l) => (
                  <label key={l.id} className={`sub ${on ? "" : "disabled"}`}>
                    <input type="checkbox" checked={!hiddenLines.includes(l.id)} disabled={!on} onChange={() => toggleLine(l.id)} />
                    <span className="swatch" style={{ background: l.color }} />
                    {l.label}
                  </label>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
