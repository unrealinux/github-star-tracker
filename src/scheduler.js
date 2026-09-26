import {
  db,
  getSetting,
  setSetting,
  saveScheduledState,
  loadScheduledState,
  getRetentionDays,
  cleanupOldSnapshots,
  rollupOldSnapshots,
} from "./db.js";
import { refresh, refreshCustomRepos, refreshTrackedQueries, setNotify } from "./tracker.js";
import { refreshExternalMetrics } from "./external.js";
import { sendAlertWebhook } from "./notify.js";
import { runDigest } from "./digest.js";
import { getLastQuota } from "./github.js";
import { logger } from "./logger.js";

// 告警 -> Webhook
setNotify(sendAlertWebhook);

// ── 刷新锁（进程内 + SQLite 行锁，防并发）─────────────────────────
// 手动刷新与定时/轮询刷新共用同一把锁，避免同时写库导致 "database is locked"
let _running = false;
const state = { lastAutoAt: null, lastAutoOk: null, lastAutoMessage: null };

function acquireRefreshLock() {
  if (_running) return false;
  try {
    db.prepare("INSERT INTO scheduled_state (key, value) VALUES ('refresh_locked', '1')").run();
    _running = true;
    return true;
  } catch {
    return false;
  }
}
function releaseRefreshLock() {
  _running = false;
  try {
    db.prepare("DELETE FROM scheduled_state WHERE key = 'refresh_locked'").run();
  } catch {}
}

(async function init() {
  // 上次进程退出若未释放锁（崩溃/被杀），重启后清理陈旧锁
  try {
    db.prepare("DELETE FROM scheduled_state WHERE key = 'refresh_locked'").run();
  } catch {}
  const saved = loadScheduledState();
  if (saved.last_auto_at) state.lastAutoAt = saved.last_auto_at;
  if (saved.last_auto_ok !== undefined) state.lastAutoOk = saved.last_auto_ok === "1";
  if (saved.last_auto_message !== undefined) state.lastAutoMessage = saved.last_auto_message;
})();

/** 一次完整刷新（热门 + 自定义 + 追踪查询 + 外部指标），调用方负责加锁 */
async function performRefresh({ token, force = false }) {
  // 配额感知：搜索配额见底时跳过本轮（手动刷新可用 force 绕过）
  const floor = Number(getSetting("quotaFloor", 3)) || 0;
  if (!force && floor > 0) {
    const q = getLastQuota();
    if (q?.search && q.search.remaining <= floor) {
      return { skipped: true, reason: `GitHub 搜索配额不足（剩余 ${q.search.remaining} ≤ ${floor}）` };
    }
  }

  const minStars = Number(getSetting("minStars", 1000)) || 1000;
  const summary = await refresh({ minStars, token });
  const customResult = await refreshCustomRepos({ token });
  const queryResult = await refreshTrackedQueries({ token });
  const external = await refreshExternalMetrics();
  return {
    ...summary,
    customUpserted: customResult.upserted,
    customRenamed: customResult.renamed,
    customStale: customResult.stale,
    queriesRefreshed: queryResult.updated,
    queryMembers: queryResult.members,
    externalFetched: external.fetched,
  };
}

export async function runScheduledRefresh({ token }) {
  if (!acquireRefreshLock()) return { skipped: true, reason: "上一轮仍在执行" };
  try {
    const result = await performRefresh({ token });
    if (result.skipped) {
      state.lastAutoAt = new Date().toISOString();
      state.lastAutoOk = false;
      state.lastAutoMessage = `已跳过：${result.reason}`;
      saveScheduledState(state);
      logger.warn("自动刷新跳过", { reason: result.reason });
      return result;
    }
    state.lastAutoAt = new Date().toISOString();
    state.lastAutoOk = true;
    state.lastAutoMessage = `抓取完成：热门 ${result.upserted}，自定义 ${result.customUpserted}，追踪 ${result.queriesRefreshed}，外部 ${result.externalFetched}，共 ${result.total} 项目`;
    saveScheduledState(state);
    logger.info("自动刷新完成", {
      hot: result.upserted,
      custom: result.customUpserted,
      external: result.externalFetched,
      total: result.total,
    });
    return result;
  } catch (e) {
    state.lastAutoAt = new Date().toISOString();
    state.lastAutoOk = false;
    state.lastAutoMessage = String(e.message || e);
    saveScheduledState(state);
    logger.error("自动刷新失败", { error: e.message });
    throw e;
  } finally {
    releaseRefreshLock();
  }
}

export async function runManualRefresh({ token }) {
  if (!acquireRefreshLock()) return { skipped: true, reason: "已有刷新任务在执行中" };
  try {
    const result = await performRefresh({ token, force: true });
    logger.info("手动刷新完成", {
      hot: result.upserted,
      custom: result.customUpserted,
      external: result.externalFetched,
    });
    return result;
  } finally {
    releaseRefreshLock();
  }
}

export function runCleanup() {
  // 先降采样（把 N 天前的快照压成每周一条），再按保留天数删除
  const rollupDays = Number(getSetting("rollupAfterDays", 30)) || 0;
  const rolled = rollupDays > 0 ? rollupOldSnapshots(rollupDays) : { scanned: 0, removed: 0 };
  const days = getRetentionDays();
  const removed = cleanupOldSnapshots(days);
  logger.info("清理与降采样", { rollupDays, rolledUp: rolled.removed, retentionDays: days, removed });
  return { removed, rolledUp: rolled.removed, rollupDays, retentionDays: days };
}

/**
 * 检查是否到达每日摘要时间（每分钟由轮询任务调用）。
 * 用「本地 HH:MM + 当天日期」判定，避免重发。
 */
export async function checkDueDigest() {
  if (getSetting("digestEnabled", "0") !== "1") return { skipped: true, reason: "未启用" };

  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const hhmm = `${p(now.getHours())}:${p(now.getMinutes())}`;
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  if (hhmm !== (getSetting("digestTime", "09:00") || "09:00")) return { skipped: true, reason: "未到时间" };
  if (getSetting("digestLastDate", "") === today) return { skipped: true, reason: "今日已发送" };

  setSetting("digestLastDate", today);
  const result = await runDigest();
  logger.info("每日摘要已发送", { ok: result.ok, status: result.status });
  return result;
}

export function getScheduleState() {
  return { ...state, running: _running };
}
