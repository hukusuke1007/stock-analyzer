// Cloudflare Workers の "cloudflare:workers" モジュールのうち、このアプリが使う分だけの型。
// wrangler types が生成するランタイムの型は画面側の DOM の型とぶつかるので、必要な分だけを書く
declare module "cloudflare:workers" {
  export const env: {
    // wrangler.jsonc の d1_databases のバインディング
    DB?: unknown;
    // Turso に繋ぐときのシークレット
    DATABASE_URL?: string;
    DATABASE_AUTH_TOKEN?: string;
  };
}
