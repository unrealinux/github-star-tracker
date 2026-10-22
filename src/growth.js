/**
 * 增长计算 —— 纯函数（不碰 db、不发网络请求），输入快照序列输出统计值。
 * 这样核心口径（日均 / 动量 / 预测 / 排序）可以在任何数据源上单元测试。
 */
import { windowOf, avgDailyGrowth } from "./windows.js";
import { dailyAggregate } from "./snapshots.js";

/**
 * P0-1: 增速动量（二阶导）—— 对比「近 3 天日均」与「更早若干天日均」。
 * 用于识别「正在加速起飞」与「热度衰减」的项目。
 * @returns {{ recentAvg:number, priorAvg:number, accel:number, surgeRatio:number, isSurge:boolean, days:number } | null}
 */
export function computeMomentum(snaps, field = "stars") {
  const days = dailyAggregate(snaps);
  if (days.length < 3) return null;

  // 相邻天的日增序列
  const deltas = [];
  for (let i = 1; i < days.length; i++) {
    deltas.push({ date: days[i].captured_at.slice(0, 10), d: days[i][field] - days[i - 1][field] });
  }
  if (deltas.length < 3) return null;

  const RECENT = Math.min(3, Math.max(1, deltas.length - 2));
  const recent = deltas.slice(-RECENT);
  const prior = deltas.slice(0, -RECENT);

  const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b.d, 0) / arr.length : 0);
  const recentAvg = mean(recent);
  const priorAvg = mean(prior);
  const accel = recentAvg - priorAvg;
  // priorAvg 为 0/负 时用绝对增量判断
  const surgeRatio = priorAvg > 0 ? recentAvg / priorAvg : recentAvg > 0 ? Infinity : 0;

  const isSurge =
    recentAvg > 0 && ((priorAvg > 0 && surgeRatio >= 1.8 && accel > 0) || (priorAvg <= 0 && recentAvg >= 5));

  return {
    recentAvg: Number(recentAvg.toFixed(2)),
    priorAvg: Number(priorAvg.toFixed(2)),
    accel: Number(accel.toFixed(2)),
    surgeRatio: surgeRatio === Infinity ? null : Number(surgeRatio.toFixed(2)),
    isSurge,
    days: days.length,
  };
}

/** 计算日增折线（支持同一天内多次快照） */
export function computeDailyGrowth(snaps, field = "stars") {
  if (!snaps || snaps.length < 2) return [];
  const result = [];
  const dayMap = new Map();
  for (const s of snaps) {
    const dayKey = s.captured_at.slice(0, 10);
    const existing = dayMap.get(dayKey);
    if (!existing || s.captured_at > existing.captured_at) dayMap.set(dayKey, s);
  }
  const days = Array.from(dayMap.values()).sort((a, b) => a.captured_at.localeCompare(b.captured_at));

  if (days.length >= 2) {
    for (let i = Math.max(1, days.length - 7); i < days.length; i++) {
      result.push({ date: days[i].captured_at.slice(0, 10), growth: days[i][field] - days[i - 1][field] });
    }
  } else {
    const recent = snaps.slice(-10);
    for (let i = 1; i < recent.length; i++) {
      result.push({
        date: recent[i].captured_at.slice(0, 10),
        growth: recent[i][field] - recent[i - 1][field],
      });
    }
  }
  return result;
}

/**
 * 近 7 天日均增长（比单次快照差值稳定）。
 * @returns {{ avg:number, days:number, samples:number } | null}
 */
export const computeAvgDailyGrowth = (snaps, field = "stars") => avgDailyGrowth(snaps, (s) => s[field]);

export function computeGrowth(repoValue, snaps, now, window, field = "stars") {
  if (!snaps || snaps.length === 0)
    return { growth: null, label: "待积累", dailyGrowth: [], avgDaily: null, momentum: null };
  const cfg = windowOf(window);
  const windowStart = now - cfg.ms;

  let baseSnap = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (Date.parse(snaps[i].captured_at) <= windowStart) {
      baseSnap = snaps[i];
      break;
    }
  }

  let growth = null,
    label = "待积累";
  if (baseSnap !== null) {
    growth = repoValue - baseSnap[field];
    // 基准只保证「不晚于窗口起点」，不保证「接近窗口长度」：
    // 采集中断过时它可能已经是很多天前，差值覆盖的是整段跨度。
    // 直接套 cfg.label 会把 7 天的增长谎报成「近24h」，所以按真实跨度标注。
    const days = Math.round((now - Date.parse(baseSnap.captured_at)) / 86400000);
    label = days <= 1 ? cfg.label : `近${days}天`;
  } else if (snaps.length >= 2) {
    if (window === "day") {
      growth = repoValue - snaps[snaps.length - 2][field];
      label = "本次更新";
    } else {
      const earliest = snaps[0];
      const days = Math.max(1, Math.round((now - Date.parse(earliest.captured_at)) / 86400000));
      growth = repoValue - earliest[field];
      label = `近${days}天`;
    }
  }
  return {
    growth,
    label,
    dailyGrowth: computeDailyGrowth(snaps, field),
    avgDaily: computeAvgDailyGrowth(snaps, field),
    momentum: computeMomentum(snaps, field),
  };
}

