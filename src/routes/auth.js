import { Router } from "express";
import {
  countUsers,
  listUsers,
  getUser,
  getUserByName,
  createUser,
  deleteUser,
  setUserPassword,
  getSession,
  deleteSession,
} from "../db.js";
import { hashPassword, verifyPassword } from "../auth.js";
import { issueSession, requireAdmin } from "../auth-middleware.js";
import { rateLimit } from "../http.js";
import { API_KEY } from "../config.js";
import { logger } from "../logger.js";

// ── 认证接口（注册 / 登录 / 会话 / 用户管理）─────────────────────
export function authRouter() {
  const r = Router();

  r.get("/auth/status", (req, res) => {
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

  r.post("/auth/register", rateLimit({ windowMs: 60_000, max: 5, name: "auth-register" }), (req, res) => {
    if (countUsers() > 0) return res.status(409).json({ error: "已存在用户，请让管理员创建账号" });
    const { username, password } = req.body || {};
    try {
      const r2 = createUser({ username, passwordHash: hashPassword(password), role: "admin" });
      if (!r2.ok) return res.status(400).json({ error: r2.error });
      const session = issueSession(r2.id, req);
      logger.info("创建首个管理员账号", { username });
      res.json({ ok: true, user: { id: r2.id, username: String(username).trim(), role: "admin" }, session });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post("/auth/login", rateLimit({ windowMs: 60_000, max: 10, name: "auth-login" }), (req, res) => {
    const { username, password } = req.body || {};
    const user = getUserByName(username);
    if (!user || !verifyPassword(password, user.password_hash)) {
      return res.status(401).json({ error: "用户名或密码错误" });
    }
    res.json({
      ok: true,
      user: { id: user.id, username: user.username, role: user.role },
      session: issueSession(user.id, req),
    });
  });

  r.post("/auth/logout", (req, res) => {
    const token = req.get("X-Session") || req.body?.session;
    if (token) deleteSession(token);
    res.json({ ok: true });
  });

  r.get("/auth/users", requireAdmin, (_req, res) => res.json({ users: listUsers() }));

  r.post("/auth/users", requireAdmin, (req, res) => {
    try {
      const { username, password, role } = req.body || {};
      const r2 = createUser({ username, passwordHash: hashPassword(password), role });
      if (!r2.ok) return res.status(400).json({ error: r2.error });
      res.json({ ok: true, id: r2.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete("/auth/users/:id", requireAdmin, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    if (!getUser(id)) return res.status(404).json({ error: "用户不存在" });
    const admins = listUsers().filter((u) => u.role === "admin");
    const target = getUser(id);
    if (target.role === "admin" && admins.length <= 1)
      return res.status(400).json({ error: "至少保留一名管理员" });
    deleteUser(id);
    res.json({ ok: true });
  });

  r.put("/auth/password", (req, res) => {
    const id = req.user?.id;
    if (!id) return res.status(400).json({ error: "API Key 模式下无法修改密码" });
    try {
      setUserPassword(id, hashPassword(req.body?.password));
      // 修改口令会使该用户已签发的会话立即失效（安全语义：换密即下线）
      deleteSession(req.get("X-Session") || "");
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  return r;
}
