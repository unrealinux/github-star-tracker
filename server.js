import express from "express";
import crypto from "node:crypto";
import cron from "node-cron";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import {
  db,
  getSetting, getSettings, setSetting, closeDb,
  listCustomRepos, countCustomRepos, addCustomRepo, removeCustomRepo, searchCustomRepo,
  toggleFavorite, listFavorites, countFavorites,
  getAlertsUnreadCount, markAlertsRead, getRecentAlerts,
  getApiQuotaInfo,
  exportDb, exportData, importData,
  getSavedViews, saveView, deleteView,
  listIndices, addIndex, removeIndex,
  listTrackedQueries, addTrackedQuery, removeTrackedQuery,
  listPushSubscriptions, countPushSubscriptions,
  countUsers, listUsers, getUser, getUserByName, createUser, deleteUser,
  setUserPassword, setUserRole, createSession, getSession, deleteSession, purgeExpiredSessions,
  addTrackedMetric, removeTrackedMetric, getTrackedMetric, countTrackedMetrics,
} from "./src/db.js";
import { hashPassword, verifyPassword, newSessionToken, SESSION_TTL_MS } from "./src/auth.js";
import {
  listRepos, listLanguages, getRepoHistory, getStats,
  getLanguageTrends, getRankChanges, getLeaderboard,
  getSurges, listReposAt, getBadgeData, AVAILABLE_METRICS,
  compareRepos, getOverview, findSimilarRepos,
  getAnomalies, getRisingStars, getSparkData,
  getEvents, backtestAlerts,
  getIndexSeries, getQueryAggregate, refreshTrackedQueries,
} from "./src/tracker.js";
import { renderBadge, colorForGrowth, compactNumber, renderSparkline, shieldsPayload } from "./src/badge.js";
import { runScheduledRefresh, runManualRefresh, getScheduleState, runCleanup, checkDueDigest } from "./src/scheduler.js";
import { testWebhook, WEBHOOK_TYPES } from "./src/notify.js";
import { SOURCE_LIST, fetchSource } from "./src/sources.js";
import { refreshExternalMetrics, listExternalMetrics, getExternalMetricHistory } from "./src/external.js";
import { backfillRepo, backfillMany, resolveBackfillScope } from "./src/backfill.js";
import { runDigest } from "./src/digest.js";
import { getVapidKeys, subscribePush, unsubscribePush, sendPushToAll } from "./src/webpush.js";
import { fetchRepoDetails, getLastQuota, getTokenState, checkToken } from "./src/github.js";
import { logger } from "./src/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
try { process.loadEnvFile(join(__dirname, ".env")); } catch {}

const app = express();

// ── 安全响应头（零依赖手写，避免引入 helmet）──────────────────────
// script-src 仅 'self'（全站只有 /app.js，无内联脚本）；style-src 保留
// 'unsafe-inline'（页面用了 style="..."）。session 存 localStorage，CSP 抬高 XSS 门槛。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
});

// ── 请求体解析：全局 256kb，仅「数据导入」单独放大到 25mb ──────────
// 之前全局 25mb 且解析发生在鉴权之前，未认证请求也能逼迫服务解析大体积 body。
const jsonSmall = express.json({ limit: "256kb" });
const jsonLarge = express.json({ limit: "25mb" });
app.use((req, res, next) => (req.path === "/api/maintenance/import" ? next() : jsonSmall(req, res, next)));

// D2: 轻量请求计数（仅按 method+status，避免高基数）供 /metrics 暴露
const requestCounters = new Map();
app.use((req, res, next) => {
  res.on("finish", () => {
    const key = `${req.method}|${res.statusCode}`;
    requestCounters.set(key, (requestCounters.get(key) || 0) + 1);
  });
  next();
});

// 反代部署时开启（TRUST_PROXY=loopback / true / IP 列表），让限流能取到真实客户端 IP
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) app.set("trust proxy", TRUST_PROXY === "true" ? true : TRUST_PROXY);

// API 响应不缓存；静态资源保留 ETag，走协商缓存（304）而不重复下载
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(join(__dirname, "public")));

const PORT      = Number(process.env.PORT) || 3001;

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

const { token: TOKEN, source: TOKEN_SOURCE } = resolveToken();
const API_KEY   = process.env.API_KEY || "";
// 只读订阅令牌：可安全地写进 RSS URL，权限仅限 /api/feed/*，不暴露主 API Key
const FEED_TOKEN = process.env.FEED_TOKEN || "";
const DEFAULT_MIN_STARS = 1000;
const DEFAULT_MIN_GROWTH = 0;
const CRON      = process.env.CRON_SCHEDULE || "0 9 * * *";
const POLL_TICK = "* * * * *";

const cronValid = cron.validate(CRON);
let cronTask = null;
let lastPollAt = 0;

const toNum = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// P1: 指标参数校验
const METRIC_KEYS = AVAILABLE_METRICS.map((m) => m.key);
const toMetric = (v) => (METRIC_KEYS.includes(v) ? v : "stars");

// ── P5: 认证与会话 ─────────────────────────────────────────────────
// 解析顺序：会话令牌 → API Key（自动化/管理员）→ 无用户时的单用户模式
const AUTH_OPEN_PATHS = new Set(["/auth/status", "/auth/login", "/auth/register", "/auth/logout"]);