/**
 * P3-15: 星数增长预测（最小二乘线性回归）
 * @returns {{ perDay:number, next100k:object|null } | null}
 */
export function predictGrowth(snaps) {
  const byDay = new Map();
  for (const s of snaps) {
    const k = s.captured_at.slice(0, 10);
    const cur = byDay.get(k);
    if (!cur || s.captured_at > cur.captured_at) byDay.set(k, s);
  }
  const pts = Array.from(byDay.values()).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
  if (pts.length < 3) return null;

  // x = 天数序号, y = stars
  const n = pts.length;
  const t0 = Date.parse(pts[0].captured_at);
  const xs = pts.map((p) => (Date.parse(p.captured_at) - t0) / 86400000);
  const ys = pts.map((p) => p.stars);
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const slope = num / den; // 星/天
  const intercept = my - slope * mx;

  const current = ys[ys.length - 1];
  const nextMilestone = [100000, 200000, 500000, 1000000, 2000000].find((m) => m > current) ?? null;
  let next100k = null;
  if (nextMilestone && slope > 0.01) {
    // 从最后一天的 x 继续推算
    const lastX = xs[xs.length - 1];
    const daysNeeded = (nextMilestone - (slope * lastX + intercept)) / slope;
    if (daysNeeded > 0 && daysNeeded < 3650) {
      next100k = {
        milestone: nextMilestone,
        days: Math.round(daysNeeded),
        eta: new Date(Date.now() + daysNeeded * 86400000).toISOString().slice(0, 10),
      };
    }
  }

  // 拟合可信度：R² 越低说明星数变化越不像直线，预测越不可信
  const ssTot = ys.reduce((a, y) => a + (y - my) ** 2, 0);
  const ssRes = ys.reduce((a, y, i) => a + (y - (slope * xs[i] + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));

  return {
    perDay: Number(slope.toFixed(2)),
    r2: Number(r2.toFixed(3)),
    samples: n,
    next100k,
  };
}

// ── 排序 ──────────────────────────────────────────────────────────
export function makeSort(sort, field = "stars") {
  switch (sort) {
    case "stars":
      return (a, b) => b.stars - a.stars;
    case "metric":
      return (a, b) => (b.metricValue ?? b[field] ?? 0) - (a.metricValue ?? a[field] ?? 0);
    case "newest":
      return (a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at);
    case "name":
      return (a, b) => a.full_name.localeCompare(b.full_name);
    case "language":
      return (a, b) => (a.language ?? "").localeCompare(b.language ?? "") || b.stars - a.stars;
    default:
      return (a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity) || b.stars - a.stars;
  }
}

/**
 * 交叉预测：星数较低但增速更快的仓库何时超过另一个。
 * 仅当两者斜率差为正、预测天数在 10 年内时给出。
 */
export function computeCrossings(repos, { maxDays = 3650, limit = 6 } = {}) {
  const out = [];
  for (const a of repos) {
    for (const b of repos) {
      if (a.id === b.id) continue;
      if (a.slope == null || b.slope == null) continue;
      if (a.current >= b.current) continue; // 只看后来者超前者
      if (a.slope <= b.slope) continue;
      const days = (b.current - a.current) / (a.slope - b.slope);
      if (!(days > 0) || days > maxDays) continue;
      out.push({
        from: a.full_name,
        to: b.full_name,
        fromId: a.id,
        toId: b.id,
        days: Math.round(days),
        eta: new Date(Date.now() + days * 86400000).toISOString().slice(0, 10),
        confidence: Number(Math.min(a.r2 ?? 0, b.r2 ?? 0).toFixed(3)),
      });
    }
  }
  return out.sort((x, y) => x.days - y.days || y.confidence - x.confidence).slice(0, limit);
}

/** 本地时区「今天 00:00」的毫秒时间戳 */
export function todayStartMs(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
