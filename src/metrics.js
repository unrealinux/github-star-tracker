/**
 * 指标与口径常量 —— 全项目共享的枚举、里程碑、小工具。
 * 只放常量与纯函数，不碰 db / 网络。
 */

// ── 指标定义（P1：多指标：星标 / 复刻 / Issue）────────────────────
const METRICS = {
  stars: { field: "stars", label: "星标", noun: "★" },
  forks: { field: "forks", label: "复刻", noun: "🍴" },
  issues: { field: "open_issues", label: "Issue", noun: "❗" },
};
export const AVAILABLE_METRICS = Object.entries(METRICS).map(([k, v]) => ({ key: k, label: v.label }));
export const metricOf = (m) => METRICS[m] || METRICS.stars;

/**
 * 🏆 排行榜的增长口径：
 *   avg7（默认）→ 近 7 天日均（星/天，稳定）
 *   day / week / month → 对应窗口内的**原始新增**（星）
 *   today → 自然日新增：本地时区今天 00:00 之前最近一条快照为基准（星）
 */
export const GROWTH_BASES = {
  avg7: { label: "近7天日均", unit: "星/天", win: null },
  day: { label: "近24h新增", unit: "星", win: "day" },
  week: { label: "近7天新增", unit: "星", win: "week" },
  month: { label: "近30天新增", unit: "星", win: "month" },
  today: { label: "今日新增（00:00 起）", unit: "星", win: "day", calendar: true },
};
export const AVAILABLE_GROWTH_BASES = Object.entries(GROWTH_BASES).map(([key, v]) => ({
  key,
  label: v.label,
}));

// 日均增长榜要求的最小样本跨度（天）：太短的样本会把「几小时的差值」外推成夸张的日增
export const MIN_GROWTH_SAMPLE_DAYS = 0.5;

// 里程碑（跨过时触发一次里程碑告警）
export const MILESTONES = [
  1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000,
];

/** 星数紧凑格式（用于时间线标签） */
export const compactStars = (n) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1_000 ? `${n / 1_000}k` : String(n);