// 常量时间比较密钥，避免通过响应时间逐字节猜出正确值（长度经 SHA-256 归一）
function safeEqual(a, b) {
  const h = (v) => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

function issueSession(userId, req) {
  const token = newSessionToken();
  createSession({ token, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(), userAgent: req.get("user-agent") });
  purgeExpiredSessions();
  return token;
}

function resolveAuth(req, res, next) {
  // 只认请求头，避免 token 经由 URL 泄漏进日志 / Referer / 浏览器历史
  const token = req.get("X-Session") || "";
  if (token) {
    const s = getSession(token);
    if (s) {
      req.userId = s.user_id;
      req.user = { id: s.user_id, username: s.username, role: s.role };
      return next();
    }
  }

  // RSS / Atom 只读令牌：能写进订阅 URL，且仅解锁 /api/feed/*，不会泄露主 API Key
  if (FEED_TOKEN && req.path.startsWith("/feed")) {
    const ft = req.get("X-Feed-Token") || req.query.token || "";
    if (ft && safeEqual(ft, FEED_TOKEN)) {
      req.userId = 0;
      req.user = { id: 0, username: "feed", role: "viewer" };
      return next();
    }
  }

  // 配置了 API_KEY 时维持原有语义：除认证接口外都必须带正确 Key（只认请求头）
  if (API_KEY) {
    const key = req.get("X-API-Key") || "";
    if (key && safeEqual(key, API_KEY)) {
      req.userId = 0;
      req.user = { id: 0, username: "api-key", role: "admin" };
      return next();
    }
    if (AUTH_OPEN_PATHS.has(req.path)) return next();
    return res.status(401).json({ error: "未授权：需要正确的 API Key", needsLogin: countUsers() > 0 });
  }

  // 未配置 API_KEY：尚无用户时保持原有单用户/共享模式
  if (countUsers() === 0) {
    req.userId = 0;
    req.user = null;
    return next();
  }

  if (AUTH_OPEN_PATHS.has(req.path)) return next();
  res.status(401).json({ error: "未登录", needsLogin: true });
}

function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  if (countUsers() === 0) return next();      // 单用户模式视为管理员
  res.status(403).json({ error: "需要管理员权限" });
}

// ── 健康检查（无需认证）──────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.round(process.uptime()),
    repos: getStats().repoCount,
    authEnabled: Boolean(API_KEY),
    time: new Date().toISOString(),
  });
});

// ── D2: Prometheus 指标（公开，不含敏感信息）────────────────
function renderMetrics() {
  const s = getStats();
  const q = getApiQuotaInfo();
  const state = getScheduleState();
  const lastRefresh = s.lastRefresh ? Math.floor(Date.parse(s.lastRefresh) / 1000) : 0;
  const lines = [];
  const metric = (name, help, type, value) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, `${name} ${value}`);
  };
  metric("gst_uptime_seconds", "Process uptime in seconds", "gauge", Math.round(process.uptime()));
  metric("gst_repos_total", "Tracked repositories", "gauge", s.repoCount);
  metric("gst_snapshots_total", "Recorded snapshots", "gauge", s.snapCount);
  metric("gst_favorites_total", "Favorited repositories", "gauge", s.favoriteCount);
  metric("gst_custom_repos_total", "Custom-tracked repositories", "gauge", s.customCount);
  metric("gst_pending_growth_total", "Repos without growth baseline", "gauge", s.pendingGrowth);
  metric("gst_tracked_metrics_total", "External metrics tracked", "gauge", countTrackedMetrics());
  metric("gst_alerts_unread", "Unread alerts", "gauge", getAlertsUnreadCount());
  metric("gst_api_quota_used", "GitHub API requests used today", "gauge", q.used);
  metric("gst_api_quota_limit", "GitHub API daily limit", "gauge", q.limit);
  metric("gst_last_refresh_timestamp_seconds", "Unix time of last snapshot", "gauge", lastRefresh);
  metric("gst_refresh_running", "1 when a refresh is in progress", "gauge", state.running ? 1 : 0);
  lines.push("# HELP gst_http_requests_total HTTP requests by method and status", "# TYPE gst_http_requests_total counter");
  for (const [key, count] of requestCounters) {
    const [method, status] = key.split("|");
    lines.push(`gst_http_requests_total{method="${method}",status="${status}"} ${count}`);
  }
  return lines.join("\n") + "\n";
}

app.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics());
});

// ── P2-9: 简易速率限制（针对消耗 GitHub 配额的端点）────────────────
const rateBuckets = new Map();
let rateLimitSeq = 0;
function rateLimit({ windowMs = 60_000, max = 6, name } = {}) {
  // 每个限流器独立分桶：否则同一 IP 在不同端点之间会互相挤占额度
  const bucket = name || `rl-${++rateLimitSeq}`;
  return (req, res, next) => {
    const key = `${bucket}:${req.ip || "unknown"}`;
    const now = Date.now();
    const b = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
    b.count++;
    rateBuckets.set(key, b);
    if (b.count > max) {
      const retry = Math.ceil((b.reset - now) / 1000);
      res.setHeader("Retry-After", String(retry));
      return res.status(429).json({ error: `请求过于频繁，请 ${retry} 秒后重试` });
    }
    next();
  };
}
// 定期清理空桶
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of rateBuckets) if (now > b.reset) rateBuckets.delete(key);
}, 60_000).unref();

// 所有 /api 先解析身份
app.use("/api", resolveAuth);

// ── 认证接口 ────────────────────────────────────────────────────────
app.get("/api/auth/status", (req, res) => {
  const token = req.get("X-Session") || "";
  const s = token ? getSession(token) : undefined;
  const users = countUsers();
  res.json({
    hasUsers: users > 0,
    userCount: users,
    user: s ? { id: s.user_id, username: s.username, role: s.role } : null,
    canRegister: users === 0,
    apiKeyConfigured: Boolean(API_KEY),
  });
});

app.post("/api/auth/register", rateLimit({ windowMs: 60_000, max: 5, name: "auth-register" }), (req, res) => {
  if (countUsers() > 0) return res.status(409).json({ error: "已存在用户，请让管理员创建账号" });
  const { username, password } = req.body || {};
  try {
    const r = createUser({ username, passwordHash: hashPassword(password), role: "admin" });
    if (!r.ok) return res.status(400).json({ error: r.error });
    const session = issueSession(r.id, req);
    logger.info("创建首个管理员账号", { username });
    res.json({ ok: true, user: { id: r.id, username: String(username).trim(), role: "admin" }, session });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/auth/login", rateLimit({ windowMs: 60_000, max: 10, name: "auth-login" }), (req, res) => {
  const { username, password } = req.body || {};
  const user = getUserByName(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: "用户名或密码错误" });
  }
  res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role }, session: issueSession(user.id, req) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.get("X-Session") || req.body?.session;
  if (token) deleteSession(token);
  res.json({ ok: true });
});

app.get("/api/auth/users", requireAdmin, (_req, res) => res.json({ users: listUsers() }));

