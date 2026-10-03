import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { getRepository } from "../src/server/db/repository";
import type { SimPlan } from "../src/server/simulator";

// 旧版がファイルに保存していたデータ(data/*.json)を、指定したユーザーの DB に取り込む。
// 取り込み先の DB は DATABASE_URL で決まる(libSQL・Turso・PostgreSQL)。D1 へは HOW_TO_DEPLOY.md の手順で移す。
// 取り込み先のユーザーは、先に画面でアカウントを作っておく。
//
//   pnpm db:import --email you@example.com [--data-dir ./data]
//
// - 設定・関心銘柄・シミュレーターの口座は、ファイルの内容で置き換える
// - 判定結果は銘柄ごとに上書きし、スクリーニング結果は同じ日時の実行がまだなければ足す
// そのため、同じデータで何度実行しても結果は変わらない。

type JsonRecord = Record<string, unknown>;

const { values: args } = parseArgs({
  options: {
    email: { type: "string" },
    "data-dir": { type: "string", default: "data" },
  },
});

/**
 * JSON ファイルを読む。ファイルがなければ null。
 */
async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw e;
  }
}

/**
 * ディレクトリ直下の .json ファイルのパスを名前順に返す。ディレクトリがなければ空。
 */
async function listJsonFiles(dir: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);

  return names
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(dir, f));
}

/**
 * data/ の下にある売買ルールのディレクトリ名(swing / rebound など)を返す。
 */
async function listStrategyDirs(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);

  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/**
 * メールアドレスから取り込み先のユーザーを探す。見つからなければ止める。
 */
async function findUserIdByEmail(email: string): Promise<string> {
  const row = await getRepository().findUserByEmail(email.trim().toLowerCase());
  if (!row) {
    throw new Error(`${email} のユーザーがいません。先に画面でアカウントを作ってください`);
  }

  return row.id;
}

/**
 * 設定と関心銘柄を取り込む。
 */
async function importSettingsAndWatchlist(userId: string, dataDir: string) {
  const repository = getRepository();

  const settings = await readJsonFile<{ decisionsProvider: "codex" | "jev"; codexModel: string }>(path.join(dataDir, "settings.json"));
  if (settings) {
    // 旧版には通知の設定がないので、今の設定を残す
    const current = await repository.loadSettings(userId);
    const values = {
      decisionsProvider: settings.decisionsProvider,
      codexModel: settings.codexModel,
      notifyTakeProfit: current?.notifyTakeProfit ?? false,
      notifyStopLoss: current?.notifyStopLoss ?? false,
    };
    await repository.saveSettings(userId, values);
    console.log(`設定: ${values.decisionsProvider} / ${values.codexModel}`);
  }

  const watchlist = await readJsonFile<{ codes: string[]; columns: number }>(path.join(dataDir, "watchlist.json"));
  if (watchlist) {
    const values = { codes: watchlist.codes, columns: watchlist.columns };
    await repository.saveWatchlist(userId, values);
    console.log(`関心銘柄: ${values.codes.length}件`);
  }
}

type SimFile = {
  initialCash: number;
  cash: number;
  createdAt: string;
  positions: { code: string; name: string; shares: number; avgPrice: number; openedAt: string; plan: unknown }[];
  trades: {
    id: string;
    at: string;
    side: "buy" | "sell";
    code: string;
    name: string;
    shares: number;
    price: number;
    priceDate: string;
    amount: number;
    realized: number | null;
  }[];
};

/**
 * シミュレーターの口座を、ファイルの内容で置き換える。
 * 消してから入れ直すまでを1回の書き込みにまとめ、途中で失敗しても口座が半端に残らないようにする。
 */
async function importSimulator(userId: string, dataDir: string) {
  const sim = await readJsonFile<SimFile>(path.join(dataDir, "simulator.json"));
  if (!sim) {
    return;
  }

  // revision を新しくして、取り込む前の口座を読んで進めていた注文が書き込めないようにする
  await getRepository().replaceSimAccount(userId, {
    initialCash: sim.initialCash,
    cash: sim.cash,
    createdAt: sim.createdAt,
    revision: crypto.randomUUID(),
    positions: sim.positions.map((p) => ({ ...p, plan: (p.plan as SimPlan | null) ?? null })),
    trades: sim.trades,
  });

  console.log(`シミュレーター: 現金 ${Math.round(sim.cash).toLocaleString("ja-JP")}円 / 保有 ${sim.positions.length}銘柄 / 売買履歴 ${sim.trades.length}件`);
}

/**
 * 判定結果(data/judgments/<売買ルール>/<銘柄>.json)を取り込む。銘柄ごとに上書きする。
 */
async function importJudgments(userId: string, dataDir: string) {
  const repository = getRepository();
  const root = path.join(dataDir, "judgments");

  for (const strategy of await listStrategyDirs(root)) {
    const files = await listJsonFiles(path.join(root, strategy));

    for (const file of files) {
      const data = await readJsonFile<JsonRecord>(file);
      if (!data || typeof data.code !== "string") {
        continue;
      }

      // 旧版の結果に判定日時がなければ、並び順が崩れないよう最古の扱いにする
      const judgedAt = typeof data.judgedAt === "string" ? data.judgedAt : "1970-01-01T00:00:00.000Z";
      await repository.saveJudgment(userId, strategy, { code: data.code, judgedAt, data });
    }

    console.log(`判定結果(${strategy}): ${files.length}件`);
  }
}

/**
 * スクリーニング結果(data/screens/<売買ルール>/<日時>.json)を取り込む。同じ日時の実行がすでにあれば飛ばす。
 */
async function importScreens(userId: string, dataDir: string) {
  const repository = getRepository();
  const root = path.join(dataDir, "screens");

  for (const strategy of await listStrategyDirs(root)) {
    let added = 0;

    for (const file of await listJsonFiles(path.join(root, strategy))) {
      const data = await readJsonFile<JsonRecord>(file);
      if (!data || typeof data.scannedAt !== "string") {
        continue;
      }

      if (await repository.hasScreen(userId, strategy, data.scannedAt)) {
        continue;
      }

      // 概要と銘柄ごとの結果に分けて保存する(1回分を1行にすると D1 の1行の上限を超えるため)
      const { results, ...summary } = data;
      await repository.saveScreen(userId, strategy, { scannedAt: data.scannedAt, summary, results: Array.isArray(results) ? results : [] });
      added++;
    }

    console.log(`スクリーニング結果(${strategy}): ${added}件を追加`);
  }
}

if (!args.email) {
  console.error("使い方: pnpm db:import --email you@example.com [--data-dir ./data]");
  process.exit(1);
}

const dataDir = path.resolve(args["data-dir"]);
const userId = await findUserIdByEmail(args.email);

console.log(`${dataDir} を ${args.email} に取り込みます`);
await importSettingsAndWatchlist(userId, dataDir);
await importSimulator(userId, dataDir);
await importJudgments(userId, dataDir);
await importScreens(userId, dataDir);
console.log("取り込みが終わりました");
