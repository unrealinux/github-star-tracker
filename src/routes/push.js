import { Router } from "express";
import { getSetting, listPushSubscriptions } from "../db.js";
import { testWebhook, WEBHOOK_TYPES } from "../notify.js";
import { runDigest } from "../digest.js";
import { getVapidKeys, subscribePush, unsubscribePush, sendPushToAll } from "../webpush.js";
import { rateLimit } from "../http.js";

// ── Webhook 测试 / 每日摘要 / Web Push（系统级通知）─────────────
export function pushRouter() {
  const r = Router();

  r.get("/webhook-types", (_req, res) => res.json({ types: WEBHOOK_TYPES }));

  r.post("/notify/test", async (req, res) => {
    const url = (req.body?.url || getSetting("webhookUrl", "") || "").trim();
    const type = req.body?.type || getSetting("webhookType", "generic") || "generic";
    if (!url) return res.status(400).json({ error: "请先填写 Webhook 地址" });
    const result = await testWebhook(url, type);
    res.status(result.ok ? 200 : 502).json(result);
  });

  r.post("/notify/digest", rateLimit({ windowMs: 60_000, max: 3 }), async (_req, res) => {
    try {
      const r2 = await runDigest();
      if (r2.skipped) return res.status(400).json({ error: r2.reason || "未发送" });
      res.status(r2.ok ? 200 : 502).json({ ok: r2.ok, status: r2.status, title: r2.title, text: r2.text });
    } catch (e) {
      res.status(502).json({ error: "摘要发送失败：" + e.message });
    }
  });

  // ── Web Push ───────────────────────────────────────────────
  r.get("/push/public-key", (_req, res) => res.json({ publicKey: getVapidKeys().publicKey }));

  r.get("/push/subscriptions", (req, res) => {
    const subs = listPushSubscriptions(req.userId || 0).map((s) => ({
      id: s.id,
      endpointHost: (() => {
        try {
          return new URL(s.endpoint).host;
        } catch {
          return "unknown";
        }
      })(),
      created_at: s.created_at,
      last_ok_at: s.last_ok_at,
      last_error: s.last_error,
    }));
    res.json({ count: subs.length, subscriptions: subs });
  });

  r.post("/push/subscribe", (req, res) => {
    const b = req.body || {};
    try {
      res.json(
        subscribePush({
          endpoint: b.endpoint,
          p256dh: b.keys?.p256dh || b.p256dh,
          auth: b.keys?.auth || b.auth,
          userAgent: req.get("user-agent"),
          userId: req.userId || 0,
        }),
      );
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post("/push/unsubscribe", (req, res) => {
    try {
      res.json(unsubscribePush(req.body?.endpoint, req.userId || 0));
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  r.post("/push/test", rateLimit({ windowMs: 60_000, max: 5 }), async (req, res) => {
    try {
      const result = await sendPushToAll(
        {
          title: "⭐ GitHub Star Tracker",
          body: "这是一条测试推送。若你看到它，说明系统级通知已打通。",
          url: "/",
        },
        req.userId || 0,
      );
      if (!result.total)
        return res.status(400).json({ error: "还没有任何推送订阅，请先在设置页启用浏览器通知" });
      res.json({ ok: result.sent > 0, ...result });
    } catch (e) {
      res.status(502).json({ error: "推送失败：" + e.message });
    }
  });

  return r;
}
