import * as XLSX from "xlsx";

// テクニカル以外の判断材料(オプション)。
// - 決算: 次回の決算発表日。JPX の「決算発表予定日」(確定)を優先し、載っていなければ Yahoo Finance の予定日(推定を含む)
// - ニュース: Google ニュースの RSS から直近7日の見出し

const UA = { "User-Agent": "Mozilla/5.0" };
const todayJst = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export type Earnings = {
  date: string; // YYYY-MM-DD
  source: "JPX" | "Yahoo";
  confirmed: boolean; // JPX に載っている、または Yahoo で推定ではない
  period: string | null; // 第２四半期など(JPX のみ)
  businessDays: number; // 今日の翌営業日から数えて何営業日目か(祝日は数えている)
};

export type EarningsInfo = { next: Earnings | null; exDividend: string | null };

export type NewsItem = { title: string; source: string; published: string; link: string };

// ---------- 決算: JPX ----------
const JPX_BASE = "https://www.jpx.co.jp";
const JPX_INDEX = `${JPX_BASE}/listing/event-schedules/financial-announcement/index.html`;

let jpxCache: { day: string; map: Map<string, { date: string; period: string | null }> } | undefined;

// JPX の決算発表予定日。決算期末の月ごとの Excel を全部読み、今日以降でいちばん近い日を銘柄ごとに持つ
export async function jpxEarnings() {
  const day = todayJst();
  if (jpxCache?.day === day) return jpxCache.map;

  const html = await (await fetch(JPX_INDEX, { headers: UA })).text();
  const links = [...new Set([...html.matchAll(/href="([^"]+kessan[^"]*\.xlsx)"/g)].map((m) => m[1]!))];
  const map = new Map<string, { date: string; period: string | null }>();
  for (const link of links) {
    const res = await fetch(new URL(link, JPX_BASE), { headers: UA });
    if (!res.ok) continue;
    const book = XLSX.read(await res.arrayBuffer());
    const rows = XLSX.utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]!]!, { header: 1 });
    for (const row of rows) {
      const [serial, code, , , , , , period] = row;
      if (typeof serial !== "number" || code == null) continue; // 見出し行など
      // Excel の日付(1900年起点の通し番号)を YYYY-MM-DD にする
      const date = new Date(Math.round((serial - 25569) * 86400_000)).toISOString().slice(0, 10);
      if (date < day) continue;
      const key = String(code);
      const prev = map.get(key);
      if (!prev || date < prev.date) map.set(key, { date, period: typeof period === "string" ? period : null });
    }
  }
  jpxCache = { day, map };
  return map;
}

// ---------- 決算: Yahoo Finance ----------
// quoteSummary は cookie と crumb が要る。1時間使い回し、401 が返ったら取り直す
let yahooAuth: { cookie: string; crumb: string; at: number } | undefined;

async function yahooCrumb(force = false) {
  if (!force && yahooAuth && Date.now() - yahooAuth.at < 3600_000) return yahooAuth;
  const res = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const crumb = await (await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, Cookie: cookie } })).text();
  if (!crumb || crumb.includes("<")) throw new Error("Yahoo Finance の crumb を取得できない");
  yahooAuth = { cookie, crumb, at: Date.now() };
  return yahooAuth;
}

type CalendarResponse = {
  quoteSummary: {
    result:
      | {
          calendarEvents?: {
            earnings?: { earningsDate?: { fmt: string }[]; isEarningsDateEstimate?: boolean };
            exDividendDate?: { fmt?: string };
          };
        }[]
      | null;
  };
};

