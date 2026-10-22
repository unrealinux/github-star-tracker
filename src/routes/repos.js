import { Router } from "express";
import {
  getSetting,
  setSetting,
  listCustomRepos,
  countCustomRepos,
  addCustomRepo,
  removeCustomRepo,
  searchCustomRepo,
  toggleFavorite,
  listFavorites,
  countFavorites,
  getAlertsUnreadCount,
  markAlertsRead,
  getRecentAlerts,
  getRepoFullNameById,
} from "../db.js";
import {
  listRepos,
  listLanguages,
  getRepoHistory,
  findSimilarRepos,
  compareRepos,
  AVAILABLE_METRICS,
} from "../tracker.js";
import { fetchRepoDetails } from "../github.js";
import { backfillRepo, backfillMany, resolveBackfillScope } from "../backfill.js";
import { toNum, toMetric, rateLimit } from "../http.js";
import { TOKEN, DEFAULT_MIN_STARS, DEFAULT_MIN_GROWTH } from "../config.js";
import { repoThresholdKey, readRepoThresholds } from "../repo-thresholds.js";

export function reposRouter() {
  const r = Router();

  // ── 仓库列表（筛选/排序/分页/关键词）─────────────────────────
  r.get("/repos", (req, res) => {
    const minStars = toNum(
      req.query.minStars,
      toNum(getSetting("minStars", DEFAULT_MIN_STARS), DEFAULT_MIN_STARS),
    );
    const minGrowth = toNum(
      req.query.minGrowth,
      toNum(getSetting("minGrowth", DEFAULT_MIN_GROWTH), DEFAULT_MIN_GROWTH),
    );
    const language = req.query.language || "";
    const sort = ["stars", "metric", "growth", "newest", "name", "language"].includes(req.query.sort)
      ? req.query.sort
      : "growth";
    const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
    const page = Math.max(1, toNum(req.query.page, 1));
    const pageSize = Math.min(200, Math.max(1, toNum(req.query.pageSize, 50)));
    const todayOnly = req.query.todayOnly === "1" || req.query.todayOnly === "true";
    const keyword = (req.query.keyword || "").trim();
    const onlyCustom = req.query.onlyCustom === "1";
    const onlyFavorite = req.query.onlyFavorite === "1";
    const metric = toMetric(req.query.metric);

    const result = listRepos({
      minStars,
      minGrowth,
      language,
      sort,
      window,
      page,
      pageSize,
      todayOnly,
      keyword,
      onlyCustom,
      onlyFavorite,
      metric,
      userId: req.userId || 0,
    });
    res.json({
      ...result,
      minStars,
      minGrowth,
      languages: listLanguages(),
      sort,
      window,
      keyword,
      onlyCustom,
      onlyFavorite,
      metric,
      metrics: AVAILABLE_METRICS,
    });
  });

  r.get("/repos/:id/history", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    const data = getRepoHistory(id, toMetric(req.query.metric), req.userId || 0);
    if (!data) return res.status(404).json({ error: "项目不存在" });
    res.json(data);
  });

  // C4: 相似仓库推荐
  r.get("/repos/:id/similar", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    const data = findSimilarRepos(id, { limit: toNum(req.query.limit, 6) });
    if (!data) return res.status(404).json({ error: "项目不存在" });
    res.json(data);
  });

  // A4: 仓库富化信息（topics/license/release/contributors）
  r.get("/repos/:id/enrich", rateLimit({ windowMs: 60_000, max: 20 }), async (req, res) => {
    const id = Number(req.params.id);
    const repo = getRepoFullNameById(id);
    if (!repo) return res.status(404).json({ error: "项目不存在" });
    try {
      res.json(await fetchRepoDetails(repo.full_name, TOKEN));
    } catch (e) {
      res.status(502).json({ error: "获取仓库详情失败：" + e.message });
    }
  });

  // C1: 多仓库对比
  r.get("/compare", (req, res) => {
    const ids = String(req.query.ids || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 8);
    if (!ids.length) return res.status(400).json({ error: "请至少选择一个仓库（ids=1,2,3）" });
    const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
    res.json(
      compareRepos({
        ids,
        window,
        metric: toMetric(req.query.metric),
        maxPoints: toNum(req.query.points, 90),
      }),
    );
  });

  // ── 每仓库告警阈值 ──────────────────────────────────────────
  r.get("/repos/:id/alert", (req, res) => {
    const id = Number(req.params.id);
    const repo = getRepoFullNameById(id);
    if (!repo) return res.status(404).json({ error: "项目不存在" });
    const thresholds = readRepoThresholds(req.userId || 0);
    res.json({
      full_name: repo.full_name,
      threshold: thresholds[repo.full_name] ?? null,
      global: Number(getSetting("alertThreshold", 50)) || 0,
    });
  });

  r.put("/repos/:id/alert", (req, res) => {
    const id = Number(req.params.id);
    const repo = getRepoFullNameById(id);
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

  // ── 📜 历史回填（stargazers 重建）───────────────────────────
  r.post("/repos/:id/backfill", rateLimit({ windowMs: 60_000, max: 6 }), async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    const days = Math.min(
      730,
      Math.max(7, toNum(req.body?.days, Number(getSetting("backfillDays", 90)) || 90)),
    );
    const maxPages = Math.min(
      100,
      Math.max(1, toNum(req.body?.maxPages, Number(getSetting("backfillMaxPages", 20)) || 20)),
    );
    try {
      const r2 = await backfillRepo({ id, token: TOKEN, days, maxPages });
      if (r2.error) return res.status(404).json({ error: r2.error });
      res.json({ ok: true, ...r2 });
    } catch (e) {
      res.status(502).json({ error: "回填失败：" + e.message });
    }
  });

  r.post("/backfill", rateLimit({ windowMs: 60_000, max: 3 }), async (req, res) => {
    const scope = ["custom", "favorites", "all"].includes(req.body?.scope) ? req.body.scope : "custom";
    const limit = Math.min(50, Math.max(1, toNum(req.body?.limit, 10)));
    const days = Math.min(
      730,
      Math.max(7, toNum(req.body?.days, Number(getSetting("backfillDays", 90)) || 90)),
    );
    const maxPages = Math.min(
      100,
      Math.max(1, toNum(req.body?.maxPages, Number(getSetting("backfillMaxPages", 20)) || 20)),
    );
    const ids = resolveBackfillScope(scope, limit);
    if (!ids.length) return res.status(400).json({ error: "该范围内没有可回填的仓库" });
    try {
      const results = await backfillMany({ ids, token: TOKEN, days, maxPages });
      res.json({ ok: true, scope, count: ids.length, results });
    } catch (e) {
      res.status(502).json({ error: "批量回填失败：" + e.message });
    }
  });

  // ── 收藏（分页）──────────────────────────────────────────────
  r.get("/favorites", (req, res) => {
    const page = Math.max(1, toNum(req.query.page, 1));
    const pageSize = Math.min(200, Math.max(1, toNum(req.query.pageSize, 100)));
    const total = countFavorites(req.userId || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const repos = listFavorites({ limit: pageSize, offset: (p - 1) * pageSize, userId: req.userId || 0 });
    res.json({ repos, total, page: p, pageSize, totalPages });
  });

  r.post("/favorites/:id/toggle", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    res.json(toggleFavorite(id, req.userId || 0));
  });

  // ── 自定义仓库（分页）───────────────────────────────────────
  r.get("/custom-repos", (req, res) => {
    const page = Math.max(1, toNum(req.query.page, 1));
    const pageSize = Math.min(200, Math.max(1, toNum(req.query.pageSize, 100)));
    const total = countCustomRepos(req.userId || 0);
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const p = Math.min(page, totalPages);
    const repos = listCustomRepos({ limit: pageSize, offset: (p - 1) * pageSize, userId: req.userId || 0 });
    res.json({ repos, total, page: p, pageSize, totalPages });
  });

  r.post("/custom-repos", (req, res) => {
    const fullName = (req.body?.full_name || "").trim();
    if (!fullName) return res.status(400).json({ error: "请输入仓库地址" });
    if (!/^[\w-]+\/[\w.-]+$/.test(fullName))
      return res.status(400).json({ error: "格式不正确，应为 owner/repo" });
    if (searchCustomRepo(fullName, req.userId || 0))
      return res.status(409).json({ error: "该仓库已在追踪列表中" });
    if (!addCustomRepo(fullName, req.body?.note || "", req.userId || 0))
      return res.status(409).json({ error: "添加失败，可能已存在" });
    res.json({ ok: true });
  });

  r.delete("/custom-repos/:name", (req, res) => {
    removeCustomRepo(decodeURIComponent(req.params.name), req.userId || 0);
    res.json({ ok: true });
  });

  // ── 告警记录 ────────────────────────────────────────────────
  r.get("/alerts", (req, res) => {
    const limit = Math.min(100, Math.max(1, toNum(req.query.limit, 20)));
    const offset = Math.max(0, toNum(req.query.offset, 0));
    res.json({
      unread: getAlertsUnreadCount(req.userId || 0),
      recent: getRecentAlerts(limit, offset, req.userId || 0),
    });
  });

  r.post("/alerts/read", (req, res) => {
    markAlertsRead(req.userId || 0);
    res.json({ ok: true });
  });

  return r;
}
