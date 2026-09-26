/**
 * PostgreSQL 迁移回归测试（node:test，零依赖，走内嵌 PGlite）
 * 运行：npm run test:postgres
 *
 * 背景：SQLite 有 `PRAGMA user_version` 版本化迁移，PostgreSQL 早期只跑
 * `CREATE TABLE IF NOT EXISTS`——一旦 schema 加列，已存在的 PG 库不会升级，
 * 启动后查询直接报 `column ... does not exist`。
 * 这里验证 PG 侧的 migratePostgres：
 *   - 全新库建到最新并标记全部迁移
 *   - 既有库（无版本记录 / 中间版本）能补齐缺失列且保留数据
 *   - 重复执行幂等
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresDriver } from "../src/dbdriver/postgres.js";
import { migratePostgres, POSTGRES_MIGRATIONS } from "../src/dbdriver/migrate.postgres.js";

const LATEST = POSTGRES_MIGRATIONS.length;
// v6 引入 repos.is_custom（见 migrate.postgres.js），用于模拟“停在中间版本”的库
const IS_CUSTOM_VERSION = 6;

const columnNames = (db, table) =>
  db
    .prepare("SELECT column_name FROM information_schema.columns WHERE table_name = ?")
    .all(table)
    .map((r) => r.column_name);

describe("PostgreSQL 迁移", () => {
  let root;
  before(() => {
    root = mkdtempSync(join(tmpdir(), "gst-pgmig-"));
  });
  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const open = (name) => createPostgresDriver({ dataDir: join(root, name) });

  test("全新库：建最新 schema，并把全部迁移标记为已应用", () => {
    const db = open("fresh");
    try {
      const r = migratePostgres(db);
      assert.deepEqual(r, { fresh: true, from: 0, to: LATEST });

      const applied = db.prepare("SELECT COUNT(*) c FROM schema_migrations").get().c;
      assert.equal(applied, LATEST, "全部迁移都应被标记为已应用");

      const cols = columnNames(db, "repos");
      for (const col of ["forks", "open_issues", "stale", "stale_since", "last_error", "is_custom"]) {
        assert.ok(cols.includes(col), `repos 缺少列 ${col}`);
      }
      const idx = db
        .prepare("SELECT indexname FROM pg_indexes WHERE tablename = 'repos'")
        .all()
        .map((x) => x.indexname);
      assert.ok(idx.includes("idx_repos_stars"), "索引应随 schema 一并创建");
    } finally {
      db.close();
    }
  });

  test("既有库缺列且无版本记录：按 version 0 补齐，且保留数据", () => {
    const db = open("legacy");
    try {
      // 先建一个最新库，写入数据
      migratePostgres(db);
      db.prepare("INSERT INTO repos (full_name, owner, name, url, stars, language) VALUES (?,?,?,?,?,?)").run(
        "facebook/react",
        "facebook",
        "react",
        "https://github.com/facebook/react",
        230000,
        "JavaScript",
      );

      // 模拟“引入迁移机制之前”的旧库：删掉后加的列，且没有 schema_migrations
      db.exec(`
        ALTER TABLE repos DROP COLUMN is_custom;
        ALTER TABLE repos DROP COLUMN stale;
        ALTER TABLE repos DROP COLUMN stale_since;
        ALTER TABLE repos DROP COLUMN last_error;
        DROP TABLE schema_migrations;
      `);

      const r = migratePostgres(db);
      assert.equal(r.from, 0, "无版本记录应从 0 开始补齐");
      assert.equal(r.fresh, false);

      const cols = columnNames(db, "repos");
      for (const col of ["stale", "stale_since", "last_error", "is_custom"]) {
        assert.ok(cols.includes(col), `迁移后仍缺少列 ${col}`);
      }
      const repo = db.prepare("SELECT full_name, stars, is_custom FROM repos").get();
      assert.equal(repo.full_name, "facebook/react");
      assert.equal(repo.stars, 230000, "既有数据必须保留");
      assert.equal(repo.is_custom, 0, "新列应有默认值");
    } finally {
      db.close();
    }
  });

  test("中间版本升级：只补缺失的迁移，且重复执行幂等", () => {
    const db = open("partial");
    try {
      migratePostgres(db);
      db.prepare("INSERT INTO repos (full_name, owner, name, url, stars) VALUES (?,?,?,?,?)").run(
        "microsoft/vscode",
        "microsoft",
        "vscode",
        "https://github.com/microsoft/vscode",
        160000,
      );

      // 回退到 v5：删掉 v6 新增的列并移除版本记录
      db.exec(`ALTER TABLE repos DROP COLUMN is_custom;`);
      db.prepare("DELETE FROM schema_migrations WHERE version >= ?").run(IS_CUSTOM_VERSION);

      const r = migratePostgres(db);
      assert.equal(r.from, IS_CUSTOM_VERSION - 1, `应从 v${IS_CUSTOM_VERSION - 1} 继续`);
      assert.ok(columnNames(db, "repos").includes("is_custom"), "v6 应把 is_custom 补回");

      // 再跑一次：已是最新，什么都不做，也不报错
      const again = migratePostgres(db);
      assert.equal(again.from, LATEST);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM schema_migrations").get().c, LATEST);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM repos").get().c, 1, "重复迁移不应复制数据");
    } finally {
      db.close();
    }
  });
});
