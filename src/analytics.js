/**
 * 只读分析层 —— 所有面向用户的榜单 / 趋势 / 检测 / 相似度查询。
 * 不写库、不发请求（getRepoHistory 的画像数据除外——它也只读）。
 */
import { db, getSetting, searchCustomRepo, allCustomRepoNames } from "./db.js";
import { WINDOWS, windowOf, isoOffset, avgDailyGrowth } from "./windows.js";
import { MIN_GROWTH_SAMPLE_DAYS, MILESTONES, compactStars, metricOf, GROWTH_BASES } from "./metrics.js";
import { loadSnapshotMap, snapshotAtMap, dailyAggregate } from "./snapshots.js";
import {
  computeGrowth,
  computeMomentum,
  computeDailyGrowth,
  predictGrowth,
  makeSort,
  computeCrossings,
  todayStartMs,
} from "./growth.js";
import { evaluateAlertRules } from "./alerts.js";

// ── 列表 ──────────────────────────────────────────────────────────
export function listRepos({
  minStars,
  minGrowth,
  language,
  sort,
  window,
  page = 1,
  pageSize = 50,
  todayOnly = false,
  keyword = "",
  onlyCustom = false,
  onlyFavorite = false,
  metric = "stars",
  userId = 0,
}) {
  const now = Date.now();
  const win = WINDOWS[window] ? window : "day";
  const metricDef = metricOf(metric);
  const field = metricDef.field;

  // 过滤下推到 SQL，避免把全表读进内存（关键词为大小写不敏感匹配）
  const kw = String(keyword || "").trim();
  const where = [];
  const params = [];
  if (minStars > 0) {
    where.push("stars >= ?");
    params.push(minStars);
  }
  if (language) {
    where.push("language = ?");
    params.push(language);
  }
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
    favSet = new Set(
      db
        .prepare("SELECT repo_id FROM favorites WHERE user_id = ?")
        .all(userId)
        .map((f) => f.repo_id),
    );
    repoRows = repoRows.filter((r) => favSet.has(r.id));
  }

  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });

  const out = repoRows.map((r) => {
    const snaps = snapMap.get(r.id) || [];
    const value = r[field] || 0;
    const { growth, label, dailyGrowth, avgDaily, momentum } = computeGrowth(value, snaps, now, win, field);
    return {
      id: r.id,
      full_name: r.full_name,
      name: r.name,
      owner: r.owner,
      url: r.url,
      description: r.description,
      language: r.language,
      homepage: r.homepage,
      stars: r.stars,
      forks: r.forks,
      open_issues: r.open_issues,
      metric,
      metricValue: value,
      metricNoun: metricDef.noun,
      growth,
      growthLabel: label,
      dailyGrowth,
      avgDailyGrowth: avgDaily ? Number(avgDaily.avg.toFixed(2)) : null,
      avgSampleDays: avgDaily ? Number(avgDaily.days.toFixed(2)) : null,
      momentum,
      first_seen_at: r.first_seen_at,
      is_custom: customSet.has(r.full_name),
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
      (!todayOnly || (r.growth !== null && r.growth > 0)),
  );

  filtered.sort(makeSort(sort, field));

  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(1, page), totalPages);

  return {
    repos: filtered.slice((p - 1) * pageSize, (p - 1) * pageSize + pageSize),
    total,
    page: p,
    pageSize,
    totalPages,
  };
}

export function listLanguages() {
  return db
    .prepare(
      `SELECT language, COUNT(*) c FROM repos
     WHERE language IS NOT NULL AND language != ''
     GROUP BY language ORDER BY c DESC, language ASC`,
    )
    .all();
}

/**
 * 🏆 排行榜：同时返回「总星 Top N」与「增长 Top N」。
 * 口径见 src/metrics.js 的 GROWTH_BASES。
 */
