import { Router } from "express";
import { getStats } from "../tracker.js";
import { getAlertsUnreadCount, getApiQuotaInfo, countTrackedMetrics } from "../db.js";
import { getScheduleState } from "../scheduler.js";
import { requestCounters } from "../http.js";
import { API_KEY } from "../config.js";

// ── 健康检查与 Prometheus 指标（均无需认证）──────────────────────
export function metaRouter() {
  const r = Router();

  r.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      uptime: Math.round(process.uptime()),
      repos: getStats().repoCount,
      authEnabled: Boolean(API_KEY),
      time: new Date().toISOString(),
    });
  });

  // D2: Prometheus 指标（公开，不含敏感信息）
  r.get("/metrics", (_req, res) => {
    res.type("text/plain; version=0.0.4; charset=utf-8").send(renderMetrics());
  });

  return r;
}

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
  lines.push(
    "# HELP gst_http_requests_total HTTP requests by method and status",
    "# TYPE gst_http_requests_total counter",
  );
  for (const [key, count] of requestCounters) {
    const [method, status] = key.split("|");
    lines.push(`gst_http_requests_total{method="${method}",status="${status}"} ${count}`);
  }
  return lines.join("\n") + "\n";
}
