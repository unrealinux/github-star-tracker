/**
 * 时间窗口与增长计算的共享定义。
 * tracker.js / external.js 复用，避免两份逻辑各自漂移。
 */
export const WINDOWS = {
  day: { ms: 24 * 3600 * 1000, label: "近24h" },
  week: { ms: 7 * 24 * 3600 * 1000, label: "近7天" },
  month: { ms: 30 * 24 * 3600 * 1000, label: "近30天" },
};

export const windowOf = (w) => WINDOWS[w] || WINDOWS.day;

/**
 * 统一用 ISO 字符串（带 T）与库内 captured_at / triggered_at 比较。
 * 直接用 datetime('now', ?) 返回的是空格分隔格式，字符串比较会被 'T' > ' ' 干扰，
 * 导致同一天内的记录被错误归类。所有时间比较一律走这里。
 */
export const isoOffset = (ms) => new Date(Date.now() - ms).toISOString();

/**
 * 近 7 天日均增长（比单次快照差值稳定）。
 * @param {Array} snaps 按 captured_at 升序的快照
 * @param {(s:any)=>number} getValue 从快照取指标值
 * @returns {{avg:number, days:number, samples:number} | null}
 */
export function avgDailyGrowth(snaps, getValue = (s) => s.stars) {
  if (!snaps || snaps.length < 2) return null;
  const cutoff = Date.now() - 7 * 86400000;
  const latest = snaps[snaps.length - 1];
  let earliest = snaps[0];
  for (const s of snaps) {
    if (Date.parse(s.captured_at) >= cutoff) {
      earliest = s;
      break;
    }
  }
  const days = (Date.parse(latest.captured_at) - Date.parse(earliest.captured_at)) / 86400000;
  if (!(days > 0)) return null;
  return { avg: (getValue(latest) - getValue(earliest)) / days, days, samples: snaps.length };
}
