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
import { createPostgresDriver, resolvePgSsl } from "../src/dbdriver/postgres.js";

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

describe("PostgreSQL SSL 开关解析（resolvePgSsl）", () => {
  test("未设 PGSSLMODE 时不干预（交给连接串）", () => {
    assert.equal(resolvePgSsl({}), null);
    assert.equal(resolvePgSsl({ DATABASE_URL: "postgres://x/y?sslmode=require" }), null);
  });

  test("disable → 显式拒绝 TLS", () => {
    assert.equal(resolvePgSsl({ PGSSLMODE: "disable" }), false);
    assert.equal(resolvePgSsl({ PGSSLMODE: "DISABLE" }), false);
  });

  test("require / no-verify → 加密但不校验证书（自签可用）", () => {
    assert.deepEqual(resolvePgSsl({ PGSSLMODE: "require" }), { rejectUnauthorized: false });
    assert.deepEqual(resolvePgSsl({ PGSSLMODE: "no-verify" }), { rejectUnauthorized: false });
  });

  test("verify-full → 校验证书，PGSSLROOTCERT 指定 CA", () => {
    const ssl = resolvePgSsl(
      { PGSSLMODE: "verify-full", PGSSLROOTCERT: "/tmp/ca.pem" },
      { readFile: (p) => `CA:${p}` },
    );
    assert.deepEqual(ssl, { rejectUnauthorized: true, ca: "CA:/tmp/ca.pem" });
    // 不指定 CA 时也能回落到系统 CA
    assert.deepEqual(resolvePgSsl({ PGSSLMODE: "verify-ca" }), { rejectUnauthorized: true });
  });

  test("DATABASE_SSLMODE 作为回退变量", () => {
    assert.deepEqual(resolvePgSsl({ DATABASE_SSLMODE: "require" }), { rejectUnauthorized: false });
  });

  test("未知取值报错，避免静默降级成明文", () => {
    assert.throws(() => resolvePgSsl({ PGSSLMODE: "banana" }), /未知的 PGSSLMODE/);
  });
});
