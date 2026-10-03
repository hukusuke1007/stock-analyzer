import { type PointerEvent, useCallback, useEffect, useState } from "react";
import { readLocal, writeLocal } from "../../lib/local-storage";

type Options = {
  axis: "x" | "y";
  storageKey: string;
  fallback: number;
  // ドラッグした量(px)から新しい大きさを出す。向き(引くと広がるか縮むか)はつまみの位置で違う
  sizeFromDrag: (startSize: number, delta: number) => number;
  // 画面に収まる大きさに丸める
  clampSize: (size: number) => number;
};

/**
 * つまみをドラッグしてパネルの大きさを変える。大きさは localStorage に残し、ダブルクリックで元に戻す。
 * 返す size をパネルの style に使い、handleProps をつまみの要素に渡す。
 */
export function useDragResize({ axis, storageKey, fallback, sizeFromDrag, clampSize }: Options) {
  const [size, setSize] = useState(() => clampSize(readLocal(storageKey, fallback)));
  const [dragging, setDragging] = useState(false);

  // ウィンドウを縮めたときも、保存した大きさから収め直す
  useEffect(() => {
    const fitSavedSize = () => setSize(clampSize(readLocal(storageKey, fallback)));
    window.addEventListener("resize", fitSavedSize);

    return () => window.removeEventListener("resize", fitSavedSize);
  }, [clampSize, storageKey, fallback]);

  /**
   * ドラッグを始める。指を離すまでポインターをつまみに捕まえ、動いた量で大きさを変える。
   */
  const startDrag = useCallback(
    (e: PointerEvent<HTMLElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);
      // ドラッグ中は文字の選択やカーソルの形を body の class で止める
      document.body.classList.add(axis === "x" ? "resizing-x" : "resizing");

      const start = axis === "x" ? e.clientX : e.clientY;
      const startSize = size;
      let latest = startSize;
      const resizeByPointer = (ev: globalThis.PointerEvent) => {
        latest = clampSize(sizeFromDrag(startSize, (axis === "x" ? ev.clientX : ev.clientY) - start));
        setSize(latest);
      };
      const finishDrag = () => {
        handle.removeEventListener("pointermove", resizeByPointer);
        handle.removeEventListener("pointerup", finishDrag);
        handle.removeEventListener("pointercancel", finishDrag);
        setDragging(false);
        document.body.classList.remove("resizing", "resizing-x");
        writeLocal(storageKey, latest);
      };

      handle.addEventListener("pointermove", resizeByPointer);
      handle.addEventListener("pointerup", finishDrag);
      handle.addEventListener("pointercancel", finishDrag);
    },
    [axis, size, clampSize, sizeFromDrag, storageKey],
  );

  const resetSize = useCallback(() => {
    const next = clampSize(fallback);

    setSize(next);
    writeLocal(storageKey, next);
  }, [clampSize, fallback, storageKey]);

  return { size, dragging, handleProps: { onPointerDown: startDrag, onDoubleClick: resetSize } };
}
