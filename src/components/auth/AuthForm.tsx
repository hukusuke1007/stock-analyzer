import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { errorMessage, requestApi } from "../../lib/api";
import { queryKeys } from "../../lib/queries";
import { resetSessionUi } from "../../lib/ui-store";
import type { User } from "../../lib/types";
import { BrandLogo } from "../common/BrandLogo";

type Mode = "login" | "signup";

const COPY: Record<Mode, { title: string; submit: string; switchText: string; switchLink: string; switchTo: "/login" | "/signup" }> = {
  login: { title: "ログイン", submit: "ログイン", switchText: "アカウントがない場合は", switchLink: "アカウントを作成", switchTo: "/signup" },
  signup: { title: "アカウント作成", submit: "作成してはじめる", switchText: "アカウントがある場合は", switchLink: "ログイン", switchTo: "/login" },
};

/**
 * メールアドレスとパスワードでログインする / アカウントを作る画面。
 * 成功したら、ログイン中のユーザーをキャッシュに入れてチャート画面へ移る。
 */
export function AuthForm({ mode }: { mode: Mode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const copy = COPY[mode];

  /**
   * 送信する。前のユーザーのデータが残らないよう、成功したらキャッシュと画面の状態を消してから移る。
   */
  const submitCredentials = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const { user } = await requestApi<{ user: User }>(`/auth/${mode}`, { method: "POST", body: { email, password } });

      queryClient.clear();
      resetSessionUi();
      queryClient.setQueryData(queryKeys.me, user);
      await navigate({ to: "/" });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submitCredentials}>
        <div className="auth-brand">
          <div className="brand">
            <BrandLogo />
          </div>
          <span className="app-name">株分析シミュレーター</span>
        </div>
        <h1>{copy.title}</h1>

        <label className="auth-field">
          <span>メールアドレス</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="auth-field">
          <span>パスワード{mode === "signup" ? "(8文字以上)" : ""}</span>
          <input
            type="password"
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            minLength={8}
            maxLength={128}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {error && <div className="settings-error">{error}</div>}

        <button className="tb-btn primary auth-submit" type="submit" disabled={busy}>
          {busy ? "送信中…" : copy.submit}
        </button>
        <p className="auth-switch">
          {copy.switchText} <Link to={copy.switchTo}>{copy.switchLink}</Link>
        </p>
        <p className="auth-note">判定は売買ルールに照らした機械的なサンプルであり、投資助言ではありません。シミュレーターは仮想売買のみで、実際には発注しません。</p>
      </form>
    </main>
  );
}
