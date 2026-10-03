// 表示設定をブラウザ(localStorage)に残す。容量超過やプライベートモードで使えなくても画面は動かす

/**
 * 保存した値を読む。なければ(読めなければ)fallback。
 */
export function readLocal<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);

    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

/**
 * 値を保存する。保存できなくても例外は出さない。
 */
export function writeLocal(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 容量超過やプライベートモードでは保存しない
  }
}
