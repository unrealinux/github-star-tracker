import { db } from "./db.js";
import { searchTopRepos } from "./github.js";

const WINDOWS = {
  day: { ms: 24 * 3600 * 1000, label: "近24h" },
  week: { ms: 7 * 24 * 3600 * 1000, label: "近7天" },
  month: { ms: 30 * 24 * 3600 * 1000, label: "近30天" },
};

const upsertRepo = db.prepare(`
  INSERT INTO repos (full_name, owner, name, url, description, language, homepage, stars, gh_created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(full_name) DO UPDATE SET
    stars = excluded.stars,
    url = excluded.url,
    description = excluded.description,
    language = excluded.language,
    homepage = excluded.homepage,
    updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
`);

const getRepoId = db.prepare("SELECT id FROM repos WHERE full_name = ?");
const insertSnapshot = db.prepare(
  "INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?, ?, ?)"
);

export async function refresh({ minStars, token }) {
  const items = await searchTopRepos({ minStars, token });
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
      r.gh_created_at
    );
    const row = getRepoId.get(r.full_name);
    if (row) insertSnapshot.run(row.id, r.stars, new Date().toISOString());
  }
  return {
    upserted: items.length,
    total: db.prepare("SELECT COUNT(*) c FROM repos").get().c,
    snapshots: db.prepare("SELECT COUNT(*) c FROM snapshots").get().c,
  };
}

/** 计算单个 repo 在指定窗口的星数增长：取窗口前最近一次快照做基线。 */
function computeGrowth(repoStars, snaps, now, window) {
  if (snaps.length === 0) return { growth: null, label: "待积累" };
  const cfg = WINDOWS[window] || WINDOWS.day;
  // snapshots 按时间倒序：找"最早不早于窗口"的基线，即 captured_at <= now-窗口 中最新的一条
  const base = snaps.find((s) => Date.parse(s.captured_at) <= now - cfg.ms);
  if (base) return { growth: repoStars - base.stars, label: cfg.label };
  // 历史不足一个完整窗口：日窗口退化为上次更新差，周/月用最早快照并按实际天数标注
  if (snaps.length >= 2) {
    if (window === "day") return { growth: repoStars - snaps[1].stars, label: "本次更新" };
    const earliest = snaps[snaps.length - 1];
    const days = Math.max(1, Math.round((now - Date.parse(earliest.captured_at)) / 86400000));
    return { growth: repoStars - earliest.stars, label: `近${days}天` };
  }
  return { growth: null, label: "待积累" };
}

function cmpByGrowth(a, b) {
  const ga = a.growth ?? -Infinity;
  const gb = b.growth ?? -Infinity;
  return gb - ga || b.stars - a.stars;
}

function makeSort(sort) {
  switch (sort) {
    case "stars":
      return (a, b) => b.stars - a.stars;
    case "newest":
      return (a, b) => Date.parse(b.first_seen_at) - Date.parse(a.first_seen_at);
    case "name":
      return (a, b) => a.full_name.localeCompare(b.full_name);
    case "language":
      return (a, b) => (a.language ?? "").localeCompare(b.language ?? "") || b.stars - a.stars;
    default:
      return cmpByGrowth;
  }
}

export function listRepos({ minStars, minGrowth, language, sort, window }) {
  const now = Date.now();
  const win = WINDOWS[window] ? window : "day";
  const rows = db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM snapshots s WHERE s.repo_id = r.id) AS snap_count
       FROM repos r ORDER BY r.stars DESC`
    )
    .all();

  const getSnaps = db.prepare(
    "SELECT stars, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at DESC"
  );

  const out = rows.map((r) => {
    const snaps = getSnaps.all(r.id);
    const { growth, label } = computeGrowth(r.stars, snaps, now, win);
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
      growth,
      growthLabel: label,
      snap_count: r.snap_count,
      first_seen_at: r.first_seen_at,
      spark: snaps.slice(0, 10).reverse().map((s) => ({ t: s.captured_at, stars: s.stars })),
    };
  });

  return out
    .filter(
      (r) =>
        r.stars >= minStars &&
        (minGrowth <= 0 || (r.growth !== null && r.growth >= minGrowth)) &&
        (!language || r.language === language)
    )
    .sort(makeSort(sort));
}

export function listLanguages() {
  return db
    .prepare(
      `SELECT language, COUNT(*) c FROM repos
       WHERE language IS NOT NULL AND language != ''
       GROUP BY language ORDER BY c DESC`
    )
    .all();
}

export function getRepoHistory(id) {
  const repo = db
    .prepare(
      "SELECT id, full_name, name, owner, url, description, language, homepage, stars, gh_created_at, first_seen_at FROM repos WHERE id = ?"
    )
    .get(id);
  if (!repo) return null;
  const history = db
    .prepare("SELECT stars, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC")
    .all(id);
  return { repo, history };
}

export function getStats() {
  const repoCount = db.prepare("SELECT COUNT(*) c FROM repos").get().c;
  const snapCount = db.prepare("SELECT COUNT(*) c FROM snapshots").get().c;
  const lastRefresh = db.prepare("SELECT MAX(captured_at) t FROM snapshots").get().t;
  const noGrowth = db.prepare("SELECT COUNT(*) c FROM repos r WHERE (SELECT COUNT(*) FROM snapshots s WHERE s.repo_id = r.id) < 2").get().c;
  return { repoCount, snapCount, lastRefresh, pendingGrowth: noGrowth };
}
