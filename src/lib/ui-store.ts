import { Store } from "@tanstack/react-store";
import { DEFAULT_HIDDEN_LINES, DEFAULT_INDICATORS, type IndicatorId } from "./chart-theme";
import { readLocal, writeLocal } from "./local-storage";
import type { Options } from "./types";

// 画面の状態のうち、サーバーに保存しないもの(表示設定・入力中の下書き・判定中の印など)。
// サーバーのデータ(株価・判定結果・関心銘柄・口座)は TanStack Query のキャッシュに持ち、ここには置かない。
// 表示設定は localStorage に残す

export type PendingJudgment = { loading: true } | { error: string };

export type UiState = {
  strategy: string;
  options: Options; // テクニカル以外の材料(決算・ニュース)
  indicators: IndicatorId[]; // 今の売買ルールで表示するインジケーター
  hiddenLines: string[]; // 非表示にした線(SUBLINES の id)
  dataWindow: boolean; // カーソル位置の値を一覧する「データ表示」
  showPrice: boolean; // 価格の段(下の段はインジケーターの選択で決まる)
  range: number; // 期間ボタン(1M=22 / 3M=66 / 6M=132 / 1Y=0 本)
  tools: { magnet: boolean; lines: boolean };
  news: Record<string, string>; // 銘柄ごとに貼ったニュースの下書き
  names: Record<string, string>; // 銘柄検索で分かった JPX の和名
  pending: Record<string, PendingJudgment>; // `${strategy}:${code}` → 判定中 / 判定の失敗
  chartCode: string | null; // チャートタブで開いている銘柄(上部の「判定」の対象)
  live: { busy: boolean; at: string | null }; // 取引時間中のライブ更新の状態
  trade: { open: boolean; code: string | null }; // 売買ダイアログ
  orderCode: string | null; // シミュレーターの注文欄の銘柄
  flash: string | null; // 上部バーに一時的に出すエラー
  settingsOpen: boolean;
};

// 保存済みのインジケーターの選択に、あとから追加したもの(MA25・MA100・ボリンジャー・一目)を一度だけ足す
const ADDED_2026_09: IndicatorId[] = ["ma25", "ma100", "bb", "ichimoku"];

/**
 * 売買ルールごとに保存したインジケーターの選択を読む。保存がなければ、その売買ルールの既定。
 */
function readIndicators(strategy: string): IndicatorId[] {
  const saved = readLocal<IndicatorId[] | null>(`indicators:${strategy}`, null);
  const set = new Set<IndicatorId>(saved ?? DEFAULT_INDICATORS[strategy] ?? ["ma25", "vol"]);

  if (saved && !readLocal(`indicators:${strategy}:added-2026-09`, false)) {
    for (const id of ADDED_2026_09) {
      set.add(id);
    }
    writeLocal(`indicators:${strategy}`, [...set]);
    writeLocal(`indicators:${strategy}:added-2026-09`, true);
  }

  return [...set];
}

/**
 * localStorage から最初の状態を組み立てる。
 */
function readInitialState(): UiState {
  const strategy = readLocal("strategy", "swing");

  return {
    strategy,
    options: { earnings: false, news: false, ...readLocal<Partial<Options>>("options", {}) },
    indicators: readIndicators(strategy),
    hiddenLines: readLocal("hiddenLines", DEFAULT_HIDDEN_LINES),
    dataWindow: readLocal("dataWindow", true),
    showPrice: readLocal("showPrice", true),
    range: readLocal("range", 132),
    tools: { magnet: false, lines: true },
    news: readLocal<Record<string, string>>("news", {}),
    names: {},
    pending: {},
    chartCode: null,
    live: { busy: false, at: null },
    trade: { open: false, code: null },
    orderCode: null,
    flash: null,
    settingsOpen: false,
  };
}

export const uiStore = new Store<UiState>(readInitialState());

/**
 * 状態の一部を書き換える。
 */
function patchUi(patch: Partial<UiState>) {
  uiStore.setState((s) => ({ ...s, ...patch }));
}

/**
 * 判定結果を探すときのキー。売買ルールごとに分ける。
 */
export function judgmentKey(code: string, strategy: string): string {
  return `${strategy}:${code}`;
}

/**
 * 売買ルールを切り替える。インジケーターの選択は売買ルールごとに保存しているので読み直す。
 */
export function selectStrategy(strategy: string) {
  writeLocal("strategy", strategy);
  patchUi({ strategy, indicators: readIndicators(strategy) });
}

/**
 * 材料(決算・ニュース)のオン / オフを切り替える。上部バーとスクリーナーの2か所から呼ぶ。
 */
export function toggleOption(key: keyof Options) {
  const options = { ...uiStore.state.options, [key]: !uiStore.state.options[key] };

  writeLocal("options", options);
  patchUi({ options });
}

/**
 * インジケーターの表示を切り替え、今の売買ルールの選択として保存する。
 */
export function toggleIndicator(id: IndicatorId) {
  const { strategy, indicators } = uiStore.state;
  const next = indicators.includes(id) ? indicators.filter((x) => x !== id) : [...indicators, id];

  writeLocal(`indicators:${strategy}`, next);
  patchUi({ indicators: next });
}

