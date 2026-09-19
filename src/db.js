import { mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDriver, driverName, isPostgres } from "./dbdriver/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DB_DIR || join(__dirname, "..", "data");
mkdirSync(dataDir, { recursive: true });

// 支持 DB_PATH 覆盖（测试时用临时库）
const dbPath = process.env.DB_PATH || join(dataDir, "tracker.db");
export const db = createDriver({
  sqlitePath: dbPath,
  pgDataDir: process.env.PG_DATA_DIR || join(dataDir, "pg"),
  databaseUrl: process.env.DATABASE_URL || "",
});

export { driverName, isPostgres };

// ── 基础表结构（PostgreSQL 模式下由 dbdriver/schema.postgres.js 建表）──
if (!isPostgres) db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT UNIQUE NOT NULL,
  owner         TEXT,
  name          TEXT,
  url           TEXT,
  description   TEXT,
  language      TEXT,
  homepage      TEXT,
  stars         INTEGER NOT NULL DEFAULT 0,
  forks         INTEGER NOT NULL DEFAULT 0,
  open_issues   INTEGER NOT NULL DEFAULT 0,
  gh_created_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  is_custom     INTEGER NOT NULL DEFAULT 0,
  stale         INTEGER NOT NULL DEFAULT 0,
  stale_since   TEXT,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stars       INTEGER NOT NULL,
  forks       INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS custom_repos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,
  full_name   TEXT NOT NULL,
  user_note   TEXT,
  added_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(user_id, full_name)
);

