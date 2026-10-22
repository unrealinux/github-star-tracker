/**
 * 快照读取层 —— 有界加载、时点查询、窗口基线、按天聚合。
 * 统一在这里约束「最大读多少」：避免任何分析路径悄悄把全表快照拉进内存。
 */
import { db } from "./db.js";
import { WINDOWS, isoOffset } from "./windows.js";

// 快照查询上限：只取最近 35 天、每仓库最多 400 条，避免全表加载
const SNAPSHOT_WINDOW_DAYS = 35;
const SNAPSHOT_PER_REPO_CAP = 400;

/** P0-2: 有界快照加载（时间窗 + 每仓库上限），替代全表扫描。
 * 可传入 repoIds 只加载相关仓库，避免全库快照进入内存。*/
export function loadSnapshotMap({
  days = SNAPSHOT_WINDOW_DAYS,
  perRepo = SNAPSHOT_PER_REPO_CAP,
  repoIds = null,
} = {}) {
  if (repoIds && repoIds.length === 0) return new Map();
  const since = isoOffset(days * 86400000);
  const map = new Map();
  const collect = (rows) => {
    for (const s of rows) {
      let arr = map.get(s.repo_id);
      if (!arr) {
        arr = [];
        map.set(s.repo_id, arr);
      }
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
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(chunk.length, stmt);
    }
    collect(stmt.all(since, ...chunk, perRepo));
  }
  return map;
}

/** 只取每个仓库最近 N 条快照（用于告警基线），极度轻量 */
export function loadRecentSnapshotMap(perRepo = 2) {
  const rows = db
    .prepare(
      `
    SELECT repo_id, stars, forks, open_issues, captured_at FROM (
      SELECT repo_id, stars, forks, open_issues, captured_at,
             ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY captured_at DESC) AS rn
      FROM snapshots
    ) AS sq WHERE rn <= ?
    ORDER BY repo_id ASC, captured_at ASC
  `,
    )
    .all(perRepo);

  const map = new Map();
  for (const s of rows) {
    let arr = map.get(s.repo_id);
    if (!arr) {
      arr = [];
      map.set(s.repo_id, arr);
    }
    arr.push(s);
  }
  return map;
}

const SNAPSHOT_FIELDS = new Set(["stars", "forks", "open_issues"]);

/** 某一时刻（ISO）每个仓库最近一次的指标值（单次窗口函数查询，替代 N 个相关子查询） */
export function snapshotAtMap(iso, field = "stars") {
  const col = SNAPSHOT_FIELDS.has(field) ? field : "stars";
  const rows = db
    .prepare(
      `
    SELECT repo_id, val FROM (
      SELECT repo_id, ${col} AS val,
             ROW_NUMBER() OVER (PARTITION BY repo_id ORDER BY captured_at DESC) AS rn
      FROM snapshots WHERE captured_at <= ?
    ) AS sq WHERE rn = 1
  `,
    )
    .all(iso);
  return new Map(rows.map((r) => [r.repo_id, r.val]));
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
    if (Date.parse(snaps[i].captured_at) <= windowStart) {
      snap = snaps[i];
      break;
    }
  }
  // 窗口内没有基准（快照都太新）：退回相邻快照，此时跨度不足一天
  if (snap === null) snap = snaps[snaps.length - 2];

  return { snap, days: Math.max(1, (now - Date.parse(snap.captured_at)) / 86400000) };
}

/** 按天聚合：每天取最后一条快照 */
export function dailyAggregate(snaps) {
  const dayMap = new Map();
  for (const s of snaps) {
    const k = s.captured_at.slice(0, 10);
    const cur = dayMap.get(k);
    if (!cur || s.captured_at > cur.captured_at) dayMap.set(k, s);
  }
  return Array.from(dayMap.values()).sort((a, b) => a.captured_at.localeCompare(b.captured_at));
}
