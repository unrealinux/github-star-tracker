/**
 * 验证 PostgreSQL 连接的 SSL 开关是否真的生效（供 CI / 本地手动验证）。
 *
 * 用法：
 *   DB_DRIVER=postgres node scripts/verify-pg-ssl.mjs <database-url> <sslmode> <expected: true|false>
 *
 * 例（连本地 TLS 版 PG）：
 *   DB_DRIVER=postgres node scripts/verify-pg-ssl.mjs \
 *     "postgres://gst:gst@127.0.0.1:5433/gst" require true
 *
 * 原理：用项目自己的驱动连上去，查 `pg_stat_ssl` 判断**这条连接**是否被 TLS 加密。
 */
process.env.DATABASE_URL = process.argv[2] || process.env.DATABASE_URL || "";
process.env.PGSSLMODE = process.argv[3] || "";
const expected = (process.argv[4] || "true") === "true";

const { db, closeDb, isPostgres } = await import("../src/db.js");

if (!isPostgres) {
  console.error("需要 DB_DRIVER=postgres");
  process.exit(2);
}

try {
  const row = db.prepare("SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()").get();
  const actual = Boolean(row?.ssl);
  console.log(`PGSSLMODE=${process.env.PGSSLMODE || "(unset)"} → pg_stat_ssl.ssl=${actual}`);
  if (actual !== expected) {
    console.error(`✗ 期望 ssl=${expected}，实际 ${actual}`);
    process.exitCode = 1;
  } else {
    console.log("✓ SSL 开关符合预期");
  }
} finally {
  closeDb();
}
