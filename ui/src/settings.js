// 設定ダイアログ。判定(Decisions)に使う AI と Codex のモデルを変え、アプリの情報を出す。
// 設定はサーバー(GET / PUT /settings)が data/settings.json に保存する。
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function request(method, body) {
  const res = await fetch("/settings", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function render(data) {
  const { settings, options, app } = data;
  $("#settings-providers").innerHTML = options.providers
    .map(
      (p) => `<label class="settings-radio ${p.available ? "" : "unavailable"}">
        <input type="radio" name="provider" value="${esc(p.id)}" ${p.id === settings.decisionsProvider ? "checked" : ""} />
        <span><b>${esc(p.label)}</b>${p.note ? `<small>${esc(p.note)}</small>` : ""}</span>
      </label>`,
    )
    .join("");

  // モデル一覧が取れない(Codex を使えない)ときも、今の設定だけは出しておく
  const models = options.codexModels.length
    ? options.codexModels
    : [{ id: settings.codexModel, label: settings.codexModel, isDefault: false }];
  $("#settings-model").innerHTML = models
    .map((m) => `<option value="${esc(m.id)}" ${m.id === settings.codexModel ? "selected" : ""}>${esc(m.label)}${m.isDefault ? "(Codex の既定)" : ""}</option>`)
    .join("");
  $("#settings-model").disabled = !options.codexModels.length;

  $("#settings-about").innerHTML = `
    <dt>アプリ</dt><dd>${esc(app.name)}</dd>
    <dt>バージョン</dt><dd>${esc(app.version)}</dd>
    <dt>ライセンス</dt><dd>${esc(app.license)} License © 2026 ${esc(app.author)}</dd>
    <dt>X</dt><dd><a href="${esc(app.x)}" target="_blank" rel="noopener noreferrer">${esc(app.x)}</a></dd>
    <dt>免責事項</dt><dd>投資助言ではありません。利用は自己責任で行ってください。作者はこのツールの利用によるいかなる損害についても一切の責任を負いません。</dd>`;
}

function showError(msg) {
  $("#settings-error").textContent = msg ?? "";
  $("#settings-error").hidden = !msg;
}

export function initSettings({ onSaved }) {
  const dialog = $("#settings-dialog");

  const open = async () => {
    showError(null);
    $("#settings-providers").innerHTML = `<div class="settings-note">読み込み中…</div>`;
    dialog.showModal();
    try {
      render(await request("GET"));
    } catch (e) {
      showError(`設定を読み込めません: ${e.message}`);
    }
  };

  // 左ツールバーの歯車と、上部バーの AI の状態から開く
  for (const el of document.querySelectorAll("[data-open-settings]")) el.addEventListener("click", open);

  // 枠の外(背景)をクリックしたら閉じる
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });

  $("#settings-save").addEventListener("click", async () => {
    const btn = $("#settings-save");
    btn.disabled = true;
    showError(null);
    try {
      const body = { decisionsProvider: dialog.querySelector('input[name="provider"]:checked')?.value };
      if (!$("#settings-model").disabled) body.codexModel = $("#settings-model").value;
      render(await request("PUT", body));
      dialog.close();
      await onSaved?.();
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
    }
  });
}
