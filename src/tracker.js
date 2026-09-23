import {
  db, getSetting, recordApiUsage,
  hasRecentAlert, insertAlert, getRepoIdMap, allCustomRepoNames, searchCustomRepo,
  getIndex, getTrackedQuery, listTrackedQueries, getQueryMemberIds, replaceQueryMembers,
  markRepoStale, clearRepoStale, renameRepo, listUsers,
} from "./db.js";
import { searchTopRepos, fetchCustomRepo } from "./github.js";
import { WINDOWS, windowOf, isoOffset, avgDailyGrowth } from "./windows.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 快照查询上限：只取最近 35 天、每仓库最多 400 条，避免全表加载
const SNAPSHOT_WINDOW_DAYS = 35;
const SNAPSHOT_PER_REPO_CAP = 400;

// ── 指标定义（P1：多指标）────────────────────────────────────────
const METRICS = {
  stars:  { field: "stars",       label: "星标",   noun: "★" },
  forks:  { field: "forks",       label: "复刻",   noun: "🍴" },
  issues: { field: "open_issues", label: "Issue", noun: "❗" },
};
export const AVAILABLE_METRICS = Object.entries(METRICS).map(([k, v]) => ({ key: k, label: v.label }));
const metricOf = (m) => METRICS[m] || METRICS.stars;

const upsertRepo = db.prepare(`
  INSERT INTO repos (full_name, owner, name, url, description, language, homepage, stars, forks, open_issues, gh_created_at, is_custom)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(full_name) DO UPDATE SET
    stars       = excluded.stars,
    forks       = excluded.forks,
    open_issues = excluded.open_issues,
    url         = excluded.url,
    description = excluded.description,
    language    = excluded.language,
    homepage    = excluded.homepage,
    is_custom   = MAX(repos.is_custom, excluded.is_custom),
    updated_at  = strftime('%Y-%m-%dT%H:%M:%SZ','now')
`);

const insertSnapshot = db.prepare(
  "INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?, ?, ?, ?, ?)"
);

// ── 通知回调（由 notify.js 注入）──────────────────────────────────
let notifyCallback = null;
export function setNotify(cb) { notifyCallback = cb; }

// 里程碑（跨过时触发一次里程碑告警）
const MILESTONES = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000, 1000000, 2000000, 5000000, 10000000];

/** 星数紧凑格式（用于时间线标签） */
const compactStars = (n) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1_000 ? `${n / 1_000}k` : String(n));

/** 读取告警配置（含每仓库阈值；阈值按用户隔离） */
function loadAlertConfig(userId = 0) {
  const key = userId ? `repoThresholds:${userId}` : "repoThresholds";
  let repoThresholds = {};
  try { repoThresholds = JSON.parse(getSetting(key, "{}") || "{}"); } catch { repoThresholds = {}; }
  return {
    threshold: Number(getSetting("alertThreshold", 50)) || 0,
    repoThresholds: repoThresholds && typeof repoThresholds === "object" ? repoThresholds : {},
    alertOnDrop: getSetting("alertOnDrop", "0") === "1",
    dropThreshold: Number(getSetting("dropThreshold", 50)) || 0,
    alertOnMilestone: getSetting("alertOnMilestone", "0") === "1",
  };
}

/**
 * 告警评估目标：无用户时只有「单用户/共享」(id=0)，否则每个用户各按自己的阈值评估。
 * @returns {Array<{userId:number, cfg:object}>}
 */
function getAlertTargets() {
  const users = listUsers();
  if (!users.length) return [{ userId: 0, cfg: loadAlertConfig(0) }];
  return users.map((u) => ({ userId: u.id, cfg: loadAlertConfig(u.id) }));
}

function fireAlert(repoId, fullName, alert, userId = 0) {
  insertAlert(repoId, alert.threshold, alert.growth, alert.currentStars, { kind: alert.kind, message: alert.message, userId });
  if (notifyCallback) {
    Promise.resolve(notifyCallback({ repoId, fullName, ...alert, userId }))
      .catch((e) => console.error("[notify]", e.message));
  }
}

/**
 * 找窗口基准快照，并给出它「真的有多旧」（天，下限 1）。
 *
 * 基准只保证「不晚于窗口起点」，不保证「接近窗口长度」：采集中断过
 * （服务没开 / cron 失败 / 机器关机）时它可能已是多天前。调用方必须
 * 用 days 把增量折算成日均，否则会把 N 天的变化当成一天。
 *
 * @returns {{ snap:any, days:number } | null}
 */
export function windowBaseline(snaps, now = Date.now(), windowMs = WINDOWS.day.ms) {
  if (!snaps || snaps.length < 2) return null;
  const windowStart = now - windowMs;

  let snap = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (Date.parse(snaps[i].captured_at) <= windowStart) { snap = snaps[i]; break; }
  }
  // 窗口内没有基准（快照都太新）：退回相邻快照，此时跨度不足一天
  if (snap === null) snap = snaps[snaps.length - 2];

  return { snap, days: Math.max(1, (now - Date.parse(snap.captured_at)) / 86400000) };
}

/**
 * 纯函数：根据星数与基线判断应触发哪些告警。
 * 与副作用（写库/推送）分离，便于测试。
 *
 * 阈值是「日增星数」，所以先按 baseDays 归一到日均再比 —— 采集中断时
 * 基准可能是多天前的快照，拿整段跨度直接比阈值会放大若干倍（实测 7 天
 * 的增量触发了 241 条假告警）。告警里存的 growth 也因此是日均值。
 *
 * @param {number} baseDays 基准快照距现在的天数（≥1）；省略按 1 天
 * @returns {Array<{kind:string, threshold:number, growth:number, days:number, currentStars:number, message?:string}>}
 */
export function evaluateAlertRules({ fullName, repoStars, baseStars, baseDays = 1, prevStars, cfg }) {
  const out = [];
  if (baseStars == null) return out;

  const days = Number.isFinite(baseDays) && baseDays > 0 ? baseDays : 1;
  // 先取整再比较，保证「触发了」与「界面显示的数值」一致（≥ 阈值）
  const growth = Math.round((repoStars - baseStars) / days);

  const override = Number(cfg?.repoThresholds?.[fullName]);
  const effective = Number.isFinite(override) ? override : cfg.threshold;
  if (effective > 0 && growth >= effective) {
    out.push({ kind: "growth", threshold: effective, growth, days, currentStars: repoStars });
  }

  if (cfg.alertOnDrop && cfg.dropThreshold > 0 && growth <= -cfg.dropThreshold) {
    out.push({ kind: "drop", threshold: cfg.dropThreshold, growth, days, currentStars: repoStars });
  }

  if (cfg.alertOnMilestone && prevStars != null) {
    const crossed = MILESTONES.find((m) => prevStars < m && repoStars >= m);
    if (crossed) {
      out.push({
        kind: "milestone",
        threshold: crossed,
        growth: repoStars - prevStars,
        currentStars: repoStars,
        message: `${fullName} 突破 ${crossed.toLocaleString("en-US")} 星`,
      });
    }
  }
  return out;
}

/**
 * 检查并生成告警。
 * @param {number|null} prevStars 上一次刷新时的星数（用于里程碑判定）
 */
function checkAlerts(repoId, fullName, repoStars, snaps, prevStars, cfg, userId = 0) {
  const base = windowBaseline(snaps);
  if (!base) return;

  const { snap, days } = base;
  for (const alert of evaluateAlertRules({ fullName, repoStars, baseStars: snap.stars, baseDays: days, prevStars, cfg })) {
    const hours = alert.kind === "milestone" ? 24 : 2;
    if (hasRecentAlert(repoId, hours, alert.kind, userId)) continue;
    fireAlert(repoId, fullName, alert, userId);
  }
}

