/**
 * 服务端环境配置 —— process.env 的集中读取点。
 *
 * 注意：必须（在任何读取 process.env 的代码之前）加载 .env，
 * 因此这里第一个 import 就是 ./env.js。ESM 模块缓存保证 env.js 只执行一次，
 * 且因 server.js 也把它放在 import 列表最前面，读取 env 的时序语义与拆分前一致。
 */
import "./env.js";
import cron from "node-cron";

/**
 * 解析 GitHub token：优先 `GITHUB_TOKEN`，为空时回退到 gh CLI 约定的 `GH_TOKEN`。
 * 这样就能直接 `GITHUB_TOKEN=$(gh auth token) node server.js`，
 * 而不必去网页手建 token。纯函数，便于测试。
 * @returns {{ token: string, source: "GITHUB_TOKEN"|"GH_TOKEN"|null }}
 */
export function resolveToken(env = process.env) {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, source: "GITHUB_TOKEN" };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, source: "GH_TOKEN" };
  return { token: "", source: null };
}

const resolved = resolveToken();

export const TOKEN = resolved.token;
export const TOKEN_SOURCE = resolved.source;

export const API_KEY = process.env.API_KEY || "";
// 只读订阅令牌：可安全地写进 RSS URL，权限仅限 /api/feed/*，不暴露主 API Key
export const FEED_TOKEN = process.env.FEED_TOKEN || "";
export const DEFAULT_MIN_STARS = 1000;
export const DEFAULT_MIN_GROWTH = 0;
// 排行榜 / 榜单类接口的返回条数上限（可用 LEADERBOARD_MAX 调大）
export const LEADERBOARD_MAX = Math.max(1, Number(process.env.LEADERBOARD_MAX) || 200);
export const CRON = process.env.CRON_SCHEDULE || "0 9 * * *";
export const POLL_TICK = "* * * * *";

export const cronValid = cron.validate(CRON);
