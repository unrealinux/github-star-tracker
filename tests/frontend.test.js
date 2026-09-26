/**
 * 前端冒烟测试（真实 Chrome 无头 + 原生 CDP，零依赖）
 *
 * 覆盖：
 *   1. 页面能加载，且 /app.js 真的执行了（#token-status 从「检测中…」被刷新）
 *   2. 加载全过程没有 JS 异常、没有 CSP 违规、没有资源加载失败
 *
 * 设计：
 *   - 强制走 SQLite 临时库 + 单用户模式，不依赖后端驱动、不污染真实数据
 *   - 找不到 Chrome 时整组跳过（本地无 Chrome / CI 未装时不影响 npm test）
 *   - Chrome 路径可用 CHROME_BIN / CHROME_PATH 指定
 *
 * 运行：npm test  或  node --test tests/frontend.test.js
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import server.js 之前设置（db.js / server.js 在模块加载时读取）
const dataDir = mkdtempSync(join(tmpdir(), "gst-fe-"));
process.env.DB_DIR = dataDir;
process.env.DB_PATH = join(dataDir, "frontend.db");
process.env.DB_DRIVER = "sqlite";
process.env.API_KEY = "";
process.env.FEED_TOKEN = "";
process.env.LOG_LEVEL = "error";

const { app } = await import("../server.js");

// ── 定位 Chrome ──────────────────────────────────────────────────
function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    try {
      return execSync(`command -v ${name}`, { encoding: "utf8" }).trim();
    } catch {
      /* 继续找 */
    }
  }
  return null;
}

const CHROME = findChrome();

// ── 极简 CDP 客户端（基于 Node ≥22 内置的全局 WebSocket）──────────
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }
  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
}

async function launchChrome() {
  const userDataDir = mkdtempSync(join(tmpdir(), "gst-chrome-"));
  const proc = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "--disable-component-update",
      "--mute-audio",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"], detached: true },
  );

  const wsUrl = await new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error("Chrome 未在 15s 内就绪")), 15000);
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome 提前退出，code=${code}`));
    });
  });

  const port = new URL(wsUrl).port;
  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return { proc, ws, cdp: new CDP(ws), userDataDir };
}

async function closeChrome(browser) {
  try {
    browser.ws.close();
  } catch {
    /* 已关闭 */
  }
  try {
    process.kill(-browser.proc.pid, "SIGKILL");
  } catch {
    try {
      browser.proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  try {
    rmSync(browser.userDataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

// ── 服务器 + 浏览器生命周期 ─────────────────────────────────────
let server;
let base;
let browser;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  if (CHROME) browser = await launchChrome();
});

after(async () => {
  if (browser) await closeChrome(browser);
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

test(
  "页面加载：app.js 执行成功且无 JS 异常 / CSP 违规 / 资源错误",
  { skip: CHROME ? false : "未找到 Chrome", timeout: 60000 },
  async () => {
    const { cdp } = browser;
    const problems = [];

    cdp.on((msg) => {
      if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        problems.push(`JS 异常: ${d.exception?.description || d.text}`);
      } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
        problems.push(
          "console.error: " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "),
        );
      } else if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry;
        if (e.source === "security" || e.level === "error")
          problems.push(`${e.source}/${e.level}: ${e.text}`);
      } else if (msg.method === "Network.loadingFailed" && !msg.params.canceled) {
        const b = msg.params.blockedReason ? ` (${msg.params.blockedReason})` : "";
        problems.push(`资源加载失败: ${msg.params.errorText}${b}`);
      }
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");

    const loaded = new Promise((resolve) => {
      const off = cdp.on((m) => {
        if (m.method === "Page.loadEventFired") {
          off();
          resolve();
        }
      });
    });
    await cdp.send("Page.navigate", { url: base + "/" });
    await loaded;

    // 轮询到 app.js 完成首屏数据加载（#token-status 由「检测中…」被刷新）
    const evaluate = async (expression) => {
      const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      return result.value;
    };
    const readState = () =>
      evaluate(`JSON.stringify({
    title: document.title,
    status: document.getElementById('token-status')?.textContent?.trim() || '',
  })`);

    let state = JSON.parse(await readState());
    const deadline = Date.now() + 10000;
    while (state.status === "检测中…" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      state = JSON.parse(await readState());
    }

    assert.equal(state.title, "GitHub 星标追踪", "页面标题不对，前端可能没加载");
    assert.notEqual(state.status, "检测中…", "app.js 未完成启动（#token-status 未被刷新）");
    assert.deepEqual(problems, [], "加载过程中出现错误 / CSP 违规 / 资源失败");
  },
);