/** P0-2: 有界快照加载（时间窗 + 每仓库上限），替代全表扫描。
 * 可传入 repoIds 只加载相关仓库，避免全库快照进入内存。*/
function loadSnapshotMap({ days = SNAPSHOT_WINDOW_DAYS, perRepo = SNAPSHOT_PER_REPO_CAP, repoIds = null } = {}) {
  if (repoIds && repoIds.length === 0) return new Map();
  const since = isoOffset(days * 86400000);
  const map = new Map();
  const collect = (rows) => {
    for (const s of rows) {
      let arr = map.get(s.repo_id);
      if (!arr) { arr = []; map.set(s.repo_id, arr); }
      arr.push(s);
    }
  };

  const SQL = (inClause) => `
    SELECT repo_id, stars, forks, open_issues, captured_at FROM (
      SELECT repo_id, stars, forks, open_issues, captured_at,
             ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY captured_at DESC) AS rn
      FROM snapshots
      WHERE captured_at >= ?${inClause}
    ) AS sq WHERE rn <= ?
    ORDER BY repo_id ASC, captured_at ASC`;

  if (!repoIds) {
    collect(db.prepare(SQL("")).all(since, perRepo));
    return map;
  }

  // 分批查询，避免 SQLite 变量上限（默认 999）
  const CHUNK = 500;
  const stmtCache = new Map();
  for (let i = 0; i < repoIds.length; i += CHUNK) {
    const chunk = repoIds.slice(i, i + CHUNK);
    const sql = SQL(` AND repo_id IN (${chunk.map(() => "?").join(",")})`);
    let stmt = stmtCache.get(chunk.length);
    if (!stmt) { stmt = db.prepare(sql); stmtCache.set(chunk.length, stmt); }
    collect(stmt.all(since, ...chunk, perRepo));
  }
  return map;
}

/** 只取每个仓库最近 N 条快照（用于告警基线），极度轻量 */
function loadRecentSnapshotMap(perRepo = 2) {
  const rows = db.prepare(`
    SELECT repo_id, stars, forks, open_issues, captured_at FROM (
      SELECT repo_id, stars, forks, open_issues, captured_at,
             ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY captured_at DESC) AS rn
      FROM snapshots
    ) AS sq WHERE rn <= ?
    ORDER BY repo_id ASC, captured_at ASC
  `).all(perRepo);

  const map = new Map();
  for (const s of rows) {
    let arr = map.get(s.repo_id);
    if (!arr) { arr = []; map.set(s.repo_id, arr); }
    arr.push(s);
  }
  return map;
}

/** 某一时刻（ISO）每个仓库最近一次的指标值（单次窗口函数查询，替代 N 个相关子查询） */
const SNAPSHOT_FIELDS = new Set(["stars", "forks", "open_issues"]);
function snapshotAtMap(iso, field = "stars") {
  const col = SNAPSHOT_FIELDS.has(field) ? field : "stars";
  const rows = db.prepare(`
    SELECT repo_id, val FROM (
      SELECT repo_id, ${col} AS val,
             ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY captured_at DESC) AS rn
      FROM snapshots WHERE captured_at <= ?
    ) AS sq WHERE rn = 1
  `).all(iso);
  return new Map(rows.map((r) => [r.repo_id, r.val]));
}

