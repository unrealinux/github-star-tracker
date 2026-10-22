import { Router } from "express";
import {
  getSettings,
  setSetting,
  getSavedViews,
  saveView,
  deleteView,
  listIndices,
  addIndex,
  removeIndex,
  listTrackedQueries,
  addTrackedQuery,
  updateTrackedQuery,
  removeTrackedQuery,
  countPushSubscriptions,
} from "../db.js";
import {
  getIndexSeries,
  getQueryAggregate,
  getQueryMemberGrowth,
  refreshTrackedQueries,
} from "../tracker.js";
import { getTokenState } from "../github.js";
import { WEBHOOK_TYPES } from "../notify.js";
import { toNum, toMetric, rateLimit, GROWTH_BASIS_KEYS } from "../http.js";
import { DEFAULT_MIN_STARS, DEFAULT_MIN_GROWTH, TOKEN, API_KEY } from "../config.js";
import { repoThresholdKey } from "../repo-thresholds.js";

export function settingsRouter() {
  const r = Router();

  r.get("/settings", (_req, res) => res.json(publicSettings(_req.userId || 0)));

  r.put("/settings", (req, res) => {
    const b = req.body || {};
    try {
      if (b.minStars !== undefined) setSetting("minStars", toNum(b.minStars, DEFAULT_MIN_STARS));
      if (b.minGrowth !== undefined) setSetting("minGrowth", toNum(b.minGrowth, DEFAULT_MIN_GROWTH));
      if (b.retentionDays !== undefined) setSetting("retentionDays", toNum(b.retentionDays, 90));
      if (b.alertThreshold !== undefined) setSetting("alertThreshold", toNum(b.alertThreshold, 50));
      if (b.autoPollMinutes !== undefined) setSetting("autoPollMinutes", toNum(b.autoPollMinutes, 0));
      if (b.searchQuery !== undefined) setSetting("searchQuery", String(b.searchQuery).trim());
      if (b.trendingEnabled !== undefined) setSetting("trendingEnabled", b.trendingEnabled ? "1" : "0");
      if (b.trendingDays !== undefined) {
        const n = Number(b.trendingDays);
        setSetting("trendingDays", Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : 30);
      }
      if (b.trendingMinStars !== undefined) {
        const n = Number(b.trendingMinStars);
        setSetting("trendingMinStars", Number.isFinite(n) ? Math.max(0, n) : 50);
      }
      if (b.webhookUrl !== undefined) setSetting("webhookUrl", String(b.webhookUrl).trim());
      if (b.webhookType !== undefined)
        setSetting("webhookType", WEBHOOK_TYPES.includes(b.webhookType) ? b.webhookType : "generic");
      if (b.theme !== undefined)
        setSetting("theme", ["dark", "light", "contrast"].includes(b.theme) ? b.theme : "dark");
      if (b.alertOnDrop !== undefined) setSetting("alertOnDrop", b.alertOnDrop ? "1" : "0");
      if (b.dropThreshold !== undefined) setSetting("dropThreshold", toNum(b.dropThreshold, 50));
      if (b.alertOnMilestone !== undefined) setSetting("alertOnMilestone", b.alertOnMilestone ? "1" : "0");
      if (b.digestEnabled !== undefined) setSetting("digestEnabled", b.digestEnabled ? "1" : "0");
      if (b.digestTime !== undefined)
        setSetting(
          "digestTime",
          /^\d{1,2}:\d{2}$/.test(String(b.digestTime)) ? String(b.digestTime) : "09:00",
        );
      if (b.autoBackup !== undefined) setSetting("autoBackup", b.autoBackup ? "1" : "0");
      if (b.backfillDays !== undefined)
        setSetting("backfillDays", Math.min(730, Math.max(7, toNum(b.backfillDays, 90))));
      if (b.backfillMaxPages !== undefined)
        setSetting("backfillMaxPages", Math.min(100, Math.max(1, toNum(b.backfillMaxPages, 20))));
      if (b.quotaFloor !== undefined) setSetting("quotaFloor", Math.max(0, toNum(b.quotaFloor, 3)));
      if (b.externalIntervalHours !== undefined)
        setSetting("externalIntervalHours", Math.max(0, toNum(b.externalIntervalHours, 24)));
      if (b.rollupAfterDays !== undefined)
        setSetting("rollupAfterDays", Math.max(0, toNum(b.rollupAfterDays, 30)));
      if (b.sourceIntervals !== undefined && typeof b.sourceIntervals === "object") {
        const clean = {};
        for (const [k, v] of Object.entries(b.sourceIntervals)) {
          const n = Number(v);
          if (/^[\w-]+$/.test(k) && Number.isFinite(n) && n >= 0) clean[k] = n;
        }
        setSetting("sourceIntervals", JSON.stringify(clean));
      }
      if (b.repoThresholds !== undefined && b.repoThresholds && typeof b.repoThresholds === "object") {
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

  // ── 保存的筛选视图（C5）─────────────────────────────────────
  r.get("/views", (req, res) => res.json({ views: getSavedViews(req.userId || 0) }));

  r.post("/views", (req, res) => {
    try {
      const views = saveView({ name: req.body?.name, filters: req.body?.filters }, req.userId || 0);
      res.json({ ok: true, views });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete("/views/:name", (req, res) => {
    res.json({ ok: true, views: deleteView(decodeURIComponent(req.params.name), req.userId || 0) });
  });

  // ── 自定义指数（本地筛选条件聚合）─────────────────────────
  r.get("/indices", (req, res) => res.json({ indices: listIndices(req.userId || 0) }));

  r.post("/indices", (req, res) => {
    const b = req.body || {};
    const spec = {
      language: b.language ? String(b.language).trim() : undefined,
      keyword: b.keyword ? String(b.keyword).trim() : undefined,
      minStars: b.minStars === undefined || b.minStars === "" ? undefined : toNum(b.minStars, 0),
      maxStars: b.maxStars === undefined || b.maxStars === "" ? undefined : toNum(b.maxStars, 0),
    };
    const r2 = addIndex(b.name, spec, req.userId || 0);
    if (!r2.ok) return res.status(409).json({ error: r2.error });
    res.json({ ok: true, id: r2.id });
  });

  r.delete("/indices/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    if (!removeIndex(id, req.userId || 0)) return res.status(404).json({ error: "指数不存在" });
    res.json({ ok: true });
  });

  r.get("/indices/:id/series", (req, res) => {
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

  // ── 生态 / topic 追踪（GitHub 搜索语法）──────────────────
  r.get("/queries", (req, res) => res.json({ queries: listTrackedQueries(req.userId || 0) }));

  r.post("/queries", (req, res) => {
    try {
      const r2 = addTrackedQuery(req.body?.label, req.body?.query, req.userId || 0);
      if (!r2.ok) return res.status(409).json({ error: r2.error });
      res.json({ ok: true, id: r2.id });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.delete("/queries/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    if (!removeTrackedQuery(id, req.userId || 0)) return res.status(404).json({ error: "追踪不存在" });
    res.json({ ok: true });
  });

  r.put("/queries/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    try {
      if (!updateTrackedQuery(id, req.body?.label, req.body?.query, req.userId || 0))
        return res.status(404).json({ error: "追踪不存在" });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.get("/queries/:id", (req, res) => {
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

  r.get("/queries/:id/growth", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    const data = getQueryMemberGrowth(id, {
      basis: GROWTH_BASIS_KEYS.includes(req.query.basis) ? req.query.basis : "today",
      limit: Math.min(100, Math.max(1, toNum(req.query.limit, 10))),
      metric: toMetric(req.query.metric),
      userId: req.userId || 0,
    });
    if (!data) return res.status(404).json({ error: "追踪不存在" });
    res.json(data);
  });

  r.post("/queries/refresh", rateLimit({ windowMs: 60_000, max: 3 }), async (_req, res) => {
    try {
      res.json({ ok: true, ...(await refreshTrackedQueries({ token: TOKEN })) });
    } catch (e) {
      res.status(502).json({ error: "刷新追踪失败：" + e.message });
    }
  });

  return r;
}

function publicSettings(userId = 0) {
  const s = getSettings();
  const num = (key, fallback) => {
    const n = Number(s[key]);
    return s[key] === undefined || s[key] === "" || !Number.isFinite(n) ? fallback : n;
  };
  return {
    minStars: num("minStars", DEFAULT_MIN_STARS),
    minGrowth: num("minGrowth", DEFAULT_MIN_GROWTH),
    retentionDays: num("retentionDays", 90),
    alertThreshold: num("alertThreshold", 50),
    autoPollMinutes: num("autoPollMinutes", 0),
    searchQuery: s.searchQuery || "",
    trendingEnabled: s.trendingEnabled !== "0",
    trendingDays: num("trendingDays", 30),
    trendingMinStars: num("trendingMinStars", 50),
    webhookUrl: s.webhookUrl || "",
    webhookType: s.webhookType || "generic",
    theme: s.theme || "dark",
    alertOnDrop: s.alertOnDrop === "1",
    dropThreshold: num("dropThreshold", 50),
    alertOnMilestone: s.alertOnMilestone === "1",
    digestEnabled: s.digestEnabled === "1",
    digestTime: s.digestTime || "09:00",
    autoBackup: s.autoBackup !== "0",
    backfillDays: num("backfillDays", 90),
    backfillMaxPages: num("backfillMaxPages", 20),
    quotaFloor: num("quotaFloor", 3),
    externalIntervalHours: num("externalIntervalHours", 24),
    rollupAfterDays: num("rollupAfterDays", 30),
    sourceIntervals: s.sourceIntervals || "{}",
    pushCount: countPushSubscriptions(userId),
    tokenConfigured: Boolean(TOKEN),
    tokenState: getTokenState(),
    authEnabled: Boolean(API_KEY),
  };
}
