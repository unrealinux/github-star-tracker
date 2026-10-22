/**
 * tracker 门面 —— 保持对外导出不变（digest / scheduler / routes / tests 都从这里取）。
 * 实现已按职责拆到：
 *   collect.js  采集写路径（refresh / refreshCustomRepos / refreshTrackedQueries）
 *   alerts.js   告警引擎（evaluateAlertRules / checkAlerts / setNotify）
 *   snapshots.js 快照读取（loadSnapshotMap / windowBaseline / dailyAggregate）
 *   growth.js   纯计算（computeGrowth / predictGrowth / makeSort …）
 *   analytics.js 只读榜单与检测（listRepos / getLeaderboard / getAnomalies …）
 *   indices.js  指数与生态聚合（getIndexSeries / getQueryAggregate …）
 */
import { setNotify } from "./alerts.js";
import { trendingSettings, refresh, refreshCustomRepos, refreshTrackedQueries } from "./collect.js";
import { windowBaseline, dailyAggregate } from "./snapshots.js";
import {
  computeMomentum,
  computeDailyGrowth,
  computeAvgDailyGrowth,
  computeGrowth,
  predictGrowth,
  makeSort,
  computeCrossings,
  todayStartMs,
} from "./growth.js";
import { evaluateAlertRules, loadAlertConfig, getAlertTargets, fireAlert, checkAlerts } from "./alerts.js";
import {
  AVAILABLE_METRICS,
  metricOf,
  GROWTH_BASES,
  AVAILABLE_GROWTH_BASES,
  MIN_GROWTH_SAMPLE_DAYS,
  MILESTONES,
  compactStars,
} from "./metrics.js";
import { loadSnapshotMap, loadRecentSnapshotMap, snapshotAtMap } from "./snapshots.js";
import {
  listRepos,
  listLanguages,
  getLeaderboard,
  getSurges,
  listReposAt,
  getLanguageTrends,
  getRankChanges,
  getBadgeData,
  getRepoHistory,
  compareRepos,
  getOverview,
  findSimilarRepos,
  getAnomalies,
  getRisingStars,
  getSparkData,
  getEvents,
  backtestAlerts,
  getStats,
} from "./analytics.js";
import { resolveIndexMembers, getIndexSeries, getQueryAggregate, getQueryMemberGrowth } from "./indices.js";

export {
  // 采集
  trendingSettings,
  refresh,
  refreshCustomRepos,
  refreshTrackedQueries,
  // 告警
  setNotify,
  evaluateAlertRules,
  checkAlerts,
  // 快照 / 基线
  windowBaseline,
  // 增长纯函数
  predictGrowth,
  // 榜单 / 分析
  listRepos,
  listLanguages,
  getLeaderboard,
  getSurges,
  listReposAt,
  getLanguageTrends,
  getRankChanges,
  getBadgeData,
  getRepoHistory,
  compareRepos,
  getOverview,
  findSimilarRepos,
  getAnomalies,
  getRisingStars,
  getSparkData,
  getEvents,
  backtestAlerts,
  getStats,
  // 指数 / 生态
  resolveIndexMembers,
  getIndexSeries,
  getQueryAggregate,
  getQueryMemberGrowth,
  // 常量（server.js 的参数校验与 UI 依赖）
  AVAILABLE_METRICS,
  GROWTH_BASES,
  AVAILABLE_GROWTH_BASES,
};

// 内部共享（不导出门面之外的东西，只供拆开的子模块互相使用）
export { metricOf, MIN_GROWTH_SAMPLE_DAYS, MILESTONES, compactStars };
export { loadAlertConfig, getAlertTargets, fireAlert };
export { dailyAggregate, loadSnapshotMap, loadRecentSnapshotMap, snapshotAtMap };
export {
  computeMomentum,
  computeDailyGrowth,
  computeAvgDailyGrowth,
  computeGrowth,
  makeSort,
  computeCrossings,
  todayStartMs,
};