// ── 刷新 ──────────────────────────────────────────────────────────
export async function refresh({ minStars, token }) {
  const query = getSetting("searchQuery", "") || "";
  const { items, rate } = await searchTopRepos({ minStars, token, query });
  const now = new Date().toISOString();
  const alertTargets = getAlertTargets();

  // P2-8: 批量预取 id，避免逐条 SELECT
  const idMap = getRepoIdMap(items.map((r) => r.full_name));
  const snapMap = loadRecentSnapshotMap(2);
  let fetched = 0;

  db.exec("BEGIN");
  try {
    for (const r of items) {
      upsertRepo.run(r.full_name, r.owner, r.name, r.url, r.description, r.language, r.homepage, r.stars, r.forks || 0, r.open_issues || 0, r.gh_created_at, 0);
      const id = idMap.get(r.full_name) ?? db.prepare("SELECT id FROM repos WHERE full_name = ?").get(r.full_name)?.id;
      if (!id) continue;
      insertSnapshot.run(id, r.stars, r.forks || 0, r.open_issues || 0, now);
      const prev = snapMap.get(id) || [];
      const prevStars = prev.length ? prev[prev.length - 1].stars : null;
      const snaps = [...prev, { stars: r.stars, captured_at: now }];
      for (const t of alertTargets) checkAlerts(id, r.full_name, r.stars, snaps, prevStars, t.cfg, t.userId);
      fetched++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  recordApiUsage(rate?.used ?? 0, rate?.limit ?? 60, now);

  return {
    upserted: fetched,
    total: db.prepare("SELECT COUNT(*) c FROM repos").get().c,
    snapshots: db.prepare("SELECT COUNT(*) c FROM snapshots").get().c,
    quota: rate ? { used: rate.used, limit: rate.limit } : null,
  };
}

/** 刷新自定义仓库 */
export async function refreshCustomRepos({ token }) {
  const customRepos = db.prepare("SELECT full_name FROM custom_repos").all();
  const now = new Date().toISOString();
  const alertTargets = getAlertTargets();

  const idMap = getRepoIdMap(customRepos.map((c) => c.full_name));
  const snapMap = loadRecentSnapshotMap(2);
  let fetched = 0, renamed = 0, stale = 0;

  for (const cr of customRepos) {
    const requested = cr.full_name;
    try {
      const info = await fetchCustomRepo(requested, token);

      // 404：仓库被删除/转为私有/改名后旧地址失效 → 标记 stale，不再静默吞掉
      if (!info) {
        markRepoStale(requested, "404 Not Found");
        stale++;
        continue;
      }

      // GitHub 对改名后的旧地址会 301 → fetch 自动跟随，返回新 full_name
      let lookupKey = requested;
      if (info.full_name && info.full_name !== requested) {
        const r = renameRepo(requested, info.full_name);
        if (r.renamed) renamed++;
        lookupKey = info.full_name;
      }
      clearRepoStale(lookupKey);

      upsertRepo.run(info.full_name, info.owner, info.name, info.url, info.description, info.language, info.homepage, info.stars, info.forks || 0, info.open_issues || 0, info.gh_created_at, 1);
      const id = idMap.get(lookupKey)
        ?? db.prepare("SELECT id FROM repos WHERE full_name = ?").get(lookupKey)?.id
        ?? db.prepare("SELECT id FROM repos WHERE full_name = ?").get(info.full_name)?.id;
      if (!id) continue;
      insertSnapshot.run(id, info.stars, info.forks || 0, info.open_issues || 0, now);
      const prev = snapMap.get(id) || [];
      const prevStars = prev.length ? prev[prev.length - 1].stars : null;
      const snaps = [...prev, { stars: info.stars, captured_at: now }];
      for (const t of alertTargets) checkAlerts(id, info.full_name, info.stars, snaps, prevStars, t.cfg, t.userId);
      fetched++;
    } catch (e) {
      markRepoStale(requested, String(e.message || e).slice(0, 200));
      stale++;
      console.error(`[custom] 抓取 ${requested} 失败:`, e.message);
    }
  }
  return { upserted: fetched, renamed, stale, total: db.prepare("SELECT COUNT(*) c FROM repos").get().c };
}

// ── 增长计算 ──────────────────────────────────────────────────────
/** 按天聚合：每天取最后一条快照 */
function dailyAggregate(snaps) {
  const dayMap = new Map();
  for (const s of snaps) {
    const k = s.captured_at.slice(0, 10);
    const cur = dayMap.get(k);
    if (!cur || s.captured_at > cur.captured_at) dayMap.set(k, s);
  }
  return Array.from(dayMap.values()).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}

/**
 * P0-1: 增速动量（二阶导）—— 对比「近 3 天日均」与「更早若干天日均」。
 * 用于识别「正在加速起飞」与「热度衰减」的项目。
 * @returns {{ recentAvg:number, priorAvg:number, accel:number, surgeRatio:number, isSurge:boolean, days:number } | null}
 */
function computeMomentum(snaps, field = "stars") {
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
  const surgeRatio = priorAvg > 0 ? recentAvg / priorAvg : (recentAvg > 0 ? Infinity : 0);

  const isSurge = recentAvg > 0 && (
    (priorAvg > 0 && surgeRatio >= 1.8 && accel > 0) ||
    (priorAvg <= 0 && recentAvg >= 5)
  );

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
function computeDailyGrowth(snaps, field = "stars") {
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
      result.push({ date: recent[i].captured_at.slice(0, 10), growth: recent[i][field] - recent[i - 1][field] });
    }
  }
  return result;
}

/**
 * 近 7 天日均增长（比单次快照差值稳定）。
 * @returns {{ avg:number, days:number, samples:number } | null}
 */
const computeAvgDailyGrowth = (snaps, field = "stars") =>
  avgDailyGrowth(snaps, (s) => s[field]);

function computeGrowth(repoValue, snaps, now, window, field = "stars") {
  if (!snaps || snaps.length === 0) return { growth: null, label: "待积累", dailyGrowth: [], avgDaily: null, momentum: null };
  const cfg = windowOf(window);
  const windowStart = now - cfg.ms;

  let baseSnap = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (Date.parse(snaps[i].captured_at) <= windowStart) { baseSnap = snaps[i]; break; }
  }

  let growth = null, label = "待积累";
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
  return { growth, label, dailyGrowth: computeDailyGrowth(snaps, field), avgDaily: computeAvgDailyGrowth(snaps, field), momentum: computeMomentum(snaps, field) };
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
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  if (den === 0) return null;
  const slope = num / den;           // 星/天
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
function makeSort(sort, field = "stars") {
  switch (sort) {
    case "stars":   return (a, b) => b.stars - a.stars;
    case "metric":  return (a, b) => (b.metricValue ?? b[field] ?? 0) - (a.metricValue ?? a[field] ?? 0);
    case "newest":  return (a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at);
    case "name":    return (a, b) => a.full_name.localeCompare(b.full_name);
    case "language":return (a, b) => (a.language ?? "").localeCompare(b.language ?? "") || b.stars - a.stars;
    default:        return (a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity) || b.stars - a.stars;
  }
}

// ── 列表 ──────────────────────────────────────────────────────────
export function listRepos({
  minStars, minGrowth, language, sort, window,
  page = 1, pageSize = 50, todayOnly = false,
  keyword = "", onlyCustom = false, onlyFavorite = false,
  metric = "stars", userId = 0,
}) {
  const now = Date.now();
  const win = WINDOWS[window] ? window : "day";
  const metricDef = metricOf(metric);
  const field = metricDef.field;

  // 过滤下推到 SQL，避免把全表读进内存（关键词为大小写不敏感匹配）
  const kw = String(keyword || "").trim();
  const where = [];
  const params = [];
  if (minStars > 0) { where.push("stars >= ?"); params.push(minStars); }
  if (language) { where.push("language = ?"); params.push(language); }
  if (kw) {
    const like = `%${kw.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push("(full_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  let repoRows = db.prepare(`SELECT * FROM repos ${whereSql} ORDER BY stars DESC, id ASC`).all(...params);

  // 自定义仓库以 custom_repos 表为准（新增后无需等下一次刷新即可显示/筛选）
  const customSet = new Set(allCustomRepoNames(userId).map((c) => c.full_name));
  if (onlyCustom) repoRows = repoRows.filter((r) => customSet.has(r.full_name));

  let favSet = null;
  if (onlyFavorite) {
    favSet = new Set(db.prepare("SELECT repo_id FROM favorites WHERE user_id = ?").all(userId).map((f) => f.repo_id));
    repoRows = repoRows.filter((r) => favSet.has(r.id));
  }

  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });

  const out = repoRows.map((r) => {
    const snaps = snapMap.get(r.id) || [];
    const value = r[field] || 0;
    const { growth, label, dailyGrowth, avgDaily, momentum } = computeGrowth(value, snaps, now, win, field);
    return {
      id: r.id, full_name: r.full_name, name: r.name, owner: r.owner,
      url: r.url, description: r.description, language: r.language, homepage: r.homepage,
      stars: r.stars, forks: r.forks, open_issues: r.open_issues,
      metric, metricValue: value, metricNoun: metricDef.noun,
      growth, growthLabel: label, dailyGrowth,
      avgDailyGrowth: avgDaily ? Number(avgDaily.avg.toFixed(2)) : null,
      avgSampleDays: avgDaily ? Number(avgDaily.days.toFixed(2)) : null,
      momentum,
      first_seen_at: r.first_seen_at, is_custom: customSet.has(r.full_name),
      stale: Boolean(r.stale),
      is_favorite: favSet ? favSet.has(r.id) : undefined,
      spark: snaps.slice(-10).map((s) => ({ t: s.captured_at, stars: s[field] ?? s.stars })),
    };
  });

  const filtered = out.filter(
    (r) =>
      r.stars >= minStars &&
      (minGrowth <= 0 || (r.growth !== null && r.growth >= minGrowth)) &&
      (!language || r.language === language) &&
      (!todayOnly || (r.growth !== null && r.growth > 0))
  );

  filtered.sort(makeSort(sort, field));

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);

  return {
    repos: filtered.slice((p - 1) * pageSize, (p - 1) * pageSize + pageSize),
    total, page: p, pageSize, totalPages,
  };
}

export function listLanguages() {
  return db.prepare(
    `SELECT language, COUNT(*) c FROM repos
     WHERE language IS NOT NULL AND language != ''
     GROUP BY language ORDER BY c DESC, language ASC`
  ).all();
}

/**
 * 🏆 排行榜：同时返回「总星 Top N」与「日均增长 Top N」。
 * 日均增长用最近 7 天快照计算，比单次差值稳定。
 */
export function getLeaderboard({ limit = 10, window = "day", minStars = 0, metric = "stars" } = {}) {
  const now = Date.now();
  const win = WINDOWS[window] ? window : "day";
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  // 显式排序：不同后端行序不同，不排序会让并列名次的顺序随机
  const repoRows = minStars > 0
    ? db.prepare("SELECT * FROM repos WHERE stars >= ? ORDER BY id").all(minStars)
    : db.prepare("SELECT * FROM repos ORDER BY id").all();
  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });

  const rows = repoRows.map((r) => {
    const snaps = snapMap.get(r.id) || [];
    const value = r[field] || 0;
    const { growth, label, avgDaily } = computeGrowth(value, snaps, now, win, field);
    return {
      id: r.id, full_name: r.full_name, url: r.url, language: r.language,
      description: r.description, stars: r.stars, metricValue: value,
      growth, growthLabel: label,
      avgDailyGrowth: avgDaily ? Number(avgDaily.avg.toFixed(2)) : null,
      avgSampleDays: avgDaily ? Number(avgDaily.days.toFixed(2)) : null,
    };
  });

  // 并列时用 id 打破，保证 SQLite / PostgreSQL 给出相同结果
  const byStars = rows.slice().sort((a, b) => b.metricValue - a.metricValue || a.id - b.id).slice(0, limit);
  const byGrowth = rows
    .filter((r) => r.avgDailyGrowth !== null)
    .sort((a, b) => b.avgDailyGrowth - a.avgDailyGrowth || a.id - b.id)
    .slice(0, limit);

  const sampleDays = rows.reduce((m, r) => Math.max(m, r.avgSampleDays || 0), 0);
  return { byStars, byGrowth, limit, window, metric, metricLabel: metricDef.label, metricNoun: metricDef.noun, sampleDays: Number(sampleDays.toFixed(2)) };
}

/**
 * P0-1: 爆发榜 —— 按「增速加速度」排序，识别正在起飞的项目。
 */
export function getSurges({ limit = 10, minStars = 0, includeDecaying = false, metric = "stars" } = {}) {
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  const repoRows = minStars > 0
    ? db.prepare("SELECT id, full_name, url, language, stars FROM repos WHERE stars >= ?").all(minStars)
    : db.prepare("SELECT id, full_name, url, language, stars FROM repos").all();
  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });

  const rows = [];
  for (const r of repoRows) {
    const m = computeMomentum(snapMap.get(r.id) || [], field);
    if (!m) continue;
    if (!includeDecaying && !m.isSurge) continue;
    rows.push({
      id: r.id, full_name: r.full_name, url: r.url, language: r.language, stars: r.stars,
      ...m,
    });
  }

  rows.sort((a, b) => b.accel - a.accel);
  return { surges: rows.slice(0, limit), decaying: rows.filter((r) => r.accel < 0).slice(-limit).reverse(), metric, metricLabel: metricDef.label };
}

/**
 * P0-2: 历史回放 —— 重建「某一时刻」的榜单。
 * @param {string} at ISO 时间戳
 * @param {string} window 计算该时刻的增长所用窗口
 */
export function listReposAt({ at, window = "day", minStars = 0, sort = "stars", limit = 50, offset = 0 }) {
  const atMs = Date.parse(at);
  if (!Number.isFinite(atMs)) return { error: "无效的时间参数" };
  const cfg = windowOf(window);
  const atIso = new Date(atMs).toISOString();
  const baseIso = new Date(atMs - cfg.ms).toISOString();

  const nowMap = snapshotAtMap(atIso, "stars");
  const baseMap = snapshotAtMap(baseIso, "stars");
  if (nowMap.size === 0) return { error: "该时间点尚无快照数据", at: atIso };

  const repos = db.prepare("SELECT id, full_name, url, language, description, stars FROM repos").all();
  const out = [];
  for (const r of repos) {
    const starsAt = nowMap.get(r.id);
    if (starsAt == null) continue;                 // 当时还未收录
    if (starsAt < minStars) continue;
    const base = baseMap.get(r.id);
    const growth = base != null ? starsAt - base : null;
    out.push({
      id: r.id, full_name: r.full_name, url: r.url, language: r.language,
      description: r.description, stars: starsAt, currentStars: r.stars,
      growth, growthLabel: base != null ? cfg.label : "无基线",
      sinceThen: r.stars - starsAt,
    });
  }

  if (sort === "growth") out.sort((a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity) || b.stars - a.stars);
  else out.sort((a, b) => b.stars - a.stars);

  out.forEach((r, i) => { r.rank = i + 1; });
  const total = out.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    at: atIso, window, total, totalPages,
    repos: out.slice(offset, offset + limit),
  };
}

export function getLanguageTrends(window = "day") {
  const win = WINDOWS[window] ? window : "day";
  const baseMap = snapshotAtMap(isoOffset(WINDOWS[win].ms));
  const rows = db.prepare(
    `SELECT id, language, stars FROM repos
     WHERE language IS NOT NULL AND language != ''`
  ).all();

  const langMap = new Map();
  for (const r of rows) {
    const base = baseMap.get(r.id);
    const growth = r.stars - (base ?? r.stars);
    const e = langMap.get(r.language);
    if (e) { e.totalStars += r.stars; e.totalGrowth += growth; e.count += 1; }
    else langMap.set(r.language, { language: r.language, count: 1, totalStars: r.stars, totalGrowth: growth });
  }
  return Array.from(langMap.values())
    .sort((a, b) => b.totalGrowth - a.totalGrowth || b.totalStars - a.totalStars)
    .slice(0, 10);
}

/**
 * P1-5: 排名变化 —— 对比「当前」与「窗口前」的 star 排名
 */
export function getRankChanges(window = "day", limit = 20) {
  const win = WINDOWS[window] ? window : "day";

  // 当前排名
  const current = db.prepare(
    "SELECT id, full_name, stars, language FROM repos ORDER BY stars DESC"
  ).all();
  const currentRank = new Map(current.map((r, i) => [r.id, i + 1]));

  // 窗口前排名（单次窗口函数查询取每个仓库窗口前最近一次快照）
  const pastStars = snapshotAtMap(isoOffset(WINDOWS[win].ms), "stars");
  const pastRanked = current
    .filter((r) => pastStars.get(r.id) != null)
    .sort((a, b) => pastStars.get(b.id) - pastStars.get(a.id));
  const pastRank = new Map(pastRanked.map((r, i) => [r.id, i + 1]));
  const pastStarsById = new Map(pastRanked.map((r) => [r.id, pastStars.get(r.id)]));

  const changes = [];
  for (const r of current) {
    const p = pastRank.get(r.id);
    if (!p) continue;
    const c = currentRank.get(r.id);
    changes.push({
      id: r.id, full_name: r.full_name, stars: r.stars, language: r.language,
      rank: c, prevRank: p, delta: p - c,
      growth: r.stars - (pastStarsById.get(r.id) ?? r.stars),
    });
  }

  return {
    risers: changes.filter((c) => c.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, limit),
    fallers: changes.filter((c) => c.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, limit),
  };
}

/**
 * P2: 徽章数据（单个仓库，轻量查询）
 */
export function getBadgeData(fullName, window = "day") {
  const win = WINDOWS[window] ? window : "day";
  const r = db.prepare(
    "SELECT id, full_name, stars, forks, open_issues FROM repos WHERE full_name = ?"
  ).get(fullName);
  if (!r) return null;

  const snaps = db.prepare(
    "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC"
  ).all(r.id);

  const g = computeGrowth(r.stars, snaps, Date.now(), win, "stars");
  const gf = computeGrowth(r.forks, snaps, Date.now(), win, "forks");
  const gi = computeGrowth(r.open_issues, snaps, Date.now(), win, "open_issues");

  return {
    full_name: r.full_name,
    stars: r.stars, forks: r.forks, open_issues: r.open_issues,
    growth: g.growth, growthLabel: g.label,
    growthForks: gf.growth, growthIssues: gi.growth,
    ratio: r.forks > 0 ? Number((r.stars / r.forks).toFixed(1)) : null,
    snapshots: snaps.length,
  };
}

export function getRepoHistory(id, metric = "stars", userId = 0) {
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  const repo = db.prepare(
    "SELECT id, full_name, name, owner, url, description, language, homepage, stars, forks, open_issues, gh_created_at, first_seen_at, stale, stale_since, last_error FROM repos WHERE id = ?"
  ).get(id);
  if (!repo) return null;
  repo.is_custom = Boolean(searchCustomRepo(repo.full_name, userId));
  const rows = db.prepare(
    "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC"
  ).all(id);
  // 历史序列按指标投影（保持 {stars, captured_at} 兼容结构）
  const history = rows.map((s) => ({ stars: s[field] ?? s.stars, captured_at: s.captured_at }));

  // 时间线事件：里程碑 + 告警（用于在历史曲线上标注）
  const events = [];
  let prevStars = null;
  for (const s of rows) {
    if (prevStars != null) {
      const crossed = MILESTONES.find((m) => prevStars < m && s.stars >= m);
      if (crossed) {
        events.push({
          date: s.captured_at, type: "milestone",
          label: `${compactStars(crossed)} \u2605`,
          message: `突破 ${crossed.toLocaleString("en-US")} 星`,
        });
      }
    }
    prevStars = s.stars;
  }
  for (const a of db.prepare(
    "SELECT kind, growth, triggered_at, message FROM alerts WHERE repo_id = ? ORDER BY triggered_at ASC"
  ).all(id)) {
    events.push({
      date: a.triggered_at,
      type: a.kind,
      label: a.kind === "milestone" ? "\u{1F3C1}" : a.kind === "drop" ? `-${Math.abs(a.growth)}` : `+${a.growth}`,
      message: a.message || (a.kind === "drop" ? `掉星 ${Math.abs(a.growth)}` : `新增 ${a.growth} 星`),
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date));

  return {
    repo,
    metric,
    metricLabel: metricDef.label,
    history,
    events,
    series: {
      stars: rows.map((s) => ({ stars: s.stars, captured_at: s.captured_at })),
      forks: rows.map((s) => ({ stars: s.forks, captured_at: s.captured_at })),
      issues: rows.map((s) => ({ stars: s.open_issues, captured_at: s.captured_at })),
    },
    dailyGrowth: computeDailyGrowth(history, "stars"),
    prediction: predictGrowth(history),
  };
}

/**
 * C1: 多仓库对比 —— 返回各仓库按天聚合的指标序列（含百分比变化），用于叠加对比。
 */
export function compareRepos({ ids = [], window = "day", metric = "stars", maxPoints = 90 } = {}) {
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  const win = WINDOWS[window] ? window : "day";
  const repos = [];

  for (const rawId of ids) {
    const id = Number(rawId);
    if (!Number.isInteger(id)) continue;
    const repo = db.prepare(
      "SELECT id, full_name, url, language, description, stars, forks, open_issues FROM repos WHERE id = ?"
    ).get(id);
    if (!repo) continue;

    const rows = db.prepare(
      "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC"
    ).all(id);
    const days = dailyAggregate(rows).slice(-maxPoints);
    const series = days.map((s) => ({ t: s.captured_at.slice(0, 10), value: s[field] ?? s.stars }));
    const first = series.length ? series[0].value : null;
    const last = series.length ? series[series.length - 1].value : null;
    // 星数趋势斜率（用于交叉预测）
    const pred = predictGrowth(rows);

    repos.push({
      id: repo.id,
      full_name: repo.full_name,
      url: repo.url,
      language: repo.language,
      description: repo.description,
      stars: repo.stars,
      current: repo[field] ?? repo.stars,
      snapshots: rows.length,
      slope: pred ? pred.perDay : null,
      r2: pred ? pred.r2 : null,
      change: first != null && last != null ? last - first : null,
      changePct: first ? Number((((last - first) / first) * 100).toFixed(2)) : null,
      series: series.map((p) => ({
        t: p.t,
        value: p.value,
        pct: first ? Number((((p.value - first) / first) * 100).toFixed(2)) : 0,
      })),
    });
  }

  // x 轴并集（所有仓库出现过的日期）
  const dates = Array.from(new Set(repos.flatMap((r) => r.series.map((p) => p.t)))).sort();
  return { window: win, metric, metricLabel: metricDef.label, dates, repos, crossings: computeCrossings(repos) };
}

/**
 * 交叉预测：星数较低但增速更快的仓库何时超过另一个。
 * 仅当两者斜率差为正、预测天数在 10 年内时给出。
 */
function computeCrossings(repos, { maxDays = 3650, limit = 6 } = {}) {
  const out = [];
  for (const a of repos) {
    for (const b of repos) {
      if (a.id === b.id) continue;
      if (a.slope == null || b.slope == null) continue;
      if (a.current >= b.current) continue;      // 只看后来者超前者
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

/**
 * C2: 全局趋势 —— 收录/快照活动、每日总星数、数据健康度。
 */
export function getOverview({ days = 60, userId = 0 } = {}) {
  const d = Math.min(365, Math.max(7, Number(days) || 60));
  const since = isoOffset(d * 86400000);

  const discoveries = db.prepare(
    `SELECT substr(first_seen_at, 1, 10) AS date, COUNT(*) AS count
     FROM repos WHERE first_seen_at >= ? GROUP BY date ORDER BY date`
  ).all(since);

  const snapshotActivity = db.prepare(
    `SELECT substr(captured_at, 1, 10) AS date, COUNT(*) AS count
     FROM snapshots WHERE captured_at >= ? GROUP BY date ORDER BY date`
  ).all(since);

  // 每日总星数：每个仓库当天最后一条快照之和
  const totalStars = db.prepare(
    `SELECT date, SUM(stars) AS "totalStars" FROM (
       SELECT repo_id, substr(captured_at, 1, 10) AS date, stars,
              ROW_NUMBER() OVER (PARTITION BY repo_id, substr(captured_at, 1, 10) ORDER BY captured_at DESC) AS rn
       FROM snapshots WHERE captured_at >= ?
     ) AS sq WHERE rn = 1 GROUP BY date ORDER BY date`
  ).all(since);

  const totalRepos = db.prepare("SELECT COUNT(*) c FROM repos").get().c;
  const covered = db.prepare(
    "SELECT COUNT(*) c FROM (SELECT repo_id FROM snapshots GROUP BY repo_id HAVING COUNT(*) >= 2) AS sq"
  ).get().c;
  const avgSnaps = db.prepare("SELECT AVG(c) a FROM (SELECT COUNT(*) c FROM snapshots GROUP BY repo_id) AS sq").get().a;
  const oldest = db.prepare("SELECT MIN(captured_at) t FROM snapshots").get().t;
  const stats = getStats(userId);

  return {
    days: d,
    discoveries,
    snapshotActivity,
    totalStars,
    languages: listLanguages().slice(0, 8),
    health: {
      totalRepos,
      covered,
      coveragePct: totalRepos ? Math.round((covered / totalRepos) * 100) : 0,
      avgSnapshots: avgSnaps ? Number(avgSnaps.toFixed(1)) : 0,
      oldestSnapshot: oldest,
      lastRefresh: stats.lastRefresh,
      snapCount: stats.snapCount,
      staleCount: stats.staleCount,
    },
    totals: { repoCount: stats.repoCount, snapCount: stats.snapCount, favoriteCount: stats.favoriteCount },
  };
}

// ── C4: 相似仓库推荐（语言 + 描述词袋余弦）────────────────────────
const SIMILAR_STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "your", "you", "are", "its", "it's",
  "library", "framework", "tool", "tools", "app", "application", "using", "use", "used", "based",
  "simple", "fast", "easy", "lightweight", "modern", "build", "built", "code", "project", "open",
  "source", "github", "https", "http", "www", "com", "org", "a", "an", "of", "to", "in", "on",
]);

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9+#.]+/g) || [])
    .map((w) => w.replace(/^\.+|\.+$/g, ""))
    .filter((w) => w.length > 2 && !SIMILAR_STOPWORDS.has(w));
}

function cosine(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter++;
  return inter / Math.sqrt(setA.size * setB.size);
}

/**
 * C4: 找出与目标仓库相似的仓库（同语言 + 描述相似度）。
 * @returns {{repo:string, similar:Array} | null}
 */
export function findSimilarRepos(id, { limit = 6 } = {}) {
  const target = db.prepare("SELECT id, full_name, language, description FROM repos WHERE id = ?").get(id);
  if (!target) return null;
  const lim = Math.min(20, Math.max(1, Number(limit) || 6));
  const targetTokens = new Set(tokenize(target.description));

  const candidates = db.prepare(
    "SELECT id, full_name, url, language, description, stars FROM repos WHERE id != ?"
  ).all(id);

  const scored = [];
  for (const r of candidates) {
    const sameLang = target.language && r.language === target.language;
    const sim = cosine(targetTokens, new Set(tokenize(r.description)));
    const score = (sameLang ? 1 : 0) + 2 * sim;
    if (score < 0.8) continue;
    scored.push({
      id: r.id, full_name: r.full_name, url: r.url, language: r.language,
      description: r.description, stars: r.stars,
      reason: sameLang && sim > 0 ? "同语言·描述相近" : sameLang ? "同语言" : "描述相近",
      score: Number(score.toFixed(3)),
    });
  }

  scored.sort((a, b) => b.score - a.score || b.stars - a.stars);
  return { repo: target.full_name, similar: scored.slice(0, lim) };
}

/**
 * 异常检测：对每个仓库的「日增序列」做 z-score（相对自身历史）。
 * 比固定阈值更抗噪：能区分「本来就热」和「突然被引爆」。
 * 必须同时返回 samples/sd，避免样本不足时过度自信。
 */
export function getAnomalies({ days = 30, z = 2.5, limit = 12, minSamples = 5, minStars = 0 } = {}) {
  const lookback = Math.min(120, Math.max(5, Number(days) || 30));
  const threshold = Math.max(1, Number(z) || 2.5);
  const minN = Math.max(3, Number(minSamples) || 5);
  const lim = Math.min(50, Math.max(1, Number(limit) || 12));

  const repoRows = Number(minStars) > 0
    ? db.prepare("SELECT id, full_name, url, language, stars FROM repos WHERE stars >= ?").all(minStars)
    : db.prepare("SELECT id, full_name, url, language, stars FROM repos").all();
  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });

  const rows = [];
  for (const r of repoRows) {
    const daysArr = dailyAggregate(snapMap.get(r.id) || []).slice(-(lookback + 1));
    if (daysArr.length < minN + 1) continue;

    const deltas = [];
    for (let i = 1; i < daysArr.length; i++) {
      deltas.push({ date: daysArr[i].captured_at.slice(0, 10), d: daysArr[i].stars - daysArr[i - 1].stars });
    }
    if (deltas.length < minN + 1) continue;

    const history = deltas.slice(0, -1);
    const latest = deltas[deltas.length - 1];
    const mean = history.reduce((a, x) => a + x.d, 0) / history.length;
    const sd = Math.sqrt(history.reduce((a, x) => a + (x.d - mean) ** 2, 0) / history.length);
    if (!(sd > 0)) continue;

    const zScore = (latest.d - mean) / sd;
    if (Math.abs(zScore) < threshold) continue;
    rows.push({
      id: r.id, full_name: r.full_name, url: r.url, language: r.language, stars: r.stars,
      date: latest.date, delta: latest.d, mean: Number(mean.toFixed(2)), sd: Number(sd.toFixed(2)),
      z: Number(zScore.toFixed(2)), samples: history.length,
      direction: zScore > 0 ? "spike" : "drop",
    });
  }

  rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return {
    days: lookback, z: threshold, minSamples: minN,
    spikes: rows.filter((r) => r.direction === "spike").slice(0, lim),
    drops: rows.filter((r) => r.direction === "drop").slice(0, lim),
  };
}

/**
 * 黑马榜：低星但高「日增百分比」的项目（用 maxStars 截断规模影响）。
 */
export function getRisingStars({ limit = 15, maxStars = 0, minDays = 14, minStars = 100 } = {}) {
  const floor = Math.max(0, Number(minStars) || 0);
  const minAge = Math.max(0, Number(minDays) || 14);

  // maxStars <= 0 时自动取「追踪集星数中位数」作为上限，
  // 否则当抓取范围只覆盖头部仓库时（例如最低星数 6 万），固定阈值会把榜单筛空。
  let cap = Number(maxStars);
  if (!Number.isFinite(cap) || cap <= 0) {
    const row = db.prepare(
      "SELECT stars FROM repos ORDER BY stars ASC LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM repos)"
    ).get();
    cap = row ? row.stars : Number.MAX_SAFE_INTEGER;
  }

  const repoRows = db.prepare(
    "SELECT id, full_name, url, language, stars, gh_created_at, first_seen_at FROM repos WHERE stars <= ? AND stars >= ?"
  ).all(cap, floor);
  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });
  const now = Date.now();

  const rows = [];
  for (const r of repoRows) {
    const avg = avgDailyGrowth(snapMap.get(r.id) || [], (s) => s.stars);
    if (!avg || !(avg.avg > 0) || avg.days < 1) continue;

    const created = Date.parse(r.gh_created_at || r.first_seen_at);
    const ageDays = Number.isFinite(created) ? Math.max(1, Math.round((now - created) / 86400000)) : null;
    if (ageDays != null && ageDays < minAge) continue;

    rows.push({
      id: r.id, full_name: r.full_name, url: r.url, language: r.language, stars: r.stars,
      avgDailyGrowth: Number(avg.avg.toFixed(2)),
      sampleDays: Number(avg.days.toFixed(2)),
      ageDays,
      pctPerDay: Number(((avg.avg / Math.max(1, r.stars)) * 100).toFixed(3)),
    });
  }

  rows.sort((a, b) => b.pctPerDay - a.pctPerDay || b.avgDailyGrowth - a.avgDailyGrowth);
  return { maxStars: cap, minDays: minAge, minStars: floor, rising: rows.slice(0, Math.min(50, Math.max(1, Number(limit) || 15))) };
}

/** 迷你走势图数据（最近 N 条快照） */
export function getSparkData(fullName, points = 30, metric = "stars") {
  const metricDef = metricOf(metric);
  const r = db.prepare("SELECT id, full_name, stars FROM repos WHERE full_name = ?").get(fullName);
  if (!r) return null;
  const n = Math.min(120, Math.max(2, Number(points) || 30));
  const rows = db.prepare(
    "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at DESC LIMIT ?"
  ).all(r.id, n);
  return {
    full_name: r.full_name,
    metric,
    current: r.stars,
    values: rows.reverse().map((s) => s[metricDef.field] ?? s.stars),
  };
}

/**
 * 事件聚类：把「同一天多个仓库同时异常」识别为一波趋势。
 * 每天对每个仓库做 leave-one-out 的 z-score（用除当天外的日增算均值/标准差），
 * 当某天异常仓库数 ≥ minRepos 时归为一个事件，并用语言/描述共同词自动命名。
 */
export function getEvents({ days = 30, z = 2, minRepos = 3, minSamples = 4, minStars = 0, limit = 12 } = {}) {
  const lookback = Math.min(120, Math.max(5, Number(days) || 30));
  const zt = Math.max(1, Number(z) || 2);
  const minGroup = Math.max(2, Number(minRepos) || 3);
  const minN = Math.max(3, Number(minSamples) || 4);

  const repoRows = Number(minStars) > 0
    ? db.prepare("SELECT id, full_name, url, language, description FROM repos WHERE stars >= ?").all(minStars)
    : db.prepare("SELECT id, full_name, url, language, description FROM repos").all();
  const snapMap = loadSnapshotMap({ days: lookback, perRepo: lookback + 5, repoIds: repoRows.map((r) => r.id) });
  const byDate = new Map();

  for (const r of repoRows) {
    const daysArr = dailyAggregate(snapMap.get(r.id) || []);
    if (daysArr.length < minN + 1) continue;

    const deltas = [];
    for (let i = 1; i < daysArr.length; i++) {
      deltas.push({ date: daysArr[i].captured_at.slice(0, 10), d: daysArr[i].stars - daysArr[i - 1].stars });
    }
    if (deltas.length < minN + 1) continue;

    let sum = 0, sumSq = 0;
    for (const x of deltas) { sum += x.d; sumSq += x.d * x.d; }
    const n = deltas.length;

    for (const cur of deltas) {
      if (cur.d <= 0) continue;
      const m = (sum - cur.d) / (n - 1);
      const sd = Math.sqrt(Math.max(0, (sumSq - cur.d * cur.d) / (n - 1) - m * m));
      if (!(sd > 0)) continue;
      const zs = (cur.d - m) / sd;
      if (zs < zt) continue;
      let arr = byDate.get(cur.date);
      if (!arr) { arr = []; byDate.set(cur.date, arr); }
      arr.push({
        id: r.id, full_name: r.full_name, url: r.url, language: r.language,
        description: r.description, delta: cur.d, z: Number(zs.toFixed(2)),
      });
    }
  }

  const events = [];
  for (const [date, members] of byDate) {
    if (members.length < minGroup) continue;
    members.sort((a, b) => b.delta - a.delta);

    const langCount = new Map();
    for (const m of members) if (m.language) langCount.set(m.language, (langCount.get(m.language) || 0) + 1);
    const dominantLanguage = [...langCount.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // 共同词：出现在一半以上成员描述里的词
    const termCount = new Map();
    for (const m of members) {
      for (const t of new Set(tokenize(m.description))) termCount.set(t, (termCount.get(t) || 0) + 1);
    }
    const thresholdCount = Math.ceil(members.length / 2);
    const terms = [...termCount.entries()]
      .filter(([, c]) => c >= thresholdCount)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([t]) => t);

    events.push({
      date,
      count: members.length,
      totalDelta: members.reduce((a, m) => a + m.delta, 0),
      avgZ: Number((members.reduce((a, m) => a + m.z, 0) / members.length).toFixed(2)),
      dominantLanguage,
      terms,
      repos: members.slice(0, 20).map(({ description, ...rest }) => rest),
    });
  }

  events.sort((a, b) => b.date.localeCompare(a.date) || b.count - a.count);
  return { days: lookback, z: zt, minRepos: minGroup, minSamples: minN, events: events.slice(0, Math.min(50, Math.max(1, Number(limit) || 12))) };
}

/**
 * 告警规则回测：用历史快照重放，统计给定规则会触发多少次。
 * 与生产逻辑共用 evaluateAlertRules()，保证「回测结果 = 实际会发生的告警」。
 */
export function backtestAlerts({
  days = 90, threshold, dropThreshold, alertOnDrop, alertOnMilestone,
  minStars = 0, maxFires = 200,
} = {}) {
  const lookback = Math.min(365, Math.max(7, Number(days) || 90));
  let repoThresholds = {};
  try { repoThresholds = JSON.parse(getSetting("repoThresholds", "{}") || "{}") || {}; } catch { repoThresholds = {}; }

  const cfg = {
    threshold: Math.max(0, Number(threshold ?? getSetting("alertThreshold", 50)) || 0),
    repoThresholds,
    alertOnDrop: alertOnDrop ?? (getSetting("alertOnDrop", "0") === "1"),
    dropThreshold: Math.max(0, Number(dropThreshold ?? getSetting("dropThreshold", 50)) || 0),
    alertOnMilestone: alertOnMilestone ?? (getSetting("alertOnMilestone", "0") === "1"),
  };

  const repoRows = Number(minStars) > 0
    ? db.prepare("SELECT id, full_name FROM repos WHERE stars >= ?").all(minStars)
    : db.prepare("SELECT id, full_name FROM repos").all();
  const snapMap = loadSnapshotMap({ days: lookback, perRepo: lookback + 5, repoIds: repoRows.map((r) => r.id) });
  const since = isoOffset(lookback * 86400000);

  const fires = [];
  let sampleDaysTotal = 0, evaluatedRepos = 0;

  for (const r of repoRows) {
    const daysArr = dailyAggregate(snapMap.get(r.id) || []).filter((d) => d.captured_at >= since);
    if (daysArr.length < 2) continue;
    evaluatedRepos++;
    sampleDaysTotal += daysArr.length;

    for (let i = 1; i < daysArr.length; i++) {
      const prev = daysArr[i - 1].stars;
      const cur = daysArr[i].stars;
      const alerts = evaluateAlertRules({ fullName: r.full_name, repoStars: cur, baseStars: prev, prevStars: prev, cfg });
      for (const a of alerts) {
        fires.push({
          date: daysArr[i].captured_at.slice(0, 10),
          id: r.id, full_name: r.full_name, kind: a.kind,
          growth: a.growth, stars: cur, threshold: a.threshold,
          message: a.message || null,
        });
      }
    }
  }

  const byKind = { growth: 0, drop: 0, milestone: 0 };
  const byRepo = new Map();
  for (const f of fires) {
    byKind[f.kind] = (byKind[f.kind] || 0) + 1;
    byRepo.set(f.full_name, (byRepo.get(f.full_name) || 0) + 1);
  }

  fires.sort((a, b) => b.date.localeCompare(a.date));
  return {
    days: lookback,
    rules: cfg,
    summary: {
      total: fires.length,
      byKind,
      repos: byRepo.size,
      evaluatedRepos,
      avgSampleDays: evaluatedRepos ? Number((sampleDaysTotal / evaluatedRepos).toFixed(1)) : 0,
    },
    topRepos: [...byRepo.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([full_name, count]) => ({ full_name, count })),
    fired: fires.slice(0, Math.min(500, Math.max(1, Number(maxFires) || 200))),
  };
}

/**
 * P4: 解析指数成员（用本地筛选条件，无需联网）。
 */
export function resolveIndexMembers(spec = {}) {
  const where = [];
  const params = [];
  const minStars = Number(spec.minStars);
  const maxStars = Number(spec.maxStars);
  if (Number.isFinite(minStars) && minStars > 0) { where.push("stars >= ?"); params.push(minStars); }
  if (Number.isFinite(maxStars) && maxStars > 0) { where.push("stars <= ?"); params.push(maxStars); }
  if (spec.language) { where.push("language = ?"); params.push(String(spec.language)); }
  if (spec.keyword) {
    const like = `%${String(spec.keyword).replace(/[\\%_]/g, (c) => "\\" + c)}%`;
    where.push("(full_name LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')");
    params.push(like, like, like);
  }
  const sql = `SELECT id, full_name, url, language, stars FROM repos
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY stars DESC LIMIT 500`;
  return db.prepare(sql).all(...params);
}

/**
 * 由一组仓库合成一条指数曲线。
 * - weight="equal"：每个仓库先归一到自身起点=100，再等权平均（对成员增减更稳健）
 * - weight="cap"：所有仓库星数求和后归一到首日=100（市值加权）
 * 缺失日期用最近一次已知值前向填充，避免曲线出现假阶跃。
 */
function computeAggregateSeries(repoIds, { days = 90, weight = "equal" } = {}) {
  const ids = [...new Set(repoIds.filter(Number.isInteger))];
  if (!ids.length) {
    return { dates: [], index: [], total: [], memberCount: 0, starsNow: 0, changePct: null, members: [], weight: "equal" };
  }

  const snapMap = loadSnapshotMap({ days, perRepo: days + 5, repoIds: ids });
  const seriesById = new Map();
  const allDates = new Set();
  for (const id of ids) {
    const m = new Map();
    for (const d of dailyAggregate(snapMap.get(id) || [])) {
      const k = d.captured_at.slice(0, 10);
      m.set(k, d.stars);
      allDates.add(k);
    }
    seriesById.set(id, m);
  }

  const dates = [...allDates].sort();
  const first = new Map();
  const last = new Map();
  const perRepoIdx = new Map(ids.map((id) => [id, []]));
  const total = [];

  for (const date of dates) {
    let sum = 0;
    for (const id of ids) {
      const v = seriesById.get(id).get(date);
      if (v != null) { last.set(id, v); if (!first.has(id)) first.set(id, v); }
      const cur = last.get(id);
      const base = first.get(id);
      perRepoIdx.get(id).push(cur == null ? null : (base ? (cur / base) * 100 : 100));
      if (cur != null) sum += cur;
    }
    total.push(sum);
  }

  let index;
  if (weight === "cap") {
    const base = total[0] || 0;
    index = total.map((v) => (base ? Number(((v / base) * 100).toFixed(2)) : 0));
  } else {
    index = dates.map((_, i) => {
      let s = 0, n = 0;
      for (const id of ids) {
        const v = perRepoIdx.get(id)[i];
        if (v != null) { s += v; n++; }
      }
      return n ? Number((s / n).toFixed(2)) : null;
    });
  }

  // 成员明细（一次分块查询，避免 N+1）
  const rows = [];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    rows.push(...db.prepare(
      `SELECT id, full_name, url, language, stars FROM repos WHERE id IN (${chunk.map(() => "?").join(",")})`
    ).all(...chunk));
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const members = ids.map((id) => {
    const row = rowById.get(id);
    if (!row) return null;
    const f = first.get(id), l = last.get(id);
    return {
      id, full_name: row.full_name, url: row.url, language: row.language,
      current: row.stars,
      change: f != null && l != null ? l - f : null,
      changePct: f ? Number((((l - f) / f) * 100).toFixed(2)) : null,
    };
  }).filter(Boolean);

  const starsNow = members.reduce((a, m) => a + (m.current || 0), 0);
  for (const m of members) m.sharePct = starsNow ? Number(((m.current / starsNow) * 100).toFixed(2)) : 0;
  members.sort((a, b) => b.current - a.current);

  const idxVals = index.filter((v) => v != null);
  const firstIdx = idxVals.length ? idxVals[0] : null;
  const lastIdx = idxVals.length ? idxVals[idxVals.length - 1] : null;

  return {
    dates, index, total,
    memberCount: members.length,
    starsNow,
    changePct: firstIdx ? Number((((lastIdx - firstIdx) / firstIdx) * 100).toFixed(2)) : null,
    members,
    weight: weight === "cap" ? "cap" : "equal",
  };
}

/** P4: 指数（本地筛选条件聚合） */
export function getIndexSeries(id, { days = 90, weight = "equal", userId = 0 } = {}) {
  const idx = getIndex(id);
  if (!idx || idx.user_id !== userId) return null;
  const members = resolveIndexMembers(idx.spec);
  return {
    id: idx.id, name: idx.name, spec: idx.spec, created_at: idx.created_at,
    ...computeAggregateSeries(members.map((m) => m.id), { days, weight }),
  };
}

/** P4: 生态 / topic 追踪聚合 */
export function getQueryAggregate(id, { days = 90, weight = "equal", userId = 0 } = {}) {
  const q = getTrackedQuery(id);
  if (!q || q.user_id !== userId) return null;
  return {
    id: q.id, label: q.label, query: q.query,
    member_count: q.member_count, last_run_at: q.last_run_at,
    ...computeAggregateSeries(getQueryMemberIds(id), { days, weight }),
  };
}

const lastSnapStmt = db.prepare("SELECT stars, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at DESC LIMIT 1");

/** 同一天且星数未变则不重复写快照（tracked query 可能与热门榜重叠） */
function shouldSnapshot(repoId, stars, now) {
  const last = lastSnapStmt.get(repoId);
  if (!last) return true;
  return !(last.stars === stars && last.captured_at.slice(0, 10) === now.slice(0, 10));
}

/**
 * P4: 刷新所有被追踪的搜索/topic，并把结果写入成员表。
 * 每个查询只取 1 页（最多 100 个仓库），避免破坏搜索配额。
 */
export async function refreshTrackedQueries({ token, perQuery = 100 } = {}) {
  const queries = listTrackedQueries();
  let updated = 0, members = 0;

  for (const q of queries) {
    try {
      const { items } = await searchTopRepos({
        token, query: q.query, maxPages: 1, perPage: Math.min(100, Math.max(1, Number(perQuery) || 100)),
      });
      const now = new Date().toISOString();
      const idMap = getRepoIdMap(items.map((r) => r.full_name));
      const ids = [];

      db.exec("BEGIN");
      try {
        for (const r of items) {
          upsertRepo.run(r.full_name, r.owner, r.name, r.url, r.description, r.language, r.homepage, r.stars, r.forks || 0, r.open_issues || 0, r.gh_created_at, 0);
          const id = idMap.get(r.full_name) ?? db.prepare("SELECT id FROM repos WHERE full_name = ?").get(r.full_name)?.id;
          if (!id) continue;
          if (shouldSnapshot(id, r.stars, now)) insertSnapshot.run(id, r.stars, r.forks || 0, r.open_issues || 0, now);
          ids.push(id);
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }

      replaceQueryMembers(q.id, ids, now);
      updated++;
      members += ids.length;
      await sleep(150);
    } catch (e) {
      console.error(`[query] 抓取「${q.label}」失败:`, e.message);
    }
  }

  return { queries: queries.length, updated, members };
}

export function getStats(userId = 0) {
  // 单次查询汇总，避免多次往返；pendingGrowth 用索引友好的相关计数
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM repos) AS "repoCount",
      (SELECT COUNT(*) FROM custom_repos WHERE user_id = ?) AS "customCount",
      (SELECT COUNT(*) FROM favorites WHERE user_id = ?) AS "favoriteCount",
      (SELECT COUNT(*) FROM snapshots) AS "snapCount",
      (SELECT COUNT(*) FROM repos WHERE stale = 1) AS "staleCount",
      (SELECT MAX(captured_at) FROM snapshots) AS "lastRefresh",
      (SELECT COUNT(*) FROM repos r
        WHERE (SELECT COUNT(*) FROM snapshots s WHERE s.repo_id = r.id) < 2) AS "pendingGrowth"
  `).get(userId, userId);
  return {
    repoCount: row.repoCount,
    customCount: row.customCount,
    customRepoCount: row.customCount,
    snapCount: row.snapCount,
    staleCount: row.staleCount,
    lastRefresh: row.lastRefresh,
    pendingGrowth: row.pendingGrowth,
    favoriteCount: row.favoriteCount,
  };
}