app.post("/api/auth/users", requireAdmin, (req, res) => {
  try {
    const { username, password, role } = req.body || {};
    const r = createUser({ username, passwordHash: hashPassword(password), role });
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/auth/users/:id", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  if (!getUser(id)) return res.status(404).json({ error: "用户不存在" });
  const admins = listUsers().filter((u) => u.role === "admin");
  const target = getUser(id);
  if (target.role === "admin" && admins.length <= 1) return res.status(400).json({ error: "至少保留一名管理员" });
  deleteUser(id);
  res.json({ ok: true });
});

app.put("/api/auth/password", (req, res) => {
  const id = req.user?.id;
  if (!id) return res.status(400).json({ error: "API Key 模式下无法修改密码" });
  try {
    setUserPassword(id, hashPassword(req.body?.password));
    deleteSession(req.get("X-Session") || "");
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ── 设置 ──────────────────────────────────────────────────────────
function publicSettings(userId = 0) {
  const s = getSettings();
  const num = (key, fallback) => {
    const n = Number(s[key]);
    return s[key] === undefined || s[key] === "" || !Number.isFinite(n) ? fallback : n;
  };
  return {
    minStars:        num("minStars", DEFAULT_MIN_STARS),
    minGrowth:       num("minGrowth", DEFAULT_MIN_GROWTH),
    retentionDays:   num("retentionDays", 90),
    alertThreshold:  num("alertThreshold", 50),
    autoPollMinutes: num("autoPollMinutes", 0),
    searchQuery:     s.searchQuery || "",
    webhookUrl:      s.webhookUrl || "",
    webhookType:     s.webhookType || "generic",
    theme:           s.theme || "dark",
    alertOnDrop:       s.alertOnDrop === "1",
    dropThreshold:     num("dropThreshold", 50),
    alertOnMilestone:  s.alertOnMilestone === "1",
    digestEnabled:     s.digestEnabled === "1",
    digestTime:        s.digestTime || "09:00",
    autoBackup:        s.autoBackup !== "0",
    backfillDays:      num("backfillDays", 90),
    backfillMaxPages:  num("backfillMaxPages", 20),
    quotaFloor:        num("quotaFloor", 3),
    externalIntervalHours: num("externalIntervalHours", 24),
    rollupAfterDays:   num("rollupAfterDays", 30),
    sourceIntervals:   s.sourceIntervals || "{}",
    pushCount:         countPushSubscriptions(userId),
    tokenConfigured: Boolean(TOKEN),
    tokenState:      getTokenState(),
    authEnabled:     Boolean(API_KEY),
  };
}

app.get("/api/settings", (_req, res) => res.json(publicSettings(_req.userId || 0)));

// ── 保存的筛选视图（C5）─────────────────────────────────────────
app.get("/api/views", (req, res) => res.json({ views: getSavedViews(req.userId || 0) }));

app.post("/api/views", (req, res) => {
  try {
    const views = saveView({ name: req.body?.name, filters: req.body?.filters }, req.userId || 0);
    res.json({ ok: true, views });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/views/:name", (req, res) => {
  res.json({ ok: true, views: deleteView(decodeURIComponent(req.params.name), req.userId || 0) });
});

// ── P4: 自定义指数（本地筛选条件聚合）─────────────────────────
app.get("/api/indices", (req, res) => res.json({ indices: listIndices(req.userId || 0) }));

app.post("/api/indices", (req, res) => {
  const b = req.body || {};
  const spec = {
    language: b.language ? String(b.language).trim() : undefined,
    keyword: b.keyword ? String(b.keyword).trim() : undefined,
    minStars: b.minStars === undefined || b.minStars === "" ? undefined : toNum(b.minStars, 0),
    maxStars: b.maxStars === undefined || b.maxStars === "" ? undefined : toNum(b.maxStars, 0),
  };
  const r = addIndex(b.name, spec, req.userId || 0);
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ ok: true, id: r.id });
});

app.delete("/api/indices/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  if (!removeIndex(id, req.userId || 0)) return res.status(404).json({ error: "指数不存在" });
  res.json({ ok: true });
});

app.get("/api/indices/:id/series", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  const data = getIndexSeries(id, {
    days: toNum(req.query.days, 90),
    weight: req.query.weight === "cap" ? "cap" : "equal",
    userId: req.userId || 0,
  });
  if (!data) return res.status(404).json({ error: "指数不存在" });
  res.json(data);
});

// ── P4: 生态 / topic 追踪（GitHub 搜索语法）──────────────────
app.get("/api/queries", (req, res) => res.json({ queries: listTrackedQueries(req.userId || 0) }));

app.post("/api/queries", (req, res) => {
  try {
    const r = addTrackedQuery(req.body?.label, req.body?.query, req.userId || 0);
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.json({ ok: true, id: r.id });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete("/api/queries/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  if (!removeTrackedQuery(id, req.userId || 0)) return res.status(404).json({ error: "追踪不存在" });
  res.json({ ok: true });
});

app.get("/api/queries/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  const data = getQueryAggregate(id, {
    days: toNum(req.query.days, 90),
    weight: req.query.weight === "cap" ? "cap" : "equal",
    userId: req.userId || 0,
  });
  if (!data) return res.status(404).json({ error: "追踪不存在" });
  res.json(data);
});

app.post("/api/queries/refresh", rateLimit({ windowMs: 60_000, max: 3 }), async (_req, res) => {
  try {
    res.json({ ok: true, ...(await refreshTrackedQueries({ token: TOKEN })) });
  } catch (e) {
    res.status(502).json({ error: "刷新追踪失败：" + e.message });
  }
});

