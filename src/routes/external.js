import { Router } from "express";
import { addTrackedMetric, removeTrackedMetric, getTrackedMetric } from "../db.js";
import { refreshExternalMetrics, listExternalMetrics, getExternalMetricHistory } from "../external.js";
import { SOURCE_LIST, fetchSource } from "../sources.js";
import { rateLimit } from "../http.js";

// ── 📦 外部指标（P3：通用多数据源：npm / PyPI / Docker / crates / …）──
export function externalRouter() {
  const r = Router();

  r.get("/sources", (_req, res) => res.json({ sources: SOURCE_LIST }));

  r.get("/metrics", (req, res) => {
    const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";
    res.json({ metrics: listExternalMetrics(window), window });
  });

  r.post("/metrics", async (req, res) => {
    const source = String(req.body?.source || "").trim();
    const key = String(req.body?.key || "").trim();
    if (!source || !key) return res.status(400).json({ error: "缺少 source 或 key" });
    if (!SOURCE_LIST.some((s) => s.key === source))
      return res.status(400).json({ error: `未知数据源: ${source}` });

    // 先验证能取到数据
    let probe;
    try {
      probe = await fetchSource(source, key);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    if (!probe) return res.status(404).json({ error: "未找到该指标，请检查名称是否正确" });

    const r2 = addTrackedMetric({ source, key, label: probe.label || key, url: probe.url, unit: probe.unit });
    if (!r2.ok) return res.status(409).json({ error: r2.error });
    res.json({ ok: true, id: r2.id, value: probe.value });
  });

  r.delete("/metrics/:id", (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "无效的 ID" });
    if (!getTrackedMetric(id)) return res.status(404).json({ error: "指标不存在" });
    removeTrackedMetric(id);
    res.json({ ok: true });
  });

  r.get("/metrics/:id/history", (req, res) => {
    const data = getExternalMetricHistory(req.params.id);
    if (!data) return res.status(404).json({ error: "指标不存在" });
    res.json(data);
  });

  r.post("/metrics/refresh", rateLimit({ windowMs: 60_000, max: 10 }), async (_req, res) => {
    try {
      const r2 = await refreshExternalMetrics({ force: true });
      res.json({ ok: true, ...r2 });
    } catch (e) {
      res.status(502).json({ error: "刷新失败: " + e.message });
    }
  });

  return r;
}
