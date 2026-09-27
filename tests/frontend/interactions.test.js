/**
 * 前端交互流程测试（真实 Chrome 无头 + 原生 CDP，零依赖）
 *
 * 覆盖冒烟之上的真实交互：命令面板、主题切换、Tab 切换、详情弹层与收藏、筛选。
 * 只依赖本地接口，不依赖 GitHub 网络。运行：npm run test:frontend
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
  const ins = ctx.db.prepare(
    "INSERT INTO repos (full_name, name, owner, url, description, language, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,?,?,0)",
  );
  ins.run("seed/one", "one", "seed", "https://github.com/seed/one", "A seeded repo", "Go", 1234, 10, 2);
  ins.run("seed/low", "low", "seed", "https://github.com/seed/low", "A low-star repo", "Rust", 50, 1, 0);
  if (CHROME) browser = await launchChrome();
});

after(async () => {
  if (browser) await closeChrome(browser);
  for (const entry of spawnedChrome) killChrome(entry);
  await stopServer(ctx);
});

const skip = CHROME ? false : "未找到 Chrome";
const open = () => openPage(browser.cdp, ctx.base + "/");

test("命令面板：打开后可过滤、Esc 关闭", { skip, timeout: 60000 }, async () => {
  const { evaluate, waitFor } = await open();

  await evaluate(`document.getElementById('palette-btn').click()`);
  assert.ok(await waitFor(`!document.getElementById('palette-overlay').classList.contains('hidden')`));
  assert.equal(
    await evaluate(`document.activeElement === document.getElementById('palette-input')`),
    true,
    "打开后应聚焦输入框",
  );
  assert.ok(
    (await evaluate(`document.querySelectorAll('#palette-list .palette-item').length`)) > 0,
    "命令面板应有可选项",
  );

  await evaluate(`(() => {
    const i = document.getElementById('palette-input');
    i.value = '主题';
    i.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  assert.ok(await waitFor(`document.querySelectorAll('#palette-list .palette-item').length > 0`));
  const titles = await evaluate(
    `[...document.querySelectorAll('#palette-list .palette-title')].map((e) => e.textContent).join('|')`,
  );
  assert.match(titles, /主题/, "过滤后应只剩包含「主题」的项");

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
  assert.ok(await waitFor(`document.getElementById('palette-overlay').classList.contains('hidden')`));
});

test("主题切换：data-theme 变化且刷新后保持", { skip, timeout: 60000 }, async () => {
  const { evaluate, waitFor } = await open();
  const before = await evaluate(`document.documentElement.getAttribute('data-theme')`);

  await evaluate(`document.getElementById('theme-toggle').click()`);
  assert.ok(
    await waitFor(`document.documentElement.getAttribute('data-theme') !== ${JSON.stringify(before)}`),
  );
  const after = await evaluate(`document.documentElement.getAttribute('data-theme')`);
  assert.notEqual(after, before);
  assert.ok(["light", "dark", "contrast"].includes(after), `未知主题：${after}`);

  const { waitFor: reloadWait } = await open();
  assert.ok(
    await reloadWait(`document.documentElement.getAttribute('data-theme') === ${JSON.stringify(after)}`),
    "刷新后主题应保持",
  );
});

test("Tab 切换：面板显示隐藏与 aria-selected 同步", { skip, timeout: 60000 }, async () => {
  const { evaluate, waitFor } = await open();
  assert.equal(
    await evaluate(`document.getElementById('tab-repos').classList.contains('active')`),
    true,
    "初始应停在仓库列表",
  );

  await evaluate(`document.querySelector('.tab[data-tab="settings"]').click()`);
  assert.ok(await waitFor(`document.getElementById('tab-settings').classList.contains('active')`));
  assert.equal(await evaluate(`document.getElementById('tab-repos').classList.contains('hidden')`), true);
  assert.equal(
    await evaluate(`document.querySelector('.tab[data-tab="settings"]').getAttribute('aria-selected')`),
    "true",
  );
  assert.equal(
    await evaluate(`document.querySelector('.tab[data-tab="repos"]').getAttribute('aria-selected')`),
    "false",
  );
});

test("详情弹层：点行打开、收藏切换、关闭收起", { skip, timeout: 60000 }, async () => {
  const { evaluate, waitFor } = await open();
  assert.ok(await waitFor(`document.querySelectorAll('.repo-row').length > 0`));

  await evaluate(`document.querySelector('.repo-row').click()`);
  assert.ok(await waitFor(`!document.getElementById('detail-overlay').classList.contains('hidden')`));
  assert.match(await evaluate(`document.getElementById('detail-body').textContent`), /seed\/one/);

  assert.ok(await waitFor(`!!document.getElementById('fav-btn')`));
  await evaluate(`document.getElementById('fav-btn').click()`);
  assert.ok(await waitFor(`document.getElementById('fav-btn').textContent.includes('已收藏')`));

  await evaluate(`document.getElementById('detail-close').click()`);
  assert.ok(await waitFor(`document.getElementById('detail-overlay').classList.contains('hidden')`));
});

test("筛选：调整最低星数后列表随之变化", { skip, timeout: 60000 }, async () => {
  const { evaluate, waitFor } = await open();
  assert.ok(await waitFor(`document.querySelectorAll('.repo-row').length > 0`));
  assert.equal(
    await evaluate(`document.querySelectorAll('.repo-row').length`),
    1,
    "默认下限应挡住 50 星的低星仓库",
  );

  await evaluate(`(() => {
    document.getElementById('min-stars').value = '0';
    document.getElementById('apply').click();
  })()`);
  assert.ok(await waitFor(`document.querySelectorAll('.repo-row').length === 2`));
});
