/**
 * 驱动选择：
 *   DB_DRIVER=sqlite   （默认）node:sqlite，零依赖、同步
 *   DB_DRIVER=postgres 则使用 PostgreSQL：
 *       设置了 DATABASE_URL → 连接外部 PostgreSQL（需要可选依赖 pg）
 *       否则               → 内嵌 PGlite（Postgres 16 WASM，需要可选依赖 @electric-sql/pglite）
 *
 * 两种驱动都暴露同一套同步接口：prepare().get/all/run、exec、close。
 */
import { createRequire } from "node:module";
import { createPostgresDriver } from "./postgres.js";
import { migratePostgres } from "./migrate.postgres.js";

const raw = (process.env.DB_DRIVER || "sqlite").toLowerCase();
export const driverName = ["postgres", "postgresql", "pg"].includes(raw) ? "postgres" : "sqlite";
export const isPostgres = driverName === "postgres";

export function createDriver({ sqlitePath, pgDataDir, databaseUrl = "" } = {}) {
  if (isPostgres) {
    const db = createPostgresDriver({ databaseUrl, dataDir: pgDataDir });
    migratePostgres(db);
    return db;
  }
  // 按需加载，避免 PostgreSQL 模式下也出现 node:sqlite 的实验性警告
  const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");
  const db = new DatabaseSync(sqlitePath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}
