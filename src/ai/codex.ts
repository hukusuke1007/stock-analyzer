import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { getSettings } from "../settings.js";
import type { JsonValue } from "../strategies/index.js";

// Codex App Server(`codex app-server`、stdio の JSON-RPC)のクライアント。
// 認証は Codex CLI のログイン(ChatGPT アカウント)をそのまま使うので API キーは要らない。
// プロセスは1つだけ立ち上げて使い回し、問い合わせごとに使い捨てのスレッド(ephemeral)で1ターンだけ回す。
// 銘柄ごとの判定(ai/decisions-codex.ts)と、判定済みの銘柄のランク付け(rankStocks)に使う。
// プロトコル: https://developers.openai.com/codex/app-server

const BIN = process.env.CODEX_BIN ?? "codex";
// 判定(Decisions)とランク付けの両方で使うモデルは、設定(settings.ts の codexModel)で決める
export const codexModel = () => getSettings().codexModel;
const RANK_EFFORT = process.env.RANK_EFFORT ?? "medium";
const TURN_TIMEOUT_MS = 5 * 60_000;

export type RankItem = { code: string; rank: number; score: number; reason: string };
export type Ranking = { model: string; summary: string; items: RankItem[] };

type TurnCompleted = {
  threadId: string;
  turn: { status: string; error: { message: string } | null; items: { type: string; text?: string }[] };
};

class AppServer {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  // スレッドごとのターン完了待ち
  private turns = new Map<string, { resolve: (p: TurnCompleted) => void; reject: (e: Error) => void }>();
  private stderr = "";
  closed: Error | null = null;
  ready: Promise<void>;

  constructor() {
    this.child = spawn(BIN, ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
    this.child.stderr.on("data", (d) => (this.stderr = (this.stderr + d).slice(-2000)));
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => this.onLine(line));
    this.child.on("error", (e) => this.close(e));
    this.child.on("exit", (code) => this.close(new Error(`codex app-server が終了した(code ${code}) ${this.stderr.trim()}`)));
    this.ready = (async () => {
      await this.request("initialize", {
        clientInfo: { name: "stock_analyzer", title: "Stock Analyzer", version: "0.2.0" },
        capabilities: null,
      });
      this.send({ method: "initialized" });
    })();
  }

  private send(msg: object) {
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string) {
    let msg: { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error.message));
      else p?.resolve(msg.result);
    } else if (msg.id !== undefined) {
      // サーバーからの要求(コマンド実行の承認など)。何も実行させないので断る
      this.send({ id: msg.id, error: { code: -32601, message: "このクライアントは対応していない" } });
    } else if (msg.method === "turn/completed") {
      const p = msg.params as TurnCompleted;
      this.turns.get(p.threadId)?.resolve(p);
      this.turns.delete(p.threadId);
    } else if (msg.method === "error") {
      const p = msg.params as { threadId?: string; error?: { message?: string }; willRetry?: boolean };
      if (p.willRetry || !p.threadId) return;
      this.turns.get(p.threadId)?.reject(new Error(p.error?.message ?? "Codex のエラー"));
      this.turns.delete(p.threadId);
    }
  }

  private close(e: Error) {
    if (this.closed) return;
    this.closed = e;
    for (const p of this.pending.values()) p.reject(e);
    for (const t of this.turns.values()) t.reject(e);
    this.pending.clear();
    this.turns.clear();
    this.child.kill();
  }

  request<T>(method: string, params: unknown): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = ++this.nextId;
    const res = new Promise<T>((resolve, reject) => this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject }));
    this.send({ id, method, params });
    return res;
  }

  // 構造化出力(outputSchema)つきで1ターン回し、最終メッセージを JSON で返す
  async turn<T>(opts: TurnOptions): Promise<{ model: string; output: T }> {
    await this.ready;
    const started = await this.request<{ thread: { id: string }; model: string }>("thread/start", {
      model: opts.model,
      cwd: os.tmpdir(), // リポジトリを読ませない
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      developerInstructions: opts.instructions,
      serviceName: "stock_analyzer",
    });
    const threadId = started.thread.id;
    let timer: NodeJS.Timeout | undefined;
    const completed = new Promise<TurnCompleted>((resolve, reject) => {
      this.turns.set(threadId, { resolve, reject });
      timer = setTimeout(() => {
        this.turns.delete(threadId);
        reject(new Error(`Codex のターンが ${TURN_TIMEOUT_MS / 1000} 秒で終わらない`));
      }, TURN_TIMEOUT_MS);
    });
    try {
      await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: opts.prompt, text_elements: [] }],
        effort: opts.effort,
        outputSchema: opts.schema,
      });
      const { turn } = await completed;
      if (turn.status !== "completed") throw new Error(`Codex のターンが ${turn.status}: ${turn.error?.message ?? ""}`);
      const text = turn.items.filter((i) => i.type === "agentMessage").at(-1)?.text;
      if (!text) throw new Error("Codex の応答に最終メッセージがない");
      return { model: started.model, output: JSON.parse(text) as T };
    } finally {
      clearTimeout(timer);
    }
  }
}

