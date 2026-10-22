/**
 * 采集层 —— 项目里唯一会「写数据 + 发网络请求」的模块：
 *   refresh / refreshCustomRepos / refreshTrackedQueries。
 * 事务、批量 id 预取、告警触发都在这里闭环。
 */
import {
  db,
  getSetting,
  recordApiUsage,
  getRepoIdMap,
  markRepoStale,
  clearRepoStale,
  renameRepo,
  listTrackedQueries,
  replaceQueryMembers,
} from "./db.js";
import { searchTopRepos, fetchCustomRepo, trendingQuery } from "./github.js";
import { logger } from "./logger.js";
import { getAlertTargets, checkAlerts } from "./alerts.js";
import { loadRecentSnapshotMap } from "./snapshots.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 基础发现：每日按 stars 抓取的页数（每页 100）；GitHub 搜索最多 10 页 = 1000 条
const DISCOVERY_MAX_PAGES = Math.max(1, Math.min(10, Number(process.env.DISCOVERY_MAX_PAGES) || 10));

// 常用写语句（模块加载时 prepare 一次）
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
  "INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?, ?, ?, ?, ?)",
);

/** 「新且热」发现源的配置（设置优先，回退到 TRENDING_* 环境变量） */
export function trendingSettings() {
  const enabled = (getSetting("trendingEnabled", process.env.TRENDING_ENABLED ?? "1") ?? "1") !== "0";
  const days = Math.max(1, Number(getSetting("trendingDays", process.env.TRENDING_DAYS ?? 30)) || 30);
  const minStars = Math.max(
    0,
    Number(getSetting("trendingMinStars", process.env.TRENDING_MIN_STARS ?? 50)) || 50,
  );
  return { enabled, days, minStars };
}

/** 抓取「新且热」仓库（近似 GitHub Trending）。失败不影响主刷新流程。 */
async function collectTrending({ token }) {
  const { enabled, days, minStars } = trendingSettings();
  if (!enabled) return { items: [], rate: null };
  try {
    return await searchTopRepos({
      token,
      query: trendingQuery({ days, minStars }),
      maxPages: 2,
      perPage: 100,
    });
  } catch (e) {
    logger.warn("Trending 发现源抓取失败", { error: e.message });
    return { items: [], rate: null };
  }
}

export async function refresh({ minStars, token }) {
  const query = getSetting("searchQuery", "") || "";
  const { items, rate } = await searchTopRepos({ minStars, token, query, maxPages: DISCOVERY_MAX_PAGES });

  // 叠加「新且热」发现源：让近期冒头的新仓库进入采集，从而出现在日均新增排行里
  const trending = await collectTrending({ token });
  const merged = new Map();
  for (const r of [...items, ...trending.items]) if (!merged.has(r.full_name)) merged.set(r.full_name, r);
  const allItems = [...merged.values()];
  const lastRate = trending.rate || rate;

  const now = new Date().toISOString();
  const alertTargets = getAlertTargets();

  // P2-8: 批量预取 id，避免逐条 SELECT
  const idMap = getRepoIdMap(allItems.map((r) => r.full_name));
  const snapMap = loadRecentSnapshotMap(2);
  let fetched = 0;

  db.exec("BEGIN");
  try {
    for (const r of allItems) {
      upsertRepo.run(
        r.full_name,
        r.owner,
        r.name,
        r.url,
        r.description,
        r.language,
        r.homepage,
        r.stars,
        r.forks || 0,
        r.open_issues || 0,
        r.gh_created_at,
        0,
      );
      const id =
        idMap.get(r.full_name) ?? db.prepare("SELECT id FROM repos WHERE full_name = ?").get(r.full_name)?.id;
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

  recordApiUsage(lastRate?.used ?? 0, lastRate?.limit ?? 60, now);

  return {
    upserted: fetched,
    trending: trending.items.length,
    total: db.prepare("SELECT COUNT(*) c FROM repos").get().c,
    snapshots: db.prepare("SELECT COUNT(*) c FROM snapshots").get().c,
    quota: lastRate ? { used: lastRate.used, limit: lastRate.limit } : null,
  };
}

/** 刷新自定义仓库 */
export async function refreshCustomRepos({ token }) {
  const customRepos = db.prepare("SELECT full_name FROM custom_repos").all();
  const now = new Date().toISOString();
  const alertTargets = getAlertTargets();

  const idMap = getRepoIdMap(customRepos.map((c) => c.full_name));
  const snapMap = loadRecentSnapshotMap(2);
  let fetched = 0,
    renamed = 0,
    stale = 0;

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

      upsertRepo.run(
        info.full_name,
        info.owner,
        info.name,
        info.url,
        info.description,
        info.language,
        info.homepage,
        info.stars,
        info.forks || 0,
        info.open_issues || 0,
        info.gh_created_at,
        1,
      );
      const id =
        idMap.get(lookupKey) ??
        db.prepare("SELECT id FROM repos WHERE full_name = ?").get(lookupKey)?.id ??
        db.prepare("SELECT id FROM repos WHERE full_name = ?").get(info.full_name)?.id;
      if (!id) continue;
      insertSnapshot.run(id, info.stars, info.forks || 0, info.open_issues || 0, now);
      const prev = snapMap.get(id) || [];
      const prevStars = prev.length ? prev[prev.length - 1].stars : null;
      const snaps = [...prev, { stars: info.stars, captured_at: now }];
      for (const t of alertTargets)
        checkAlerts(id, info.full_name, info.stars, snaps, prevStars, t.cfg, t.userId);
      fetched++;
    } catch (e) {
      markRepoStale(requested, String(e.message || e).slice(0, 200));
      stale++;
      console.error(`[custom] 抓取 ${requested} 失败:`, e.message);
    }
  }
  return { upserted: fetched, renamed, stale, total: db.prepare("SELECT COUNT(*) c FROM repos").get().c };
}

