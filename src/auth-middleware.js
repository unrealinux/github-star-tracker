/**
 * 认证中间件 —— 解析顺序：会话令牌 → API Key（自动化/管理员）→ 无用户时的单用户模式。
 * P5 认证与会话的 app 级中间件部分（哈希/签发算法本体在 src/auth.js）。
 */
import { createSession, getSession, purgeExpiredSessions, countUsers } from "./db.js";
import { newSessionToken, SESSION_TTL_MS } from "./auth.js";
import { safeEqual } from "./http.js";
import { API_KEY, FEED_TOKEN } from "./config.js";

const AUTH_OPEN_PATHS = new Set(["/auth/status", "/auth/login", "/auth/register", "/auth/logout"]);

export function issueSession(userId, req) {
  const token = newSessionToken();
  createSession({
    token,
    userId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
    userAgent: req.get("user-agent"),
  });
  purgeExpiredSessions();
  return token;
}

export function resolveAuth(req, res, next) {
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

export function requireAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  if (countUsers() === 0) return next(); // 单用户模式视为管理员
  res.status(403).json({ error: "需要管理员权限" });
}