async function yahooCalendar(code: string, retry = true): Promise<{ date: string | null; estimate: boolean; exDividend: string | null }> {
  const auth = await yahooCrumb();
  const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${code}.T?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`;
  const res = await fetch(url, { headers: { ...UA, Cookie: auth.cookie } });
  if (res.status === 401 && retry) {
    await yahooCrumb(true);
    return yahooCalendar(code, false);
  }
  if (!res.ok) throw new Error(`${code}: Yahoo Finance の決算予定を取得できない (HTTP ${res.status})`);
  const ev = ((await res.json()) as CalendarResponse).quoteSummary.result?.[0]?.calendarEvents;
  const today = todayJst();
  const date = ev?.earnings?.earningsDate?.map((d) => d.fmt).find((d) => d >= today) ?? null;
  const exDividend = ev?.exDividendDate?.fmt ?? null;
  return { date, estimate: ev?.earnings?.isEarningsDateEstimate ?? true, exDividend: exDividend && exDividend >= today ? exDividend : null };
}

// 今日の翌日から date までの平日の数(祝日は考慮しない)
function businessDaysUntil(date: string) {
  let n = 0;
  const d = new Date(`${todayJst()}T00:00:00Z`);
  const end = new Date(`${date}T00:00:00Z`);
  while (d < end) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

export async function nextEarnings(code: string): Promise<EarningsInfo> {
  const [jpx, yahoo] = await Promise.all([
    jpxEarnings().catch(() => new Map<string, { date: string; period: string | null }>()),
    yahooCalendar(code).catch(() => null),
  ]);
  const fromJpx = jpx.get(code);
  let next: Earnings | null = null;
  if (fromJpx) {
    next = { date: fromJpx.date, source: "JPX", confirmed: true, period: fromJpx.period, businessDays: businessDaysUntil(fromJpx.date) };
  } else if (yahoo?.date) {
    next = { date: yahoo.date, source: "Yahoo", confirmed: !yahoo.estimate, period: null, businessDays: businessDaysUntil(yahoo.date) };
  }
  return { next, exDividend: yahoo?.exDividend ?? null };
}

// ---------- ニュース: Google ニュース RSS ----------
const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
const tag = (xml: string, name: string) => decode(xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`))?.[1] ?? "");

// 株価ページなど、ニュースではない結果を除く
const NOT_NEWS = /株価・株式情報|株価チャート|株価 \|/;

// /screen では候補全部(数百件)を取りに行くので、同時アクセス数を絞る
const NEWS_CONCURRENCY = 4;
let newsActive = 0;
const newsWaiters: (() => void)[] = [];
async function newsSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (newsActive >= NEWS_CONCURRENCY) await new Promise<void>((r) => newsWaiters.push(r));
  newsActive++;
  try {
    return await fn();
  } finally {
    newsActive--;
    newsWaiters.shift()?.();
  }
}

async function fetchNewsXml(url: string, retry = true): Promise<string> {
  const res = await newsSlot(() => fetch(url, { headers: UA }));
  // 混み合って断られたら、少し待って1回だけやり直す
  if ((res.status === 429 || res.status >= 500) && retry) {
    await new Promise((r) => setTimeout(r, 1500));
    return fetchNewsXml(url, false);
  }
  if (!res.ok) throw new Error(`Google ニュースを取得できない (HTTP ${res.status})`);
  return res.text();
}

export async function fetchNews(name: string, limit = 10): Promise<NewsItem[]> {
  const q = encodeURIComponent(`"${name}" when:7d`);
  const xml = await fetchNewsXml(`https://news.google.com/rss/search?q=${q}&hl=ja&gl=JP&ceid=JP:ja`);
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map(([, item]) => {
      const source = tag(item!, "source");
      const title = tag(item!, "title").replace(new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`), "");
      const pub = tag(item!, "pubDate");
      return {
        title,
        source,
        published: pub ? new Date(new Date(pub).getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "",
        link: tag(item!, "link"),
      };
    })
    .filter((n) => n.title && !NOT_NEWS.test(n.title))
    .sort((a, b) => b.published.localeCompare(a.published))
    .slice(0, limit);
}

// Jev に渡すニュースの本文。見出しを新しい順に並べる
export const newsText = (items: NewsItem[]) =>
  items.length ? items.map((n) => `${n.published} ${n.title}(${n.source})`).join("\n") : "直近7日のニュースは見つからなかった";