CREATE TABLE IF NOT EXISTS favorites (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL DEFAULT 0,
  repo_id   INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  added_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(user_id, repo_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL DEFAULT 0,
  repo_id       INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  threshold     INTEGER NOT NULL,
  growth        INTEGER NOT NULL,
  current_stars INTEGER NOT NULL,
  triggered_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  read          INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'growth',
  message       TEXT
);

CREATE TABLE IF NOT EXISTS api_stats (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT NOT NULL UNIQUE DEFAULT (strftime('%Y-%m-%d','now')),
  requests_used   INTEGER NOT NULL DEFAULT 0,
  requests_limit  INTEGER NOT NULL DEFAULT 60,
  last_refresh_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- P3: 通用外部指标（支持 npm / PyPI / Docker Hub 等非 GitHub 数据源）
CREATE TABLE IF NOT EXISTS tracked_metrics (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source        TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT,
  url           TEXT,
  unit          TEXT,
  current_value REAL,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(source, key)
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  metric_id   INTEGER NOT NULL REFERENCES tracked_metrics(id) ON DELETE CASCADE,
  value       REAL NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_metric_snapshots_metric ON metric_snapshots(metric_id, captured_at);

-- P4: 泛化追踪对象
--   indices        —— 用本地筛选条件定义的「合成指数」（无需联网，成员实时计算）
--   tracked_queries—— 用 GitHub 搜索语法定义的「生态/topic 追踪」（刷新时抓取成员）
CREATE TABLE IF NOT EXISTS indices (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  spec       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS tracked_queries (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL DEFAULT 0,
  label        TEXT NOT NULL,
  query        TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(user_id, label)
);

CREATE TABLE IF NOT EXISTS query_members (
  query_id INTEGER NOT NULL REFERENCES tracked_queries(id) ON DELETE CASCADE,
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (query_id, repo_id)
);

-- Web Push 订阅（浏览器/手机系统级通知）
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL DEFAULT 0,
  endpoint    TEXT UNIQUE NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  last_ok_at  TEXT,
  last_error  TEXT
);

-- P5: 多用户
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);
`);

// ── P2-11: 迁移机制（PRAGMA user_version）─────────────────────────
const MIGRATIONS = [
  // v1: 删除废弃的 retention_config 表（保留天数已改存 settings）
  () => {
    db.exec(`DROP TABLE IF EXISTS retention_config;`);
  },
  // v2: 多指标支持（forks / open_issues）
  () => {
    const hasCol = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!hasCol("repos", "forks")) db.exec("ALTER TABLE repos ADD COLUMN forks INTEGER NOT NULL DEFAULT 0");
    if (!hasCol("repos", "open_issues")) db.exec("ALTER TABLE repos ADD COLUMN open_issues INTEGER NOT NULL DEFAULT 0");
    if (!hasCol("snapshots", "forks")) db.exec("ALTER TABLE snapshots ADD COLUMN forks INTEGER NOT NULL DEFAULT 0");
    if (!hasCol("snapshots", "open_issues")) db.exec("ALTER TABLE snapshots ADD COLUMN open_issues INTEGER NOT NULL DEFAULT 0");
  },
  // v3: 规则化告警（kind/message）
  () => {
    const hasCol = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!hasCol("alerts", "kind")) db.exec("ALTER TABLE alerts ADD COLUMN kind TEXT NOT NULL DEFAULT 'growth'");
    if (!hasCol("alerts", "message")) db.exec("ALTER TABLE alerts ADD COLUMN message TEXT");
  },
  // v4: 仓库健康状态（重命名/删除检测）
  () => {
    const hasCol = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!hasCol("repos", "stale")) db.exec("ALTER TABLE repos ADD COLUMN stale INTEGER NOT NULL DEFAULT 0");
    if (!hasCol("repos", "stale_since")) db.exec("ALTER TABLE repos ADD COLUMN stale_since TEXT");
    if (!hasCol("repos", "last_error")) db.exec("ALTER TABLE repos ADD COLUMN last_error TEXT");
  },
  // v5: 多用户（user_id 作用域化 + 唯一约束重建）
  () => {
    const hasCol = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);

    // 重建带有旧唯一约束的表：关闭外键以免 RENAME 改写其它表的引用
    db.exec("PRAGMA foreign_keys = OFF");
    try {
      if (!hasCol("favorites", "user_id")) {
        db.exec(`
          ALTER TABLE favorites RENAME TO favorites_old;
          CREATE TABLE favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
            added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UNIQUE(user_id, repo_id));
          INSERT INTO favorites (id, user_id, repo_id, added_at)
            SELECT id, 0, repo_id, added_at FROM favorites_old;
          DROP TABLE favorites_old;`);
      }
      if (!hasCol("custom_repos", "user_id")) {
        db.exec(`
          ALTER TABLE custom_repos RENAME TO custom_repos_old;
          CREATE TABLE custom_repos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            full_name TEXT NOT NULL,
            user_note TEXT,
            added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UNIQUE(user_id, full_name));
          INSERT INTO custom_repos (id, user_id, full_name, user_note, added_at)
            SELECT id, 0, full_name, user_note, added_at FROM custom_repos_old;
          DROP TABLE custom_repos_old;`);
      }
      if (!hasCol("tracked_queries", "user_id")) {
        db.exec(`
          ALTER TABLE tracked_queries RENAME TO tracked_queries_old;
          CREATE TABLE tracked_queries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            label TEXT NOT NULL,
            query TEXT NOT NULL,
            member_count INTEGER NOT NULL DEFAULT 0,
            last_run_at TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UNIQUE(user_id, label));
          INSERT INTO tracked_queries (id, user_id, label, query, member_count, last_run_at, created_at)
            SELECT id, 0, label, query, member_count, last_run_at, created_at FROM tracked_queries_old;
          DROP TABLE tracked_queries_old;`);
      }
      if (!hasCol("indices", "user_id")) {
        db.exec(`
          ALTER TABLE indices RENAME TO indices_old;
          CREATE TABLE indices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL DEFAULT 0,
            name TEXT NOT NULL,
            spec TEXT NOT NULL DEFAULT '{}',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
            UNIQUE(user_id, name));
          INSERT INTO indices (id, user_id, name, spec, created_at)
            SELECT id, 0, name, spec, created_at FROM indices_old;
          DROP TABLE indices_old;`);
      }
      if (!hasCol("alerts", "user_id")) db.exec("ALTER TABLE alerts ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0");
      if (!hasCol("push_subscriptions", "user_id")) db.exec("ALTER TABLE push_subscriptions ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0");
    } finally {
      db.exec("PRAGMA foreign_keys = ON");
    }
  },
  // v6: 自定义仓库标记（repos.is_custom）
  // v0.1.0 的库没有这一列，必须补上，否则后面的索引创建会直接报错
  () => {
    const hasCol = (table, col) =>
      db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!hasCol("repos", "is_custom")) db.exec("ALTER TABLE repos ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0");
  },
];

function migrate() {
  const current = db.prepare("PRAGMA user_version").get().user_version || 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    try {
      MIGRATIONS[v]();
      db.exec(`PRAGMA user_version = ${v + 1}`);
    } catch (e) {
      console.error(`[migration] v${v + 1} 失败:`, e.message);
      break;
    }
  }
}
if (!isPostgres) migrate();   // PostgreSQL 从 schema 直接建到最新结构，无需历史迁移

// ── P0-3: 索引（加速过滤、排序、快照查询）──────────────────────────
// 必须放在 migrate() 之后：索引列（如 repos.is_custom）可能由迁移补充，
// 旧库在此处建索引会因缺列而启动失败。
if (!isPostgres) db.exec(`
CREATE INDEX IF NOT EXISTS idx_snapshots_repo_captured ON snapshots(repo_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at   ON snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_repos_language          ON repos(language) WHERE language IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_repos_stars             ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_repos_is_custom         ON repos(is_custom) WHERE is_custom = 1;
CREATE INDEX IF NOT EXISTS idx_alerts_triggered        ON alerts(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unread           ON alerts(read) WHERE read = 0;
CREATE INDEX IF NOT EXISTS idx_query_members_query     ON query_members(query_id);
`);

// ── 设置读写 ──────────────────────────────────────────────────────
export function getSetting(key, fallback = null) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}

/** 一次性读取全部设置（替代逐键查询） */
export function getSettings() {
  const out = {};
  for (const { key, value } of db.prepare("SELECT key, value FROM settings").all()) out[key] = value;
  return out;
}

// ── 保存的筛选视图（C5，按用户隔离）─────────────────────────────
const MAX_VIEWS = 30;
const userKey = (base, userId) => (userId ? `${base}:${userId}` : base);

export function getSavedViews(userId = 0) {
  try {
    const v = JSON.parse(getSetting(userKey("savedViews", userId), "[]"));
    return Array.isArray(v) ? v.filter((x) => x && x.name) : [];
  } catch { return []; }
}

/** 新增/覆盖同名视图，返回最新列表 */
export function saveView({ name, filters }, userId = 0) {
  const clean = String(name || "").trim().slice(0, 40);
  if (!clean) throw new Error("视图名称不能为空");
  if (!filters || typeof filters !== "object") throw new Error("缺少筛选条件");
  const views = getSavedViews(userId).filter((v) => v.name !== clean);
  views.unshift({ name: clean, filters, savedAt: new Date().toISOString() });
  setSetting(userKey("savedViews", userId), JSON.stringify(views.slice(0, MAX_VIEWS)));
  return views.slice(0, MAX_VIEWS);
}

export function deleteView(name, userId = 0) {
  const views = getSavedViews(userId).filter((v) => v.name !== name);
  setSetting(userKey("savedViews", userId), JSON.stringify(views));
  return views;
}

// ── P4: 自定义指数（indices）────────────────────────────────
export function listIndices(userId = 0) {
  return db.prepare("SELECT id, user_id, name, spec, created_at FROM indices WHERE user_id = ? ORDER BY id DESC").all(userId)
    .map((r) => ({ ...r, spec: safeParse(r.spec) }));
}

export function getIndex(id) {
  const r = db.prepare("SELECT id, user_id, name, spec, created_at FROM indices WHERE id = ?").get(id);
  return r ? { ...r, spec: safeParse(r.spec) } : null;
}

export function addIndex(name, spec, userId = 0) {
  const clean = String(name || "").trim().slice(0, 60);
  if (!clean) throw new Error("指数名称不能为空");
  try {
    const r = db.prepare("INSERT INTO indices (name, spec, user_id) VALUES (?, ?, ?)").run(clean, JSON.stringify(spec || {}), userId);
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch {
    return { ok: false, error: "同名指数已存在" };
  }
}

export function removeIndex(id, userId = 0) {
  return db.prepare("DELETE FROM indices WHERE id = ? AND user_id = ?").run(id, userId).changes;
}

// ── P4: 生态 / topic 追踪（tracked_queries）─────────────────
export function listTrackedQueries(userId = null) {
  const sql = "SELECT id, user_id, label, query, member_count, last_run_at, created_at FROM tracked_queries";
  if (userId == null) return db.prepare(`${sql} ORDER BY id DESC`).all();
  return db.prepare(`${sql} WHERE user_id = ? ORDER BY id DESC`).all(userId);
}

export function getTrackedQuery(id) {
  return db.prepare("SELECT * FROM tracked_queries WHERE id = ?").get(id);
}

export function addTrackedQuery(label, query, userId = 0) {
  const l = String(label || "").trim().slice(0, 60);
  const q = String(query || "").trim();
  if (!l) throw new Error("名称不能为空");
  if (!q) throw new Error("搜索语法不能为空");
  try {
    const r = db.prepare("INSERT INTO tracked_queries (label, query, user_id) VALUES (?, ?, ?)").run(l, q, userId);
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch {
    return { ok: false, error: "同名追踪已存在" };
  }
}

export function removeTrackedQuery(id, userId = 0) {
  db.prepare("DELETE FROM query_members WHERE query_id = ?").run(id);
  return db.prepare("DELETE FROM tracked_queries WHERE id = ? AND user_id = ?").run(id, userId).changes;
}

/** 用最新一次抓取结果整体替换成员列表 */
export function replaceQueryMembers(queryId, repoIds, ranAt) {
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM query_members WHERE query_id = ?").run(queryId);
    const ins = db.prepare("INSERT OR IGNORE INTO query_members (query_id, repo_id) VALUES (?, ?)");
    for (const id of repoIds) ins.run(queryId, id);
    db.prepare("UPDATE tracked_queries SET member_count = ?, last_run_at = ? WHERE id = ?")
      .run(repoIds.length, ranAt || new Date().toISOString(), queryId);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getQueryMemberIds(queryId) {
  return db.prepare("SELECT repo_id FROM query_members WHERE query_id = ?").all(queryId).map((r) => r.repo_id);
}

// ── Web Push 订阅 ─────────────────────────────────────
export function listPushSubscriptions(userId = null) {
  const sql = "SELECT id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_ok_at, last_error FROM push_subscriptions";
  if (userId == null) return db.prepare(sql).all();
  return db.prepare(`${sql} WHERE user_id = ?`).all(userId);
}

export function countPushSubscriptions(userId = null) {
  if (userId == null) return db.prepare("SELECT COUNT(*) c FROM push_subscriptions").get().c;
  return db.prepare("SELECT COUNT(*) c FROM push_subscriptions WHERE user_id = ?").get(userId).c;
}

export function addPushSubscription({ endpoint, p256dh, auth, userAgent, userId = 0 }) {
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, user_id) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, user_id = excluded.user_id`
  ).run(endpoint, p256dh, auth, userAgent || null, userId);
}

