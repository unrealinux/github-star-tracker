/**
 * Web Push（零依赖实现）
 *
 * - VAPID：ES256 JWT，用 node:crypto 的 EC P-256 密钥签名（IEEE-P1363 原始签名）
 * - 负载加密：RFC 8291 `aes128gcm`
 *     ECDH(P-256) → HKDF-SHA256 派生 IKM → 再派生 CEK/NONCE → AES-128-GCM
 *
 * 这样无需引入 web-push 等第三方库，保持项目「零外部依赖」的特性。
 */
import crypto from "node:crypto";
import { getSetting, setSetting } from "./db.js";
import {
  listPushSubscriptions,
  addPushSubscription,
  removePushSubscriptionById,
  removePushSubscriptionByEndpoint,
  markPushOk,
  markPushError,
} from "./db.js";
import { logger } from "./logger.js";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const fromB64u = (s) => Buffer.from(String(s), "base64url");
const RECORD_SIZE = 4096;
const PUSH_TIMEOUT_MS = 10_000;

// ── VAPID 密钥 ────────────────────────────────────────────────────
let cachedKeys = null;

/** 生成一对 P-256 密钥；公钥为 base64url 的未压缩点（65 字节） */
export function generateVapidKeys() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" }); // { kty, crv, x, y, d }
  const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
  return { publicKey: b64u(raw), privateJwk: jwk };
}

/** 读取（必要时生成并持久化）VAPID 密钥 */
export function getVapidKeys() {
  if (cachedKeys) return cachedKeys;
  const pub = getSetting("vapidPublicKey");
  const priv = getSetting("vapidPrivateKey");
  if (pub && priv) {
    try {
      cachedKeys = { publicKey: pub, privateJwk: JSON.parse(priv) };
      return cachedKeys;
    } catch {
      /* 密钥损坏则重新生成 */
    }
  }
  const keys = generateVapidKeys();
  setSetting("vapidPublicKey", keys.publicKey);
  setSetting("vapidPrivateKey", JSON.stringify(keys.privateJwk));
  cachedKeys = keys;
  logger.info("已生成 VAPID 密钥对");
  return keys;
}

const vapidSubject = () =>
  process.env.VAPID_SUBJECT ||
  getSetting("vapidSubject", "mailto:admin@example.com") ||
  "mailto:admin@example.com";

/**
 * 生成 VAPID 授权头（JWT 受众为该 endpoint 的 origin）。
 * @returns {string} 形如 `vapid t=<jwt>, k=<公钥>`
 */
export function vapidAuthHeader(endpoint, subject = vapidSubject(), ttlSeconds = 12 * 3600) {
  const { publicKey, privateJwk } = getVapidKeys();
  const audience = new URL(endpoint).origin;
  const signingInput = [
    b64u(JSON.stringify({ typ: "JWT", alg: "ES256" })),
    b64u(JSON.stringify({ aud: audience, exp: Math.floor(Date.now() / 1000) + ttlSeconds, sub: subject })),
  ].join(".");
  const key = crypto.createPrivateKey({ format: "jwk", key: privateJwk });
  const sig = crypto.sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${b64u(sig)}, k=${publicKey}`;
}

// ── 负载加密（RFC 8291 aes128gcm）─────────────────────────────────
/**
 * @param {{p256dh:string, auth:string}} subscription 客户端 p256dh / auth（base64url）
 * @param {Buffer|string} payload
 * @returns {Buffer} aes128gcm 报文（header + 密文 + tag）
 */
export function encryptPayload(subscription, payload) {
  const clientPub = fromB64u(subscription.p256dh);
  const authSecret = fromB64u(subscription.auth);
  if (clientPub.length !== 65) throw new Error("p256dh 必须是 65 字节的未压缩点");
  if (authSecret.length !== 16) throw new Error("auth 必须是 16 字节");

  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const serverPub = ecdh.getPublicKey(); // 65 字节
  const sharedSecret = ecdh.computeSecret(clientPub); // 32 字节

  const authInfo = Buffer.concat([Buffer.from("WebPush: info\0"), clientPub, serverPub]);
  const ikm = Buffer.from(crypto.hkdfSync("sha256", sharedSecret, authSecret, authInfo, 32));

  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16),
  );
  const nonce = Buffer.from(
    crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12),
  );

  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(RECORD_SIZE, 0);
  const header = Buffer.concat([salt, rs, Buffer.from([serverPub.length]), serverPub]);

  // 0x02 = 最后一条记录的填充分隔符
  const plaintext = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);

  const cipher = crypto.createCipheriv("aes-128-gcm", cek, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  return Buffer.concat([header, ciphertext]);
}

/** 发送一条推送，返回 HTTP 状态码 */
export async function sendPush(subscription, message) {
  const body = encryptPayload(subscription, Buffer.from(JSON.stringify(message)));
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: vapidAuthHeader(subscription.endpoint),
      Urgency: "normal",
    },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  return res.status;
}

/**
 * 向订阅设备推送。404/410 表示订阅已失效，直接清理。
 * @param {object} message 推送内容 {title, body, url}
 * @param {number|null} userId 限定某个用户的设备；null = 全部（如系统级测试）
 * @returns {{sent:number, failed:number, removed:number, total:number}}
 */
export async function sendPushToAll(message, userId = null) {
  const subs = listPushSubscriptions(userId);
  if (!subs.length) return { sent: 0, failed: 0, removed: 0, total: 0 };

  let sent = 0,
    failed = 0,
    removed = 0;
  for (const s of subs) {
    try {
      const status = await sendPush(s, message);
      if (status >= 200 && status < 300) {
        markPushOk(s.id);
        sent++;
      } else if (status === 404 || status === 410) {
        removePushSubscriptionById(s.id);
        removed++;
      } else {
        markPushError(s.id, `HTTP ${status}`);
        failed++;
      }
    } catch (e) {
      markPushError(s.id, String(e.message || e).slice(0, 200));
      failed++;
    }
  }
  return { sent, failed, removed, total: subs.length };
}

// ── 订阅管理（供路由使用）────────────────────────────────────────
export function subscribePush({ endpoint, p256dh, auth, userAgent, userId = 0 }) {
  if (!endpoint || !p256dh || !auth) throw new Error("缺少 endpoint / p256dh / auth");
  // Buffer.from(..,"base64url") 对非法字符很宽容，必须校验解码后的长度
  const pub = fromB64u(p256dh);
  const authBuf = fromB64u(auth);
  if (pub.length !== 65) throw new Error("p256dh 必须是 65 字节的未压缩公钥（base64url）");
  if (authBuf.length !== 16) throw new Error("auth 必须是 16 字节（base64url）");
  addPushSubscription({ endpoint, p256dh, auth, userAgent, userId });
  logger.info("新增推送订阅", { endpoint: String(endpoint).slice(0, 60) });
  return { ok: true };
}

export function unsubscribePush(endpoint, userId = null) {
  if (!endpoint) throw new Error("缺少 endpoint");
  removePushSubscriptionByEndpoint(endpoint, userId);
  return { ok: true };
}