app.put("/api/settings", (req, res) => {
  const b = req.body || {};
  try {
    if (b.minStars        !== undefined) setSetting("minStars",        toNum(b.minStars, DEFAULT_MIN_STARS));
    if (b.minGrowth       !== undefined) setSetting("minGrowth",       toNum(b.minGrowth, DEFAULT_MIN_GROWTH));
    if (b.retentionDays   !== undefined) setSetting("retentionDays",   toNum(b.retentionDays, 90));
    if (b.alertThreshold  !== undefined) setSetting("alertThreshold",  toNum(b.alertThreshold, 50));
    if (b.autoPollMinutes !== undefined) setSetting("autoPollMinutes", toNum(b.autoPollMinutes, 0));
    if (b.searchQuery     !== undefined) setSetting("searchQuery",     String(b.searchQuery).trim());
    if (b.webhookUrl      !== undefined) setSetting("webhookUrl",      String(b.webhookUrl).trim());
    if (b.webhookType     !== undefined) setSetting("webhookType",     WEBHOOK_TYPES.includes(b.webhookType) ? b.webhookType : "generic");
    if (b.theme           !== undefined) setSetting("theme",           ["dark", "light", "contrast"].includes(b.theme) ? b.theme : "dark");
    if (b.alertOnDrop     !== undefined) setSetting("alertOnDrop",     b.alertOnDrop ? "1" : "0");
    if (b.dropThreshold   !== undefined) setSetting("dropThreshold",   toNum(b.dropThreshold, 50));
    if (b.alertOnMilestone !== undefined) setSetting("alertOnMilestone", b.alertOnMilestone ? "1" : "0");
    if (b.digestEnabled   !== undefined) setSetting("digestEnabled",   b.digestEnabled ? "1" : "0");
    if (b.digestTime      !== undefined) setSetting("digestTime",      /^\d{1,2}:\d{2}$/.test(String(b.digestTime)) ? String(b.digestTime) : "09:00");
    if (b.autoBackup      !== undefined) setSetting("autoBackup",      b.autoBackup ? "1" : "0");
    if (b.backfillDays    !== undefined) setSetting("backfillDays",    Math.min(730, Math.max(7, toNum(b.backfillDays, 90))));
    if (b.backfillMaxPages !== undefined) setSetting("backfillMaxPages", Math.min(100, Math.max(1, toNum(b.backfillMaxPages, 20))));
    if (b.quotaFloor      !== undefined) setSetting("quotaFloor",      Math.max(0, toNum(b.quotaFloor, 3)));
    if (b.externalIntervalHours !== undefined) setSetting("externalIntervalHours", Math.max(0, toNum(b.externalIntervalHours, 24)));
    if (b.rollupAfterDays !== undefined) setSetting("rollupAfterDays", Math.max(0, toNum(b.rollupAfterDays, 30)));
    if (b.sourceIntervals !== undefined && typeof b.sourceIntervals === "object") {
      const clean = {};
      for (const [k, v] of Object.entries(b.sourceIntervals)) {
        const n = Number(v);
        if (/^[\w-]+$/.test(k) && Number.isFinite(n) && n >= 0) clean[k] = n;
      }
      setSetting("sourceIntervals", JSON.stringify(clean));
    }
    if (b.repoThresholds  !== undefined && b.repoThresholds && typeof b.repoThresholds === "object") {
      const clean = {};
      for (const [k, v] of Object.entries(b.repoThresholds)) {
        const n = Number(v);
        if (/^[\w-]+\/[\w.-]+$/.test(k) && Number.isFinite(n) && n >= 0) clean[k] = n;
      }
      setSetting(repoThresholdKey(req.userId || 0), JSON.stringify(clean));
    }
    res.json({ ok: true, settings: publicSettings(req.userId || 0) });
  } catch {
    res.status(500).json({ error: "设置更新失败" });
  }
});

// ── 仓库列表 ──────────────────────────────────────────────────────
app.get("/api/repos", (req, res) => {
  const minStars     = toNum(req.query.minStars,  toNum(getSetting("minStars", DEFAULT_MIN_STARS),  DEFAULT_MIN_STARS));
  const minGrowth    = toNum(req.query.minGrowth, toNum(getSetting("minGrowth", DEFAULT_MIN_GROWTH), DEFAULT_MIN_GROWTH));
  const language     = req.query.language || "";
  const sort         = ["stars", "metric", "growth", "newest", "name", "language"].includes(req.query.sort) ? req.query.sort : "growth";
  const window       = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  const page         = Math.max(1, toNum(req.query.page, 1));
  const pageSize     = Math.min(200, Math.max(1, toNum(req.query.pageSize, 50)));
  const todayOnly    = req.query.todayOnly === "1" || req.query.todayOnly === "true";
  const keyword      = (req.query.keyword || "").trim();
  const onlyCustom   = req.query.onlyCustom === "1";
  const onlyFavorite = req.query.onlyFavorite === "1";
  const metric       = toMetric(req.query.metric);

  const result = listRepos({ minStars, minGrowth, language, sort, window, page, pageSize, todayOnly, keyword, onlyCustom, onlyFavorite, metric, userId: req.userId || 0 });
  res.json({ ...result, minStars, minGrowth, languages: listLanguages(), sort, window, keyword, onlyCustom, onlyFavorite, metric, metrics: AVAILABLE_METRICS });
});

app.get("/api/repos/:id/history", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  const data = getRepoHistory(id, toMetric(req.query.metric), req.userId || 0);
  if (!data) return res.status(404).json({ error: "项目不存在" });
  res.json(data);
});

// ── C4: 相似仓库推荐 ────────────────────────────────────────────
app.get("/api/repos/:id/similar", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  const data = findSimilarRepos(id, { limit: toNum(req.query.limit, 6) });
  if (!data) return res.status(404).json({ error: "项目不存在" });
  res.json(data);
});

// ── A4: 仓库富化信息（topics/license/release/contributors）───────
app.get("/api/repos/:id/enrich", rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? db.prepare("SELECT full_name FROM repos WHERE id = ?").get(id) : null;
  if (!repo) return res.status(404).json({ error: "项目不存在" });
  try {
    res.json(await fetchRepoDetails(repo.full_name, TOKEN));
  } catch (e) {
    res.status(502).json({ error: "获取仓库详情失败：" + e.message });
  }
});

// ── C1: 多仓库对比 ──────────────────────────────────────────────
app.get("/api/compare", (req, res) => {
  const ids = String(req.query.ids || "").split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 8);
  if (!ids.length) return res.status(400).json({ error: "请至少选择一个仓库（ids=1,2,3）" });
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  res.json(compareRepos({ ids, window, metric: toMetric(req.query.metric), maxPoints: toNum(req.query.points, 90) }));
});

// ── C2: 全局趋势 ────────────────────────────────────────────────
app.get("/api/overview", (req, res) => {
  res.json(getOverview({ days: toNum(req.query.days, 60), userId: req.userId || 0 }));
});

// ── 每仓库告警阈值 ─────────────────────────────────────────────
const repoThresholdKey = (userId = 0) => (userId ? `repoThresholds:${userId}` : "repoThresholds");

function readRepoThresholds(userId = 0) {
  try { return JSON.parse(getSetting(repoThresholdKey(userId), "{}") || "{}") || {}; } catch { return {}; }
}