/**
 * ボリンジャーバンド・一目均衡表の線を1本ずつ表示 / 非表示にする。
 */
export function toggleLine(lineId: string) {
  const hidden = uiStore.state.hiddenLines;
  const next = hidden.includes(lineId) ? hidden.filter((x) => x !== lineId) : [...hidden, lineId];

  writeLocal("hiddenLines", next);
  patchUi({ hiddenLines: next });
}

export const PANES = [
  { id: "price", label: "価格" },
  { id: "rsi", label: "RSI" },
  { id: "rci", label: "RCI" },
  { id: "macd", label: "MACD" },
] as const;

export type PaneId = (typeof PANES)[number]["id"];

/**
 * チャートの段を表示しているかを返す。下の段はインジケーターの選択と同じもの。
 */
export function isPaneVisible(s: Pick<UiState, "showPrice" | "indicators">, id: PaneId): boolean {
  return id === "price" ? s.showPrice : s.indicators.includes(id);
}

/**
 * チャートの段(価格 / RSI / RCI / MACD)の表示を切り替える。
 * 全部の段を消すとチャートが空になるので、最後の1つは消さずに知らせる。
 */
export function togglePane(id: PaneId) {
  const s = uiStore.state;
  const visibleCount = PANES.filter((p) => isPaneVisible(s, p.id)).length;
  if (isPaneVisible(s, id) && visibleCount === 1) {
    showFlash("少なくとも1つの段は表示してください");
    return;
  }

  if (id === "price") {
    writeLocal("showPrice", !s.showPrice);
    patchUi({ showPrice: !s.showPrice });
  } else {
    toggleIndicator(id);
  }
}

export function setRange(range: number) {
  writeLocal("range", range);
  patchUi({ range });
}

export function toggleDataWindow() {
  writeLocal("dataWindow", !uiStore.state.dataWindow);
  patchUi({ dataWindow: !uiStore.state.dataWindow });
}

export function setTools(tools: Partial<UiState["tools"]>) {
  patchUi({ tools: { ...uiStore.state.tools, ...tools } });
}

/**
 * 銘柄に貼ったニュースの下書きを残す。空にしたら消す。
 */
export function setNewsDraft(code: string, text: string) {
  const news = { ...uiStore.state.news };
  if (text.trim()) {
    news[code] = text;
  } else {
    delete news[code];
  }

  writeLocal("news", news);
  patchUi({ news });
}

/**
 * 銘柄検索で分かった和名を覚えておく(チャートや一覧の銘柄名に使う)。
 */
export function rememberName(code: string, name: string) {
  patchUi({ names: { ...uiStore.state.names, [code]: name } });
}

/**
 * 判定中 / 判定の失敗の印を付ける。null なら外す(結果は Query のキャッシュに入る)。
 */
export function setPendingJudgment(key: string, value: PendingJudgment | null) {
  const pending = { ...uiStore.state.pending };
  if (value) {
    pending[key] = value;
  } else {
    delete pending[key];
  }

  patchUi({ pending });
}

/**
 * 売買ルール1つ分の、判定の失敗の印をまとめて外す(結果をクリアしたとき)。
 */
export function clearPendingJudgments(strategy: string) {
  const pending = Object.fromEntries(Object.entries(uiStore.state.pending).filter(([k]) => !k.startsWith(`${strategy}:`)));

  patchUi({ pending });
}

/**
 * 売買ダイアログを開く。注文欄はシミュレーター タブと共通なので、注文欄の銘柄も切り替える。
 */
export function openTradeDialog(code: string) {
  patchUi({ trade: { open: true, code }, orderCode: code });
}

export function closeTradeDialog() {
  patchUi({ trade: { open: false, code: uiStore.state.trade.code } });
}

export function setChartCode(code: string | null) {
  patchUi({ chartCode: code });
}

export function setLiveStatus(live: UiState["live"]) {
  patchUi({ live });
}

export function setOrderCode(code: string | null) {
  patchUi({ orderCode: code });
}

export function setSettingsOpen(open: boolean) {
  patchUi({ settingsOpen: open });
}

/**
 * ログイン中のユーザーに結び付いた画面の状態(開いていた銘柄・判定中の印・ダイアログなど)を消す。
 * ログイン・ログアウト・退会のときに呼び、前のユーザーの銘柄や判定の印が次のユーザーの画面に残らないようにする。
 * 表示設定(インジケーターなど)とニュースの下書きはブラウザの設定なので残す。
 */
export function resetSessionUi() {
  patchUi({
    names: {},
    pending: {},
    chartCode: null,
    live: { busy: false, at: null },
    trade: { open: false, code: null },
    orderCode: null,
    flash: null,
    settingsOpen: false,
  });
}

let flashTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * 上部バーにエラーを2.5秒だけ出す。
 */
export function showFlash(message: string) {
  clearTimeout(flashTimer);
  patchUi({ flash: message });
  flashTimer = setTimeout(() => patchUi({ flash: null }), 2500);
}
