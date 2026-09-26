import {
  listTrackedMetrics,
  updateTrackedMetricValue,
  insertMetricSnapshot,
  getMetricSnapshots,
} from "./db.js";
import { getSetting } from "./db.js";
import { fetchSource } from "./sources.js";
import { logger } from "./logger.js";
import { windowOf, avgDailyGrowth } from "./windows.js";

/**
 * 抓取外部指标的当前值并写快照。
 * 支持按数据源设置最小刷新间隔（小时），避免 npm/HN 这类慢变指标被每轮重复抓。
 * @param {{force?:boolean}} opts force=true 时忽略间隔（手动刷新用）
 */
export async function refreshExternalMetrics({ force = false } = {}) {
  const metrics = listTrackedMetrics();
  let intervals = {};
  try {
    intervals = JSON.parse(getSetting("sourceIntervals", "{}") || "{}");
  } catch {
    intervals = {};
  }
  const defaultHours = Number(getSetting("externalIntervalHours", 24)) || 0;
  const now = Date.now();
  const nowIso = new Date().toISOString();
  let ok = 0,
    skipped = 0;

  for (const m of metrics) {
    const hours = Number(intervals[m.source] ?? defaultHours) || 0;
    if (!force && hours > 0 && m.updated_at) {
      const age = now - Date.parse(m.updated_at);
      if (age >= 0 && age < hours * 3600 * 1000) {
        skipped++;
        continue;
      }
    }
    try {
      const r = await fetchSource(m.source, m.key);
      if (!r || typeof r.value !== "number") {
        logger.warn("外部指标抓取无结果", { source: m.source, key: m.key });
        continue;
      }
      updateTrackedMetricValue(m.id, r.value, r.label, r.url, r.unit);
      insertMetricSnapshot(m.id, r.value, nowIso);
      ok++;
    } catch (e) {
      logger.warn("外部指标抓取失败", { source: m.source, key: m.key, error: e.message });
    }
  }
  return { fetched: ok, skipped, total: metrics.length };
}

function computeGrowth(currentValue, snaps, window) {
  if (!snaps || snaps.length === 0) return { growth: null, label: "待积累" };
  const cfg = windowOf(window);
  const windowStart = Date.now() - cfg.ms;

  let base = null;
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (Date.parse(snaps[i].captured_at) <= windowStart) {
      base = snaps[i].value;
      break;
    }
  }
  if (base !== null) return { growth: currentValue - base, label: cfg.label };
  if (snaps.length >= 2) return { growth: currentValue - snaps[snaps.length - 2].value, label: "本次更新" };
  return { growth: null, label: "待积累" };
}

/** 列出外部指标（含增长） */
export function listExternalMetrics(window = "day") {
  const metrics = listTrackedMetrics();
  return metrics
    .map((m) => {
      const snaps = getMetricSnapshots(m.id);
      const { growth, label } = computeGrowth(m.current_value ?? 0, snaps, window);
      const a = avgDailyGrowth(snaps, (s) => s.value);
      return {
        id: m.id,
        source: m.source,
        key: m.key,
        label: m.label || m.key,
        url: m.url,
        unit: m.unit,
        value: m.current_value,
        growth,
        growthLabel: label,
        avgDailyGrowth: a ? Number(a.avg.toFixed(2)) : null,
        avgSampleDays: a ? Number(a.days.toFixed(2)) : null,
        snapshots: snaps.length,
        updatedAt: m.updated_at,
        spark: snaps.slice(-10).map((s) => ({ t: s.captured_at, stars: s.value })),
      };
    })
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
}

export function getExternalMetricHistory(id) {
  const m = listTrackedMetrics().find((x) => x.id === Number(id));
  if (!m) return null;
  const snaps = getMetricSnapshots(m.id).map((s) => ({ stars: s.value, captured_at: s.captured_at }));
  return { metric: m, history: snaps };
}
