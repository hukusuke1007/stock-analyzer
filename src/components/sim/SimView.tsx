import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSelector } from "@tanstack/react-store";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { errorMessage, requestApi } from "../../lib/api";
import { formatDateTime, formatNumber, formatSigned, formatSignedYen, formatYen, signClass } from "../../lib/format";
import { queryKeys, simQuery } from "../../lib/queries";
import type { SimSnapshot } from "../../lib/types";
import { setOrderCode, showFlash, uiStore } from "../../lib/ui-store";
import { DEFAULT_INITIAL_CASH, showOrderMessage } from "./order-state";
import { OrderPanel } from "./OrderPanel";
import { PositionsTable } from "./PositionsTable";
import { TradesTable } from "./TradesTable";
import { WatchBuySection } from "./WatchBuyTable";

/**
 * 株シミュレーター(仮想売買)タブを描く。元金から銘柄を買い、利確・損切りラインで売ったときの損益を見ながら売買する。
 * 口座はサーバーに保存する(GET /api/sim・POST /api/sim/orders・POST /api/sim/reset)。実際には発注しない。
 */
export function SimView() {
  const sim = useQuery(simQuery);
  const orderCode = useSelector(uiStore, (s) => s.orderCode);
  const chartCode = useSelector(uiStore, (s) => s.chartCode);

  // 注文欄が空なら、チャートで見ていた銘柄を入れる。起動直後にこのタブを開いていたときは、
  // あとからチャートの銘柄が決まった時点で入れる
  useEffect(() => {
    if (!orderCode && chartCode) {
      setOrderCode(chartCode);
    }
  }, [orderCode, chartCode]);

  return (
    <main id="sim-view" className="sim-view">
      <div className="grid-bar">
        <span className="panel-title">株シミュレーター</span>
        <span className="tag probe">仮想売買 · 実際には発注しません</span>
        <span className="muted small-label">{sim.data ? `${formatDateTime(sim.data.createdAt)} から` : ""}</span>
        <div className="spacer" />
        <ResetForm initialCash={sim.data?.initialCash ?? null} />
        <button className="tb-btn small" type="button" title="保有株の現在値を取り直します" onClick={() => void sim.refetch()}>
          ↻ 株価を更新
        </button>
        <TotalAsset account={sim.data} />
      </div>

      <SummaryCards account={sim.data} error={sim.error ? errorMessage(sim.error) : null} loading={sim.isFetching} />

      <div className="sim-body">
        <OrderPanel />
        <section className="sim-main">
          <WatchBuySection />
          <h4 className="sim-h">保有株</h4>
          <div className="table-wrap">
            <PositionsTable positions={sim.data?.positions ?? []} />
          </div>
          <h4 className="sim-h">売買履歴</h4>
          <div className="table-wrap">
            <TradesTable trades={sim.data?.trades ?? []} />
          </div>
        </section>
      </div>

      <div className="grid-foot muted">
        株価は Yahoo Finance の最新の日足(取引時間中は現在値、東証は約20分遅れ)で約定したことにします。手数料・税金は含めません。100株単位。投資助言ではありません。
      </div>
    </main>
  );
}

/**
 * 元金を入れて口座を始め直すフォームを描く。保有株と売買履歴を消すので、確認してから送る。
 */
