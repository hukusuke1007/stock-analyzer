import { type ReactNode, useEffect, useRef } from "react";

/**
 * ブラウザの <dialog> をモーダルとして開く。open が false になったら閉じる。
 * Esc や枠の外(背景)のクリックで閉じたときは onClose を呼び、親の状態を閉じた側にそろえる。
 */
export function Modal({ open, onClose, className, labelledBy, children }: {
  open: boolean;
  onClose: () => void;
  className?: string;
  labelledBy?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={labelledBy}
      onClose={onClose}
      // 枠の外(背景)をクリックしたら閉じる。中身のクリックは target が dialog にならない
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          e.currentTarget.close();
        }
      }}
    >
      {open && children}
    </dialog>
  );
}