app.get("/api/repos/:id/alert", (req, res) => {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? db.prepare("SELECT full_name FROM repos WHERE id = ?").get(id) : null;
  if (!repo) return res.status(404).json({ error: "项目不存在" });
  const thresholds = readRepoThresholds(req.userId || 0);
  res.json({
    full_name: repo.full_name,
    threshold: thresholds[repo.full_name] ?? null,
    global: Number(getSetting("alertThreshold", 50)) || 0,
  });
});

app.put("/api/repos/:id/alert", (req, res) => {
  const id = Number(req.params.id);
  const repo = Number.isInteger(id) ? db.prepare("SELECT full_name FROM repos WHERE id = ?").get(id) : null;
  if (!repo) return res.status(404).json({ error: "项目不存在" });
  const thresholds = readRepoThresholds(req.userId || 0);
  const raw = req.body?.threshold;
  if (raw === null || raw === "" || raw === undefined) delete thresholds[repo.full_name];
  else {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return res.status(400).json({ error: "阈值必须是非负数" });
    thresholds[repo.full_name] = n;
  }
  setSetting(repoThresholdKey(req.userId || 0), JSON.stringify(thresholds));
  res.json({ ok: true, full_name: repo.full_name, threshold: thresholds[repo.full_name] ?? null });
});

// ── 📜 历史回填（stargazers 重建）─────────────────────────────
app.post("/api/repos/:id/backfill", rateLimit({ windowMs: 60_000, max: 6 }), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  const days = Math.min(730, Math.max(7, toNum(req.body?.days, Number(getSetting("backfillDays", 90)) || 90)));
  const maxPages = Math.min(100, Math.max(1, toNum(req.body?.maxPages, Number(getSetting("backfillMaxPages", 20)) || 20)));
  try {
    const r = await backfillRepo({ id, token: TOKEN, days, maxPages });
    if (r.error) return res.status(404).json({ error: r.error });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: "回填失败：" + e.message });
  }
});

app.post("/api/backfill", rateLimit({ windowMs: 60_000, max: 3 }), async (req, res) => {
  const scope = ["custom", "favorites", "all"].includes(req.body?.scope) ? req.body.scope : "custom";
  const limit = Math.min(50, Math.max(1, toNum(req.body?.limit, 10)));
  const days = Math.min(730, Math.max(7, toNum(req.body?.days, Number(getSetting("backfillDays", 90)) || 90)));
  const maxPages = Math.min(100, Math.max(1, toNum(req.body?.maxPages, Number(getSetting("backfillMaxPages", 20)) || 20)));
  const ids = resolveBackfillScope(scope, limit);
  if (!ids.length) return res.status(400).json({ error: "该范围内没有可回填的仓库" });
  try {
    const results = await backfillMany({ ids, token: TOKEN, days, maxPages });
    res.json({ ok: true, scope, count: ids.length, results });
  } catch (e) {
    res.status(502).json({ error: "批量回填失败：" + e.message });
  }
});

// ── 收藏（P2-10 支持分页）─────────────────────────────────────────
app.get("/api/favorites", (req, res) => {
  const page = Math.max(1, toNum(req.query.page, 1));
  const pageSize = Math.min(200, Math.max(1, toNum(req.query.pageSize, 100)));
  const total = countFavorites(req.userId || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, totalPages);
  const repos = listFavorites({ limit: pageSize, offset: (p - 1) * pageSize, userId: req.userId || 0 });
  res.json({ repos, total, page: p, pageSize, totalPages });
});

app.post("/api/favorites/:id/toggle", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  res.json(toggleFavorite(id, req.userId || 0));
});

// ── 自定义仓库（P2-10 支持分页）───────────────────────────────────
app.get("/api/custom-repos", (req, res) => {
  const page = Math.max(1, toNum(req.query.page, 1));
  const pageSize = Math.min(200, Math.max(1, toNum(req.query.pageSize, 100)));
  const total = countCustomRepos(req.userId || 0);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(page, totalPages);
  const repos = listCustomRepos({ limit: pageSize, offset: (p - 1) * pageSize, userId: req.userId || 0 });
  res.json({ repos, total, page: p, pageSize, totalPages });
});

app.post("/api/custom-repos", (req, res) => {
  const fullName = (req.body?.full_name || "").trim();
  if (!fullName) return res.status(400).json({ error: "请输入仓库地址" });
  if (!/^[\w-]+\/[\w.-]+$/.test(fullName)) return res.status(400).json({ error: "格式不正确，应为 owner/repo" });
  if (searchCustomRepo(fullName, req.userId || 0)) return res.status(409).json({ error: "该仓库已在追踪列表中" });
  if (!addCustomRepo(fullName, req.body?.note || "", req.userId || 0)) return res.status(409).json({ error: "添加失败，可能已存在" });
  res.json({ ok: true });
});

app.delete("/api/custom-repos/:name", (req, res) => {
  removeCustomRepo(decodeURIComponent(req.params.name), req.userId || 0);
  res.json({ ok: true });
});

// ── 告警 ──────────────────────────────────────────────────────────
app.get("/api/alerts", (req, res) => {
  const limit = Math.min(100, Math.max(1, toNum(req.query.limit, 20)));
  const offset = Math.max(0, toNum(req.query.offset, 0));
  res.json({ unread: getAlertsUnreadCount(req.userId || 0), recent: getRecentAlerts(limit, offset, req.userId || 0) });
});

app.post("/api/alerts/read", (req, res) => {
  markAlertsRead(req.userId || 0);
  res.json({ ok: true });
});

// ── 🧪 告警规则回测 ─────────────────────────────────────
app.get("/api/alerts/backtest", (req, res) => {
  const bool = (v) => (v === undefined ? undefined : v === "1" || v === "true");
  res.json(backtestAlerts({
    days: toNum(req.query.days, 90),
    threshold: req.query.threshold === undefined ? undefined : toNum(req.query.threshold, 50),
    dropThreshold: req.query.dropThreshold === undefined ? undefined : toNum(req.query.dropThreshold, 50),
    alertOnDrop: bool(req.query.onDrop),
    alertOnMilestone: bool(req.query.onMilestone),
    minStars: toNum(req.query.minStars, 0),
    maxFires: toNum(req.query.limit, 200),
  }));
});

