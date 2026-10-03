import * as XLSX from "xlsx";

// JPX の「東証上場銘柄一覧」から上場株を取る。一覧は月1回更新される。
// スクリーニング(/screen)はプライムだけ、銘柄検索(/search)はプライム・スタンダード・グロースを使う
const LIST_URL = "https://www.jpx.co.jp/markets/statistics-equities/misc/tvdivq0000001vg2-att/data_j.xlsx";

export type Listing = {
  code: string;
  name: string;
  market: string; // プライム / スタンダード / グロース
  sector: string; // 33業種区分
  scale: string; // 規模区分(TOPIX Core30 / Large70 / Mid400 / Small 1 / Small 2 / -)
};

type Row = { コード: string | number; 銘柄名: string; "市場・商品区分": string; "33業種区分": string; 規模区分: string };

const MARKETS = ["プライム", "スタンダード", "グロース"];

let cache: { day: string; listings: Listing[] } | undefined;

// ETF・REIT・PRO Market などを除いた上場株
export async function stockListings(): Promise<Listing[]> {
  const day = new Date().toISOString().slice(0, 10);
  if (cache?.day === day) return cache.listings;

  const res = await fetch(LIST_URL);
  if (!res.ok) throw new Error(`JPX の銘柄一覧を取得できない (HTTP ${res.status})`);
  const book = XLSX.read(await res.arrayBuffer());
  const rows = XLSX.utils.sheet_to_json<Row>(book.Sheets[book.SheetNames[0]!]!);

  const listings = rows.flatMap((r) => {
    const market = MARKETS.find((m) => r["市場・商品区分"].startsWith(m));
    return market ? [{ code: String(r.コード), name: r.銘柄名, market, sector: r["33業種区分"], scale: r.規模区分 }] : [];
  });
  cache = { day, listings };
  return listings;
}

export async function primeListings(): Promise<Listing[]> {
  return (await stockListings()).filter((l) => l.market === "プライム");
}

// 検索用に表記をそろえる: 全角英数・半角カナを揃え(NFKC)、ひらがなをカタカナに、英字を大文字にする
const normalize = (s: string) =>
  s
    .normalize("NFKC")
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
    .replace(/\s+/g, "")
    .toUpperCase();

// 規模区分(時価総額の大きい順)。検索結果で大きい会社を上に出す
const SCALES = ["TOPIX Core30", "TOPIX Large70", "TOPIX Mid400", "TOPIX Small 1", "TOPIX Small 2"];
const scaleRank = (scale: string) => (SCALES.includes(scale) ? SCALES.indexOf(scale) : SCALES.length);

// 証券コードの前方一致と、銘柄名の部分一致。一致の強さ(コード一致 → 名前の前方一致 → 部分一致)、市場、規模の順に並べる
export async function searchListings(query: string, limit = 12): Promise<Listing[]> {
  const q = normalize(query);
  if (!q) return [];
  const scored = (await stockListings()).flatMap((l) => {
    const name = normalize(l.name);
    const score = l.code === q ? 0 : l.code.startsWith(q) ? 1 : name.startsWith(q) ? 2 : name.includes(q) ? 3 : -1;
    return score < 0 ? [] : [{ l, score: score * 100 + MARKETS.indexOf(l.market) * 10 + scaleRank(l.scale) }];
  });
  return scored
    .sort((a, b) => a.score - b.score || a.l.code.localeCompare(b.l.code))
    .slice(0, limit)
    .map((x) => x.l);
}