export function removePushSubscriptionById(id) {
  db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
}

export function removePushSubscriptionByEndpoint(endpoint, userId = null) {
  if (userId == null) db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  else db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(endpoint, userId);
}

// ── P5: 用户与会话 ──────────────────────────────────
export function countUsers() {
  return db.prepare("SELECT COUNT(*) c FROM users").get().c;
}

export function listUsers() {
  return db.prepare("SELECT id, username, role, created_at FROM users ORDER BY id ASC").all();
}

export function getUser(id) {
  return db.prepare("SELECT id, username, role, created_at FROM users WHERE id = ?").get(id);
}

export function getUserByName(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(String(username || "").trim());
}

export function createUser({ username, passwordHash, role = "member" }) {
  const name = String(username || "").trim().slice(0, 40);
  if (!name) throw new Error("用户名不能为空");
  if (!/^[\w.-]{2,40}$/.test(name)) throw new Error("用户名只能包含字母、数字、下划线、点或横线（2-40 位）");
  try {
    const r = db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)")
      .run(name, passwordHash, role === "admin" ? "admin" : "member");
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch {
    return { ok: false, error: "用户名已存在" };
  }
}

export function deleteUser(id) {
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(id);
  return db.prepare("DELETE FROM users WHERE id = ?").run(id).changes;
}

