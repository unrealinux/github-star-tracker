import { Router } from "express";
import { db, getRecentAlerts } from "../db.js";
import { getSurges } from "../tracker.js";

// ── RSS / Atom 订阅（/api 下，可用 FEED_TOKEN 走 ?token= 认证）───────
const xmlEscape = (s) =>
  String(s ?? "").replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c],
  );

function buildAtom(req, { title, kind, entries }) {
  const base = `${req.protocol}://${req.get("host")}`;
  const self = `${base}/api/feed/${kind}.xml`;
  const updated = new Date().toISOString();
  const items = entries
    .map(
      (e) => `  <entry>
    <title>${xmlEscape(e.title)}</title>
    <link href="${xmlEscape(e.link)}"/>
    <id>${xmlEscape(e.id)}</id>
    <updated>${xmlEscape(e.updated)}</updated>
    <summary>${xmlEscape(e.summary || "")}</summary>
  </entry>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>${xmlEscape(title)}</title>
  <link href="${xmlEscape(self)}" rel="self"/>
  <link href="${xmlEscape(base)}"/>
  <id>${xmlEscape(self)}</id>
  <updated>${updated}</updated>
${items}
</feed>`;
}

export function feedRouter() {
  const r = Router();

  r.get("/feed/:kind", (req, res) => {
    const kind = String(req.params.kind).replace(/\.xml$/, "");
    const gh = (n) => `https://github.com/${n}`;
    let title, entries;

    if (kind === "surges") {
      title = "GitHub Star Tracker · 爆发项目";
      entries = getSurges({ limit: 30, minStars: 0 }).surges.map((r2) => ({
        title: `🚀 ${r2.full_name} 加速度 +${r2.accel} 星/天²`,
        link: gh(r2.full_name),
        id: `urn:gst:surge:${r2.full_name}:${new Date().toISOString().slice(0, 10)}`,
        updated: new Date().toISOString(),
        summary: `当前 ${Number(r2.stars).toLocaleString("en-US")} 星 · 近日均 ${r2.recentAvg} · 前期均 ${r2.priorAvg}`,
      }));
    } else if (kind === "new") {
      title = "GitHub Star Tracker · 新收录";
      entries = db
        .prepare(
          "SELECT full_name, stars, language, first_seen_at FROM repos ORDER BY first_seen_at DESC LIMIT 30",
        )
        .all()
        .map((r2) => ({
          title: `🆕 ${r2.full_name}（★${Number(r2.stars).toLocaleString("en-US")}）`,
          link: gh(r2.full_name),
          id: `urn:gst:new:${r2.full_name}`,
          updated: r2.first_seen_at,
          summary: r2.language || "",
        }));
    } else if (kind === "alerts") {
      title = "GitHub Star Tracker · 告警";
      entries = getRecentAlerts(30, 0, req.userId || 0).map((a) => ({
        title: `🔔 ${a.full_name} ${a.message || `+${a.growth} 星`}`,
        link: gh(a.full_name),
        id: `urn:gst:alert:${a.id}`,
        updated: a.triggered_at,
        summary: `类型 ${a.kind} · 当前 ${Number(a.current_stars).toLocaleString("en-US")} 星`,
      }));
    } else {
      return res.status(404).json({ error: "未知订阅类型（surges|new|alerts）" });
    }

    res.type("application/atom+xml; charset=utf-8").send(buildAtom(req, { title, kind, entries }));
  });

  return r;
}
