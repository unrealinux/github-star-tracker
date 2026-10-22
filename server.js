/**
 * 服务入口与路由组装（composition root）。
 *
 * 这里只负责把各部分"接起来"：
 *   全局中间件（安全头 / 请求体 / 计数）→ 公开端点（health/metrics/徽章/订阅）
 *   → 认证中间件 → 各领域路由（auth/settings/repos/trends/maintenance/push/external/feed）
 *   → 404 + 错误处理 → 启动与优雅关闭。
 *
 * 具体路由实现在 src/routes/，共享工具在 src/http.js，认证中间件在 src/auth-middleware.js，
 * 环境配置在 src/config.js。
 */
import "./src/env.js";
import express from "express";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { closeDb } from "./src/db.js";
import { logger } from "./src/logger.js";
import { checkToken } from "./src/github.js";
import { securityHeaders, countRequests } from "./src/http.js";
import { resolveAuth } from "./src/auth-middleware.js";
import { TOKEN, TOKEN_SOURCE, API_KEY, CRON, cronValid, resolveToken } from "./src/config.js";
import { startCronJobs } from "./src/scheduler.js";
import { metaRouter } from "./src/routes/meta.js";
import { badgesRouter } from "./src/routes/badges.js";
import { authRouter } from "./src/routes/auth.js";
import { settingsRouter } from "./src/routes/settings.js";
import { reposRouter } from "./src/routes/repos.js";
import { trendsRouter } from "./src/routes/trends.js";
import { maintenanceRouter } from "./src/routes/maintenance.js";
import { pushRouter } from "./src/routes/push.js";
import { externalRouter } from "./src/routes/external.js";
import { feedRouter } from "./src/routes/feed.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// ── 全局中间件 ─────────────────────────────────────────────────────
app.use(securityHeaders);

// 请求体解析：全局 256kb，仅「数据导入」单独放大到 25mb（jsonLarge 由 maintenance 路由自带）
const jsonSmall = express.json({ limit: "256kb" });
app.use((req, res, next) => (req.path === "/api/maintenance/import" ? next() : jsonSmall(req, res, next)));

app.use(countRequests);

// 反代部署时开启（TRUST_PROXY=loopback / true / IP 列表），让限流能取到真实客户端 IP
const TRUST_PROXY = process.env.TRUST_PROXY;
if (TRUST_PROXY) app.set("trust proxy", TRUST_PROXY === "true" ? true : TRUST_PROXY);

// API 响应不缓存；静态资源保留 ETag，走协商缓存（304）而不重复下载
app.use("/api", (_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use(express.static(join(__dirname, "public")));

// ── 公开端点（无需认证；/api 之外 + 拥有独立令牌机制的订阅）───────
app.use(metaRouter());
app.use(badgesRouter());

// 所有 /api 先解析身份
app.use("/api", resolveAuth);

// ── 认证后的业务路由（挂载顺序与职责分区见 src/routes/*）─────────
app.use("/api", authRouter());
app.use("/api", settingsRouter());
app.use("/api", reposRouter());
app.use("/api", trendsRouter());
app.use("/api", maintenanceRouter());
app.use("/api", pushRouter());
app.use("/api", externalRouter());
app.use("/api", feedRouter());

// ── 404 + 统一错误处理（必须在路由之后）────────────────────────────
app.use((_req, res) => res.status(404).json({ error: "接口不存在" }));

app.use((err, _req, res, _next) => {
  logger.error("请求处理异常", { error: err.message, stack: err.stack?.split("\n")[1]?.trim() });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || "内部错误" });
});

const PORT = Number(process.env.PORT) || 3001;

// ── 启动 + 优雅关闭（P3-13）───────────────────────────────────
export function startServer() {
  startCronJobs();
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
        if (state === "invalid")
          logger.warn(`${TOKEN_SOURCE} 无效（GitHub 返回 401），已回退匿名模式，请更换 token`);
        else if (state === "ok") logger.info(`${TOKEN_SOURCE} 校验通过`);
      })
      .catch(() => {
        /* 探测失败不影响启动 */
      });
  }

  function shutdown(signal) {
    logger.info(`收到 ${signal}，正在关闭…`);
    server.close(() => {
      closeDb();
      logger.info("已安全关闭");
      process.exit(0);
    });
    // 兜底：5 秒后强制退出
    setTimeout(() => {
      closeDb();
      process.exit(0);
    }, 5000).unref();
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  return server;
}

// 作为脚本直接运行时才监听端口（被 import 时只导出 app，便于集成测试）
export { app };
export { resolveToken };
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) startServer();