// ── 语言趋势 + 排名变化（P1-5）────────────────────────────────────
app.get("/api/languages/trends", (req, res) => {
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  res.json({ trends: getLanguageTrends(window) });
});

app.get("/api/trends/rank", (req, res) => {
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  const limit = Math.min(50, Math.max(1, toNum(req.query.limit, 20)));
  res.json({ window, ...getRankChanges(window, limit) });
});

// ── 🏆 排行榜（总星 Top N + 日均增长 Top N）─────────────────────
app.get("/api/leaderboard", (req, res) => {
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  const limit = Math.min(50, Math.max(1, toNum(req.query.limit, 10)));
  const minStars = toNum(req.query.minStars, Number(getSetting("minStars", DEFAULT_MIN_STARS)) || 0);
  res.json(getLeaderboard({ limit, window, minStars, metric: toMetric(req.query.metric) }));
});

// ── 🚀 爆发榜（P0-1：增速加速度）───────────────────────────────
app.get("/api/trends/surge", (req, res) => {
  const limit = Math.min(50, Math.max(1, toNum(req.query.limit, 10)));
  const minStars = toNum(req.query.minStars, 0);
  const includeDecaying = req.query.decaying === "1";
  res.json(getSurges({ limit, minStars, includeDecaying, metric: toMetric(req.query.metric) }));
});

// ── 🔎 异常检测（z-score，相对自身历史）────────────────────────
app.get("/api/trends/anomaly", (req, res) => {
  res.json(getAnomalies({
    days: toNum(req.query.days, 30),
    z: Number(req.query.z) || 2.5,
    limit: toNum(req.query.limit, 12),
    minSamples: toNum(req.query.minSamples, 5),
    minStars: toNum(req.query.minStars, 0),
  }));
});

// ── 🐎 黑马榜（低星高增速）──────────────────────────────────
app.get("/api/trends/rising", (req, res) => {
  res.json(getRisingStars({
    limit: toNum(req.query.limit, 15),
    maxStars: req.query.maxStars === undefined || req.query.maxStars === "" ? 0 : toNum(req.query.maxStars, 0),
    minDays: toNum(req.query.minDays, 14),
    minStars: toNum(req.query.minStars, 100),
  }));
});

// ── 🌊 事件聚类（同一天多个仓库同时异动）─────────────────────
app.get("/api/trends/events", (req, res) => {
  res.json(getEvents({
    days: toNum(req.query.days, 30),
    z: Number(req.query.z) || 2,
    minRepos: toNum(req.query.minRepos, 3),
    minSamples: toNum(req.query.minSamples, 4),
    minStars: toNum(req.query.minStars, 0),
    limit: toNum(req.query.limit, 12),
  }));
});

// ── ⏪ 历史回放（P0-2）────────────────────────────────────────
app.get("/api/replay", (req, res) => {
  const at = req.query.at;
  if (!at) return res.status(400).json({ error: "缺少 at 参数（ISO 时间戳）" });
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  const sort = req.query.sort === "growth" ? "growth" : "stars";
  const limit = Math.min(200, Math.max(1, toNum(req.query.limit, 50)));
  const offset = Math.max(0, toNum(req.query.offset, 0));
  const minStars = toNum(req.query.minStars, 0);
  const data = listReposAt({ at, window, minStars, sort, limit, offset });
  if (data.error) return res.status(400).json(data);
  res.json(data);
});

// ── 统计 ──────────────────────────────────────────────────────────
app.get("/api/stats", (req, res) => {
  res.json({
    ...getStats(req.userId || 0),
    quota: getApiQuotaInfo(),
    tokenConfigured: Boolean(TOKEN),
    tokenState: getTokenState(),
    authEnabled: Boolean(API_KEY),
    auto: {
      schedule: CRON,
      enabled: cronValid,
      nextRun: cronValid && cronTask ? cronTask.getNextRun()?.toISOString() ?? null : null,
      ...getScheduleState(),
    },
    autoPoll: Number(getSetting("autoPollMinutes", 0)) || 0,
    externalCount: countTrackedMetrics(),
    githubQuota: getLastQuota(),
    staleCount: getStats(req.userId || 0).staleCount,
  });
});

// ── 刷新（P2-9 限流：每分钟最多 6 次）─────────────────────────────
app.post("/api/refresh", rateLimit({ windowMs: 60_000, max: 6 }), async (_req, res) => {
  try {
    const summary = await runManualRefresh({ token: TOKEN });
    if (summary.skipped) return res.status(409).json({ ok: false, skipped: true, reason: summary.reason });
    res.json({ ok: true, ...summary });
  } catch (e) {
    res.status(502).json({ error: "刷新失败：" + e.message });
  }
});

// ── Webhook 测试与摘要（P1-4）───────────────────────────────────
app.get("/api/webhook-types", (_req, res) => res.json({ types: WEBHOOK_TYPES }));

app.post("/api/notify/test", async (req, res) => {
  const url = (req.body?.url || getSetting("webhookUrl", "") || "").trim();
  const type = (req.body?.type || getSetting("webhookType", "generic") || "generic");
  if (!url) return res.status(400).json({ error: "请先填写 Webhook 地址" });
  const result = await testWebhook(url, type);
  res.status(result.ok ? 200 : 502).json(result);
});

app.post("/api/notify/digest", rateLimit({ windowMs: 60_000, max: 3 }), async (_req, res) => {
  try {
    const r = await runDigest();
    if (r.skipped) return res.status(400).json({ error: r.reason || "未发送" });
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status, title: r.title, text: r.text });
  } catch (e) {
    res.status(502).json({ error: "摘要发送失败：" + e.message });
  }
});

// ── Web Push（浏览器/手机系统级通知）─────────────────────────
app.get("/api/push/public-key", (_req, res) => res.json({ publicKey: getVapidKeys().publicKey }));

app.get("/api/push/subscriptions", (req, res) => {
  const subs = listPushSubscriptions(req.userId || 0).map((s) => ({
    id: s.id,
    endpointHost: (() => { try { return new URL(s.endpoint).host; } catch { return "unknown"; } })(),
    created_at: s.created_at,
    last_ok_at: s.last_ok_at,
    last_error: s.last_error,
  }));
  res.json({ count: subs.length, subscriptions: subs });
});

