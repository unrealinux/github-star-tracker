import { db } from "./db.js";
import { fetchStargazers } from "./github.js";
import { logger } from "./logger.js";

const PER_PAGE = 100;
const DEFAULT_DAYS = 90;
const DEFAULT_MAX_PAGES = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const todayUtc = () => new Date().toISOString().slice(0, 10);

/**
 * 用 GitHub stargazers（带 starred_at）重建历史星数快照。
 *
 * 原理：stargazers 按时间倒序返回。第 i 个（0-based）stargazer 出现的时刻，
 * 该仓库约有「当前总星数 - i」颗星。按天取当天最新一条作为当日收盘星值。
 *
 * 注意事项：
 * - 无法感知取关（unstargazers），重建值略高于真实历史，属近似
 * - forks / open_issues 用当前值填充，避免这两个指标出现虚假增长
 * - 只补齐「尚无快照的日期」，不覆盖真实数据；跳过今天
 * @returns {Promise<object>}
 */
export async function backfillRepo({ id, token, days = DEFAULT_DAYS, maxPages = DEFAULT_MAX_PAGES }) {
  const repo = db.prepare("SELECT id, full_name, stars, forks, open_issues FROM repos WHERE id = ?").get(id);
  if (!repo) return { error: "仓库不存在", id };

  const cutoff = Date.now() - days * 86400000;
  const byDay = new Map(); // date -> 当天收盘星数（先出现的即当天最大值）
  const pages = { fetched: 0, points: 0, oldest: null, reachedCutoff: false };

  for (let page = 1; page <= maxPages; page++) {
    const { items, hasMore } = await fetchStargazers(repo.full_name, { token, page, perPage: PER_PAGE });
    pages.fetched++;

    if (items.length === 0) {
      pages.reachedCutoff = true;
      break;
    }

    let hitCutoff = false;
    for (let i = 0; i < items.length; i++) {
      const at = items[i].starred_at;
      if (!at) continue;
      const day = at.slice(0, 10);
      const stars = Math.max(1, repo.stars - ((page - 1) * PER_PAGE + i));
      if (!byDay.has(day)) byDay.set(day, stars);
      pages.points++;
      pages.oldest = at;
      if (Date.parse(at) < cutoff) hitCutoff = true;
    }

    if (hitCutoff) {
      pages.reachedCutoff = true;
      break;
    }
    if (!hasMore) {
      pages.reachedCutoff = true;
      break;
    }
    await sleep(120); // 轻微节流，避免触发二级限流
  }

  const today = todayUtc();
  const existing = new Set(
    db
      .prepare("SELECT substr(captured_at, 1, 10) AS d FROM snapshots WHERE repo_id = ?")
      .all(repo.id)
      .map((r) => r.d),
  );

  const ins = db.prepare(
    "INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?, ?, ?, ?, ?)",
  );
  let inserted = 0;
  db.exec("BEGIN");
  try {
    for (const [day, stars] of byDay) {
      if (day === today || existing.has(day)) continue;
      ins.run(repo.id, stars, repo.forks || 0, repo.open_issues || 0, `${day}T23:59:59Z`);
      inserted++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  logger.info("历史回填完成", { repo: repo.full_name, inserted, pages: pages.fetched });
  return {
    id: repo.id,
    full_name: repo.full_name,
    inserted,
    points: pages.points,
    pages: pages.fetched,
    oldest: pages.oldest,
    approximate: true,
    reachedCutoff: pages.reachedCutoff,
  };
}

/** 解析批量回填范围 → repo id 列表 */
export function resolveBackfillScope(scope = "custom", limit = 10) {
  const lim = Math.min(50, Math.max(1, Number(limit) || 10));
  if (scope === "favorites") {
    return db
      .prepare(`SELECT r.id FROM repos r JOIN favorites f ON f.repo_id = r.id ORDER BY r.stars DESC LIMIT ?`)
      .all(lim)
      .map((r) => r.id);
  }
  if (scope === "all") {
    return db
      .prepare("SELECT id FROM repos ORDER BY stars DESC LIMIT ?")
      .all(lim)
      .map((r) => r.id);
  }
  // custom（默认）：自定义追踪优先，其次收藏，最后按星数补齐
  return db
    .prepare(
      `SELECT r.id FROM repos r
     LEFT JOIN custom_repos c ON c.full_name = r.full_name
     LEFT JOIN favorites f ON f.repo_id = r.id
     ORDER BY (c.id IS NOT NULL) DESC, (f.repo_id IS NOT NULL) DESC, r.stars DESC
     LIMIT ?`,
    )
    .all(lim)
    .map((r) => r.id);
}

/** 顺序回填多个仓库，返回每个仓库的结果（失败不中断整体） */
export async function backfillMany({ ids, token, days = DEFAULT_DAYS, maxPages = DEFAULT_MAX_PAGES }) {
  const results = [];
  for (const id of ids) {
    try {
      results.push(await backfillRepo({ id, token, days, maxPages }));
    } catch (e) {
      logger.warn("历史回填失败", { id, error: e.message });
      results.push({ id, error: e.message });
    }
  }
  return results;
}
