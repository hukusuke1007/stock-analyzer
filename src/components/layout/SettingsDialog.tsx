import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { useEffect, useState } from "react";
import { errorMessage, requestApi } from "../../lib/api";
import { requestNotificationPermission } from "../../lib/notifications";
import { queryKeys, settingsQuery } from "../../lib/queries";
import type { SettingsPayload } from "../../lib/types";
import { setSettingsOpen, uiStore } from "../../lib/ui-store";
import { Modal } from "../common/Modal";

/**
 * 設定ダイアログ。判定(Decisions)に使う AI・Codex のモデル・利確 / 損切りの通知を変え、アプリの情報を出す。
 * 設定はログイン中のユーザーごとにサーバーに保存される。
 */
export function SettingsDialog() {
  const open = useSelector(uiStore, (s) => s.settingsOpen);

  return (
    <Modal open={open} onClose={() => setSettingsOpen(false)} className="settings-dialog" labelledBy="settings-title">
      <SettingsForm />
    </Modal>
  );
}

/**
 * 設定の中身。ダイアログを開くたびに作り直し、サーバーの今の設定から始める。
 */
function SettingsForm() {
  const queryClient = useQueryClient();
  const { data, error: loadError } = useQuery(settingsQuery);
  const [provider, setProvider] = useState<string | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [notify, setNotify] = useState({ notifyTakeProfit: false, notifyStopLoss: false });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 読み込めたら、今の設定を選んだ状態にする
  useEffect(() => {
    if (data) {
      setProvider(data.settings.decisionsProvider);
      setModel(data.settings.codexModel);
      setNotify({ notifyTakeProfit: data.settings.notifyTakeProfit, notifyStopLoss: data.settings.notifyStopLoss });
    }
  }, [data]);

  /**
   * 保存する。判定の AI が変わると上部バーの表示も変わるので、/health を取り直す。
   */
  const saveSettings = async () => {
    setSaving(true);
    setError(null);

    try {
      const body = { decisionsProvider: provider, ...notify, ...(data?.options.codexModels.length ? { codexModel: model } : {}) };
      const saved = await requestApi<SettingsPayload>("/settings", { method: "PUT", body });

      queryClient.setQueryData(queryKeys.settings, saved);
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
      setSettingsOpen(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * 通知の ON / OFF を切り替える。ON にするときはブラウザに通知の許可を求め、断られたら ON にしない。
   */
  const toggleNotify = async (key: keyof typeof notify, on: boolean) => {
    setError(null);
    if (on && !(await requestNotificationPermission())) {
      setError("ブラウザの通知が許可されていません。ブラウザのサイトの設定で通知を許可してから ON にしてください");
      return;
    }

    setNotify((prev) => ({ ...prev, [key]: on }));
  };

  // モデル一覧が取れない(Codex を使えない)ときも、今の設定だけは出しておく
  const models = data?.options.codexModels.length
    ? data.options.codexModels
    : data
      ? [{ id: data.settings.codexModel, label: data.settings.codexModel, isDefault: false }]
      : [];
  const shownError = error ?? (loadError ? `設定を読み込めません: ${errorMessage(loadError)}` : null);

  return (
    <form method="dialog" className="settings-form">
      <div className="settings-head">
        <h2 id="settings-title">設定</h2>
        <button type="submit" value="cancel" className="settings-close" aria-label="閉じる">
          ×
        </button>
      </div>

      <section className="settings-sec">
        <h3>判定(Decisions)に使う AI</h3>
        <div className="settings-providers">
          {!data && <div className="settings-note">読み込み中…</div>}
          {data?.options.providers.map((p) => (
            <label key={p.id} className={`settings-radio ${p.available ? "" : "unavailable"}`}>
              <input type="radio" name="provider" value={p.id} checked={provider === p.id} onChange={() => setProvider(p.id)} />
              <span>
                <b>{p.label}</b>
                {p.note && <small>{p.note}</small>}
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="settings-sec">
        <h3>Codex のモデル</h3>
        <p className="settings-note">判定(Codex を選んだとき)とランク付けに使う</p>
        <select
          className="settings-select"
          value={model ?? ""}
          disabled={!data?.options.codexModels.length}
          onChange={(e) => setModel(e.target.value)}
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
              {m.isDefault ? "(Codex の既定)" : ""}
            </option>
          ))}
        </select>
      </section>

      <section className="settings-sec">
        <h3>ブラウザ通知</h3>
        <p className="settings-note">シミュレーターの保有株が判定の売り方のラインに届いたら、銘柄ごと・ラインごとに1回だけ知らせる(取引時間中は1分ごとに確認)</p>
        <div className="settings-providers">
          <label className="settings-radio">
            <input type="checkbox" checked={notify.notifyTakeProfit} onChange={(e) => toggleNotify("notifyTakeProfit", e.target.checked)} />
            <span>
              <b>利確ラインに届いたら通知する</b>
            </span>
          </label>
          <label className="settings-radio">
            <input type="checkbox" checked={notify.notifyStopLoss} onChange={(e) => toggleNotify("notifyStopLoss", e.target.checked)} />
            <span>
              <b>損切りラインに届いたら通知する</b>
            </span>
          </label>
        </div>
      </section>

      {shownError && <div className="settings-error">{shownError}</div>}

      <div className="settings-actions">
        <button type="submit" value="cancel" className="tb-btn">
          キャンセル
        </button>
        <button type="button" className="tb-btn primary" disabled={saving || !data} onClick={saveSettings}>
          保存
        </button>
      </div>

      {data && (
        <section className="settings-sec settings-about">
          <h3>このアプリについて</h3>
          <dl>
            <dt>アプリ</dt>
            <dd>{data.app.name}</dd>
            <dt>バージョン</dt>
            <dd>{data.app.version}</dd>
            <dt>ライセンス</dt>
            <dd>
              {data.app.license} License © 2026 {data.app.author}
            </dd>
            <dt>X</dt>
            <dd>
              <a href={data.app.x} target="_blank" rel="noopener noreferrer">
                {data.app.x}
              </a>
            </dd>
            <dt>免責事項</dt>
            <dd>投資助言ではありません。利用は自己責任で行ってください。作者はこのツールの利用によるいかなる損害についても一切の責任を負いません。</dd>
          </dl>
        </section>
      )}
    </form>
  );
}
