import { Router } from "express";
import { renderBadge, colorForGrowth, compactNumber, renderSparkline, shieldsPayload } from "../badge.js";
import { getBadgeData, getSparkData } from "../tracker.js";
import { toNum, toMetric } from "../http.js";

// ── SVG 徽章 + shields.io endpoint + 迷你走势图（公开，可嵌入 README）──
//   用法：![stars](http://host/badge/owner/repo.svg)
//   shields endpoint：https://img.shields.io/endpoint?url=<host>/badge/owner/repo.json
//   可选：?metric=forks|issues &window=day|week|month &label=自定义
//   走势图：![trend](http://host/spark/owner/repo.svg?points=30)
export function badgesRouter() {
  const r = Router();

  r.get("/badge/:owner/:name", (req, res) => {
    let name = req.params.name;
    const asJson = name.endsWith(".json");
    if (asJson) name = name.slice(0, -5);
    else if (name.endsWith(".svg")) name = name.slice(0, -4);

    const fullName = `${req.params.owner}/${name}`;
    const metric = toMetric(req.query.metric);
    const window = ["day", "week", "month"].includes(req.query.window) ? req.query.window : "day";

    const data = getBadgeData(fullName, window);
    if (!data) {
      if (asJson) return res.json(shieldsPayload("GitHub", "not tracked", "#8b949e"));
      res.type("image/svg+xml");
      res.setHeader("Cache-Control", "public, max-age=60");
      return res.send(renderBadge("GitHub", "not tracked", "#8b949e"));
    }

    const metricMeta = {
      stars: ["Stars", data.stars, data.growth],
      forks: ["Forks", data.forks, data.growthForks],
      issues: ["Issues", data.open_issues, data.growthIssues],
    };
    const [labelBase, value, growth] = metricMeta[metric];
    const label = req.query.label ? String(req.query.label) : labelBase;
    const suffix = growth != null && growth !== 0 ? ` (${growth > 0 ? "+" : ""}${growth})` : "";

    if (asJson) {
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.json(shieldsPayload(label, compactNumber(value) + suffix, colorForGrowth(growth)));
    }
    res.type("image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=300");
    res.send(renderBadge(label, compactNumber(value) + suffix, colorForGrowth(growth)));
  });

  r.get("/spark/:owner/:name", (req, res) => {
    let name = req.params.name;
    if (name.endsWith(".svg")) name = name.slice(0, -4);
    const fullName = `${req.params.owner}/${name}`;
    const data = getSparkData(fullName, toNum(req.query.points, 30), toMetric(req.query.metric));
    res.type("image/svg+xml");
    res.setHeader("Cache-Control", "public, max-age=300");
    if (!data) return res.send(renderBadge("trend", "not tracked", "#8b949e"));
    res.send(
      renderSparkline(data.values, { width: toNum(req.query.w, 120), height: toNum(req.query.h, 32) }),
    );
  });

  return r;
}
