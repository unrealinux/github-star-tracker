/**
 * PostgreSQL 增量迁移
 *
 * 背景：SQLite 用 `PRAGMA user_version` 记录迁移版本（见 src/db.js），
 * 而 PostgreSQL 早期只跑 `CREATE TABLE IF NOT EXISTS`：一旦以后给 schema 加列，
 * 已存在的库不会被升级，启动后查询就会报 `column ... does not exist`。
 *
 * 这里给 PG 补上同样的版本化迁移能力：
 *   - `schema_migrations` 表记录已应用版本
 *   - 全新库：直接建最新 schema，并把全部迁移标记为已应用
 *   - 既有库：从当前版本逐条补齐到最新
 *
 * 约定：每个迁移必须**幂等**（`ADD COLUMN IF NOT EXISTS` / `DROP ... IF EXISTS`），
 * 因为引入本机制之前就已存在的库没有版本记录，会被当作 version 0 从头补齐。
 * 新增 schema 变更时，请在 SQLite 的 MIGRATIONS（src/db.js）与这里各追加一条。
 */
import { POSTGRES_SCHEMA } from "./schema.postgres.js";

const NOW = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

/**
 * 与 SQLite `MIGRATIONS` 一一对应的 PostgreSQL 迁移。
 * 数组下标 i 对应版本 i+1。
 */
export const POSTGRES_MIGRATIONS = [
  // v1: 删除废弃的 retention_config 表（保留天数已改存 settings）
  (db) => db.exec("DROP TABLE IF EXISTS retention_config;"),

  // v2: 多指标支持（forks / open_issues）
  (db) => db.exec(`
    ALTER TABLE IF EXISTS repos ADD COLUMN IF NOT EXISTS forks       INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS repos ADD COLUMN IF NOT EXISTS open_issues INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS snapshots ADD COLUMN IF NOT EXISTS forks       INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS snapshots ADD COLUMN IF NOT EXISTS open_issues INTEGER NOT NULL DEFAULT 0;
  `),

  // v3: 规则化告警（kind / message）
  (db) => db.exec(`
    ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS kind    TEXT NOT NULL DEFAULT 'growth';
    ALTER TABLE IF EXISTS alerts ADD COLUMN IF NOT EXISTS message TEXT;
  `),

  // v4: 仓库健康状态（重命名 / 删除检测）
  (db) => db.exec(`
    ALTER TABLE IF EXISTS repos ADD COLUMN IF NOT EXISTS stale       INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS repos ADD COLUMN IF NOT EXISTS stale_since TEXT;
    ALTER TABLE IF EXISTS repos ADD COLUMN IF NOT EXISTS last_error  TEXT;
  `),

  // v5: 多用户（user_id 作用域化）
  (db) => db.exec(`
    ALTER TABLE IF EXISTS favorites          ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS custom_repos       ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS tracked_queries    ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS indices            ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS alerts             ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE IF EXISTS push_subscriptions ADD COLUMN IF NOT EXISTS user_id INTEGER NOT NULL DEFAULT 0;
  `),

  // v6: 自定义仓库标记（repos.is_custom）
  (db) => db.exec("ALTER TABLE IF EXISTS repos ADD COLUMN IF NOT EXISTS is_custom INTEGER NOT NULL DEFAULT 0;"),
];

function markApplied(db, version) {
  db.prepare("INSERT INTO schema_migrations (version) VALUES (?) ON CONFLICT (version) DO NOTHING").run(version);
}

function appliedVersion(db) {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get();
  return Number(row?.v) || 0;
}

/**
 * 确保 PostgreSQL 库结构与当前代码一致。
 * @returns {{ fresh: boolean, from: number, to: number }}
 */
export function migratePostgres(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (${NOW})
  );`);

  // 用 to_regclass 判断是否已建库（不依赖 information_schema，且库不存在时也安全）
  const hasRepos = Boolean(db.prepare("SELECT to_regclass('repos') AS t").get()?.t);
  const latest = POSTGRES_MIGRATIONS.length;

  if (!hasRepos) {
    // 全新库：schema.postgres.js 已是最新结构，直接标记全部迁移为已应用
    db.exec(POSTGRES_SCHEMA);
    for (let v = 1; v <= latest; v++) markApplied(db, v);
    return { fresh: true, from: 0, to: latest };
  }

  const from = appliedVersion(db);
  for (let v = from; v < latest; v++) {
    // 每条迁移 + 版本标记作为一个事务：中途失败就整条回滚，避免半迁移状态
    db.exec("BEGIN");
    try {
      POSTGRES_MIGRATIONS[v](db);
      markApplied(db, v + 1);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`PostgreSQL 迁移 v${v + 1} 失败: ${e.message}`);
    }
  }
  return { fresh: false, from, to: latest };
}