app.post("/api/push/subscribe", (req, res) => {
  const b = req.body || {};
  try {
    res.json(subscribePush({
      endpoint: b.endpoint,
      p256dh: b.keys?.p256dh || b.p256dh,
      auth: b.keys?.auth || b.auth,
      userAgent: req.get("user-agent"),
      userId: req.userId || 0,
    }));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/push/unsubscribe", (req, res) => {
  try {
    res.json(unsubscribePush(req.body?.endpoint, req.userId || 0));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/push/test", rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
  try {
    const result = await sendPushToAll({
      title: "⭐ GitHub Star Tracker",
      body: "这是一条测试推送。若你看到它，说明系统级通知已打通。",
      url: "/",
    }, req.userId || 0);
    if (!result.total) return res.status(400).json({ error: "还没有任何推送订阅，请先在设置页启用浏览器通知" });
    res.json({ ok: result.sent > 0, ...result });
  } catch (e) {
    res.status(502).json({ error: "推送失败：" + e.message });
  }
});

// ── 维护 ──────────────────────────────────────────────────────────
app.post("/api/maintenance/cleanup", (_req, res) => {
  try { res.json({ ok: true, ...runCleanup() }); }
  catch (e) { res.status(500).json({ error: "清理失败：" + e.message }); }
});

app.get("/api/maintenance/export", (req, res) => {
  try {
    if (req.query.format === "json") return res.json(exportData());
    const path = exportDb();
    res.download(path, `github-star-tracker-backup-${new Date().toISOString().slice(0, 10)}.db`);
  } catch (e) {
    res.status(500).json({ error: "导出失败：" + e.message });
  }
});

app.post("/api/maintenance/import", jsonLarge, (req, res) => {
  try {
    const mode = req.body?.mode === "replace" ? "replace" : "merge";
    const payload = req.body?.data || req.body;
    const result = importData(payload, { mode });
    logger.info("数据导入完成", { mode, ...result.counts });
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(400).json({ error: "导入失败：" + e.message });
  }
});

// ── SVG 徽章 + shields.io endpoint（公开，可嵌入 README）──────────
//   用法：![stars](http://host/badge/owner/repo.svg)
//   shields endpoint：https://img.shields.io/endpoint?url=<host>/badge/owner/repo.json
//   可选：?metric=forks|issues &window=day|week|month &label=自定义
app.get("/badge/:owner/:name", (req, res) => {
  let name = req.params.name;
  const asJson = name.endsWith(".json");
  if (asJson) name = name.slice(0, -5);
  else if (name.endsWith(".svg")) name = name.slice(0, -4);

  const fullName = `${req.params.owner}/${name}`;
  const metric = toMetric(req.query.metric);
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";

  const data = getBadgeData(fullName, window);
  if (!data) {
    if (asJson) return res.json(shieldsPayload("GitHub", "not tracked", "#8b949e"));
    res.type("image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=60");
    return res.send(renderBadge("GitHub", "not tracked", "#8b949e"));
  }

  const metricMeta = { stars: ["Stars", data.stars, data.growth], forks: ["Forks", data.forks, data.growthForks], issues: ["Issues", data.open_issues, data.growthIssues] };
  const [labelBase, value, growth] = metricMeta[metric];
  const label = req.query.label ? String(req.query.label) : labelBase;
  const suffix = growth != null && growth !== 0 ? ` (${growth > 0 ? "+" : ""}${growth})` : "";

  if (asJson) {
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.json(shieldsPayload(label, compactNumber(value) + suffix, colorForGrowth(growth)));
  }
  res.type("image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=300");
  res.send(renderBadge(label, compactNumber(value) + suffix, colorForGrowth(growth)));
});

// ── 迷你走势图（公开）─────────────────────────────────────────
//   用法：![trend](http://host/spark/owner/repo.svg)
app.get("/spark/:owner/:name", (req, res) => {
  let name = req.params.name;
  if (name.endsWith(".svg")) name = name.slice(0, -4);
  const fullName = `${req.params.owner}/${name}`;
  const data = getSparkData(fullName, toNum(req.query.points, 30), toMetric(req.query.metric));
  res.type("image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=300");
  if (!data) return res.send(renderBadge("trend", "not tracked", "#8b949e"));
  res.send(renderSparkline(data.values, { width: toNum(req.query.w, 120), height: toNum(req.query.h, 32) }));
});

// ── RSS / Atom 订阅（/api 下，可用 FEED_TOKEN 走 ?token= 认证）───────
const xmlEscape = (s) => String(s ?? "").replace(/[<>&"']/g, (c) => ({
  "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;",
}[c]));

function buildAtom(req, { title, kind, entries }) {
  const base = `${req.protocol}://${req.get("host")}`;
  const self = `${base}/api/feed/${kind}.xml`;
  const updated = new Date().toISOString();
  const items = entries.map((e) => `  <entry>
    <title>${xmlEscape(e.title)}</title>
    <link href="${xmlEscape(e.link)}"/>
    <id>${xmlEscape(e.id)}</id>
    <updated>${xmlEscape(e.updated)}</updated>
    <summary>${xmlEscape(e.summary || "")}</summary>
  </entry>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(title)}</title>
  <link href="${xmlEscape(self)}" rel="self"/>
  <link href="${xmlEscape(base)}"/>
  <id>${xmlEscape(self)}</id>
  <updated>${updated}</updated>
${items}
</feed>`;
}

app.get("/api/feed/:kind", (req, res) => {
  const kind = String(req.params.kind).replace(/\.xml$/, "");
  const gh = (n) => `https://github.com/${n}`;
  let title = "";
  let entries = [];

  if (kind === "surges") {
    title = "GitHub Star Tracker · 爆发项目";
    entries = getSurges({ limit: 30, minStars: 0 }).surges.map((r) => ({
      title: `🚀 ${r.full_name} 加速度 +${r.accel} 星/天²`,
      link: gh(r.full_name),
      id: `urn:gst:surge:${r.full_name}:${new Date().toISOString().slice(0, 10)}`,
      updated: new Date().toISOString(),
      summary: `当前 ${Number(r.stars).toLocaleString("en-US")} 星 · 近日均 ${r.recentAvg} · 前期均 ${r.priorAvg}`,
    }));
  } else if (kind === "new") {
    title = "GitHub Star Tracker · 新收录";
    entries = db.prepare("SELECT full_name, stars, language, first_seen_at FROM repos ORDER BY first_seen_at DESC LIMIT 30").all()
      .map((r) => ({
        title: `🆕 ${r.full_name}（★${Number(r.stars).toLocaleString("en-US")}）`,
        link: gh(r.full_name),
        id: `urn:gst:new:${r.full_name}`,
        updated: r.first_seen_at,
        summary: r.language || "",
      }));
  } else if (kind === "alerts") {
    title = "GitHub Star Tracker · 告警";
    entries = getRecentAlerts(30, 0, req.userId || 0).map((a) => ({
      title: `🔔 ${a.full_name} ${a.message || `+${a.growth} 星`}`,
      link: gh(a.full_name),
      id: `urn:gst:alert:${a.id}`,
      updated: a.triggered_at,
      summary: `类型 ${a.kind} · 当前 ${Number(a.current_stars).toLocaleString("en-US")} 星`,
    }));
  } else {
    return res.status(404).json({ error: "未知订阅类型（surges|new|alerts）" });
  }

  res.type("application/atom+xml; charset=utf-8").send(buildAtom(req, { title, kind, entries }));
});

// ── 📦 外部指标（P3：通用多数据源）──────────────────────────────
app.get("/api/sources", (_req, res) => res.json({ sources: SOURCE_LIST }));

app.get("/api/metrics", (req, res) => {
  const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
  res.json({ metrics: listExternalMetrics(window), window });
});

app.post("/api/metrics", async (req, res) => {
  const source = String(req.body?.source || "").trim();
  const key = String(req.body?.key || "").trim();
  if (!source || !key) return res.status(400).json({ error: "缺少 source 或 key" });
  if (!SOURCE_LIST.some((s) => s.key === source)) return res.status(400).json({ error: `未知数据源: ${source}` });

  // 先验证能取到数据
  let probe;
  try { probe = await fetchSource(source, key); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  if (!probe) return res.status(404).json({ error: "未找到该指标，请检查名称是否正确" });

  const r = addTrackedMetric({ source, key, label: probe.label || key, url: probe.url, unit: probe.unit });
  if (!r.ok) return res.status(409).json({ error: r.error });
  res.json({ ok: true, id: r.id, value: probe.value });
});

app.delete("/api/metrics/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
  if (!getTrackedMetric(id)) return res.status(404).json({ error: "指标不存在" });
  removeTrackedMetric(id);
  res.json({ ok: true });
});

app.get("/api/metrics/:id/history", (req, res) => {
  const data = getExternalMetricHistory(req.params.id);
  if (!data) return res.status(404).json({ error: "指标不存在" });
  res.json(data);
});

app.post("/api/metrics/refresh", rateLimit({ windowMs: 60_000, max: 10 }), async (_req, res) => {
  try {
    const r = await refreshExternalMetrics({ force: true });
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(502).json({ error: "刷新失败: " + e.message });
  }
});

// ── 404 + 统一错误处理（必须在路由之后）────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "接口不存在" }));

app.use((err, _req, res, _next) => {
  logger.error("请求处理异常", { error: err.message, stack: err.stack?.split("\n")[1]?.trim() });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "内部错误" });
});

