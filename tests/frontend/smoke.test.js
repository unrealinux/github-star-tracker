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

const { app } = await import("../../server.js");
const { db } = await import("../../src/db.js");

// 播种一条仓库，让列表页真的渲染出动态卡片（翻页按钮 / 收藏按钮等随之生成）
db.prepare(
  "INSERT INTO repos (full_name, name, owner, url, description, language, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,?,?,0)",
).run("seed/one", "one", "seed", "https://github.com/seed/one", "A seeded repo", "Go", 1234, 10, 2);

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

const spawnedChrome = [];

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

// 回收 Chrome 进程组 + 临时目录；启动失败或测试异常都要调用，否则孤儿进程会拖住测试进程
function killChrome({ proc, userDataDir }) {
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

async function closeChrome(browser) {
  try {
    browser.ws.close();
  } catch {
    /* 已关闭 */
  }
  killChrome(browser);
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
  // 启动阶段失败时 browser 还没赋上，这里兼底回收所有拉起过的 Chrome
  for (const entry of spawnedChrome) killChrome(entry);
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

test(
  "无障碍：按钮/表单有可访问名称，Tab 语义完整，无重复 id",
  { skip: CHROME ? false : "未找到 Chrome", timeout: 60000 },
  async () => {
    const { cdp } = browser;
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
    await cdp.send("Page.navigate", { url: base + "/" });
    await loaded;

    const evaluate = async (expression) => {
      const { result } = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
      return result.value;
    };
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const ready = await evaluate(
        `document.getElementById('token-status')?.textContent?.trim() !== '检测中…'`,
      );
      if (ready) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    // 等动态列表渲染出来（种子的仓库），让扫描也覆盖运行时生成的控件
    const listDeadline = Date.now() + 5000;
    let repoRows = 0;
    while (Date.now() < listDeadline) {
      repoRows = await evaluate(`document.querySelectorAll('.repo-row').length`);
      if (repoRows > 0) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(repoRows > 0, "种子的仓库未渲染，动态控件的无障碍扫描未覆盖");

    const raw = await evaluate(`(() => {
      const problems = [];
      const byLabel = (el) => (el.getAttribute('aria-labelledby') || '').trim().split(' ')
        .map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
      const accName = (el) =>
        (el.getAttribute('aria-label') || '').trim() || byLabel(el) ||
        (el.getAttribute('title') || '').trim() || (el.textContent || '').trim();

      document.querySelectorAll('button').forEach((b) => {
        if (!accName(b)) problems.push('按钮缺少可访问名称: ' + (b.id ? '#' + b.id : b.outerHTML.slice(0, 80)));
      });
      document.querySelectorAll('input, select, textarea').forEach((el) => {
        if (el.type === 'hidden') return;
        const ok = (el.labels && el.labels.length) || (el.getAttribute('aria-label') || '').trim() ||
          byLabel(el) || (el.getAttribute('title') || '').trim();
        if (!ok) problems.push('表单控件缺少标签: ' + (el.id ? '#' + el.id : el.tagName));
      });
      document.querySelectorAll('img').forEach((img) => {
        if (!img.hasAttribute('alt')) problems.push('图片缺少 alt: ' + img.src);
      });

      const seen = new Set();
      document.querySelectorAll('[id]').forEach((el) => {
        if (seen.has(el.id)) problems.push('重复 id: ' + el.id);
        else seen.add(el.id);
      });

      const tabs = document.querySelectorAll('[role="tab"]');
      if (!tabs.length) problems.push('没有 role=tab');
      tabs.forEach((t) => {
        const sel = t.getAttribute('aria-selected');
        if (sel !== 'true' && sel !== 'false') problems.push('tab 缺少 aria-selected: ' + t.textContent.trim());
        const c = t.getAttribute('aria-controls');
        if (!c || !document.getElementById(c)) problems.push('tab 的 aria-controls 未指向面板: ' + t.textContent.trim());
      });
      const panels = document.querySelectorAll('[role="tabpanel"]');
      if (panels.length !== tabs.length) problems.push('tabpanel 与 tab 数量不一致');
      panels.forEach((p) => {
        if (!p.getAttribute('aria-labelledby')) problems.push('tabpanel 缺少 aria-labelledby: ' + p.id);
      });

      return JSON.stringify(problems);
    })()`);
    assert.deepEqual(JSON.parse(raw), [], "存在无障碍问题");
  },
);
