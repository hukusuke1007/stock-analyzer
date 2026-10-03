import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { errorMessage, requestApi } from "../../lib/api";
import { meQuery } from "../../lib/queries";
import { resetSessionUi } from "../../lib/ui-store";
import { Modal } from "../common/Modal";

/**
 * 上部バーの右端のアカウントのメニュー(ログイン中のメールアドレス・ログアウト・退会)。
 */
export function AccountMenu() {
  const { data: user } = useQuery(meQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // メニューの外をクリックしたら閉じる
  useEffect(() => {
    if (!open) {
      return;
    }

    const closeOnOutsideClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("click", closeOnOutsideClick);

    return () => document.removeEventListener("click", closeOnOutsideClick);
  }, [open]);

  /**
   * ログアウトする。次にログインするユーザーに前のデータが見えないよう、キャッシュと画面の状態を消す。
   * 先にログイン画面へ移るのは、画面を出したままキャッシュを消すと、残った画面が API を取り直して 401 になるため。
   */
  const logout = async () => {
    await requestApi("/auth/logout", { method: "POST" }).catch(() => {});

    await navigate({ to: "/login" });
    queryClient.clear();
    resetSessionUi();
  };

  return (
    <div className="dropdown" ref={ref}>
      <button className="tb-btn account-btn" type="button" title={user?.email} onClick={() => setOpen(!open)}>
        {user?.email ?? "アカウント"} ▾
      </button>
      {open && (
        <div className="menu account-menu">
          <div className="account-email">{user?.email}</div>
          <button type="button" onClick={logout}>
            ログアウト
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              setOpen(false);
              setDeleting(true);
            }}
          >
            退会する…
          </button>
        </div>
      )}
      <Modal open={deleting} onClose={() => setDeleting(false)} className="settings-dialog" labelledBy="delete-account-title">
        <DeleteAccountForm onCancel={() => setDeleting(false)} />
      </Modal>
    </div>
  );
}

/**
 * 退会の確認。誤操作を防ぐため、パスワードを入れ直してもらう。
 */
function DeleteAccountForm({ onCancel }: { onCancel: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * 退会する。サーバーはこのユーザーのデータをすべて消し、ログアウトした状態にする。
   */
  const deleteAccount = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await requestApi("/auth/account", { method: "DELETE", body: { password } });

      // ログアウトと同じく、画面を移ってからキャッシュと画面の状態を消す
      await navigate({ to: "/signup" });
      queryClient.clear();
      resetSessionUi();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={deleteAccount}>
      <div className="settings-head">
        <h2 id="delete-account-title">退会する</h2>
        <button type="button" className="settings-close" aria-label="閉じる" onClick={onCancel}>
          ×
        </button>
      </div>
      <p className="settings-note">
        アカウントと、保存した判定結果・スクリーニング結果・関心銘柄・設定・シミュレーターの口座をすべて削除します。元に戻せません。
      </p>
      <label className="delete-account-field">
        <span>確認のためパスワードを入力してください</span>
        <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      {error && <div className="settings-error">{error}</div>}
      <div className="settings-actions">
        <button type="button" className="tb-btn" onClick={onCancel}>
          キャンセル
        </button>
        <button type="submit" className="tb-btn danger" disabled={busy || !password}>
          退会する
        </button>
      </div>
    </form>
  );
}