function ResetForm({ initialCash }: { initialCash: number | null }) {
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");

  // 口座を読み込んだ・始め直したときに、今の元金を入れておく。元金が変わらない限り書き換えないので、入力中は途切れない
  useEffect(() => {
    if (initialCash != null) {
      setInput(formatNumber(initialCash, 0));
    }
  }, [initialCash]);

  /**
   * 入れた元金で口座を始め直す。空欄なら既定の元金。結果は注文欄に出し、失敗は上部バーで知らせる。
   */
  const resetAccount = async (e: FormEvent) => {
    e.preventDefault();

    // 桁区切りや「円」を付けて入れても読めるようにする
    const raw = input.replace(/[,，円\s]/g, "");
    const cash = raw === "" ? DEFAULT_INITIAL_CASH : Number(raw);
    if (!Number.isInteger(cash) || cash < 1) {
      showFlash("元金は1円以上の整数で入れてください");
      return;
    }

    if (!confirm(`保有株と売買履歴を消して、元金 ${formatNumber(cash, 0)}円で始め直します。よろしいですか?`)) {
      return;
    }

    try {
      const account = await requestApi<SimSnapshot>("/sim/reset", { method: "POST", body: { initialCash: cash } });

      queryClient.setQueryData(queryKeys.sim, account);
      showOrderMessage({ ok: true, text: `元金 ${formatYen(cash)}で始め直しました`, code: uiStore.state.orderCode });
    } catch (err) {
      showFlash(`始め直せませんでした: ${errorMessage(err)}`);
    }
  };

  return (
    <form className="sim-reset" autoComplete="off" onSubmit={resetAccount}>
      <label className="muted small-label" htmlFor="sim-initial">
        元金
      </label>
      <input
        id="sim-initial"
        className="filter num"
        inputMode="numeric"
        placeholder="1,000,000"
        value={input}
        onChange={(e) => setInput(e.target.value)}
      />
      <span className="muted small-label">円</span>
      <button className="tb-btn danger small" type="submit" title="保有株と売買履歴を消して、この元金で始め直します">
        この元金で始め直す
      </button>
    </form>
  );
}

/**
 * 上部の右端に、現金と保有株を合わせた今の資産額を出す。口座を読み込むまでは空(CSS で隠れる)。
 */
function TotalAsset({ account }: { account: SimSnapshot | undefined }) {
  if (!account) {
    return <div className="sim-total" title="現金 + 保有株の評価額(今の株価)" />;
  }

  const s = account.summary;

  return (
    <div className="sim-total" title="現金 + 保有株の評価額(今の株価)">
      <span className="k">資産</span>
      <b>{formatYen(s.total)}</b>
      <span className={signClass(s.pnl)}>
        {formatSignedYen(s.pnl)} ({formatSigned(s.pnlPct)})
      </span>
      <span className="muted">
        現金 {formatYen(account.cash)} + 株 {formatYen(s.marketValue)}
      </span>
    </div>
  );
}

/**
 * 口座のまとめ(総資産・損益・現金・評価額・含み損益・実現損益)をカードで並べる。
 */
function SummaryCards({ account, error, loading }: { account: SimSnapshot | undefined; error: string | null; loading: boolean }) {
  if (error) {
    return (
      <div className="sim-summary">
        <div className="error">口座を読み込めませんでした: {error}</div>
      </div>
    );
  }

  if (!account) {
    return (
      <div className="sim-summary">
        <div className="loading muted">
          <div className="spinner" />
          読み込み中…
        </div>
      </div>
    );
  }

  const s = account.summary;

  return (
    <div className="sim-summary">
      <SummaryCard label="総資産" value={formatYen(s.total)} sub={`元金 ${formatYen(account.initialCash)}`} />
      <SummaryCard
        label="損益(元金比)"
        value={formatSignedYen(s.pnl)}
        sub={<span className={signClass(s.pnlPct)}>{formatSigned(s.pnlPct)}</span>}
        valueClass={signClass(s.pnl)}
      />
      <SummaryCard label="現金(買付余力)" value={formatYen(account.cash)} />
      <SummaryCard label="保有株の評価額" value={formatYen(s.marketValue)} sub={`${account.positions.length}銘柄`} />
      <SummaryCard label="含み損益" value={formatSignedYen(s.unrealized)} sub="保有株を今の株価で売ったら" valueClass={signClass(s.unrealized)} />
      <SummaryCard label="実現損益" value={formatSignedYen(s.realized)} sub="売却済みの損益の合計" valueClass={signClass(s.realized)} />
      {loading && (
        <div className="s-loading">
          <div className="spinner" />
        </div>
      )}
    </div>
  );
}

/**
 * まとめのカードを1枚描く。
 */
function SummaryCard({ label, value, sub = "", valueClass = "" }: { label: string; value: string; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="s-card">
      <div className="k">{label}</div>
      <div className={`v ${valueClass}`}>{value}</div>
      <div className="sub">{sub}</div>
    </div>
  );
}
