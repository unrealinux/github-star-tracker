/**
 * .env 加载顺序回归测试
 *
 * 背景：ESM 的静态 import 先于模块体执行。loadEnvFile 若写在 server.js 的
 * 模块体里，db.js / auth.js 在 import 时读到的 process.env 不含 .env 的值
 * （DB_DRIVER、SESSION_TTL_DAYS 等会被静默忽略）。
 * src/env.js 作为 server.js 的第一个 import 修复了这一点，这里直接验证顺序。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test(".env 在读取 process.env 的模块之前加载（GST_ENV_FILE 可覆盖路径）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gst-env-"));
  const envFile = join(dir, "custom.env");
  writeFileSync(envFile, "SESSION_TTL_DAYS=1\nGST_ENV_MARKER=loaded\n");
  process.env.GST_ENV_FILE = envFile;

  try {
    await import("../src/env.js");
    assert.equal(process.env.GST_ENV_MARKER, "loaded", "env 文件应被加载");

    const { SESSION_TTL_MS } = await import("../src/auth.js");
    assert.equal(SESSION_TTL_MS, 24 * 3600 * 1000, "后加载的 auth.js 应看到 SESSION_TTL_DAYS=1");
  } finally {
    delete process.env.GST_ENV_FILE;
    delete process.env.SESSION_TTL_DAYS;
    delete process.env.GST_ENV_MARKER;
    rmSync(dir, { recursive: true, force: true });
  }
});
