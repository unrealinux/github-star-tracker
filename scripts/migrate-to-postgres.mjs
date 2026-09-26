#!/usr/bin/env node
/**
 * 把现有 SQLite 数据迁移到 PostgreSQL。
 *
 * 用法：
 *   node scripts/migrate-to-postgres.mjs                     # 内嵌 PGlite → data/pg
 *   node scripts/migrate-to-postgres.mjs --pg-data-dir /path/to/pg
 *   node scripts/migrate-to-postgres.mjs --database-url postgres://user:pass@host/db
 *   node scripts/migrate-to-postgres.mjs --from /path/to/tracker.db
 *
 * 迁移是「合并」语义：已存在的记录不会重复写入（用户/指数/追踪/订阅按唯一键去重）。
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const from = resolve(opt("--from", "data/tracker.db"));
const databaseUrl = opt("--database-url", process.env.DATABASE_URL || "");
const pgDataDir = opt("--pg-data-dir", process.env.PG_DATA_DIR || "");

if (!existsSync(from)) {
  console.error(`✗ 找不到 SQLite 文件：${from}`);
  process.exit(1);
}
if (!databaseUrl && !pgDataDir) {
  console.error("✗ 需要指定 --database-url（外部 PostgreSQL）或 --pg-data-dir（内嵌 PGlite）");
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
console.log(`→ 源 SQLite：${from}`);
console.log(
  `→ 目标：${databaseUrl ? `外部 PostgreSQL (${databaseUrl.replace(/:[^:@/]+@/, ":***@")})` : `内嵌 PGlite (${pgDataDir})`}`,
);

// 1) 从 SQLite 导出 JSON（子进程，避免同进程混用两种驱动）
const exp = spawnSync(process.execPath, [join(root, "scripts", "_export-sqlite.mjs")], {
  env: { ...process.env, DB_DRIVER: "sqlite", DB_PATH: from },
  encoding: "utf8",
  maxBuffer: 512 * 1024 * 1024,
});
if (exp.status !== 0) {
  console.error("✗ 导出失败：\n" + (exp.stderr || exp.stdout));
  process.exit(1);
}
let payload;
try {
  payload = JSON.parse(exp.stdout);
} catch (e) {
  console.error("✗ 导出结果不是合法 JSON：" + e.message);
  process.exit(1);
}
console.log(
  `  导出：repos=${payload.repos?.length ?? 0} snapshots=${payload.snapshots?.length ?? 0} ` +
    `users=${payload.users?.length ?? 0} indices=${payload.indices?.length ?? 0}`,
);

// 2) 导入 PostgreSQL
const imp = spawnSync(process.execPath, [join(root, "scripts", "_import-postgres.mjs")], {
  env: {
    ...process.env,
    DB_DRIVER: "postgres",
    DATABASE_URL: databaseUrl,
    PG_DATA_DIR: pgDataDir || process.env.PG_DATA_DIR || "",
  },
  input: exp.stdout,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (imp.status !== 0) {
  console.error("✗ 导入失败：\n" + (imp.stderr || imp.stdout));
  process.exit(1);
}
console.log("✓ " + (imp.stdout || "").trim());
console.log("完成。之后用 DB_DRIVER=postgres 启动服务即可。");
