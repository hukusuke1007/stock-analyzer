import { useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useSelector } from "@tanstack/react-store";
import { isMarketOpen, refreshLiveBars } from "../../lib/live";
import { useHealth, useJudgeStock, useStrategies } from "../../lib/queries";
import { selectStrategy, setSettingsOpen, uiStore } from "../../lib/ui-store";
import { BrandLogo } from "../common/BrandLogo";
import { AccountMenu } from "./AccountMenu";
import { IndicatorMenu } from "./IndicatorMenu";
import { MaterialsToggle } from "./MaterialsToggle";
import { SearchBox } from "./SearchBox";

const VIEWS = [
  { path: "/", label: "チャート" },
  { path: "/watchlist", label: "関心銘柄" },
  { path: "/sim", label: "シミュレーター" },
] as const;

/**
 * 上部バー。画面の切り替え・銘柄検索・売買ルール・材料・インジケーター・ライブ更新・AI の状態・判定・アカウント。
 */
export function TopBar() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const strategies = useStrategies();
  const strategy = useSelector(uiStore, (s) => s.strategy);
  const chartCode = useSelector(uiStore, (s) => s.chartCode);
  const judgeStock = useJudgeStock();

  /**
   * 画面を切り替える。チャートに戻るときは、最後に開いていた銘柄を開く。
   */
  const openView = (path: (typeof VIEWS)[number]["path"]) => {
    if (path === "/") {
      void navigate({ to: "/", search: chartCode ? { code: chartCode } : {} });
    } else {
      void navigate({ to: path });
    }
  };

  return (
    <header className="topbar">
      <div className="brand" title="株分析シミュレーター">
        <BrandLogo />
      </div>
      <span className="app-name">株分析シミュレーター</span>
      <div className="segmented tabs" role="tablist">
        {VIEWS.map((v) => (
          <button key={v.path} type="button" role="tab" className={pathname === v.path ? "active" : ""} onClick={() => openView(v.path)}>
            {v.label}
          </button>
        ))}
      </div>
      <div className="sep" />
      <SearchBox />
      <div className="sep" />
      <div className="segmented" role="tablist">
        {strategies.map((s) => (
          <button key={s.id} type="button" title={s.label} className={s.id === strategy ? "active" : ""} onClick={() => selectStrategy(s.id)}>
            {s.label.replace(/[((].*$/, "")}
          </button>
        ))}
      </div>
      <div className="sep" />
      <MaterialsToggle
        titles={{
          group: "テクニカル以外の判断材料。オンにすると判定・スキャンで調べる",
          earnings: "次回の決算発表日(JPX の予定日、なければ Yahoo の予定日)。近ければ見送り",
          news: "直近7日のニュース見出し(Google ニュース)。Decisions が悪材料と判断したら見送り",
        }}
      />
      <div className="sep" />
      <IndicatorMenu />
      <div className="spacer" />
      <LiveStatus />
      <AiStatus />
      {pathname === "/" && (
        <button className="tb-btn primary" type="button" disabled={!chartCode} onClick={() => chartCode && judgeStock(chartCode)}>
          判定
        </button>
      )}
      <AccountMenu />
    </header>
  );
}

/**
 * ライブ更新の状態。クリックで今すぐ取り直す。
 */
function LiveStatus() {
  const queryClient = useQueryClient();
  const live = useSelector(uiStore, (s) => s.live);
  const at = live.at ? new Date(live.at).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" }) : null;
  const open = isMarketOpen();

  let label: string;
  if (open) {
    label = live.busy ? "● 更新中…" : `● ライブ${at ? ` ${at} 更新` : ""}`;
  } else {
    label = `取引時間外${at ? ` · ${at} 更新` : ""}`;
  }

  return (
    <button
      className={`status ${open ? "live" : ""}`}
      type="button"
      title="取引時間中は1分ごとに株価を取り直してチャートに反映します(Yahoo Finance、約20分遅れ)。クリックで今すぐ更新"
      onClick={() => refreshLiveBars(queryClient, true)}
    >
      {label}
    </button>
  );
}

/**
 * 判定に使う AI とランク付けの Codex が使えるか。クリックで設定を開く。一時的なエラー(flash)もここに出す。
 */
function AiStatus() {
  const { data: h, isError } = useHealth();
  const flash = useSelector(uiStore, (s) => s.flash);

  if (flash) {
    return <span className="status err">{flash}</span>;
  }
  if (isError) {
    return <span className="status err">サーバーに接続できません</span>;
  }
  if (!h) {
    return <span className="status">…</span>;
  }

  const d = h.decisions;
  const title = [
    `判定(Decisions): ${d.label}${d.provider === "codex" ? ` ${h.codexModel}` : ""}${d.available ? "" : " — 使えないので数値条件だけで判定"}`,
    `ランク付け: Codex ${h.codexModel}${h.codex ? "" : " — 使えないので判定順に並べる"}`,
    "クリックで設定を開く",
  ].join("\n");

  return (
    <button className={`status ${d.available && h.codex ? "on" : "off"}`} type="button" title={title} onClick={() => setSettingsOpen(true)}>
      判定: {d.provider === "jev" ? "Jev" : "Codex"}
      {d.available ? "" : "(未接続)"} / ランク: Codex{h.codex ? "" : "(未接続)"}
    </button>
  );
}