const lastSnapStmt = db.prepare(
  "SELECT stars, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at DESC LIMIT 1",
);

/** 同一天且星数未变则不重复写快照（tracked query 可能与热门榜重叠） */
function shouldSnapshot(repoId, stars, now) {
  const last = lastSnapStmt.get(repoId);
  if (!last) return true;
  return !(last.stars === stars && last.captured_at.slice(0, 10) === now.slice(0, 10));
}

/**
 * P4: 刷新所有被追踪的搜索/topic，并把结果写入成员表。
 * 每行语法最多 `pagesCap` 页，避免破坏搜索配额；多行成员取并集。
 */
export async function refreshTrackedQueries({ token, perQuery = 100, maxPages } = {}) {
  const queries = listTrackedQueries();
  const pagesCap = Math.min(5, Math.max(1, Number(maxPages) || Number(process.env.QUERY_MAX_PAGES) || 2));
  let updated = 0,
    members = 0;

  for (const q of queries) {
    try {
      // 支持多行：每行一条搜索语法，成员取并集（GitHub 搜索不支持 OR）
      const lines = String(q.query || "")
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const now = new Date().toISOString();
      const collected = [];
      for (const line of lines) {
        const { items } = await searchTopRepos({
          token,
          query: line,
          maxPages: pagesCap,
          perPage: Math.min(100, Math.max(1, Number(perQuery) || 100)),
        });
        collected.push(...items);
        await sleep(150);
      }
      // 多行之间可能重叠，按 full_name 去重
      const byName = new Map();
      for (const r of collected) if (!byName.has(r.full_name)) byName.set(r.full_name, r);
      const items = [...byName.values()];

      const idMap = getRepoIdMap(items.map((r) => r.full_name));
      const ids = [];

      db.exec("BEGIN");
      try {
        for (const r of items) {
          upsertRepo.run(
            r.full_name,
            r.owner,
            r.name,
            r.url,
            r.description,
            r.language,
            r.homepage,
            r.stars,
            r.forks || 0,
            r.open_issues || 0,
            r.gh_created_at,
            0,
          );
          const id =
            idMap.get(r.full_name) ??
            db.prepare("SELECT id FROM repos WHERE full_name = ?").get(r.full_name)?.id;
          if (!id) continue;
          if (shouldSnapshot(id, r.stars, now))
            insertSnapshot.run(id, r.stars, r.forks || 0, r.open_issues || 0, now);
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
