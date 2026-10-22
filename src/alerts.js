/**
 * 告警引擎 —— 读取囤户阈值、评估规则、落库与推送。
 * 与副作用分离的部分（evaluateAlertRules）是纯函数，便于测试与回测复用。
 */
import { getSetting, insertAlert, hasRecentAlert, listUsers } from "./db.js";
import { windowBaseline } from "./snapshots.js";
import { MILESTONES } from "./metrics.js";

// ── 通知回调（由 scheduler.js 注入 notify.js）─────────────────────
let notifyCallback = null;
export function setNotify(cb) {
  notifyCallback = cb;
}

/** 读取告警配置（含每仓库阈值；阈值按用户隔离） */
export function loadAlertConfig(userId = 0) {
  const key = userId ? `repoThresholds:${userId}` : "repoThresholds";
  let repoThresholds;
  try {
    repoThresholds = JSON.parse(getSetting(key, "{}") || "{}");
  } catch {
    repoThresholds = {};
  }
  return {
    threshold: Number(getSetting("alertThreshold", 50)) || 0,
    repoThresholds: repoThresholds && typeof repoThresholds === "object" ? repoThresholds : {},
    alertOnDrop: getSetting("alertOnDrop", "0") === "1",
    dropThreshold: Number(getSetting("dropThreshold", 50)) || 0,
    alertOnMilestone: getSetting("alertOnMilestone", "0") === "1",
  };
}

/**
 * 告警评估目标：无用户时只有「单用户/共享」(id=0)，否则每个用户各按自己的阈值评估。
 * @returns {Array<{userId:number, cfg:object}>}
 */
export function getAlertTargets() {
  const users = listUsers();
  if (!users.length) return [{ userId: 0, cfg: loadAlertConfig(0) }];
  return users.map((u) => ({ userId: u.id, cfg: loadAlertConfig(u.id) }));
}

export function fireAlert(repoId, fullName, alert, userId = 0) {
  insertAlert(repoId, alert.threshold, alert.growth, alert.currentStars, {
    kind: alert.kind,
    message: alert.message,
    userId,
  });
  if (notifyCallback) {
    Promise.resolve(notifyCallback({ repoId, fullName, ...alert, userId })).catch((e) =>
      console.error("[notify]", e.message),
    );
  }
}

/**
 * 纯函数：根据星数与基线判断应触发哪些告警。
 * 与副作用（写库/推送）分离，便于测试。
 *
 * 阈值是「日增星数」，所以先按 baseDays 归一到日均再比 —— 采集中断时
 * 基准可能是多天前的快照，拿整段跨度直接比阈值会放大若干倍（实测 7 天
 * 的增量触发了 241 条假告警）。告警里存的 growth 也因此是日均值。
 *
 * @param {number} baseDays 基准快照距现在的天数（≥1）；省略按 1 天
 * @returns {Array<{kind:string, threshold:number, growth:number, days:number, currentStars:number, message?:string}>}
 */
export function evaluateAlertRules({ fullName, repoStars, baseStars, baseDays = 1, prevStars, cfg }) {
  const out = [];
  if (baseStars == null) return out;

  const days = Number.isFinite(baseDays) && baseDays > 0 ? baseDays : 1;
  // 先取整再比较，保证「触发了」与「界面显示的数值」一致（≥ 阈值）
  const growth = Math.round((repoStars - baseStars) / days);

  const override = Number(cfg?.repoThresholds?.[fullName]);
  const effective = Number.isFinite(override) ? override : cfg.threshold;
  if (effective > 0 && growth >= effective) {
    out.push({ kind: "growth", threshold: effective, growth, days, currentStars: repoStars });
  }

  if (cfg.alertOnDrop && cfg.dropThreshold > 0 && growth <= -cfg.dropThreshold) {
    out.push({ kind: "drop", threshold: cfg.dropThreshold, growth, days, currentStars: repoStars });
  }

  if (cfg.alertOnMilestone && prevStars != null) {
    const crossed = MILESTONES.find((m) => prevStars < m && repoStars >= m);
    if (crossed) {
      out.push({
        kind: "milestone",
        threshold: crossed,
        growth: repoStars - prevStars,
        currentStars: repoStars,
        message: `${fullName} 突破 ${crossed.toLocaleString("en-US")} 星`,
      });
    }
  }
  return out;
}

/**
 * 检查并生成告警。
 * @param {number|null} prevStars 上一次刷新时的星数（用于里程碑判定）
 */
export function checkAlerts(repoId, fullName, repoStars, snaps, prevStars, cfg, userId = 0) {
  const base = windowBaseline(snaps);
  if (!base) return;

  const { snap, days } = base;
  for (const alert of evaluateAlertRules({
    fullName,
    repoStars,
    baseStars: snap.stars,
    baseDays: days,
    prevStars,
    cfg,
  })) {
    const hours = alert.kind === "milestone" ? 24 : 2;
    if (hasRecentAlert(repoId, hours, alert.kind, userId)) continue;
    fireAlert(repoId, fullName, alert, userId);
  }
}