// ── 定时任务（仅作为主进程运行时启用，便于测试时 import app）──
function startScheduler() {
  if (cronValid) {
    cronTask = cron.schedule(CRON, () => {
      runScheduledRefresh({ token: TOKEN }).catch((e) => logger.error("定时刷新异常", { error: e.message }));
    });
  }

  cron.schedule(POLL_TICK, () => {
    const minutes = Number(getSetting("autoPollMinutes", 0)) || 0;
    if (minutes > 0 && Date.now() - lastPollAt >= minutes * 60 * 1000) {
      lastPollAt = Date.now();
      runScheduledRefresh({ token: TOKEN }).catch((e) => logger.error("轮询刷新异常", { error: e.message }));
    }
    checkDueDigest().catch((e) => logger.error("摘要检查异常", { error: e.message }));
  }).unref?.();

  // 每日自动备份（保留最近 5 份），可在设置中关闭
  try {
    cron.schedule("0 3 * * *", () => {
      if (getSetting("autoBackup", "1") !== "1") return;
      try {
        const p = exportDb();
        logger.info("自动备份完成", { file: p.split("/").pop() });
      } catch (e) {
        logger.warn("自动备份失败", { error: e.message });
      }
    });
  } catch (e) {
    logger.warn("自动备份任务未启用", { error: e.message });
  }

  // 每日清理 + 降采样（备份之后）
  try {
    cron.schedule("30 3 * * *", () => {
      try { runCleanup(); } catch (e) { logger.warn("清理任务失败", { error: e.message }); }
    });
  } catch (e) {
    logger.warn("清理任务未启用", { error: e.message });
  }
}

// ── 启动 + 优雅关闭（P3-13）───────────────────────────────────
export function startServer() {
  startScheduler();
  const server = app.listen(PORT, () => {
    logger.info("GitHub Star Tracker 已启动", {
      url: `http://localhost:${PORT}`,
      token: Boolean(TOKEN),
      tokenSource: TOKEN_SOURCE,
      auth: Boolean(API_KEY),
      cron: cronValid ? CRON : "disabled",
    });
  });

  // 启动时探一次 token 是否真的有效（/rate_limit 不消耗配额）。
  // 不阻塞监听，失败也不影响启动；只为了让 UI 不把「配了个坏 token」显示成 ✅。
  if (TOKEN) {
    checkToken(TOKEN)
      .then((state) => {
        if (state === "invalid") logger.warn(`${TOKEN_SOURCE} 无效（GitHub 返回 401），已回退匿名模式，请更换 token`);
        else if (state === "ok") logger.info(`${TOKEN_SOURCE} 校验通过`);
      })
      .catch(() => { /* 探测失败不影响启动 */ });
  }

  function shutdown(signal) {
    logger.info(`收到 ${signal}，正在关闭…`);
    server.close(() => {
      closeDb();
      logger.info("已安全关闭");
      process.exit(0);
    });
    // 兜底：5 秒后强制退出
    setTimeout(() => { closeDb(); process.exit(0); }, 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return server;
}

// 作为脚本直接运行时才监听端口（被 import 时只导出 app，便于集成测试）
export { app };
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
