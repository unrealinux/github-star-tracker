/**
 * 前端测试共用基座（真实 Chrome 无头 + 原生 CDP，零依赖）
 *
 * 提供：
 *   - findChrome / CHROME：定位本机或 CI 注入（CHROME_BIN）的 Chrome
 *   - launchChrome / closeChrome / killChrome / spawnedChrome：进程生命周期（含失败回收）
 *   - startServer / stopServer：起一个临时 SQLite + 单用户模式的服务
 *   - openPage：导航到页面、等首屏就绪，返回 evaluate / waitFor 工具
 *
 * 环境变量必须在 import server.js 之前设置，因此 startServer 内部才动态 import。
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 定位 Chrome ──────────────────────────────────────────────────
export function findChrome() {
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

export const CHROME = findChrome();

// ── 极简 CDP 客户端（基于 Node ≥22 内置的全局 WebSocket）──────────
export class CDP {
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

// ── Chrome 生命周期 ──────────────────────────────────────────────
const spawnedChrome = [];
export { spawnedChrome };

/** 回收 Chrome 进程组 + 临时目录；启动失败或测试异常都要调用，否则孤儿进程会拖住测试进程 */
export function killChrome({ proc, userDataDir }) {
  try {
    process.kill(-proc.pid, "SIGKILL");
  } catch {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* 已退出 */
    }
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

export async function launchChrome() {
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
  const entry = { proc, userDataDir };
  spawnedChrome.push(entry);

  try {
    const wsUrl = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error("Chrome 未在 30s 内就绪")), 30000);
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
    return { ...entry, ws, cdp: new CDP(ws) };
  } catch (err) {
    killChrome(entry);
    throw err;
  }
}

export async function closeChrome(browser) {
  try {
    browser.ws.close();
  } catch {
    /* 已关闭 */
  }
  killChrome(browser);
}

// ── 服务器生命周期 ──────────────────────────────────────────────
export async function startServer() {
  const dataDir = mkdtempSync(join(tmpdir(), "gst-fe-"));
  process.env.DB_DIR = dataDir;
  process.env.DB_PATH = join(dataDir, "frontend.db");
  process.env.DB_DRIVER = "sqlite"; // 强制 SQLite，与后端驱动解耦
  process.env.API_KEY = "";
  process.env.FEED_TOKEN = "";
  process.env.GITHUB_TOKEN = ""; // 匿名模式，避免测试用掉开发者的真实 token
  process.env.GH_TOKEN = "";
  process.env.LOG_LEVEL = "error";

  const { app } = await import("../../server.js");
  const { db } = await import("../../src/db.js");
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { app, db, server, base, dataDir };
}

export async function stopServer({ server, dataDir }) {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

// ── 页面操作 ────────────────────────────────────────────────────
export async function openPage(cdp, url) {
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  const loaded = new Promise((resolve) => {
    const off = cdp.on((m) => {
      if (m.method === "Page.loadEventFired") {
        off();
        resolve();
      }
    });
  });
  await cdp.send("Page.navigate", { url });
  await loaded;

  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text);
    return result.value;
  };

  const waitFor = async (expr, { timeout = 8000, interval = 100 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await evaluate(`Boolean(${expr})`)) return true;
      await new Promise((r) => setTimeout(r, interval));
    }
    return false;
  };

  // 等首屏就绪：要么已登录并加载完数据（#token-status 被刷新 + settings 已应用），
  // 要么被登录层拦住（多用户模式下未登录）。
  await waitFor(
    `document.getElementById('token-status')?.textContent?.trim() !== '检测中…'` +
      ` || !document.getElementById('auth-overlay')?.classList.contains('hidden')`,
  );
  await waitFor(
    `document.getElementById('min-stars')?.value !== ''` +
      ` || !document.getElementById('auth-overlay')?.classList.contains('hidden')`,
  );
  return { evaluate, waitFor };
}
