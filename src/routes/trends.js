import { Router } from "express";
import { getSetting } from "../db.js";
import {
  getLanguageTrends,
  getRankChanges,
  getLeaderboard,
  getSurges,
  getAnomalies,
  getRisingStars,
  getEvents,
  backtestAlerts,
  listReposAt,
  getOverview,
} from "../tracker.js";
import { toNum, toMetric, GROWTH_BASIS_KEYS } from "../http.js";
import { LEADERBOARD_MAX, DEFAULT_MIN_STARS } from "../config.js";

export function trendsRouter() {
  const r = Router();

  // ── 语言趋势 + 排名变化 ─────────────────────────────────────
  r.get("/languages/trends", (req, res) => {
    const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
    res.json({ trends: getLanguageTrends(window) });
  });

  r.get("/trends/rank", (req, res) => {
    const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
    const limit = Math.min(50, Math.max(1, toNum(req.query.limit, 20)));
    res.json({ window, ...getRankChanges(window, limit) });
  });

  // ── 🏆 排行榜（总星 Top N + 日均增长 Top N）─────────────────
  r.get("/leaderboard", (req, res) => {
    const basis = GROWTH_BASIS_KEYS.includes(req.query.basis) ? req.query.basis : "avg7";
    const limit = Math.min(LEADERBOARD_MAX, Math.max(1, toNum(req.query.limit, 10)));
    const minStars = toNum(req.query.minStars, Number(getSetting("minStars", DEFAULT_MIN_STARS)) || 0);
    res.json(getLeaderboard({ limit, basis, minStars, metric: toMetric(req.query.metric) }));
  });

  // ── 🚀 爆发榜（P0-1：增速加速度）───────────────────────────
  r.get("/trends/surge", (req, res) => {
    const limit = Math.min(50, Math.max(1, toNum(req.query.limit, 10)));
    const minStars = toNum(req.query.minStars, 0);
    const includeDecaying = req.query.decaying === "1";
    res.json(getSurges({ limit, minStars, includeDecaying, metric: toMetric(req.query.metric) }));
  });

  // ── 🔎 异常检测（z-score，相对自身历史）────────────────────
  r.get("/trends/anomaly", (req, res) => {
    res.json(
      getAnomalies({
        days: toNum(req.query.days, 30),
        z: Number(req.query.z) || 2.5,
        limit: toNum(req.query.limit, 12),
        minSamples: toNum(req.query.minSamples, 5),
        minStars: toNum(req.query.minStars, 0),
      }),
    );
  });

  // ── 🐎 黑马榜（低星高增速）─────────────────────────────────
  r.get("/trends/rising", (req, res) => {
    res.json(
      getRisingStars({
        limit: toNum(req.query.limit, 15),
        maxStars:
          req.query.maxStars === undefined || req.query.maxStars === "" ? 0 : toNum(req.query.maxStars, 0),
        minDays: toNum(req.query.minDays, 14),
        minStars: toNum(req.query.minStars, 100),
      }),
    );
  });

  // ── 🌊 事件聚类（同一天多个仓库同时异动）───────────────────
  r.get("/trends/events", (req, res) => {
    res.json(
      getEvents({
        days: toNum(req.query.days, 30),
        z: Number(req.query.z) || 2,
        minRepos: toNum(req.query.minRepos, 3),
        minSamples: toNum(req.query.minSamples, 4),
        minStars: toNum(req.query.minStars, 0),
        limit: toNum(req.query.limit, 12),
      }),
    );
  });

  // ── ⏪ 历史回放（P0-2）──────────────────────────────────────
  r.get("/replay", (req, res) => {
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

  // ── 🧪 告警规则回测 ────────────────────────────────────────
  r.get("/alerts/backtest", (req, res) => {
    const bool = (v) => (v === undefined ? undefined : v === "1" || v === "true");
    res.json(
      backtestAlerts({
        days: toNum(req.query.days, 90),
        threshold: req.query.threshold === undefined ? undefined : toNum(req.query.threshold, 50),
        dropThreshold: req.query.dropThreshold === undefined ? undefined : toNum(req.query.dropThreshold, 50),
        alertOnDrop: bool(req.query.onDrop),
        alertOnMilestone: bool(req.query.onMilestone),
        minStars: toNum(req.query.minStars, 0),
        maxFires: toNum(req.query.limit, 200),
      }),
    );
  });

  // ── C2: 全局趋势 ───────────────────────────────────────────
  r.get("/overview", (req, res) => {
    res.json(getOverview({ days: toNum(req.query.days, 60), userId: req.userId || 0 }));
  });

  return r;
}
