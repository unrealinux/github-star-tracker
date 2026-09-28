/**
 * 前端登录 / 多用户流程测试（真实 Chrome 无头 + 原生 CDP，零依赖）
 *
 * 覆盖：单用户模式不强制登录 → 注册首个管理员 → 刷新后登录态保持 →
 *       登出转登录模式 → 错误口令被拦 → 正确口令进入。
 * 运行：npm run test:frontend
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
  ctx = await startServer(); // 全新库、无用户、无 API_KEY
  if (CHROME) browser = await launchChrome();
});

after(async () => {
  if (browser) await closeChrome(browser);
  for (const entry of spawnedChrome) killChrome(entry);
  await stopServer(ctx);
});

const skip = CHROME ? false : "未找到 Chrome";

test(
  "多用户：注册管理员 → 登录态保持 → 登出 → 重新登录（含错误口令）",
  { skip, timeout: 90000 },
  async () => {
    const { evaluate, waitFor } = await openPage(browser.cdp, ctx.base + "/");

    // 1) 单用户模式：不强制登录
    assert.equal(
      await evaluate(`document.getElementById('auth-overlay').classList.contains('hidden')`),
      true,
      "单用户模式不应弹登录层",
    );

    // 2) 走设置页的「启用多用户」入口 → 注册模式
    await evaluate(`document.getElementById('enable-multiuser-btn').click()`);
    assert.ok(await waitFor(`!document.getElementById('auth-overlay').classList.contains('hidden')`));
    assert.equal(await evaluate(`document.getElementById('auth-title').textContent`), "创建管理员账号");

    // 3) 注册首个管理员
    await evaluate(`(() => {
      document.getElementById('auth-username').value = 'alice';
      document.getElementById('auth-password').value = 'secret123';
      document.getElementById('auth-submit').click();
    })()`);
    assert.ok(
      await waitFor(`document.getElementById('auth-overlay').classList.contains('hidden')`),
      "注册成功后应关闭登录层",
    );
    assert.ok(
      await waitFor(`document.getElementById('token-status').textContent.trim() !== '检测中…'`),
      "注册成功后应加载数据",
    );
    assert.ok(await evaluate(`!!localStorage.getItem('gst_session')`), "应保存会话");

    // 4) 刷新后仍保持登录
    const { evaluate: ev2, waitFor: w2 } = await openPage(browser.cdp, ctx.base + "/");
    assert.equal(
      await ev2(`document.getElementById('auth-overlay').classList.contains('hidden')`),
      true,
      "刷新后应保持登录",
    );
    assert.match(await ev2(`document.getElementById('account-who').textContent`), /alice/);
    assert.ok(await w2(`document.getElementById('token-status').textContent.trim() !== '检测中…'`));

    // 5) 登出 → 转为登录模式
    await ev2(`document.getElementById('logout-btn').click()`);
    await new Promise((r) => setTimeout(r, 600)); // 等 logout 请求 + location.reload
    const { evaluate: ev3, waitFor: w3 } = await openPage(browser.cdp, ctx.base + "/");
    assert.ok(
      await w3(`!document.getElementById('auth-overlay').classList.contains('hidden')`),
      "登出后应要求登录",
    );
    assert.equal(await ev3(`document.getElementById('auth-title').textContent`), "登录");

    // 6) 错误口令：报错且不放行
    await ev3(`(() => {
      document.getElementById('auth-username').value = 'alice';
      document.getElementById('auth-password').value = 'wrong-pass';
      document.getElementById('auth-submit').click();
    })()`);
    assert.ok(
      await w3(`!document.getElementById('auth-error').classList.contains('hidden')`),
      "错误口令应显示错误信息",
    );
    assert.equal(
      await ev3(`document.getElementById('auth-overlay').classList.contains('hidden')`),
      false,
      "错误口令不应放行",
    );

    // 7) 正确口令：进入
    await ev3(`(() => {
      document.getElementById('auth-username').value = 'alice';
      document.getElementById('auth-password').value = 'secret123';
      document.getElementById('auth-submit').click();
    })()`);
    assert.ok(
      await w3(`document.getElementById('auth-overlay').classList.contains('hidden')`),
      "正确口令应放行",
    );
    assert.ok(await w3(`document.getElementById('token-status').textContent.trim() !== '检测中…'`));
  },
);
