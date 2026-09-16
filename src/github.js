const BASE = "https://api.github.com";
const RETRY_TIMES = 3;
const RETRY_DELAY_MS = 1000;

// ETag 缓存：GitHub 的 304 响应不计入主配额，可显著省配额
const etagCache = new Map();
// 按资源（search / core / graphql …）分别记录最近一次配额，供调度决策
let lastQuota = null;

/** 最近一次请求的配额信息；已按资源分类，如 { search: {...}, core: {...} } */
export function getLastQuota() {
  return lastQuota;
}

/** 清空 ETag 缓存（强制下次全量拉取） */
export function resetEtagCache() {
  etagCache.clear();
}

function parseRateLimit(res) {
  const limit = Number(res.headers.get("x-ratelimit-limit"));
  if (!limit) return null;
  return {
    resource:  res.headers.get("x-ratelimit-resource") || "core",
    used:      Number(res.headers.get("x-ratelimit-used")) || 0,
    limit,
    remaining: Number(res.headers.get("x-ratelimit-remaining")) || 0,
    reset:     res.headers.get("x-ratelimit-reset"),
  };
}

function headersFor(token, accept) {
  return {
    Accept: accept || "application/vnd.github+json",
    "User-Agent": "github-star-tracker",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造 /repos/{owner}/{repo} 路径。
 * 注意：不能对 fullName 整体 encodeURIComponent —— '/' 会被编成 %2F，GitHub 会返回 404。
 */
const repoPath = (fullName) => String(fullName).split("/").map(encodeURIComponent).join("/");

/**
 * 带 ETag 协商与指数退避的 GitHub JSON 请求。
 * - 命中 ETag（304）时直接返回缓存的解析结果，且不消耗配额
 * - 429 / 5xx 自动重试
 * @returns {{ data:any, rate:object|null, cached:boolean }}
 */
async function requestJson(url, { token, accept, allow404 = false } = {}) {
  const cached = etagCache.get(url);
  for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
    const res = await fetch(url, {
      headers: {
        ...headersFor(token, accept),
        ...(cached ? { "If-None-Match": cached.etag } : {}),
      },
    });

    const rate = parseRateLimit(res);
    if (rate) lastQuota = { ...(lastQuota || {}), [rate.resource]: rate, last: rate };

    if (res.status === 304 && cached) {
      return { data: cached.data, rate: rate || cached.rate || null, cached: true };
    }
    if (res.status === 404 && allow404) {
      return { data: null, rate, cached: false };
    }
    if (res.ok) {
      const data = await res.json();
      const etag = res.headers.get("etag");
      if (etag) etagCache.set(url, { etag, data, rate });
      return { data, rate, cached: false };
    }

    if ((res.status === 429 || res.status >= 500) && attempt < RETRY_TIMES) {
      const retryAfter = res.headers.get("Retry-After");
      const delay = retryAfter ? Number(retryAfter) * 1000 : RETRY_DELAY_MS * Math.pow(2, attempt);
      console.warn(`[github] ${res.status} on attempt ${attempt + 1}, retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
      continue;
    }

    if (res.status === 403 || res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const err = new Error(`GitHub 限流（${res.status}）: ${body.message || "rate limit exceeded"}`);
      err.rate = rate;
      throw err;
    }
    throw new Error(`GitHub API 错误（${res.status}）`);
  }
  throw new Error(`GitHub API 重试 ${RETRY_TIMES + 1} 次后仍失败`);
}

function mapRepo(it) {
  return {
    full_name: it.full_name,
    owner: (it.owner && it.owner.login) || null,
    name: it.name,
    url: it.html_url,
    description: it.description,
    language: it.language,
    homepage: it.homepage,
    stars: it.stargazers_count,
    forks: it.forks_count ?? 0,
    open_issues: it.open_issues_count ?? 0,
    gh_created_at: it.created_at,
  };
}

/**
 * 搜索 GitHub 热门仓库。
 * @param {string} query 自定义搜索语法（如 "language:javascript stars:>1000"），留空则用 stars:>=minStars
 * @returns {{ items: Array, rate: object|null }}
 */
export async function searchTopRepos({ minStars, token, maxPages = 3, perPage = 100, query = "" }) {
  const baseQ = String(query || "").trim();
  const q = encodeURIComponent(baseQ || `stars:>=${minStars}`);
  const items = [];
  let lastRate = null;

  for (let page = 1; page <= maxPages; page++) {
    const url = `${BASE}/search/repositories?q=${q}&sort=stars&order=desc&per_page=${perPage}&page=${page}`;
    const { data, rate } = await requestJson(url, { token });
    if (rate) lastRate = rate;

    if (!data.items || data.items.length === 0) break;
    for (const it of data.items) items.push(mapRepo(it));
    if (data.items.length < perPage) break;
  }

  return { items, rate: lastRate };
}

/** 查询单个仓库的当前信息，返回对象或 null。 */
export async function fetchCustomRepo(fullName, token) {
  const url = `${BASE}/repos/${repoPath(fullName)}`;
  const { data } = await requestJson(url, { token, allow404: true });
  if (!data) return null;              // 已删除 / 转私有 / 旧地址失效
  return mapRepo(data);
}

/**
 * 拉取某仓库的 stargazers（带 starred_at 时间戳），按时间倒序（最新在前）。
 * 用于历史回填：第 i 个（0-based）stargazer 对应当时星数 ≈ 当前总星数 - i。
 * @returns {{ items: Array<{starred_at:string, login:string}>, hasMore:boolean }}
 */
export async function fetchStargazers(fullName, { token, page = 1, perPage = 100 } = {}) {
  const url = `${BASE}/repos/${repoPath(fullName)}/stargazers?per_page=${perPage}&page=${page}&direction=desc`;
  const { data } = await requestJson(url, { token, accept: "application/vnd.github.star+json" });
  const list = Array.isArray(data) ? data : [];
  return {
    items: list.map((s) => ({
      starred_at: s.starred_at || s.starredAt || null,
      login: s.user?.login || null,
    })),
    hasMore: list.length === perPage,
  };
}

/**
 * A4: 富化仓库信息 —— topics / license / 订阅数 / 最新 release / 贡献者数。
 * 共 3 次请求（repo / releases/latest / contributors），均走 ETag 缓存。
 */
export async function fetchRepoDetails(fullName, token) {
  const enc = repoPath(fullName);
  const { data } = await requestJson(`${BASE}/repos/${enc}`, { token });

  const details = {
    full_name: data.full_name,
    topics: Array.isArray(data.topics) ? data.topics.slice(0, 20) : [],
    license: data.license && data.license.spdx_id && data.license.spdx_id !== "NOASSERTION"
      ? data.license.spdx_id
      : (data.license?.name || null),
    subscribers_count: data.subscribers_count ?? null,
    network_count: data.network_count ?? null,
    archived: Boolean(data.archived),
    disabled: Boolean(data.disabled),
    is_fork: Boolean(data.fork),
    default_branch: data.default_branch || null,
    pushed_at: data.pushed_at || null,
    size_kb: data.size ?? null,
    open_issues: data.open_issues_count ?? null,
    latestRelease: null,
    contributors: null,
  };

  // 最新 release（无 release 会 404）
  try {
    const rel = await requestJson(`${BASE}/repos/${enc}/releases/latest`, { token });
    details.latestRelease = {
      tag: rel.data.tag_name,
      name: rel.data.name || rel.data.tag_name,
      published_at: rel.data.published_at,
      url: rel.data.html_url,
      prerelease: Boolean(rel.data.prerelease),
    };
  } catch { /* 404：该仓库没有 release */ }

  // 贡献者数：per_page=1 时 Link 头 last 页号即为总数
  try {
    const res = await fetch(`${BASE}/repos/${enc}/contributors?per_page=1&anon=1`, { headers: headersFor(token) });
    if (res.ok) {
      const link = res.headers.get("link") || "";
      const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
      if (m) details.contributors = Number(m[1]);
      else {
        const arr = await res.json().catch(() => []);
        details.contributors = Array.isArray(arr) ? arr.length : null;
      }
    } else if (res.status === 404) {
      details.contributors = 0;
    }
  } catch { /* 忽略 */ }

  return details;
}
