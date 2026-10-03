import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { isStockCode, normalizeCode } from "../../lib/format";
import { searchQuery, useWatchActions, useWatchlist } from "../../lib/queries";
import type { Listing } from "../../lib/types";
import { rememberName } from "../../lib/ui-store";

/**
 * 銘柄検索。証券コードか銘柄名(ひらがな・カタカナ・半角カナどれでも)を打つと候補を出し、選ぶとチャートを開く。
 * TradingView と同じく、画面のどこでも英数字を打てばこの欄に入る。
 */
export function SearchBox() {
  const navigate = useNavigate();
  const watch = useWatchlist();
  const watchActions = useWatchActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const { data: results = [] } = useQuery(searchQuery(query));

  // 打ち続けているあいだは問い合わせない(120ms 止まったら検索する)
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 120);

    return () => clearTimeout(timer);
  }, [text]);

  // 候補が変わったら先頭を選び直す
  useEffect(() => setActive(0), [results]);

  // どこでも英数字を打てば銘柄検索に入る(入力欄や修飾キーつきの操作は除く)
  useEffect(() => {
    const focusOnTyping = (e: globalThis.KeyboardEvent) => {
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) {
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) {
        return;
      }
      if (/^[0-9a-zA-Z]$/.test(e.key)) {
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", focusOnTyping);

    return () => document.removeEventListener("keydown", focusOnTyping);
  }, []);

  /**
   * 銘柄のチャートを開き、検索欄を空にする。
   */
  const openChart = (code: string) => {
    setText("");
    setOpen(false);
    inputRef.current?.blur();
    void navigate({ to: "/", search: { code } });
  };

  const pickResult = (hit: Listing) => {
    rememberName(hit.code, hit.name);
    openChart(hit.code);
  };

  const submitSearch = (e: FormEvent) => {
    e.preventDefault();
    const hit = results[active];
    if (open && hit) {
      pickResult(hit);
      return;
    }

    // 候補がなくても、コードの形なら開いてみる
    const code = normalizeCode(text);
    if (isStockCode(code)) {
      openChart(code);
    }
  };

  const moveActive = (e: KeyboardEvent<HTMLInputElement>) => {
    // 変換中の Enter などは IME に任せる
    if (e.nativeEvent.isComposing) {
      return;
    }

    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && results.length) {
      e.preventDefault();
      const n = results.length;
      setActive((active + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const showList = open && text.trim() !== "";

  return (
    <form className="search" autoComplete="off" onSubmit={submitSearch}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M8.5 3a5.5 5.5 0 1 0 3.4 9.8l3.6 3.7 1.1-1.1-3.7-3.6A5.5 5.5 0 0 0 8.5 3Zm0 1.5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z" />
      </svg>
      <input
        ref={inputRef}
        role="combobox"
        aria-autocomplete="list"
        aria-controls="search-results"
        aria-expanded={showList}
        placeholder="銘柄名・証券コード (例: トヨタ / 7203)"
        spellCheck={false}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onKeyDown={moveActive}
        onFocus={() => setOpen(true)}
        // 候補の mousedown より先に閉じないよう、少し待ってから閉じる
        onBlur={() => setTimeout(() => setOpen(false), 100)}
      />
      {showList && (
        <ul id="search-results" className="search-results" role="listbox">
          {results.length === 0 && <li className="empty">該当する銘柄がありません</li>}
          {results.map((r, i) => {
            const watched = watch.codes.includes(r.code);

            return (
              <li
                key={r.code}
                role="option"
                aria-selected={i === active}
                className={i === active ? "active" : ""}
                onMouseMove={() => i !== active && setActive(i)}
                // click だと先に input の blur で候補が消えるので、mousedown で選ぶ
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickResult(r);
                }}
              >
                <b className="s-code">{r.code}</b>
                <span className="s-name">{r.name}</span>
                <button
                  type="button"
                  className={`s-star ${watched ? "on" : ""}`}
                  title={watched ? "関心銘柄から外す" : "関心銘柄に追加(チャートは開かない)"}
                  // ☆ は関心銘柄の登録だけ。候補は開いたままにする
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    rememberName(r.code, r.name);
                    watchActions.toggle(r.code);
                  }}
                >
                  {watched ? "★" : "☆"}
                </button>
                <span className="s-meta">
                  {r.market} · {r.sector}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </form>
  );
}