export function setUserPassword(id, passwordHash) {
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, id);
}

export function setUserRole(id, role) {
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role === "admin" ? "admin" : "member", id);
}

export function createSession({ token, userId, expiresAt, userAgent }) {
  db.prepare("INSERT INTO sessions (token, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)")
    .run(token, userId, expiresAt, userAgent || null);
}

/** 取会话及其用户；过期则删除并返回 undefined */
export function getSession(token) {
  if (!token) return undefined;
  const row = db.prepare(
    `SELECT s.token, s.expires_at, u.id AS user_id, u.username, u.role
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
  ).get(token);
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
    return undefined;
  }
  return row;
}

export function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function purgeExpiredSessions() {
  return db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString()).changes;
}

export function markPushOk(id) {
  db.prepare("UPDATE push_subscriptions SET last_ok_at = ?, last_error = NULL WHERE id = ?")
    .run(new Date().toISOString(), id);
}

export function markPushError(id, error) {
  db.prepare("UPDATE push_subscriptions SET last_error = ? WHERE id = ?").run(String(error || "").slice(0, 200), id);
}

function safeParse(s) {
  try { return JSON.parse(s || "{}"); } catch { return {}; }
}

export function setSetting(key, value) {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, String(value));
}

export function closeDb() {
  try { db.close(); } catch {}
}

// ── 自定义仓库 ────────────────────────────────────────────────────
// 附带仓库健康状态（stale / last_error），便于前端提示“已失效”
const CUSTOM_SELECT = `SELECT c.*, r.stale, r.stale_since, r.last_error, r.stars, r.language
  FROM custom_repos c LEFT JOIN repos r ON r.full_name = c.full_name`;

export function listCustomRepos({ limit = null, offset = 0, userId = 0 } = {}) {
  const sql = `${CUSTOM_SELECT} WHERE c.user_id = ? ORDER BY c.added_at DESC`;
  const rows = limit == null
    ? db.prepare(sql).all(userId)
    : db.prepare(`${sql} LIMIT ? OFFSET ?`).all(userId, limit, offset);
  return rows.map((r) => ({ ...r, stale: Boolean(r.stale) }));
}

export function countCustomRepos(userId = 0) {
  return db.prepare("SELECT COUNT(*) c FROM custom_repos WHERE user_id = ?").get(userId).c;
}

export function addCustomRepo(fullName, note = "", userId = 0) {
  try {
    db.prepare("INSERT INTO custom_repos (full_name, user_note, user_id) VALUES (?, ?, ?)").run(fullName.trim(), note.trim(), userId);
    return true;
  } catch {
    return false;
  }
}

export function removeCustomRepo(fullName, userId = 0) {
  db.prepare("DELETE FROM custom_repos WHERE full_name = ? AND user_id = ?").run(fullName, userId);
  // 仅当再没有任何用户追踪该仓库时，才清除标记
  const stillTracked = db.prepare("SELECT 1 FROM custom_repos WHERE full_name = ?").get(fullName);
  if (!stillTracked) db.prepare("UPDATE repos SET is_custom = 0 WHERE full_name = ?").run(fullName);
}

export function searchCustomRepo(fullName, userId = 0) {
  return db.prepare("SELECT * FROM custom_repos WHERE full_name = ? AND user_id = ?").get(fullName.trim(), userId);
}

export function allCustomRepoNames(userId = 0) {
  return db.prepare("SELECT full_name FROM custom_repos WHERE user_id = ?").all(userId);
}

// ── 收藏 ──────────────────────────────────────────────────────────
export function toggleFavorite(repoId, userId = 0) {
  if (!db.prepare("SELECT id FROM repos WHERE id = ?").get(repoId)) {
    return { error: "仓库不存在", added: false };
  }
  try {
    db.prepare("INSERT INTO favorites (repo_id, user_id) VALUES (?, ?)").run(repoId, userId);
    return { added: true };
  } catch {
    db.prepare("DELETE FROM favorites WHERE repo_id = ? AND user_id = ?").run(repoId, userId);
    return { added: false };
  }
}

// P2-10: 收藏分页（按用户隔离）
export function listFavorites({ limit = null, offset = 0, userId = 0 } = {}) {
  const base = `SELECT r.*, f.added_at FROM repos r JOIN favorites f ON f.repo_id = r.id
    WHERE f.user_id = ? ORDER BY f.added_at DESC`;
  if (limit == null) return db.prepare(base).all(userId);
  return db.prepare(`${base} LIMIT ? OFFSET ?`).all(userId, limit, offset);
}

export function countFavorites(userId = 0) {
  return db.prepare("SELECT COUNT(*) c FROM favorites WHERE user_id = ?").get(userId).c;
}

// ── 告警 ──────────────────────────────────────────────────────────
export function getAlertsUnreadCount(userId = 0) {
  return db.prepare("SELECT COUNT(*) c FROM alerts WHERE read = 0 AND user_id = ?").get(userId).c;
}

export function markAlertsRead(userId = 0) {
  db.prepare("UPDATE alerts SET read = 1 WHERE read = 0 AND user_id = ?").run(userId);
}

export function getRecentAlerts(limit = 20, offset = 0, userId = 0) {
  return db.prepare(
    `SELECT a.*, r.full_name, r.stars AS current_stars
     FROM alerts a JOIN repos r ON r.id = a.repo_id
     WHERE a.user_id = ?
     ORDER BY a.triggered_at DESC LIMIT ? OFFSET ?`
  ).all(userId, limit, offset);
}

export function hasRecentAlert(repoId, withinHours = 2, kind = null, userId = 0) {
  // 用 ISO 基准与 ISO 存储值比较（见 windows.js isoOffset 注释）
  const cutoff = new Date(Date.now() - withinHours * 3600 * 1000).toISOString();
  if (kind) {
    return db.prepare(
      "SELECT id FROM alerts WHERE repo_id = ? AND triggered_at > ? AND kind = ? AND user_id = ?"
    ).get(repoId, cutoff, kind, userId) !== undefined;
  }
  return db.prepare(
    "SELECT id FROM alerts WHERE repo_id = ? AND triggered_at > ? AND user_id = ?"
  ).get(repoId, cutoff, userId) !== undefined;
}

export function insertAlert(repoId, threshold, growth, currentStars, { kind = "growth", message = null, userId = 0 } = {}) {
  db.prepare(
    "INSERT INTO alerts (repo_id, threshold, growth, current_stars, kind, message, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(repoId, threshold, growth, currentStars, kind, message, userId);
}

// ── API 配额 ──────────────────────────────────────────────────────
export function recordApiUsage(used, limit, lastRefreshAt) {
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO api_stats (date, requests_used, requests_limit, last_refresh_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       requests_used = excluded.requests_used,
       requests_limit = excluded.requests_limit,
       last_refresh_at = excluded.last_refresh_at`
  ).run(today, used, limit, lastRefreshAt);
}

