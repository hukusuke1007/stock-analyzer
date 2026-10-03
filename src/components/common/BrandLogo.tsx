import { useId } from "react";

// アプリのロゴ。2本の白い柱と、斜めに切り上がる青から緑のグラデーションの柱で「上昇」を表す。
// ファビコン(__root.tsx)と README のアイコン(docs/images/icon.svg)も同じ図形を使うので、形を変えたら FAVICON_SVG と icon.svg も直す

/**
 * ロゴを描く。グラデーションの id はページ内で重複しないよう useId で作る。
 */
export function BrandLogo({ size = 32 }: { size?: number }) {
  const gradientId = useId();

  return (
    <svg className="brand-logo" width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="株分析シミュレーター">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2962ff" />
          <stop offset="1" stopColor="#00d1a0" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="#0d0d10" />
      <rect x="6" y="18" width="5" height="8" rx="1.2" fill="#f0f3fa" />
      <rect x="13.5" y="13" width="5" height="13" rx="1.2" fill="#f0f3fa" />
      <path d="M21 26V12.5L26 6.5V26Z" fill={`url(#${gradientId})`} />
    </svg>
  );
}

// ファビコン用の同じ図形(data URL に入れるので、React を通さない文字列で持つ)
export const FAVICON_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><defs><linearGradient id='g' x1='0' y1='1' x2='1' y2='0'><stop offset='0' stop-color='%232962ff'/><stop offset='1' stop-color='%2300d1a0'/></linearGradient></defs><rect width='32' height='32' rx='8' fill='%230d0d10'/><rect x='6' y='18' width='5' height='8' rx='1.2' fill='%23f0f3fa'/><rect x='13.5' y='13' width='5' height='13' rx='1.2' fill='%23f0f3fa'/><path d='M21 26V12.5L26 6.5V26Z' fill='url(%23g)'/></svg>";
