import { useSelector } from "@tanstack/react-store";
import { toggleOption, uiStore } from "../../lib/ui-store";

/**
 * 材料(決算・ニュース)のオン / オフ。上部バーとスクリーナーの2か所に置き、どちらを押しても同じ設定を切り替える。
 */
export function MaterialsToggle({ compact = false, titles }: { compact?: boolean; titles: { earnings: string; news: string; group: string } }) {
  const options = useSelector(uiStore, (s) => s.options);

  return (
    <div className={`segmented options materials-toggle ${compact ? "compact" : ""}`} title={titles.group}>
      <span className="opt-label">材料</span>
      <button type="button" className={options.earnings ? "active" : ""} title={titles.earnings} onClick={() => toggleOption("earnings")}>
        決算
      </button>
      <button type="button" className={options.news ? "active" : ""} title={titles.news} onClick={() => toggleOption("news")}>
        ニュース
      </button>
    </div>
  );
}
