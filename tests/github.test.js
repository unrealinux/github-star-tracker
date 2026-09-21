/**
 * GitHub 客户端：token 失效降级与状态上报（node:test，零依赖）
 * 运行：npm test
 *
 * 背景：拿到 401 时原实现直接抛错、不回退匿名 —— 一个过期或被吊销的 token
 * 会让**整条采集链路**停摆（定时抓取每天静默失败），而 UI 仍显示「Token ✅」，
 * 因为过去只判断「有没有配置」。
 *
 * 这里用桩替换全局 fetch 覆盖降级行为，不访问网络。
 * 计数类断言统一用 fetchCustomRepo（恰好 1 次请求），
 * 不用 fetchRepoDetails（它另会请求 releases/contributors，共 3 次）。
 */
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  fetchCustomRepo, fetchRepoDetails, searchTopRepos, checkToken,
  getTokenState, resetTokenState,
} from "../src/github.js";

const realFetch = globalThis.fetch;

/** 用桩替换全局 fetch，并记录每次请求携带的 Authorization 头 */
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const h = opts.headers || {};
    const auth = h.Authorization || h.authorization || null;
    calls.push({ url: String(url), auth });
    return handler(String(url), auth, calls.length);
  };
  return calls;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const repoBody = { full_name: "a/b", stargazers_count: 1, owner: { login: "a" }, name: "b" };

beforeEach(() => resetTokenState());
afterEach(() => { globalThis.fetch = realFetch; });

describe("GitHub token 失效降级", () => {
  test("拿到 401 时自动改用匿名重试并成功返回", async () => {
    const calls = stubFetch((_url, auth) =>
      auth ? json({ message: "Bad credentials" }, 401) : json(repoBody)
    );

    const repo = await fetchCustomRepo("a/b", "ghp_bad");

    assert.equal(repo.full_name, "a/b", "应降级成功后正常返回数据");
    assert.equal(calls.length, 2, "应先带 token 失败、再匿名成功");
    assert.equal(calls[0].auth, "Bearer ghp_bad", "第一次应带 token");
    assert.equal(calls[1].auth, null, "第二次必须匿名");
    assert.equal(getTokenState(), "invalid", "状态应标记为失效");
  });

  test("判定失效后，后续请求直接匿名——不重复浪费一次请求", async () => {
    const calls = stubFetch((_url, auth) =>
      auth ? json({ message: "Bad credentials" }, 401) : json(repoBody)
    );

    await fetchCustomRepo("a/b", "ghp_bad");     // 带 token 失败 + 匿名成功 = 2 次
    const afterFirst = calls.length;

    await fetchCustomRepo("c/d", "ghp_bad");     // 应只需 1 次
    assert.equal(calls.length, afterFirst + 1, "第二次调用不应再试 token");
    assert.equal(calls.at(-1).auth, null, "第二次调用应直接匿名");
  });

  test("searchTopRepos 同样能降级（不只 repos 接口）", async () => {
    const calls = stubFetch((_url, auth) =>
      auth ? json({ message: "Bad credentials" }, 401) : json({ items: [], total_count: 0 })
    );

    const out = await searchTopRepos({ minStars: 100, token: "ghp_bad", maxPages: 1, perPage: 1 });

    assert.ok(out, "应正常返回而不是抛错");
    assert.ok(calls.some((c) => c.auth === null), "应发生匿名请求");
    assert.equal(getTokenState(), "invalid");
  });

  test("token 有效时状态记为 ok 且一直带 token", async () => {
    const calls = stubFetch(() => json(repoBody));

    await fetchCustomRepo("a/b", "ghp_good");

    assert.equal(calls[0].auth, "Bearer ghp_good");
    assert.equal(getTokenState(), "ok");
  });

  test("未配置 token：状态为 none 且不带认证头", async () => {
    const calls = stubFetch(() => json(repoBody));

    await fetchCustomRepo("a/b", "");

    assert.equal(calls[0].auth, null);
    assert.equal(getTokenState(), "none");
  });

  test("非 401 的错误不会被误判成 token 失效", async () => {
    stubFetch(() => json({ message: "Not Found" }, 404));

    await assert.rejects(() => fetchRepoDetails("a/b", "ghp_good"));
    assert.notEqual(getTokenState(), "invalid", "404 不应判定 token 失效");
  });
});

describe("checkToken 主动探测", () => {
  test("坏 token → invalid；好 token → ok；空 token → none", async () => {
    stubFetch((_url, auth) =>
      auth === "Bearer ghp_bad" ? json({ message: "Bad credentials" }, 401) : json({ resources: {} })
    );

    assert.equal(await checkToken("ghp_bad"), "invalid");
    resetTokenState();
    assert.equal(await checkToken("ghp_good"), "ok");
    resetTokenState();
    assert.equal(await checkToken(""), "none");
  });

  test("探测失败（网络异常）时不误判为失效", async () => {
    globalThis.fetch = async () => { throw new Error("network down"); };
    assert.equal(await checkToken("ghp_good"), "unknown");
  });

  test("探测始终带 token，即使此前已判定失效", async () => {
    const calls = stubFetch((_url, auth) =>
      auth ? json({ message: "Bad credentials" }, 401) : json(repoBody)
    );

    await fetchCustomRepo("a/b", "ghp_bad");     // 先判定失效
    assert.equal(getTokenState(), "invalid");
    const before = calls.length;

    await checkToken("ghp_bad");                 // 探测必须仍带 token，否则永远测不出问题
    assert.ok(calls.length > before, "应真的发出探测请求");
    assert.equal(calls.at(-1).auth, "Bearer ghp_bad", "探测必须强制带上 token");
  });
});
