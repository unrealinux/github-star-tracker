/**
 * 前端冒烟测试（真实 Chrome 无头 + 原生 CDP，零依赖）
 *
 * 覆盖：
 *   1. 页面能加载，且 /app.js 真的执行了（#token-status 从「检测中…」被刷新）
 *   2. 加载全过程没有 JS 异常、没有 CSP 违规、没有资源加载失败
 *   3. 基础无障碍：按钮/表单有可访问名称、Tab 语义完整、无重复 id
 *
 * 公共基座见 ./harness.js。运行：npm run test:frontend
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  CHROME,
  launchChrome,
  closeChrome,
  killChrome,
  spawnedChrome,
  startServer,
  stopServer,
  openPage,
} from "./harness.js";

let ctx;
let browser;

before(async () => {
  ctx = await startServer();
  // 播种一条仓库，让列表页真的渲染出动态卡片
  ctx.db
    .prepare(
      "INSERT INTO repos (full_name, name, owner, url, description, language, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,?,?,0)",
    )
    .run("seed/one", "one", "seed", "https://github.com/seed/one", "A seeded repo", "Go", 1234, 10, 2);
  if (CHROME) browser = await launchChrome();
});

after(async () => {
  if (browser) await closeChrome(browser);
  // 启动阶段失败时 browser 还没赋上，这里兼底回收所有拉起过的 Chrome
  for (const entry of spawnedChrome) killChrome(entry);
  await stopServer(ctx);
});

const skip = CHROME ? false : "未找到 Chrome";

test("页面加载：app.js 执行成功且无 JS 异常 / CSP 违规 / 资源错误", { skip, timeout: 60000 }, async () => {
  const { cdp } = browser;
  const problems = [];

  cdp.on((msg) => {
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      problems.push(`JS 异常: ${d.exception?.description || d.text}`);
    } else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
      problems.push("console.error: " + msg.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
    } else if (msg.method === "Log.entryAdded") {
      const e = msg.params.entry;
      if (e.source === "security" || e.level === "error") problems.push(`${e.source}/${e.level}: ${e.text}`);
    } else if (msg.method === "Network.loadingFailed" && !msg.params.canceled) {
      const b = msg.params.blockedReason ? ` (${msg.params.blockedReason})` : "";
      problems.push(`资源加载失败: ${msg.params.errorText}${b}`);
    }
  });
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");

  const { evaluate } = await openPage(cdp, ctx.base + "/");
  const state = JSON.parse(
    await evaluate(`JSON.stringify({
      title: document.title,
      status: document.getElementById('token-status')?.textContent?.trim() || '',
    })`),
  );

  assert.equal(state.title, "GitHub 星标追踪", "页面标题不对，前端可能没加载");
  assert.notEqual(state.status, "检测中…", "app.js 未完成启动（#token-status 未被刷新）");
  assert.deepEqual(problems, [], "加载过程中出现错误 / CSP 违规 / 资源失败");
});

test("无障碍：按钮/表单有可访问名称，Tab 语义完整，无重复 id", { skip, timeout: 60000 }, async () => {
  const { evaluate, waitFor } = await openPage(browser.cdp, ctx.base + "/");

  // 等动态列表渲染出来（种子的仓库），让扫描也覆盖运行时生成的控件
  const ready = await waitFor(`document.querySelectorAll('.repo-row').length > 0`, {
    timeout: 5000,
  });
  assert.ok(ready, "种子的仓库未渲染，动态控件的无障碍扫描未覆盖");

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
});
