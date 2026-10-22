/**
 * HTTP 层共享工具 —— 参数解析、限流、安全响应头、请求计数、密钥比较。
 * 只放无状态/进程内状态的小工具，路由按需引入。
 */
import crypto from "node:crypto";
import express from "express";
import { AVAILABLE_METRICS, AVAILABLE_GROWTH_BASES } from "./tracker.js";

// ── 参数解析 ───────────────────────────────────────────────────────
export const toNum = (v, fallback) => {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// P1: 指标参数校验
const METRIC_KEYS = AVAILABLE_METRICS.map((m) => m.key);
const GROWTH_BASIS_KEYS = AVAILABLE_GROWTH_BASES.map((b) => b.key);
export { GROWTH_BASIS_KEYS };
export const toMetric = (v) => (METRIC_KEYS.includes(v) ? v : "stars");

// ── 常量时间比较密钥，避免通过响应时间逐字节猜出正确值（长度经 SHA-256 归一）
export function safeEqual(a, b) {
  const h = (v) => crypto.createHash("sha256").update(String(v)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// ── 安全响应头（零依赖手写，避免引入 helmet）──────────────────────
// script-src 仅 'self'（全站脚本均为同源静态文件，无内联脚本）。
// 样式拆开：style-src-elem 只允许同源（/styles.css），禁止注入 <style>；
// style-src-attr 仍保留 'unsafe-inline'——多处动态生成的 HTML 依赖
// style="width:..%/color:.."，改成 CSSOM/类名成本高、收益低（内容均已转义）。
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "style-src-elem 'self'",
  "style-src-attr 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

export function securityHeaders(_req, res, next) {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
  next();
}

// ── 请求体解析：全局 256kb，仅「数据导入」单独放大到 25mb ──────────
// 之前全局 25mb 且解析发生在鉴权之前，未认证请求也能逼迫服务解析大体积 body。
export const jsonLarge = express.json({ limit: "25mb" });

// D2: 轻量请求计数（仅按 method+status，避免高基数）供 /metrics 暴露
export const requestCounters = new Map();
export function countRequests(req, res, next) {
  res.on("finish", () => {
    const key = `${req.method}|${res.statusCode}`;
    requestCounters.set(key, (requestCounters.get(key) || 0) + 1);
  });
  next();
}

// ── P2-9: 简易速率限制（针对消耗 GitHub 配额的端点）────────────────
// 计数存在进程内存里：单实例部署够用；多实例部署时各副本各算一份、重启清零，
// 需在反向代理层做统一限流（见 README「安全建议」）。
const rateBuckets = new Map();
let rateLimitSeq = 0;
export function rateLimit({ windowMs = 60_000, max = 6, name } = {}) {
  // 每个限流器独立分桶：否则同一 IP 在不同端点之间会互相挤占额度
  const bucket = name || `rl-${++rateLimitSeq}`;
  return (req, res, next) => {
    const key = `${bucket}:${req.ip || "unknown"}`;
    const now = Date.now();
    const b = rateBuckets.get(key) || { count: 0, reset: now + windowMs };
    if (now > b.reset) {
      b.count = 0;
      b.reset = now + windowMs;
    }
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
