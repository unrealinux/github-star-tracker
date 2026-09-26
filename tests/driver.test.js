/**
 * PostgreSQL 驱动错误上报回归测试（node:test，零依赖）
 * 运行：npm test
 *
 * 背景：postgres.worker.js 的 reply() 签名是 (id, ok, result, error)，
 * 但失败分支只传了 3 个参数，错误消息落进 result 槽、error 恒为 undefined，
 * 于是主线程抛出 `new Error("undefined")`：
 *   PostgreSQL 的任何故障（认证失败 / SQL 报错 / 连接被拒）都没有可定位的信息。
 *
 * 这里用 PGlite（内嵌 PostgreSQL 16）触发一次真实的 SQL 错误来覆盖该路径，
 * 不依赖任何外部服务。修复前消息为 "undefined"，修复后应包含真实原因。
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresDriver } from "../src/dbdriver/postgres.js";

let db;
let tmp;

describe("PostgreSQL 驱动错误上报", () => {
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "gst-driver-"));
    db = createPostgresDriver({ dataDir: join(tmp, "pg") });
  });

  after(() => {
    try {
      db?.close();
    } catch {}
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  test("查询不存在的表：报出真实原因，而不是 undefined", () => {
    const missing = "table_that_does_not_exist_9f3a";
    let msg = "";
    try {
      db.prepare(`SELECT * FROM ${missing}`).all();
      assert.fail("查询不存在的表本应抛错");
    } catch (e) {
      msg = e.message;
    }
    assert.notEqual(msg, "undefined", "错误信息被吞成了 undefined");
    assert.ok(msg.trim().length > 0, "错误信息不应为空");
    assert.match(msg, new RegExp(missing), `错误信息应包含真实原因，实际：${msg}`);
  });

  test("exec 语法错误同样保留原因", () => {
    let msg = "";
    try {
      db.exec("THIS IS NOT SQL");
      assert.fail("非法 SQL 本应抛错");
    } catch (e) {
      msg = e.message;
    }
    assert.notEqual(msg, "undefined", "错误信息被吞成了 undefined");
    assert.ok(msg.trim().length > 0, "错误信息不应为空");
  });
});