export function getApiQuotaInfo() {
  const row = db.prepare(
    "SELECT requests_used, requests_limit FROM api_stats ORDER BY id DESC LIMIT 1"
  ).get();
  if (!row) return { used: 0, limit: 60, pct: 0 };
  return {
    used: row.requests_used,
    limit: row.requests_limit,
    pct: row.requests_limit ? Math.round(row.requests_used / row.requests_limit * 100) : 0,
  };
}

// ── 备份 ──────────────────────────────────────────────────────────
const MAX_BACKUPS = 5;

export function exportDb() {
  if (isPostgres) {
    throw new Error("PostgreSQL 模式不支持 .db 文件导出，请使用 JSON 导出（?format=json）或 pg_dump");
  }
  const dbDir = dirname(dbPath);
  const backupPath = join(dbDir, `tracker-backup-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "-")}.db`);
  // VACUUM INTO 生成一致性快照，且兼容 WAL 模式（直接 copy 可能拷到半写状态）
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  try {
    const backups = readdirSync(dbDir)
      .filter((f) => f.startsWith("tracker-backup-") && f.endsWith(".db"))
      .map((f) => ({ f, t: statSync(join(dbDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of backups.slice(MAX_BACKUPS)) {
      try { unlinkSync(join(dbDir, f)); } catch {}
    }
  } catch {}
  return backupPath;
}

// ── 调度状态持久化 ────────────────────────────────────────────────
export function saveScheduledState(data) {
  const pairs = [
    ["last_auto_at", data.lastAutoAt],
    ["last_auto_ok", data.lastAutoOk === true ? "1" : data.lastAutoOk === false ? "0" : null],
    ["last_auto_message", data.lastAutoMessage],
  ];
  const stmt = db.prepare("INSERT OR REPLACE INTO scheduled_state (key, value) VALUES (?, ?)");
  for (const [k, v] of pairs) {
    if (v !== null && v !== undefined) stmt.run(k, String(v));
  }
}

export function loadScheduledState() {
  const rows = db.prepare("SELECT key, value FROM scheduled_state").all();
  const state = {};
  for (const { key, value } of rows) state[key] = value;
  return state;
}

export function getRetentionDays() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'retentionDays'").get();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? Math.max(7, Math.min(365, n)) : 90;
}

export function cleanupOldSnapshots(days) {
  const d = String(new Date(Date.now() - days * 86400000).toISOString());
  return db.prepare("DELETE FROM snapshots WHERE captured_at < ?").run(d).changes;
}

/**
 * 快照降采样（rollup）：把 N 天前的快照从「每天多条」压缩为「每周一条」。
 * 保留每周最后一条，删除其余。长期部署下显著降低存储而不丢长期趋势。
 * @param {number} dailyDays 保留逐日精度的天数
 * @returns {{scanned:number, removed:number}}
 */
export function rollupOldSnapshots(dailyDays = 30) {
  const d = Math.max(1, Number(dailyDays) || 30);
  const cutoff = new Date(Date.now() - d * 86400000).toISOString();
  const scanned = db.prepare("SELECT COUNT(*) c FROM snapshots WHERE captured_at < ?").get(cutoff).c;
  if (!scanned) return { scanned: 0, removed: 0 };
  const removed = db.prepare(`
    DELETE FROM snapshots WHERE id IN (
      SELECT id FROM (
        SELECT id, ROW_NUMBER() OVER (
          PARTITION BY repo_id, strftime('%Y-%W', captured_at) ORDER BY captured_at DESC
        ) AS rn
        FROM snapshots WHERE captured_at < ?
      ) AS sq WHERE rn > 1
    )
  `).run(cutoff).changes;
  return { scanned, removed };
}

// ── 仓库健康：重命名 / 删除检测 ─────────────────────────────────

export function markRepoStale(fullName, error = null) {
  db.prepare(
    `UPDATE repos SET stale = 1, stale_since = COALESCE(stale_since, ?), last_error = ?
     WHERE full_name = ?`
  ).run(new Date().toISOString(), error, fullName);
}

export function clearRepoStale(fullName) {
  db.prepare("UPDATE repos SET stale = 0, stale_since = NULL, last_error = NULL WHERE full_name = ?").run(fullName);
}

/**
 * 仓库改名：把旧名下的历史（快照/收藏/告警/成员）整体迁移到新名，
 * 避免出现一条断档的新记录。
 * @returns {{renamed:boolean, merged:boolean}}
 */
export function renameRepo(oldName, newName) {
  if (!oldName || !newName || oldName === newName) return { renamed: false, merged: false };
  const oldRow = db.prepare("SELECT id FROM repos WHERE full_name = ?").get(oldName);
  const newRow = db.prepare("SELECT id FROM repos WHERE full_name = ?").get(newName);

  db.exec("BEGIN");
  try {
    let merged = false;
    if (oldRow && newRow && oldRow.id !== newRow.id) {
      // 新旧两条记录都存在 → 合并到新记录
      merged = true;
      const o = oldRow.id, n = newRow.id;
      db.prepare("UPDATE snapshots SET repo_id = ? WHERE repo_id = ?").run(n, o);
      db.prepare("INSERT OR IGNORE INTO favorites (repo_id, added_at) SELECT ?, added_at FROM favorites WHERE repo_id = ?").run(n, o);
      db.prepare("DELETE FROM favorites WHERE repo_id = ?").run(o);
      db.prepare("UPDATE alerts SET repo_id = ? WHERE repo_id = ?").run(n, o);
      db.prepare("INSERT OR IGNORE INTO query_members (query_id, repo_id) SELECT query_id, ? FROM query_members WHERE repo_id = ?").run(n, o);
      db.prepare("DELETE FROM query_members WHERE repo_id = ?").run(o);
      db.prepare("DELETE FROM repos WHERE id = ?").run(o);
    } else if (oldRow) {
      db.prepare("UPDATE repos SET full_name = ? WHERE id = ?").run(newName, oldRow.id);
    }
    db.prepare("UPDATE custom_repos SET full_name = ? WHERE full_name = ?").run(newName, oldName);
    db.exec("COMMIT");
    return { renamed: Boolean(oldRow), merged };
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

// ── P2-8: 批量查询 repo id（消除 N+1）─────────────────────────────
export function getRepoIdMap(names) {
  const map = new Map();
  if (!names.length) return map;
  // 分批查询，避免 SQLite 变量上限（默认 999）
  const CHUNK = 500;
  const stmt = db.prepare("SELECT id, full_name FROM repos WHERE full_name = ?");
  for (let i = 0; i < names.length; i += CHUNK) {
    for (const name of names.slice(i, i + CHUNK)) {
      const row = stmt.get(name);
      if (row) map.set(name, row.id);
    }
  }
  return map;
}

// ── P3: 外部指标 CRUD ─────────────────────────────────────────────
export function listTrackedMetrics() {
  return db.prepare("SELECT * FROM tracked_metrics ORDER BY updated_at DESC").all();
}

export function countTrackedMetrics() {
  return db.prepare("SELECT COUNT(*) c FROM tracked_metrics").get().c;
}

export function addTrackedMetric({ source, key, label, url, unit }) {
  try {
    const r = db.prepare(
      "INSERT INTO tracked_metrics (source, key, label, url, unit) VALUES (?, ?, ?, ?, ?)"
    ).run(source, key, label || key, url || null, unit || null);
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch {
    return { ok: false, error: "该指标已在追踪列表中" };
  }
}

export function removeTrackedMetric(id) {
  db.prepare("DELETE FROM tracked_metrics WHERE id = ?").run(id);
}

export function getTrackedMetric(id) {
  return db.prepare("SELECT * FROM tracked_metrics WHERE id = ?").get(id);
}

export function updateTrackedMetricValue(id, value, label, url, unit) {
  db.prepare(
    `UPDATE tracked_metrics
     SET current_value = ?, label = COALESCE(?, label), url = COALESCE(?, url), unit = COALESCE(?, unit),
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
     WHERE id = ?`
  ).run(value, label ?? null, url ?? null, unit ?? null, id);
}

export function insertMetricSnapshot(metricId, value, capturedAt) {
  db.prepare("INSERT INTO metric_snapshots (metric_id, value, captured_at) VALUES (?, ?, ?)").run(metricId, value, capturedAt);
}

export function getMetricSnapshots(metricId) {
  return db.prepare(
    "SELECT value, captured_at FROM metric_snapshots WHERE metric_id = ? ORDER BY captured_at ASC"
  ).all(metricId);
}

// ── JSON 导出 / 导入（可跨实例迁移、合并或覆盖恢复）───────────────
// 所有关联均使用自然键（full_name / source+key），不依赖本地自增 id，因此可跨库导入。
// 每条查询都显式 ORDER BY 自然键：SQLite 与 PostgreSQL 的行序不同，
// 不排序会让同一份数据的导出结果不可比，也无法用 diff 校验迁移结果。
const EXPORT_VERSION = 2;

export function exportData() {
  return {
    version: EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    settings: db.prepare("SELECT key, value FROM settings ORDER BY key").all(),
    custom_repos: db.prepare("SELECT full_name, user_note, added_at FROM custom_repos ORDER BY user_id, full_name").all(),
    repos: db.prepare(
      `SELECT full_name, owner, name, url, description, language, homepage,
              stars, forks, open_issues, gh_created_at, first_seen_at, updated_at, is_custom
       FROM repos
       ORDER BY full_name`
    ).all(),
    snapshots: db.prepare(
      `SELECT r.full_name, s.stars, s.forks, s.open_issues, s.captured_at
       FROM snapshots s JOIN repos r ON r.id = s.repo_id
       ORDER BY r.full_name, s.captured_at`
    ).all(),
    favorites: db.prepare(
      `SELECT r.full_name, f.added_at FROM favorites f JOIN repos r ON r.id = f.repo_id ORDER BY r.full_name, f.added_at`
    ).all(),
    alerts: db.prepare(
      `SELECT r.full_name, a.threshold, a.growth, a.current_stars, a.triggered_at, a.read, a.kind, a.message
       FROM alerts a JOIN repos r ON r.id = a.repo_id
       ORDER BY r.full_name, a.triggered_at, a.id`
    ).all(),
    tracked_metrics: db.prepare(
      `SELECT source, key, label, url, unit, current_value, first_seen_at, updated_at FROM tracked_metrics
       ORDER BY source, key`
    ).all(),
    metric_snapshots: db.prepare(
      `SELECT m.source, m.key, ms.value, ms.captured_at
       FROM metric_snapshots ms JOIN tracked_metrics m ON m.id = ms.metric_id
       ORDER BY m.source, m.key, ms.captured_at`
    ).all(),
    indices: db.prepare("SELECT user_id, name, spec, created_at FROM indices ORDER BY user_id, name").all(),
    tracked_queries: db.prepare(
      "SELECT user_id, label, query, member_count, last_run_at, created_at FROM tracked_queries ORDER BY user_id, label"
    ).all(),
    query_members: db.prepare(
      `SELECT q.user_id, q.label, r.full_name
       FROM query_members qm JOIN tracked_queries q ON q.id = qm.query_id
       JOIN repos r ON r.id = qm.repo_id
       ORDER BY q.user_id, q.label, r.full_name`
    ).all(),
    push_subscriptions: db.prepare(
      `SELECT user_id, endpoint, p256dh, auth, user_agent, created_at, last_ok_at, last_error
       FROM push_subscriptions
       ORDER BY user_id, endpoint`
    ).all(),
    users: db.prepare("SELECT id, username, password_hash, role, created_at FROM users ORDER BY username").all(),
  };
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/**
 * 导入 exportData() 的产物。默认 merge（保留现有数据，只补缺失），replace 则先清空。
 * @returns {{mode:string, counts:object}}
 */
export function importData(data, { mode = "merge" } = {}) {
  if (!data || typeof data !== "object") throw new Error("无效的导入数据");
  const arr = (v) => (Array.isArray(v) ? v : []);
  const counts = {
    repos: 0, snapshots: 0, custom_repos: 0, favorites: 0, alerts: 0, settings: 0,
    tracked_metrics: 0, metric_snapshots: 0, indices: 0, tracked_queries: 0,
    query_members: 0, push_subscriptions: 0, users: 0,
  };

  db.exec("BEGIN");
  try {
    if (mode === "replace") {
      db.exec("DELETE FROM query_members; DELETE FROM tracked_queries; DELETE FROM indices;");
      db.exec("DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM users;");
      db.exec("DELETE FROM metric_snapshots; DELETE FROM tracked_metrics; DELETE FROM alerts; DELETE FROM favorites;");
      db.exec("DELETE FROM snapshots; DELETE FROM custom_repos; DELETE FROM repos;");
    }

    const setStmt = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    for (const s of arr(data.settings)) {
      if (!s || s.key == null) continue;
      setStmt.run(String(s.key), s.value == null ? null : String(s.value));
      counts.settings++;
    }

    const crStmt = db.prepare(
      `INSERT OR IGNORE INTO custom_repos (full_name, user_note, added_at) VALUES (?, ?, COALESCE(?, ${NOW_SQL}))`
    );
    for (const c of arr(data.custom_repos)) {
      if (!c?.full_name) continue;
      crStmt.run(c.full_name, c.user_note ?? null, c.added_at ?? null);
      counts.custom_repos++;
    }

    const repoStmt = db.prepare(
      `INSERT INTO repos (full_name, owner, name, url, description, language, homepage, stars, forks, open_issues, gh_created_at, first_seen_at, updated_at, is_custom)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, ${NOW_SQL}), COALESCE(?, ${NOW_SQL}), COALESCE(?, 0))
       ON CONFLICT(full_name) DO UPDATE SET
         stars       = MAX(repos.stars, excluded.stars),
         forks       = MAX(repos.forks, excluded.forks),
         open_issues = MAX(repos.open_issues, excluded.open_issues),
         is_custom   = MAX(repos.is_custom, excluded.is_custom)`
    );
    for (const r of arr(data.repos)) {
      if (!r?.full_name) continue;
      repoStmt.run(
        r.full_name, r.owner ?? null, r.name ?? null, r.url ?? null, r.description ?? null,
        r.language ?? null, r.homepage ?? null, r.stars ?? 0, r.forks ?? 0, r.open_issues ?? 0,
        r.gh_created_at ?? null, r.first_seen_at ?? null, r.updated_at ?? null, r.is_custom ? 1 : 0
      );
      counts.repos++;
    }

    const idMap = new Map(db.prepare("SELECT id, full_name FROM repos").all().map((r) => [r.full_name, r.id]));

    const snapStmt = db.prepare(
      `INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at)
       SELECT ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM snapshots WHERE repo_id = ? AND captured_at = ? AND stars = ?)`
    );
    for (const s of arr(data.snapshots)) {
      const rid = idMap.get(s?.full_name);
      if (!rid || !s.captured_at) continue;
      snapStmt.run(rid, s.stars ?? 0, s.forks ?? 0, s.open_issues ?? 0, s.captured_at, rid, s.captured_at, s.stars ?? 0);
      counts.snapshots++;
    }

    const favStmt = db.prepare(
      `INSERT OR IGNORE INTO favorites (repo_id, added_at) VALUES (?, COALESCE(?, ${NOW_SQL}))`
    );
    for (const f of arr(data.favorites)) {
      const rid = idMap.get(f?.full_name);
      if (!rid) continue;
      favStmt.run(rid, f.added_at ?? null);
      counts.favorites++;
    }

    const alertStmt = db.prepare(
      `INSERT INTO alerts (repo_id, threshold, growth, current_stars, triggered_at, read, kind, message)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM alerts WHERE repo_id = ? AND triggered_at = ? AND growth = ?)`
    );
    for (const a of arr(data.alerts)) {
      const rid = idMap.get(a?.full_name);
      if (!rid || !a.triggered_at) continue;
      alertStmt.run(
        rid, a.threshold ?? 0, a.growth ?? 0, a.current_stars ?? 0, a.triggered_at,
        a.read ? 1 : 0, a.kind || "growth", a.message ?? null,
        rid, a.triggered_at, a.growth ?? 0
      );
      counts.alerts++;
    }

    const metricStmt = db.prepare(
      `INSERT OR IGNORE INTO tracked_metrics (source, key, label, url, unit, current_value, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, ${NOW_SQL}), COALESCE(?, ${NOW_SQL}))`
    );
    for (const m of arr(data.tracked_metrics)) {
      if (!m?.source || !m.key) continue;
      metricStmt.run(m.source, m.key, m.label ?? m.key, m.url ?? null, m.unit ?? null, m.current_value ?? null, m.first_seen_at ?? null, m.updated_at ?? null);
      counts.tracked_metrics++;
    }

    const metricMap = new Map(
      db.prepare("SELECT id, source, key FROM tracked_metrics").all().map((m) => [`${m.source}\n${m.key}`, m.id])
    );
    const msStmt = db.prepare(
      `INSERT INTO metric_snapshots (metric_id, value, captured_at)
       SELECT ?, ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM metric_snapshots WHERE metric_id = ? AND captured_at = ? AND value = ?)`
    );
    for (const ms of arr(data.metric_snapshots)) {
      const mid = metricMap.get(`${ms?.source}\n${ms?.key}`);
      if (!mid || !ms.captured_at || typeof ms.value !== "number") continue;
      msStmt.run(mid, ms.value, ms.captured_at, mid, ms.captured_at, ms.value);
      counts.metric_snapshots++;
    }

    // 用户
    const userStmt = db.prepare(
      `INSERT INTO users (username, password_hash, role, created_at)
       VALUES (?, ?, ?, COALESCE(?, ${NOW_SQL}))
       ON CONFLICT(username) DO NOTHING`
    );
    for (const u of arr(data.users)) {
      if (!u?.username || !u.password_hash) continue;
      userStmt.run(u.username, u.password_hash, u.role === "admin" ? "admin" : "member", u.created_at ?? null);
      counts.users++;
    }

    // 指数
    const idxStmt = db.prepare(
      `INSERT INTO indices (user_id, name, spec, created_at)
       VALUES (?, ?, ?, COALESCE(?, ${NOW_SQL}))
       ON CONFLICT(user_id, name) DO NOTHING`
    );
    for (const i of arr(data.indices)) {
      if (!i?.name) continue;
      idxStmt.run(i.user_id ?? 0, i.name, typeof i.spec === "string" ? i.spec : JSON.stringify(i.spec || {}), i.created_at ?? null);
      counts.indices++;
    }

    // 生态/ topic 追踪
    const qStmt = db.prepare(
      `INSERT INTO tracked_queries (user_id, label, query, member_count, last_run_at, created_at)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, ${NOW_SQL}))
       ON CONFLICT(user_id, label) DO NOTHING`
    );
    for (const q of arr(data.tracked_queries)) {
      if (!q?.label) continue;
      qStmt.run(q.user_id ?? 0, q.label, q.query || "", q.member_count ?? 0, q.last_run_at ?? null, q.created_at ?? null);
      counts.tracked_queries++;
    }

    // 追踪成员（按 user_id + label 与 full_name 还原）
    const queryIdMap = new Map(
      db.prepare("SELECT id, user_id, label FROM tracked_queries").all().map((q) => [`${q.user_id}\n${q.label}`, q.id])
    );
    const qmStmt = db.prepare(
      `INSERT INTO query_members (query_id, repo_id) SELECT ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM query_members WHERE query_id = ? AND repo_id = ?)`
    );
    for (const m of arr(data.query_members)) {
      const qid = queryIdMap.get(`${m?.user_id ?? 0}\n${m?.label}`);
      const rid = idMap.get(m?.full_name);
      if (!qid || !rid) continue;
      qmStmt.run(qid, rid, qid, rid);
      counts.query_members++;
    }

    // 推送订阅
    const pushStmt = db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_ok_at, last_error)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, ${NOW_SQL}), ?, ?)
       ON CONFLICT(endpoint) DO NOTHING`
    );
    for (const p of arr(data.push_subscriptions)) {
      if (!p?.endpoint || !p.p256dh || !p.auth) continue;
      pushStmt.run(p.user_id ?? 0, p.endpoint, p.p256dh, p.auth, p.user_agent ?? null, p.created_at ?? null, p.last_ok_at ?? null, p.last_error ?? null);
      counts.push_subscriptions++;
    }

    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { mode, counts };
}
