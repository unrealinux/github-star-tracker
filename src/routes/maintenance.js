import { Router } from "express";
import {
  getSetting,
  getApiQuotaInfo,
  createBackup,
  exportData,
  importData,
  countTrackedMetrics,
} from "../db.js";
import { getStats } from "../tracker.js";
import { runManualRefresh, runCleanup, getScheduleState, getCronTask } from "../scheduler.js";
import { getLastQuota, getTokenState } from "../github.js";
import { rateLimit, jsonLarge } from "../http.js";
import { TOKEN, API_KEY, CRON, cronValid } from "../config.js";
import { logger } from "../logger.js";

// ── 统计 / 立即刷新 / 数据维护 ──────────────────────────────────
export function maintenanceRouter() {
  const r = Router();

  // 统计
  r.get("/stats", (req, res) => {
    res.json({
      ...getStats(req.userId || 0),
      quota: getApiQuotaInfo(),
      tokenConfigured: Boolean(TOKEN),
      tokenState: getTokenState(),
      authEnabled: Boolean(API_KEY),
      auto: {
        schedule: CRON,
        enabled: cronValid,
        nextRun: cronValid && getCronTask() ? (getCronTask().getNextRun()?.toISOString() ?? null) : null,
        ...getScheduleState(),
      },
      autoPoll: Number(getSetting("autoPollMinutes", 0)) || 0,
      externalCount: countTrackedMetrics(),
      githubQuota: getLastQuota(),
      staleCount: getStats(req.userId || 0).staleCount,
    });
  });

  // 刷新（限流：每分钟最多 6 次）
  r.post("/refresh", rateLimit({ windowMs: 60_000, max: 6 }), async (_req, res) => {
    try {
      const summary = await runManualRefresh({ token: TOKEN });
      if (summary.skipped) return res.status(409).json({ ok: false, skipped: true, reason: summary.reason });
      res.json({ ok: true, ...summary });
    } catch (e) {
      res.status(502).json({ error: "刷新失败：" + e.message });
    }
  });

  // 维护
  r.post("/maintenance/cleanup", (_req, res) => {
    try {
      res.json({ ok: true, ...runCleanup() });
    } catch (e) {
      res.status(500).json({ error: "清理失败：" + e.message });
    }
  });

  r.get("/maintenance/export", (req, res) => {
    try {
      if (req.query.format === "json") return res.json(exportData());
      const { file, kind } = createBackup();
      const ext = kind === "sqlite" ? "db" : kind === "pg_dump" ? "dump" : "json";
      res.download(file, `github-star-tracker-backup-${new Date().toISOString().slice(0, 10)}.${ext}`);
    } catch (e) {
      res.status(500).json({ error: "导出失败：" + e.message });
    }
  });

  r.post("/maintenance/import", jsonLarge, (req, res) => {
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

  return r;
}