export type TurnOptions = { instructions: string; prompt: string; schema: JsonValue; model: string; effort: string };

// 落ちていたら立ち上げ直す
let server: AppServer | undefined;
function appServer() {
  if (!server || server.closed) server = new AppServer();
  return server;
}

export function runTurn<T>(opts: TurnOptions) {
  return appServer().turn<T>(opts);
}

// Codex で使えるモデルの一覧(設定ダイアログの選択肢)。ChatGPT アカウントで使えるものだけが返る
export type CodexModel = { id: string; label: string; isDefault: boolean };
let modelsCache: Promise<CodexModel[]> | undefined;
export function listCodexModels(): Promise<CodexModel[]> {
  modelsCache ??= (async () => {
    if (!(await codexAvailable())) return [];
    const s = appServer();
    const res = await s.request<{ data: { id?: string; model?: string; displayName?: string; isDefault?: boolean }[] }>("model/list", {});
    return res.data.flatMap((m) => {
      const id = m.id ?? m.model;
      return id ? [{ id, label: m.displayName ?? id, isDefault: Boolean(m.isDefault) }] : [];
    });
  })().catch((e) => {
    modelsCache = undefined; // 次に開いたときに取り直す
    throw e;
  });
  return modelsCache;
}

// 起動時に一度だけ、App Server が立ち上がって初期化できるかを確かめる
let available: Promise<boolean> | undefined;
export function codexAvailable(): Promise<boolean> {
  available ??= (async () => {
    const s = appServer();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        s.ready,
        new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("20秒で初期化できない")), 20_000))),
      ]);
      return true;
    } catch (e) {
      console.error(`Codex App Server を使えない: ${e instanceof Error ? e.message : e}`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  return available;
}

const RANK_INSTRUCTIONS = [
  "あなたは日本株のスイングトレードの判断材料を整理するアナリスト。",
  "渡された銘柄はすべて、売買ルールの数値条件と Decisions(または数値条件だけ)で判定済み。",
  "ルールに照らして、今日買うならどれが有望かを1位から順に並べる。",
  "重視する順: ルールの条件の充足度 > 判定(買い > 打診買い > 見送り)と判定の確率 > 悪材料・決算の近さなどのリスク > 損切り幅に対する利確幅(riskReward)。",
  "渡したデータだけで判断し、ツールやコマンドは使わない。reason は日本語で、根拠になった数値を入れて80字以内。",
].join("\n");

// 判定済みの銘柄をランク付けする。stocks の code が全部そろって返るように補う
export async function rankStocks(strategyRules: string, stocks: { code: string; [key: string]: JsonValue }[]): Promise<Ranking> {
  const schema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      ranking: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: { type: "string", enum: stocks.map((s) => s.code) },
            score: { type: "number", minimum: 0, maximum: 100 },
            reason: { type: "string" },
          },
          required: ["code", "score", "reason"],
          additionalProperties: false,
        },
      },
    },
    required: ["summary", "ranking"],
    additionalProperties: false,
  };
  const prompt = [
    "# 売買ルール",
    strategyRules,
    "",
    `# 判定済みの銘柄(${stocks.length}件)`,
    JSON.stringify(stocks),
    "",
    "全銘柄を有望な順に ranking に並べ、score(0〜100、高いほど有望)と reason を付ける。summary には上位の傾向を2〜3文で書く。",
  ].join("\n");

  const { model, output } = await runTurn<{ summary: string; ranking: { code: string; score: number; reason: string }[] }>({
    instructions: RANK_INSTRUCTIONS,
    prompt,
    schema,
    model: codexModel(),
    effort: RANK_EFFORT,
  });
  // 重複を除き、抜けた銘柄は最後に回す
  const seen = new Set<string>();
  const ordered = output.ranking.filter((r) => !seen.has(r.code) && seen.add(r.code));
  const missing = stocks.filter((s) => !seen.has(s.code)).map((s) => ({ code: s.code, score: 0, reason: "Codex のランキングに含まれなかった" }));
  return {
    model,
    summary: output.summary,
    items: [...ordered, ...missing].map((r, i) => ({ ...r, rank: i + 1 })),
  };
}
