/**
 * 每仓库告警阈值 —— 存在 settings 表里，键按用户隔离。
 * 「设置 → PUT /api/settings」写入整份覆盖表，「POST /api/repos/:id/alert」读写单个仓库，
 * 两边共用同一存储格式，故放一个小模块里。
 */
import { getSetting } from "./db.js";

export const repoThresholdKey = (userId = 0) => (userId ? `repoThresholds:${userId}` : "repoThresholds");

export function readRepoThresholds(userId = 0) {
  try {
    return JSON.parse(getSetting(repoThresholdKey(userId), "{}") || "{}") || {};
  } catch {
    return {};
  }
}