export function getLeaderboard({
  limit = 10,
  basis = "avg7",
  minStars = 0,
  metric = "stars",
  repoIds = null,
} = {}) {
  const now = Date.now();
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  const b = GROWTH_BASES[basis] || GROWTH_BASES.avg7;
  // repoIds 给定时只统计这批仓库（生态/Topic 成员增长榜用它）；否则按 minStars 全量
  let repoRows;
  if (Array.isArray(repoIds)) {
    const ids = [...new Set(repoIds.filter(Number.isInteger))];
    repoRows = [];
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      repoRows.push(
        ...db
          .prepare(`SELECT * FROM repos WHERE id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`)
          .all(...chunk),
      );
    }
    repoRows.sort((a, b) => a.id - b.id);
  } else {
    repoRows =
      minStars > 0
        ? db.prepare("SELECT * FROM repos WHERE stars >= ? ORDER BY id").all(minStars)
        : db.prepare("SELECT * FROM repos ORDER BY id").all();
  }
  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });
  const startMs = b.calendar ? todayStartMs(now) : null;

  const rows = repoRows.map((r) => {
    const snaps = snapMap.get(r.id) || [];
    const value = r[field] || 0;
    // 窗口原始增量：basis=avg7 时仍用于总星榜那行小字；窗口 basis 时就是排序值
    const { growth, label, avgDaily } = computeGrowth(value, snaps, now, b.win || "day", field);
    let basisValue;
    if (b.calendar) {
      // 自然日：取「今天 00:00 之前最近一条快照」为基准；没有则用今首条快照兜底
      let base = null;
      for (let i = snaps.length - 1; i >= 0; i--) {
        if (Date.parse(snaps[i].captured_at) <= startMs) {
          base = snaps[i][field];
          break;
        }
      }
      if (base === null) base = snaps.length ? snaps[0][field] : null;
      basisValue = base === null ? null : value - base;
    } else {
      basisValue = b.win === null ? (avgDaily ? Number(avgDaily.avg.toFixed(2)) : null) : growth;
    }
    return {
      id: r.id,
      full_name: r.full_name,
      url: r.url,
      language: r.language,
      description: r.description,
      stars: r.stars,
      metricValue: value,
      growth,
      growthLabel: label,
      avgDailyGrowth: avgDaily ? Number(avgDaily.avg.toFixed(2)) : null,
      avgSampleDays: avgDaily ? Number(avgDaily.days.toFixed(2)) : null,
      basisValue,
      basisLabel: b.label,
      basisUnit: b.unit,
    };
  });

  // 并列时用 id 打破，保证 SQLite / PostgreSQL 给出相同结果
  const byStars = rows
    .slice()
    .sort((a, b) => b.metricValue - a.metricValue || a.id - b.id)
    .slice(0, limit);
  // 增长榜：样本跨度不足的仓库不参与（避免用几小时的差值外推出假高数值）
  const candidates = rows.filter((r) => r.basisValue !== null && r.basisValue !== undefined);
  const enoughSample = candidates.filter((r) => (r.avgSampleDays || 0) >= MIN_GROWTH_SAMPLE_DAYS);
  const byGrowth = enoughSample
    .slice()
    .sort((a, b) => b.basisValue - a.basisValue || a.id - b.id)
    .slice(0, limit);
  const excludedForSample = candidates.length - enoughSample.length;

  const sampleDays = rows.reduce((m, r) => Math.max(m, r.avgSampleDays || 0), 0);
  return {
    byStars,
    byGrowth,
    limit,
    basis,
    metric,
    metricLabel: metricDef.label,
    metricNoun: metricDef.noun,
    basisLabel: b.label,
    basisUnit: b.unit,
    sampleDays: Number(sampleDays.toFixed(2)),
    minSampleDays: MIN_GROWTH_SAMPLE_DAYS,
    excludedForSample,
  };
}

/**
 * P0-1: 爆发榜 —— 按「增速加速度」排序，识别正在起飞的项目。
 */
