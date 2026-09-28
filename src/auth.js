/**
 * 认证工具（零依赖）
 * - 口令哈希：scrypt + 随机盐，存为 `scrypt$<salt>$<hash>`（均 base64url）
 * - 会话令牌：32 字节随机数
 */
import crypto from "node:crypto";

// 会话有效期：可用 SESSION_TTL_DAYS 覆盖（默认 30 天，最小 1 天）
const SESSION_TTL_DAYS = Math.max(1, Number(process.env.SESSION_TTL_DAYS) || 30);
export const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 3600 * 1000;
export const MIN_PASSWORD_LENGTH = 8;

export function hashPassword(password) {
  const pwd = String(password ?? "");
  if (pwd.length < MIN_PASSWORD_LENGTH) throw new Error(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pwd, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

/** 定时安全比较，避免时序侧信道 */
export function verifyPassword(password, stored) {
  try {
    const [scheme, saltB64, hashB64] = String(stored || "").split("$");
    if (scheme !== "scrypt" || !saltB64 || !hashB64) return false;
    const expected = Buffer.from(hashB64, "base64url");
    const actual = crypto.scryptSync(
      String(password ?? ""),
      Buffer.from(saltB64, "base64url"),
      expected.length,
    );
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export const newSessionToken = () => crypto.randomBytes(32).toString("base64url");
