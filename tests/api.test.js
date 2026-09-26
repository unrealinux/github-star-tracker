/**
 * HTTP 路由集成测试（真实启动 Express，走 fetch 请求）
 * 运行：npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import crypto from "node:crypto";

// 必须在 import server.js 之前设置环境变量（db.js 在模块加载时读取）
const tmp = mkdtempSync(join(tmpdir(), "gst-api-"));
process.env.DB_DIR = tmp;
process.env.DB_PATH = join(tmp, "api.db");
process.env.API_KEY = "test-key-123";
process.env.FEED_TOKEN = "feed-token-abc";
process.env.LOG_LEVEL = "error";

const { app, resolveToken } = await import("../server.js");
const { db, closeDb } = await import("../src/db.js");

let server;
let base;

const KEY = "test-key-123";
const api = (path, opts = {}) =>
  fetch(base + path, { ...opts, headers: { "X-API-Key": KEY, ...(opts.headers || {}) } });

before(async () => {
  db.exec("DELETE FROM snapshots; DELETE FROM favorites; DELETE FROM custom_repos; DELETE FROM repos;");
  db.prepare("INSERT INTO repos (full_name, name, owner, url, description, language, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run("api/one", "one", "api", "http://x", "A test repo", "Go", 1234, 10, 2);
  db.prepare("INSERT INTO repos (full_name, name, owner, url, description, language, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,?,?,0)")
    .run("api/two", "two", "api", "http://y", "Another test repo", "Rust", 10, 1, 0);
  const id1 = db.prepare("SELECT id FROM repos WHERE full_name = 'api/one'").get().id;
  const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,?,?,?)");
  snap.run(id1, 1200, 10, 2, new Date(Date.now() - 2 * 86400000).toISOString());
  snap.run(id1, 1234, 10, 2, new Date().toISOString());

  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  try { closeDb(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("认证与基础端点", () => {
  test("GET /health 公开且返回 ok", async () => {
    const res = await fetch(base + "/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.repos, "number");
  });

  test("/api 未带 API Key 返回 401", async () => {
    const res = await fetch(base + "/api/settings");
    assert.equal(res.status, 401);
  });

  test("/api 带 API Key 返回 200", async () => {
    const res = await api("/api/settings");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  test("未知 /api 路由返回 404 JSON", async () => {
    const res = await api("/api/does-not-exist");
    assert.equal(res.status, 404);
    assert.equal((await res.json()).error, "接口不存在");
  });
});

describe("列表与分析端点", () => {
  test("GET /api/repos 返回分页结果", async () => {
    const res = await api("/api/repos?minStars=0&sort=stars&pageSize=10");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.repos));
    assert.equal(body.repos[0].full_name, "api/one");
    assert.ok(Array.isArray(body.languages));
  });

  test("GET /api/stats 返回汇总与配额", async () => {
    const body = await (await api("/api/stats")).json();
    assert.equal(body.repoCount, 2);
    assert.ok(body.quota);
    assert.equal(body.authEnabled, true);
  });

  test("GET /api/repos/:id/history 与非法 id", async () => {
    const id = db.prepare("SELECT id FROM repos WHERE full_name = 'api/one'").get().id;
    const ok = await api(`/api/repos/${id}/history`);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).history.length >= 2);
    assert.equal((await api("/api/repos/abc/history")).status, 400);
    assert.equal((await api("/api/repos/999999/history")).status, 404);
  });

  test("GET /api/overview 与 /api/compare", async () => {
    const ov = await (await api("/api/overview?days=30")).json();
    assert.equal(typeof ov.health.coveragePct, "number");

    const ids = db.prepare("SELECT id FROM repos").all().map((r) => r.id).join(",");
    const cmp = await api(`/api/compare?ids=${ids}&window=day`);
    assert.equal(cmp.status, 200);
    assert.equal((await cmp.json()).repos.length, 2);

    assert.equal((await api("/api/compare")).status, 400);
  });

  test("GET /api/repos/:id/similar", async () => {
    const id = db.prepare("SELECT id FROM repos WHERE full_name = 'api/one'").get().id;
    const res = await api(`/api/repos/${id}/similar`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).repo, "api/one");
  });
});

describe("保存视图 CRUD（C5）", () => {
  test("保存 / 列表 / 删除", async () => {
    const create = await api("/api/views", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Go 视图", filters: { language: "Go", sort: "growth" } }),
    });
    assert.equal(create.status, 200);
    assert.equal((await create.json()).views.length, 1);

    const list = await (await api("/api/views")).json();
    assert.equal(list.views[0].name, "Go 视图");

    const del = await api(`/api/views/${encodeURIComponent("Go 视图")}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await del.json()).views.length, 0);

    const bad = await api("/api/views", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "", filters: {} }),
    });
    assert.equal(bad.status, 400);
  });
});

describe("自定义仓库与维护端点", () => {
  test("新增/重复/删除自定义仓库", async () => {
    const payload = JSON.stringify({ full_name: "api/custom", note: "n" });
    const create = await api("/api/custom-repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    assert.equal(create.status, 200);

    const dup = await api("/api/custom-repos", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload });
    assert.equal(dup.status, 409);

    const bad = await api("/api/custom-repos", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ full_name: "not-a-repo" }),
    });
    assert.equal(bad.status, 400);

    const del = await api("/api/custom-repos/api%2Fcustom", { method: "DELETE" });
    assert.equal(del.status, 200);
  });

  test("GET /api/maintenance/export?format=json 返回可导入数据", async () => {
    const res = await api("/api/maintenance/export?format=json");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.version, 2);
    assert.ok(Array.isArray(data.repos));
    assert.ok(Array.isArray(data.snapshots));
  });

  test("POST /api/maintenance/import 合并导入", async () => {
    const res = await api("/api/maintenance/import", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "merge", data: { settings: [{ key: "minStars", value: "2000" }] } }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).counts.settings, 1);
  });
});

describe("公开端点", () => {
  test("GET /badge/:owner/:name.svg 返回 SVG", async () => {
    const res = await fetch(base + "/badge/api/one.svg");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /svg/);
    assert.match(await res.text(), /<svg/);
  });

  test("GET /metrics 返回 Prometheus 文本", async () => {
    const res = await fetch(base + "/metrics");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /gst_repos_total 2/);
    assert.match(text, /# TYPE gst_http_requests_total counter/);
    assert.match(text, /gst_alerts_unread \d+/);
  });

  test("GET /api/sources 列出数据源（含新增源）", async () => {
    const { sources } = await (await api("/api/sources")).json();
    const keys = sources.map((s) => s.key);
    for (const k of ["npm", "pypi", "crates", "hackernews", "homebrew", "rubygems", "nuget", "openvsx"]) {
      assert.ok(keys.includes(k), `应包含数据源 ${k}`);
    }
  });
});

describe("信号与订阅端点（第一批）", () => {
  test("GET /api/trends/anomaly 与 /api/trends/rising", async () => {
    const a = await api("/api/trends/anomaly?z=2");
    assert.equal(a.status, 200);
    const ab = await a.json();
    assert.ok(Array.isArray(ab.spikes) && Array.isArray(ab.drops));
    assert.equal(typeof ab.z, "number");

    const r = await api("/api/trends/rising?maxStars=99999999");
    assert.equal(r.status, 200);
    assert.ok(Array.isArray((await r.json()).rising));
  });

  test("GET /api/feed/:kind.xml 返回 Atom", async () => {
    for (const kind of ["surges", "new", "alerts"]) {
      const res = await api(`/api/feed/${kind}.xml`);
      assert.equal(res.status, 200, kind);
      assert.match(res.headers.get("content-type"), /atom\+xml/);
      const text = await res.text();
      assert.match(text, /<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
      assert.match(text, /<\/feed>/);
    }
    assert.equal((await api("/api/feed/bogus.xml")).status, 404);
  });

  test("RSS 订阅用只读 FEED_TOKEN；主 API Key 不再接受查询参数", async () => {
    const FEED = process.env.FEED_TOKEN;
    // 主 API Key 走 URL 一律拒绝
    assert.equal((await fetch(base + "/api/repos?key=" + KEY)).status, 401, "?key= 不应再被接受");
    assert.equal((await fetch(base + "/api/feed/surges.xml?key=" + KEY)).status, 401, "订阅也不接受 ?key=");

    // 只读令牌可读订阅
    const ok = await fetch(base + "/api/feed/surges.xml?token=" + encodeURIComponent(FEED));
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /<feed/);

    // 令牌只能读订阅，不能调其它接口
    assert.equal((await fetch(base + "/api/repos?token=" + encodeURIComponent(FEED))).status, 401);
  });

  test("GET /spark/:owner/:name.svg 返回走势图 SVG", async () => {
    const res = await fetch(base + "/spark/api/one.svg");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /svg/);
    const svg = await res.text();
    assert.match(svg, /<svg/);
    assert.match(svg, /polyline/);
  });

  test("GET /badge/:owner/:name.json 返回 shields endpoint", async () => {
    const res = await fetch(base + "/badge/api/one.json");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.label, "Stars");
    assert.equal(typeof body.message, "string");
    assert.equal(typeof body.color, "string");
  });

  test("未追踪仓库的 shields endpoint 优雅降级", async () => {
    const res = await fetch(base + "/badge/no/such.json");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).message, "not tracked");
  });
});

describe("事件聚类与告警回测端点（第二批）", () => {
  test("GET /api/trends/events 返回事件列表", async () => {
    const res = await api("/api/trends/events?days=30&z=1&minRepos=2&minSamples=1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.events));
    assert.equal(typeof body.z, "number");
    assert.equal(typeof body.minRepos, "number");
  });

  test("GET /api/alerts/backtest 返回汇总与规则", async () => {
    const res = await api("/api/alerts/backtest?days=30&threshold=10&onDrop=1&onMilestone=1");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.summary);
    assert.equal(typeof body.summary.total, "number");
    assert.ok(body.rules);
    assert.equal(body.rules.alertOnDrop, true);
    assert.equal(body.rules.alertOnMilestone, true);
    assert.ok(Array.isArray(body.fired));
    assert.ok(Array.isArray(body.topRepos));
  });
});

describe("指数与生态端点（第三批）", () => {
  test("指数 CRUD 与曲线", async () => {
    const empty = await api("/api/indices");
    assert.equal(empty.status, 200);
    assert.ok(Array.isArray((await empty.json()).indices));

    const created = await api("/api/indices", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "API 指数", language: "Go", minStars: 100 }),
    });
    assert.equal(created.status, 200);
    const { id } = await created.json();

    const series = await api(`/api/indices/${id}/series?days=30&weight=equal`);
    assert.equal(series.status, 200);
    const s = await series.json();
    assert.equal(s.name, "API 指数");
    assert.ok(Array.isArray(s.dates));
    assert.ok(Array.isArray(s.members));

    assert.equal((await api("/api/indices/999999/series")).status, 404);
    assert.equal((await api(`/api/indices/${id}`, { method: "DELETE" })).status, 200);
    assert.equal((await api(`/api/indices/${id}`, { method: "DELETE" })).status, 404);
  });

  test("追踪查询 CRUD 与聚合", async () => {
    const bad = await api("/api/queries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "", query: "" }),
    });
    assert.equal(bad.status, 400);

    const created = await api("/api/queries", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label: "API 生态", query: "language:go stars:>100" }),
    });
    assert.equal(created.status, 200);
    const { id } = await created.json();

    const list = await (await api("/api/queries")).json();
    assert.ok(list.queries.some((q) => q.id === id));

    const agg = await api(`/api/queries/${id}?days=30`);
    assert.equal(agg.status, 200);
    assert.equal((await agg.json()).label, "API 生态");

    assert.equal((await api("/api/queries/999999")).status, 404);

    const del = await api(`/api/queries/${id}`, { method: "DELETE" });
    assert.equal(del.status, 200);
    assert.equal((await api(`/api/queries/${id}`, { method: "DELETE" })).status, 404);
  });

  test("无追踪时刷新不访问网络", async () => {
    const res = await api("/api/queries/refresh", { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.queries, 0);
    assert.equal(body.updated, 0);
  });
});

describe("运维健壮性端点（第四批）", () => {
  test("GET /api/stats 暴露配额与失效仓库数", async () => {
    const body = await (await api("/api/stats")).json();
    assert.equal(typeof body.staleCount, "number");
    assert.ok("githubQuota" in body);
    // token 必须上报真实状态，而不是只说「有没有配置」
    assert.ok("tokenState" in body, "应暴露 tokenState");
    assert.ok(["none", "unknown", "ok", "invalid"].includes(body.tokenState), `tokenState 取值非法：${body.tokenState}`);
  });

  test("PUT /api/settings 接受运维类设置", async () => {
    const res = await api("/api/settings", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ quotaFloor: 5, externalIntervalHours: 6, rollupAfterDays: 14, sourceIntervals: { npm: 12 } }),
    });
    assert.equal(res.status, 200);
    const s = (await res.json()).settings;
    assert.equal(s.quotaFloor, 5);
    assert.equal(s.externalIntervalHours, 6);
    assert.equal(s.rollupAfterDays, 14);
    assert.match(s.sourceIntervals, /npm/);
  });

  test("GET /api/custom-repos 带 stale 字段", async () => {
    await api("/api/custom-repos", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ full_name: "ops/stale-check" }),
    });
    const body = await (await api("/api/custom-repos")).json();
    const item = body.repos.find((r) => r.full_name === "ops/stale-check");
    assert.ok(item);
    assert.equal(item.stale, false);
    await api("/api/custom-repos/ops%2Fstale-check", { method: "DELETE" });
  });

  test("POST /api/maintenance/cleanup 返回清理与降采样统计", async () => {
    const res = await api("/api/maintenance/cleanup", { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.removed, "number");
    assert.equal(typeof body.rolledUp, "number");
    assert.equal(typeof body.retentionDays, "number");
  });

  test("POST /api/metrics/refresh 在无指标时不访问网络", async () => {
    const res = await api("/api/metrics/refresh", { method: "POST" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.total, 0);
    assert.equal(body.fetched, 0);
  });
});

describe("UX / PWA 端点（第五批）", () => {
  test("GET /manifest.webmanifest 返回合法清单", async () => {
    const res = await fetch(base + "/manifest.webmanifest");
    assert.equal(res.status, 200);
    const m = await res.json();
    assert.equal(m.start_url, "/");
    assert.equal(m.display, "standalone");
    assert.ok(Array.isArray(m.icons) && m.icons.length > 0);
  });

  test("GET /sw.js 与 /icon.svg 可访问", async () => {
    const sw = await fetch(base + "/sw.js");
    assert.equal(sw.status, 200);
    assert.match(await sw.text(), /addEventListener\("fetch"/);
    const icon = await fetch(base + "/icon.svg");
    assert.equal(icon.status, 200);
    assert.match(icon.headers.get("content-type"), /svg/);
  });

  test("GET /api/repos/:id/history 含 events 字段", async () => {
    const id = db.prepare("SELECT id FROM repos WHERE full_name = 'api/one'").get().id;
    const res = await api(`/api/repos/${id}/history`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.events));
  });
});

describe("Web Push 端点（第六批）", () => {
  const clientKeys = () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
  };

  test("GET /api/push/public-key 返回 65 字节公钥", async () => {
    const res = await api("/api/push/public-key");
    assert.equal(res.status, 200);
    const { publicKey } = await res.json();
    assert.equal(Buffer.from(publicKey, "base64url").length, 65);
  });

  test("订阅 → 列表 → 取消订阅", async () => {
    const keys = clientKeys();
    const bad = await api("/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/x", keys: { p256dh: "bad", auth: "bad" } }),
    });
    assert.equal(bad.status, 400);

    const ok = await api("/api/push/subscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/x", keys }),
    });
    assert.equal(ok.status, 200);

    const list = await (await api("/api/push/subscriptions")).json();
    assert.ok(list.count >= 1);
    assert.ok(list.subscriptions.some((s) => s.endpointHost === "push.example"));

    const del = await api("/api/push/unsubscribe", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: "https://push.example/x" }),
    });
    assert.equal(del.status, 200);
  });

  test("无订阅时测试推送返回 400", async () => {
    // 清空后再测
    const list = await (await api("/api/push/subscriptions")).json();
    for (const s of list.subscriptions) {
      // 通过 unsubscribe 需要 endpoint，这里直接再查一次（列表不返回 endpoint 明文）
    }
    // 若无订阅则 400；有订阅时切换为成功路径
    const res = await api("/api/push/test", { method: "POST" });
    if (list.count === 0) {
      assert.equal(res.status, 400);
    } else {
      assert.equal(res.status, 200);
    }
  });
});

describe("多用户：认证、权限与数据隔离（第七批）", () => {
  let adminSession, memberSession, memberId;

  const asUser = (session, path, opts = {}) =>
    fetch(base + path, {
      ...opts,
      headers: { ...(opts.body ? { "Content-Type": "application/json" } : {}), "X-Session": session, ...(opts.headers || {}) },
    });
  const jsonUser = (session, path, opts = {}) =>
    asUser(session, path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });

  test("注册首个用户成为管理员并返回会话", async () => {
    const res = await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret123" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.role, "admin");
    assert.ok(body.session);
    adminSession = body.session;

    const status = await (await asUser(adminSession, "/api/auth/status")).json();
    assert.equal(status.hasUsers, true);
    assert.equal(status.user.username, "alice");
    assert.equal(status.canRegister, false);
  });

  test("重复注册被拒绝，密码过短被拒绝", async () => {
    const dup = await fetch(base + "/api/auth/register", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "secret123" }),
    });
    assert.equal(dup.status, 409);
    const weak = await asUser(adminSession, "/api/auth/users", {
      method: "POST", body: JSON.stringify({ username: "weak", password: "123" }),
    });
    assert.equal(weak.status, 400);
  });

  test("登录：密码错误 401，正确返回会话", async () => {
    const bad = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "wrong" }),
    });
    assert.equal(bad.status, 401);

    const ok = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: "secret123" }),
    });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).session);
  });

  test("存在用户后无凭据访问 /api 返回 401", async () => {
    const res = await fetch(base + "/api/repos");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).needsLogin, true);
  });

  test("管理员可创建成员，成员无权管理用户", async () => {
    const created = await asUser(adminSession, "/api/auth/users", {
      method: "POST", body: JSON.stringify({ username: "bob", password: "bobpass123", role: "member" }),
    });
    assert.equal(created.status, 200);
    memberId = (await created.json()).id;

    const login = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "bobpass123" }),
    });
    memberSession = (await login.json()).session;

    const forbidden = await asUser(memberSession, "/api/auth/users", {
      method: "POST", body: JSON.stringify({ username: "eve", password: "evepass123" }),
    });
    assert.equal(forbidden.status, 403);
  });

  test("数据按用户隔离（自定义仓库 / 视图 / 指数 / 追踪 / 收藏）", async () => {
    // alice 写入
    await asUser(adminSession, "/api/custom-repos", { method: "POST", body: JSON.stringify({ full_name: "iso/alice-only" }) });
    await asUser(adminSession, "/api/views", { method: "POST", body: JSON.stringify({ name: "alice-view", filters: { language: "Go" } }) });
    await asUser(adminSession, "/api/indices", { method: "POST", body: JSON.stringify({ name: "alice-index", language: "Go" }) });
    await asUser(adminSession, "/api/queries", { method: "POST", body: JSON.stringify({ label: "alice-eco", query: "language:go" }) });

    // bob 看不到
    const bCustom = await (await asUser(memberSession, "/api/custom-repos")).json();
    assert.ok(!bCustom.repos.some((r) => r.full_name === "iso/alice-only"), "bob 不应看到 alice 的自定义仓库");
    const bViews = await (await asUser(memberSession, "/api/views")).json();
    assert.ok(!bViews.views.some((v) => v.name === "alice-view"));
    const bIndices = await (await asUser(memberSession, "/api/indices")).json();
    assert.ok(!bIndices.indices.some((i) => i.name === "alice-index"));
    const bQueries = await (await asUser(memberSession, "/api/queries")).json();
    assert.ok(!bQueries.queries.some((q) => q.label === "alice-eco"));

    // bob 写入自己的，alice 也看不到
    await asUser(memberSession, "/api/custom-repos", { method: "POST", body: JSON.stringify({ full_name: "iso/bob-only" }) });
    const aCustom = await (await asUser(adminSession, "/api/custom-repos")).json();
    assert.ok(aCustom.repos.some((r) => r.full_name === "iso/alice-only"));
    assert.ok(!aCustom.repos.some((r) => r.full_name === "iso/bob-only"));

    // 越权访问他人指数
    const aIndices = await (await asUser(adminSession, "/api/indices")).json();
    const aliceIndexId = aIndices.indices.find((i) => i.name === "alice-index").id;
    assert.equal((await asUser(memberSession, `/api/indices/${aliceIndexId}/series`)).status, 404);

    // 同名资源互不冲突
    const sameName = await asUser(memberSession, "/api/indices", { method: "POST", body: JSON.stringify({ name: "alice-index", language: "Rust" }) });
    assert.equal(sameName.status, 200, "不同用户可使用同名指数");
  });

  test("收藏与告警按用户隔离", async () => {
    const repoId = db.prepare("SELECT id FROM repos LIMIT 1").get().id;
    const t1 = await (await asUser(adminSession, `/api/favorites/${repoId}/toggle`, { method: "POST" })).json();
    assert.equal(t1.added, true);
    const aFav = await (await asUser(adminSession, "/api/favorites")).json();
    const bFav = await (await asUser(memberSession, "/api/favorites")).json();
    assert.ok(aFav.repos.some((r) => r.id === repoId));
    assert.ok(!bFav.repos.some((r) => r.id === repoId), "bob 不应看到 alice 的收藏");

    db.prepare("INSERT INTO alerts (repo_id, threshold, growth, current_stars, kind, user_id) VALUES (?,?,?,?,?,?)")
      .run(repoId, 10, 99, 5000, "growth", 1);
    const aAlerts = await (await asUser(adminSession, "/api/alerts")).json();
    const bAlerts = await (await asUser(memberSession, "/api/alerts")).json();
    assert.ok(aAlerts.unread >= 1);
    assert.equal(bAlerts.unread, 0);
  });

  test("Atom 告警订阅按用户隔离（取自己的告警，而非全局 user 0）", async () => {
    const repoId = db.prepare("SELECT id FROM repos LIMIT 1").get().id;
    db.prepare("INSERT INTO alerts (repo_id, threshold, growth, current_stars, kind, user_id) VALUES (?,?,?,?,?,?)")
      .run(repoId, 10, 77, 6000, "growth", 1);
    const aFeed = await (await asUser(adminSession, "/api/feed/alerts.xml")).text();
    const bFeed = await (await asUser(memberSession, "/api/feed/alerts.xml")).text();
    assert.match(aFeed, /\+77 星/, "alice 的订阅应包含自己的告警");
    assert.doesNotMatch(bFeed, /\+77 星/, "bob 的订阅不应包含 alice 的告警");
  });

  test("推送订阅按用户隔离", async () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url") };
    await asUser(adminSession, "/api/push/subscribe", { method: "POST", body: JSON.stringify({ endpoint: "https://push.example/alice", keys }) });
    const a = await (await asUser(adminSession, "/api/push/subscriptions")).json();
    const b = await (await asUser(memberSession, "/api/push/subscriptions")).json();
    assert.ok(a.count >= 1);
    assert.equal(b.count, 0);
  });

  test("修改密码后旧会话失效", async () => {
    const changed = await fetch(base + "/api/auth/password", {
      method: "PUT", headers: { "Content-Type": "application/json", "X-Session": memberSession },
      body: JSON.stringify({ password: "newpass456" }),
    });
    assert.equal(changed.status, 200);
    assert.equal((await asUser(memberSession, "/api/views")).status, 401);

    const relogin = await fetch(base + "/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "bob", password: "newpass456" }),
    });
    assert.equal(relogin.status, 200);
  });

  test("不能删除最后一名管理员", async () => {
    const users = await (await asUser(adminSession, "/api/auth/users")).json();
    const me = users.users.find((u) => u.username === "alice");
    const res = await asUser(adminSession, `/api/auth/users/${me.id}`, { method: "DELETE" });
    assert.equal(res.status, 400);
  });

  test("会话令牌不接受查询参数（防泄漏进日志 / Referer）", async () => {
    const viaQuery = await fetch(base + `/api/repos?session=${encodeURIComponent(adminSession)}`);
    assert.equal(viaQuery.status, 401, "URL 里的 session 不应被接受");
    const viaHeader = await asUser(adminSession, "/api/repos");
    assert.equal(viaHeader.status, 200, "请求头里的 session 仍应有效");
  });

  test("登录接口有速率限制（防暴力破解）", async () => {
    let sawTooMany = false;
    for (let i = 0; i < 15 && !sawTooMany; i++) {
      const res = await fetch(base + "/api/auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "alice", password: "definitely-wrong" }),
      });
      if (res.status === 429) {
        sawTooMany = true;
        assert.ok(Number(res.headers.get("retry-after")) > 0, "应带 Retry-After");
      } else {
        assert.equal(res.status, 401);
      }
    }
    assert.ok(sawTooMany, "连续失败登录应触发 429");
  });
});

describe("token 环境变量解析（第八批）", () => {
  test("优先用 GITHUB_TOKEN", () => {
    assert.deepEqual(resolveToken({ GITHUB_TOKEN: "ghp_a", GH_TOKEN: "gho_b" }), {
      token: "ghp_a", source: "GITHUB_TOKEN",
    });
  });

  test("GITHUB_TOKEN 为空/缺失时回退 GH_TOKEN（可直接用 gh auth token 提供）", () => {
    assert.deepEqual(resolveToken({ GH_TOKEN: "gho_b" }), { token: "gho_b", source: "GH_TOKEN" });
    assert.deepEqual(resolveToken({ GITHUB_TOKEN: "", GH_TOKEN: "gho_b" }), { token: "gho_b", source: "GH_TOKEN" });
  });

  test("两者都为空时返回空 token 与 null 来源（判定为匿名模式）", () => {
    assert.deepEqual(resolveToken({}), { token: "", source: null });
    assert.deepEqual(resolveToken({ GITHUB_TOKEN: "", GH_TOKEN: "" }), { token: "", source: null });
  });
});