export function getSurges({ limit = 10, minStars = 0, includeDecaying = false, metric = "stars" } = {}) {
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  const repoRows =
    minStars > 0
      ? db.prepare("SELECT id, full_name, url, language, stars FROM repos WHERE stars >= ?").all(minStars)
      : db.prepare("SELECT id, full_name, url, language, stars FROM repos").all();
  const snapMap = loadSnapshotMap({ repoIds: repoRows.map((r) => r.id) });

  const rows = [];
  for (const r of repoRows) {
    const m = computeMomentum(snapMap.get(r.id) || [], field);
    if (!m) continue;
    if (!includeDecaying && !m.isSurge) continue;
    rows.push({
      id: r.id,
      full_name: r.full_name,
      url: r.url,
      language: r.language,
      stars: r.stars,
      ...m,
    });
  }

  rows.sort((a, b) => b.accel - a.accel);
  return {
    surges: rows.slice(0, limit),
    decaying: rows
      .filter((r) => r.accel < 0)
      .slice(-limit)
      .reverse(),
    metric,
    metricLabel: metricDef.label,
  };
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
    if (starsAt == null) continue; // 当时还未收录
    if (starsAt < minStars) continue;
    const base = baseMap.get(r.id);
    const growth = base != null ? starsAt - base : null;
    out.push({
      id: r.id,
      full_name: r.full_name,
      url: r.url,
      language: r.language,
      description: r.description,
      stars: starsAt,
      currentStars: r.stars,
      growth,
      growthLabel: base != null ? cfg.label : "无基线",
      sinceThen: r.stars - starsAt,
    });
  }

  if (sort === "growth")
    out.sort((a, b) => (b.growth ?? -Infinity) - (a.growth ?? -Infinity) || b.stars - a.stars);
  else out.sort((a, b) => b.stars - a.stars);

  out.forEach((r, i) => {
    r.rank = i + 1;
  });
  const total = out.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    at: atIso,
    window,
    total,
    totalPages,
    repos: out.slice(offset, offset + limit),
  };
}

export function getLanguageTrends(window = "day") {
  const win = WINDOWS[window] ? window : "day";
  const baseMap = snapshotAtMap(isoOffset(WINDOWS[win].ms));
  const rows = db
    .prepare(
      `SELECT id, language, stars FROM repos
     WHERE language IS NOT NULL AND language != ''`,
    )
    .all();

  const langMap = new Map();
  for (const r of rows) {
    const base = baseMap.get(r.id);
    const growth = r.stars - (base ?? r.stars);
    const e = langMap.get(r.language);
    if (e) {
      e.totalStars += r.stars;
      e.totalGrowth += growth;
      e.count += 1;
    } else
      langMap.set(r.language, { language: r.language, count: 1, totalStars: r.stars, totalGrowth: growth });
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
  const current = db.prepare("SELECT id, full_name, stars, language FROM repos ORDER BY stars DESC").all();
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
      id: r.id,
      full_name: r.full_name,
      stars: r.stars,
      language: r.language,
      rank: c,
      prevRank: p,
      delta: p - c,
      growth: r.stars - (pastStarsById.get(r.id) ?? r.stars),
    });
  }

  return {
    risers: changes
      .filter((c) => c.delta > 0)
      .sort((a, b) => b.delta - a.delta)
      .slice(0, limit),
    fallers: changes
      .filter((c) => c.delta < 0)
      .sort((a, b) => a.delta - b.delta)
      .slice(0, limit),
  };
}

/**
 * P2: 徽章数据（单个仓库，轻量查询）
 */
export function getBadgeData(fullName, window = "day") {
  const win = WINDOWS[window] ? window : "day";
  const r = db
    .prepare("SELECT id, full_name, stars, forks, open_issues FROM repos WHERE full_name = ?")
    .get(fullName);
  if (!r) return null;

  const snaps = db
    .prepare(
      "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC",
    )
    .all(r.id);

  const g = computeGrowth(r.stars, snaps, Date.now(), win, "stars");
  const gf = computeGrowth(r.forks, snaps, Date.now(), win, "forks");
  const gi = computeGrowth(r.open_issues, snaps, Date.now(), win, "open_issues");

  return {
    full_name: r.full_name,
    stars: r.stars,
    forks: r.forks,
    open_issues: r.open_issues,
    growth: g.growth,
    growthLabel: g.label,
    growthForks: gf.growth,
    growthIssues: gi.growth,
    ratio: r.forks > 0 ? Number((r.stars / r.forks).toFixed(1)) : null,
    snapshots: snaps.length,
  };
}

