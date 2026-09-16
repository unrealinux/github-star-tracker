import { getSetting } from "./db.js";
import { sendPushToAll } from "./webpush.js";

/**
 * 告警 / 摘要外发，支持多种渠道。
 * 通过 settings 表配置：
 *   webhookUrl  - 目标地址（留空则不发）
 *   webhookType - generic | slack | discord | telegram | feishu | dingtalk | ntfy | bark | serverchan
 *
 * 渠道要点：
 *   telegram   - webhookUrl 形如 https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>
 *   ntfy       - webhookUrl 形如 https://ntfy.sh/<topic>（纯文本 body）
 *   serverchan - webhookUrl 形如 https://sctapi.ftqq.com/<KEY>.send（表单 body）
 */
const TIMEOUT_MS = 8000;

export const WEBHOOK_TYPES = [
  "generic", "slack", "discord", "telegram", "feishu", "dingtalk", "ntfy", "bark", "serverchan",
];

const json = (obj) => ({ body: JSON.stringify(obj), contentType: "application/json" });

/**
 * 把消息按渠道编码为 fetch 的 body / content-type。
 * @param {string} type
 * @param {{title?:string, text:string, event?:string, data?:object}} msg
 */
export function encodeMessage(type, msg) {
  const text = msg.text || "";
  const title = msg.title || "";
  const full = title ? `${title}\n${text}` : text;

  switch ((type || "generic").toLowerCase()) {
    case "slack":
      return json({ text: full, blocks: [{ type: "section", text: { type: "mrkdwn", text: full } }] });
    case "discord":
      return json({ content: full });
    case "feishu":
      return json({ msg_type: "text", content: { text: full } });
    case "dingtalk":
      return json({ msgtype: "text", text: { content: full } });
    case "telegram":
      // chat_id 通过 webhookUrl 的 query 传入
      return json({ text: full, disable_web_page_preview: true });
    case "bark":
      return json({ title: title || "GitHub Star Tracker", body: text });
    case "ntfy":
      return { body: full, contentType: "text/plain; charset=utf-8" };
    case "serverchan":
      return {
        body: new URLSearchParams({ title: title || "GitHub Star Tracker", desp: text }).toString(),
        contentType: "application/x-www-form-urlencoded; charset=utf-8",
      };
    default:
      return json({ event: msg.event || "alert", title, text, ...(msg.data || {}) });
  }
}

/** 将告警渲染为统一消息结构 */
function alertMessage(alert) {
  const { fullName, growth, currentStars, threshold, kind = "growth", message } = alert;
  const repoUrl = `https://github.com/${fullName}`;
  let text;
  if (kind === "milestone") text = message || `${fullName} 突破 ${Number(currentStars).toLocaleString()} 星`;
  else if (kind === "drop") text = `${fullName} 24h 内减少 ${Math.abs(growth)} 星（当前 ${Number(currentStars).toLocaleString()} 星）`;
  else text = `${fullName} 24h 内新增 ${growth} 星（阈值 ${threshold}），当前 ${Number(currentStars).toLocaleString()} 星`;

  return {
    event: `star_${kind}_alert`,
    title: "⭐ GitHub Star Tracker 告警",
    text: `${text}\n${repoUrl}`,
    data: {
      repo: fullName, url: repoUrl, growth, threshold,
      current_stars: currentStars, kind, triggered_at: new Date().toISOString(),
    },
  };
}

/** 统一带超时的 POST */
async function deliver(type, url, msg) {
  const { body, contentType } = encodeMessage(type, msg);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "Content-Type": contentType, "User-Agent": "github-star-tracker" },
      body,
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

const currentWebhook = () => ({
  url: (getSetting("webhookUrl", "") || "").trim(),
  type: (getSetting("webhookType", "generic") || "generic").toLowerCase(),
});

/** 发送告警：Webhook + 浏览器/手机系统级推送（各自失败不影响对方） */
export async function sendAlertWebhook(alert) {
  const msg = alertMessage(alert);

  // 系统级推送（无 webhook 配置时也会发；按告警所属用户定向）
  sendPushToAll({ title: msg.title, body: msg.text.split("\n")[0], url: msg.data?.url }, alert.userId ?? null).catch(() => {});

  const { url, type } = currentWebhook();
  if (!url) return;
  try {
    const res = await deliver(type, url, msg);
    if (!res.ok) console.warn(`[notify] webhook 返回 ${res.status}`);
  } catch (e) {
    console.warn("[notify] webhook 发送失败:", e.message);
  }
}

/** 发送摘要（定时日报 / 手动触发） */
export async function sendDigest({ title, text }) {
  const { url, type } = currentWebhook();
  if (!url) return { ok: false, skipped: true, reason: "未配置 Webhook 地址" };
  try {
    const res = await deliver(type, url, { event: "digest", title, text, data: { at: new Date().toISOString() } });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 发送测试通知，返回结果供接口回显 */
export async function testWebhook(url, type) {
  const msg = alertMessage({ fullName: "octocat/Hello-World", growth: 42, currentStars: 12345, threshold: 10, kind: "growth" });
  try {
    const res = await deliver((type || "generic").toLowerCase(), url, msg);
    return { ok: res.ok, status: res.status };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
