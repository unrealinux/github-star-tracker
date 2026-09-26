/**
 * 旧库升级回归测试（node:test，零依赖）
 * 运行：npm test
 *
 * 背景：src/db.js 在**模块加载时**建表 → 迁移 → 建索引。
 * 顺序错了就会让老版本的库直接启动失败，例如：
 *   - 索引创建早于迁移，而索引列由迁移补充（repos.is_custom）→ no such column
 * 这里用真实的 v0.1.0 库结构验证升级路径，避免回归。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** v0.1.0（初始提交）的库结构：只有 repos / snapshots / settings */
const V010_SCHEMA = `
CREATE TABLE repos (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  full_name     TEXT UNIQUE NOT NULL,
  owner         TEXT,
  name          TEXT,
  url           TEXT,
  description   TEXT,
  language      TEXT,
  homepage      TEXT,
  stars         INTEGER NOT NULL DEFAULT 0,
  gh_created_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE snapshots (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stars       INTEGER NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT);
`;

/** 造一个带数据的 v0.1.0 库 */
function makeLegacyDb() {
  const dir = mkdtempSync(join(tmpdir(), "gst-migrate-"));
  const file = join(dir, "tracker.db");
  const d = new DatabaseSync(file);
  d.exec(V010_SCHEMA);
  d.exec(`INSERT INTO repos (full_name,owner,name,url,stars,language) VALUES
    ('facebook/react','facebook','react','https://github.com/facebook/react',230000,'JavaScript')`);
  d.exec(`INSERT INTO snapshots (repo_id,stars,captured_at) VALUES
    (1,229000,'2025-01-01T00:00:00Z'),(1,230000,'2025-01-08T00:00:00Z')`);
  d.exec(`INSERT INTO settings (key,value) VALUES ('minStars','500')`);
  d.close();
  return { dir, file };
}

/**
 * 在子进程中加载 src/db.js —— 迁移只在模块首次加载时执行，
 * 必须用独立进程才能模拟“服务启动一次”。
 */
function loadDb({ file, dir }) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", "await import('./src/db.js')"], {
    cwd: ROOT,
    env: { ...process.env, DB_DIR: dir, DB_PATH: file, DB_DRIVER: "" },
    encoding: "utf8",
  });
}

describe("旧库升级（v0.1.0 → 最新 schema）", () => {
  test("加载 db.js 不报错，并补齐 v0.1.0 缺失的列", () => {
    const legacy = makeLegacyDb();
    try {
      const r = loadDb(legacy);
      assert.equal(r.status, 0, `旧库启动失败:\n${r.stderr}`);

      const d = new DatabaseSync(legacy.file);
      const cols = d
        .prepare("PRAGMA table_info(repos)")
        .all()
        .map((c) => c.name);
      for (const col of ["forks", "open_issues", "stale", "stale_since", "last_error", "is_custom"]) {
        assert.ok(cols.includes(col), `repos 缺少列 ${col}（迁移未覆盖）`);
      }
      d.close();
    } finally {
      rmSync(legacy.dir, { recursive: true, force: true });
    }
  });

  test("原有仓库 / 快照 / 设置数据完整保留", () => {
    const legacy = makeLegacyDb();
    try {
      const r = loadDb(legacy);
      assert.equal(r.status, 0, `旧库启动失败:\n${r.stderr}`);

      const d = new DatabaseSync(legacy.file);
      const repo = d.prepare("SELECT full_name, stars, is_custom FROM repos").get();
      assert.equal(repo.full_name, "facebook/react");
      assert.equal(repo.stars, 230000);
      assert.equal(repo.is_custom, 0, "既有仓库应默认 is_custom = 0");
      assert.equal(d.prepare("SELECT COUNT(*) c FROM snapshots").get().c, 2);
      assert.equal(d.prepare("SELECT value FROM settings WHERE key='minStars'").get().value, "500");
      d.close();
    } finally {
      rmSync(legacy.dir, { recursive: true, force: true });
    }
  });

  test("索引在迁移之后创建：依赖新增列的索引确实存在", () => {
    const legacy = makeLegacyDb();
    try {
      const r = loadDb(legacy);
      assert.equal(r.status, 0, `旧库启动失败:\n${r.stderr}`);

      const d = new DatabaseSync(legacy.file);
      const idx = d
        .prepare("SELECT name FROM sqlite_master WHERE type='index'")
        .all()
        .map((x) => x.name);
      assert.ok(idx.includes("idx_repos_is_custom"), "idx_repos_is_custom 未创建");
      assert.ok(idx.includes("idx_snapshots_repo_captured"));
      d.close();
    } finally {
      rmSync(legacy.dir, { recursive: true, force: true });
    }
  });

  test("重复启动幂等：迁移版本号推进且二次加载仍正常", () => {
    const legacy = makeLegacyDb();
    try {
      assert.equal(loadDb(legacy).status, 0);
      const first = new DatabaseSync(legacy.file);
      const v1 = first.prepare("PRAGMA user_version").get().user_version;
      first.close();
      assert.ok(v1 > 0, "user_version 应已推进");

      const again = loadDb(legacy);
      assert.equal(again.status, 0, `二次启动失败:\n${again.stderr}`);

      const second = new DatabaseSync(legacy.file);
      assert.equal(second.prepare("PRAGMA user_version").get().user_version, v1);
      assert.equal(second.prepare("SELECT COUNT(*) c FROM repos").get().c, 1, "重复迁移不应复制数据");
      second.close();
    } finally {
      rmSync(legacy.dir, { recursive: true, force: true });
    }
  });
});