export function getRepoHistory(id, metric = "stars", userId = 0) {
  const metricDef = metricOf(metric);
  const field = metricDef.field;
  const repo = db
    .prepare(
      "SELECT id, full_name, name, owner, url, description, language, homepage, stars, forks, open_issues, gh_created_at, first_seen_at, stale, stale_since, last_error FROM repos WHERE id = ?",
    )
    .get(id);
  if (!repo) return null;
  repo.is_custom = Boolean(searchCustomRepo(repo.full_name, userId));
  const rows = db
    .prepare(
      "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC",
    )
    .all(id);
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
          date: s.captured_at,
          type: "milestone",
          label: `${compactStars(crossed)} \u2605`,
          message: `突破 ${crossed.toLocaleString("en-US")} 星`,
        });
      }
    }
    prevStars = s.stars;
  }
  for (const a of db
    .prepare(
      "SELECT kind, growth, triggered_at, message FROM alerts WHERE repo_id = ? ORDER BY triggered_at ASC",
    )
    .all(id)) {
    events.push({
      date: a.triggered_at,
      type: a.kind,
      label:
        a.kind === "milestone" ? "\u{1F3C1}" : a.kind === "drop" ? `-${Math.abs(a.growth)}` : `+${a.growth}`,
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
    const repo = db
      .prepare(
        "SELECT id, full_name, url, language, description, stars, forks, open_issues FROM repos WHERE id = ?",
      )
      .get(id);
    if (!repo) continue;

    const rows = db
      .prepare(
        "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC",
      )
      .all(id);
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
  return {
    window: win,
    metric,
    metricLabel: metricDef.label,
    dates,
    repos,
    crossings: computeCrossings(repos),
  };
}

/**
 * C2: 全局趋势 —— 收录/快照活动、每日总星数、数据健康度。
 */
export function getOverview({ days = 60, userId = 0 } = {}) {
  const d = Math.min(365, Math.max(7, Number(days) || 60));
  const since = isoOffset(d * 86400000);

  const discoveries = db
    .prepare(
      `SELECT substr(first_seen_at, 1, 10) AS date, COUNT(*) AS count
     FROM repos WHERE first_seen_at >= ? GROUP BY date ORDER BY date`,
    )
    .all(since);

  const snapshotActivity = db
    .prepare(
      `SELECT substr(captured_at, 1, 10) AS date, COUNT(*) AS count
     FROM snapshots WHERE captured_at >= ? GROUP BY date ORDER BY date`,
    )
    .all(since);

  // 每日总星数：每个仓库当天最后一条快照之和
  const totalStars = db
    .prepare(
      `SELECT date, SUM(stars) AS "totalStars" FROM (
       SELECT repo_id, substr(captured_at, 1, 10) AS date, stars,
              ROW_NUMBER() OVER (PARTITION BY repo_id, substr(captured_at, 1, 10) ORDER BY captured_at DESC) AS rn
       FROM snapshots WHERE captured_at >= ?
     ) AS sq WHERE rn = 1 GROUP BY date ORDER BY date`,
    )
    .all(since);

  const totalRepos = db.prepare("SELECT COUNT(*) c FROM repos").get().c;
  const covered = db
    .prepare(
      "SELECT COUNT(*) c FROM (SELECT repo_id FROM snapshots GROUP BY repo_id HAVING COUNT(*) >= 2) AS sq",
    )
    .get().c;
  const avgSnaps = db
    .prepare("SELECT AVG(c) a FROM (SELECT COUNT(*) c FROM snapshots GROUP BY repo_id) AS sq")
    .get().a;
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
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "your",
  "you",
  "are",
  "its",
  "it's",
  "library",
  "framework",
  "tool",
  "tools",
  "app",
  "application",
  "using",
  "use",
  "used",
  "based",
  "simple",
  "fast",
  "easy",
  "lightweight",
  "modern",
  "build",
  "built",
  "code",
  "project",
  "open",
  "source",
  "github",
  "https",
  "http",
  "www",
  "com",
  "org",
  "a",
  "an",
  "of",
  "to",
  "in",
  "on",
]);

function tokenize(text) {
  return (
    String(text || "")
      .toLowerCase()
      .match(/[a-z0-9+#.]+/g) || []
  )
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

  const candidates = db
    .prepare("SELECT id, full_name, url, language, description, stars FROM repos WHERE id != ?")
    .all(id);

  const scored = [];
  for (const r of candidates) {
    const sameLang = target.language && r.language === target.language;
    const sim = cosine(targetTokens, new Set(tokenize(r.description)));
    const score = (sameLang ? 1 : 0) + 2 * sim;
    if (score < 0.8) continue;
    scored.push({
      id: r.id,
      full_name: r.full_name,
      url: r.url,
      language: r.language,
      description: r.description,
      stars: r.stars,
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

  const repoRows =
    Number(minStars) > 0
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
      id: r.id,
      full_name: r.full_name,
      url: r.url,
      language: r.language,
      stars: r.stars,
      date: latest.date,
      delta: latest.d,
      mean: Number(mean.toFixed(2)),
      sd: Number(sd.toFixed(2)),
      z: Number(zScore.toFixed(2)),
      samples: history.length,
      direction: zScore > 0 ? "spike" : "drop",
    });
  }

  rows.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
  return {
    days: lookback,
    z: threshold,
    minSamples: minN,
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
    const row = db
      .prepare("SELECT stars FROM repos ORDER BY stars ASC LIMIT 1 OFFSET (SELECT COUNT(*) / 2 FROM repos)")
      .get();
    cap = row ? row.stars : Number.MAX_SAFE_INTEGER;
  }

  const repoRows = db
    .prepare(
      "SELECT id, full_name, url, language, stars, gh_created_at, first_seen_at FROM repos WHERE stars <= ? AND stars >= ?",
    )
    .all(cap, floor);
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
      id: r.id,
      full_name: r.full_name,
      url: r.url,
      language: r.language,
      stars: r.stars,
      avgDailyGrowth: Number(avg.avg.toFixed(2)),
      sampleDays: Number(avg.days.toFixed(2)),
      ageDays,
      pctPerDay: Number(((avg.avg / Math.max(1, r.stars)) * 100).toFixed(3)),
    });
  }

  rows.sort((a, b) => b.pctPerDay - a.pctPerDay || b.avgDailyGrowth - a.avgDailyGrowth);
  return {
    maxStars: cap,
    minDays: minAge,
    minStars: floor,
    rising: rows.slice(0, Math.min(50, Math.max(1, Number(limit) || 15))),
  };
}

