/**
 * 指数 / 生态聚合层 —— 用「一组仓库」合成归一化曲线、成员增长榜。
 * 依赖 analysis 里的排行榜口径（getQueryMemberGrowth 复用 getLeaderboard）。
 */
import { db, getIndex, getTrackedQuery, getQueryMemberIds } from "./db.js";
import { dailyAggregate, loadSnapshotMap } from "./snapshots.js";
import { getLeaderboard } from "./analytics.js";

/**
 * P4: 解析指数成员（用本地筛选条件，无需联网）。
 */
export function resolveIndexMembers(spec = {}) {
  const where = [];
  const params = [];
  const minStars = Number(spec.minStars);
  const maxStars = Number(spec.maxStars);
  if (Number.isFinite(minStars) && minStars > 0) {
    where.push("stars >= ?");
    params.push(minStars);
  }
  if (Number.isFinite(maxStars) && maxStars > 0) {
    where.push("stars <= ?");
    params.push(maxStars);
  }
  if (spec.language) {
    where.push("language = ?");
    params.push(String(spec.language));
  }
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
    return {
      dates: [],
      index: [],
      total: [],
      memberCount: 0,
      starsNow: 0,
      changePct: null,
      members: [],
      weight: "equal",
    };
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
      if (v != null) {
        last.set(id, v);
        if (!first.has(id)) first.set(id, v);
      }
      const cur = last.get(id);
      const base = first.get(id);
      perRepoIdx.get(id).push(cur == null ? null : base ? (cur / base) * 100 : 100);
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
      let s = 0,
        n = 0;
      for (const id of ids) {
        const v = perRepoIdx.get(id)[i];
        if (v != null) {
          s += v;
          n++;
        }
      }
      return n ? Number((s / n).toFixed(2)) : null;
    });
  }

  // 成员明细（一次分块查询，避免 N+1）
  const rows = [];
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    rows.push(
      ...db
        .prepare(
          `SELECT id, full_name, url, language, stars FROM repos WHERE id IN (${chunk.map(() => "?").join(",")})`,
        )
        .all(...chunk),
    );
  }
  const rowById = new Map(rows.map((r) => [r.id, r]));

  const members = ids
    .map((id) => {
      const row = rowById.get(id);
      if (!row) return null;
      const f = first.get(id),
        l = last.get(id);
      return {
        id,
        full_name: row.full_name,
        url: row.url,
        language: row.language,
        current: row.stars,
        change: f != null && l != null ? l - f : null,
        changePct: f ? Number((((l - f) / f) * 100).toFixed(2)) : null,
      };
    })
    .filter(Boolean);

  const starsNow = members.reduce((a, m) => a + (m.current || 0), 0);
  for (const m of members) m.sharePct = starsNow ? Number(((m.current / starsNow) * 100).toFixed(2)) : 0;
  members.sort((a, b) => b.current - a.current);

  const idxVals = index.filter((v) => v != null);
  const firstIdx = idxVals.length ? idxVals[0] : null;
  const lastIdx = idxVals.length ? idxVals[idxVals.length - 1] : null;

  return {
    dates,
    index,
    total,
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
    id: idx.id,
    name: idx.name,
    spec: idx.spec,
    created_at: idx.created_at,
    ...computeAggregateSeries(
      members.map((m) => m.id),
      { days, weight },
    ),
  };
}

/** P4: 生态 / topic 追踪聚合 */
export function getQueryAggregate(id, { days = 90, weight = "equal", userId = 0 } = {}) {
  const q = getTrackedQuery(id);
  if (!q || q.user_id !== userId) return null;
  return {
    id: q.id,
    label: q.label,
    query: q.query,
    member_count: q.member_count,
    last_run_at: q.last_run_at,
    ...computeAggregateSeries(getQueryMemberIds(id), { days, weight }),
  };
}

/** 生态 / Topic 成员的「新增 star」增长榜（复用排行榜口径） */
export function getQueryMemberGrowth(id, { basis = "today", limit = 10, metric = "stars", userId = 0 } = {}) {
  const q = getTrackedQuery(id);
  if (!q || q.user_id !== userId) return null;
  const ids = getQueryMemberIds(id);
  return {
    id: q.id,
    label: q.label,
    query: q.query,
    memberCount: ids.length,
    ...getLeaderboard({ limit, basis, metric, minStars: 0, repoIds: ids }),
  };
}