/** 迷你走势图数据（最近 N 条快照） */
export function getSparkData(fullName, points = 30, metric = "stars") {
  const metricDef = metricOf(metric);
  const r = db.prepare("SELECT id, full_name, stars FROM repos WHERE full_name = ?").get(fullName);
  if (!r) return null;
  const n = Math.min(120, Math.max(2, Number(points) || 30));
  const rows = db
    .prepare(
      "SELECT stars, forks, open_issues, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at DESC LIMIT ?",
    )
    .all(r.id, n);
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

  const repoRows =
    Number(minStars) > 0
      ? db
          .prepare("SELECT id, full_name, url, language, description FROM repos WHERE stars >= ?")
          .all(minStars)
      : db.prepare("SELECT id, full_name, url, language, description FROM repos").all();
  const snapMap = loadSnapshotMap({
    days: lookback,
    perRepo: lookback + 5,
    repoIds: repoRows.map((r) => r.id),
  });
  const byDate = new Map();

  for (const r of repoRows) {
    const daysArr = dailyAggregate(snapMap.get(r.id) || []);
    if (daysArr.length < minN + 1) continue;

    const deltas = [];
    for (let i = 1; i < daysArr.length; i++) {
      deltas.push({ date: daysArr[i].captured_at.slice(0, 10), d: daysArr[i].stars - daysArr[i - 1].stars });
    }
    if (deltas.length < minN + 1) continue;

    let sum = 0,
      sumSq = 0;
    for (const x of deltas) {
      sum += x.d;
      sumSq += x.d * x.d;
    }
    const n = deltas.length;

    for (const cur of deltas) {
      if (cur.d <= 0) continue;
      const m = (sum - cur.d) / (n - 1);
      const sd = Math.sqrt(Math.max(0, (sumSq - cur.d * cur.d) / (n - 1) - m * m));
      if (!(sd > 0)) continue;
      const zs = (cur.d - m) / sd;
      if (zs < zt) continue;
      let arr = byDate.get(cur.date);
      if (!arr) {
        arr = [];
        byDate.set(cur.date, arr);
      }
      arr.push({
        id: r.id,
        full_name: r.full_name,
        url: r.url,
        language: r.language,
        description: r.description,
        delta: cur.d,
        z: Number(zs.toFixed(2)),
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
  return {
    days: lookback,
    z: zt,
    minRepos: minGroup,
    minSamples: minN,
    events: events.slice(0, Math.min(50, Math.max(1, Number(limit) || 12))),
  };
}

/**
 * 告警规则回测：用历史快照重放，统计给定规则会触发多少次。
 * 与生产逻辑共用 evaluateAlertRules()，保证「回测结果 = 实际会发生的告警」。
 */
export function backtestAlerts({
  days = 90,
  threshold,
  dropThreshold,
  alertOnDrop,
  alertOnMilestone,
  minStars = 0,
  maxFires = 200,
} = {}) {
  const lookback = Math.min(365, Math.max(7, Number(days) || 90));
  let repoThresholds;
  try {
    repoThresholds = JSON.parse(getSetting("repoThresholds", "{}") || "{}") || {};
  } catch {
    repoThresholds = {};
  }

  const cfg = {
    threshold: Math.max(0, Number(threshold ?? getSetting("alertThreshold", 50)) || 0),
    repoThresholds,
    alertOnDrop: alertOnDrop ?? getSetting("alertOnDrop", "0") === "1",
    dropThreshold: Math.max(0, Number(dropThreshold ?? getSetting("dropThreshold", 50)) || 0),
    alertOnMilestone: alertOnMilestone ?? getSetting("alertOnMilestone", "0") === "1",
  };

  const repoRows =
    Number(minStars) > 0
      ? db.prepare("SELECT id, full_name FROM repos WHERE stars >= ?").all(minStars)
      : db.prepare("SELECT id, full_name FROM repos").all();
  const snapMap = loadSnapshotMap({
    days: lookback,
    perRepo: lookback + 5,
    repoIds: repoRows.map((r) => r.id),
  });
  const since = isoOffset(lookback * 86400000);

  const fires = [];
  let sampleDaysTotal = 0,
    evaluatedRepos = 0;

  for (const r of repoRows) {
    const daysArr = dailyAggregate(snapMap.get(r.id) || []).filter((d) => d.captured_at >= since);
    if (daysArr.length < 2) continue;
    evaluatedRepos++;
    sampleDaysTotal += daysArr.length;

    for (let i = 1; i < daysArr.length; i++) {
      const prev = daysArr[i - 1].stars;
      const cur = daysArr[i].stars;
      const alerts = evaluateAlertRules({
        fullName: r.full_name,
        repoStars: cur,
        baseStars: prev,
        prevStars: prev,
        cfg,
      });
      for (const a of alerts) {
        fires.push({
          date: daysArr[i].captured_at.slice(0, 10),
          id: r.id,
          full_name: r.full_name,
          kind: a.kind,
          growth: a.growth,
          stars: cur,
          threshold: a.threshold,
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
    topRepos: [...byRepo.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([full_name, count]) => ({ full_name, count })),
    fired: fires.slice(0, Math.min(500, Math.max(1, Number(maxFires) || 200))),
  };
}

export function getStats(userId = 0) {
  // 单次查询汇总，避免多次往返；pendingGrowth 用索引友好的相关计数
  const row = db
    .prepare(
      `
    SELECT
      (SELECT COUNT(*) FROM repos) AS "repoCount",
      (SELECT COUNT(*) FROM custom_repos WHERE user_id = ?) AS "customCount",
      (SELECT COUNT(*) FROM favorites WHERE user_id = ?) AS "favoriteCount",
      (SELECT COUNT(*) FROM snapshots) AS "snapCount",
      (SELECT COUNT(*) FROM repos WHERE stale = 1) AS "staleCount",
      (SELECT MAX(captured_at) FROM snapshots) AS "lastRefresh",
      (SELECT COUNT(*) FROM repos r
        WHERE (SELECT COUNT(*) FROM snapshots s WHERE s.repo_id = r.id) < 2) AS "pendingGrowth"
  `,
    )
    .get(userId, userId);
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
