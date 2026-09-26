import { getLeaderboard, getSurges, getStats } from "./tracker.js";
import { sendDigest } from "./notify.js";
import { logger } from "./logger.js";

const fmt = (n) => (n == null ? "–" : Number(n).toLocaleString("en-US"));

/** 生成摘要内容（Top 日均增长 + 爆发项目 + 全局统计） */
export function buildDigest({ topN = 5 } = {}) {
  const lb = getLeaderboard({ limit: topN, window: "day", minStars: 0 });
  const { surges } = getSurges({ limit: 3, minStars: 0 });
  const stats = getStats();
  const today = new Date().toISOString().slice(0, 10);

  const lines = [
    `📦 收录 ${fmt(stats.repoCount)} 个项目 · 快照 ${fmt(stats.snapCount)} 条 · 收藏 ${fmt(stats.favoriteCount)}`,
    "",
    `🚀 日均增长 Top ${topN}`,
  ];
  if (!lb.byGrowth.length) lines.push("  （暂无足够数据）");
  lb.byGrowth.forEach((r, i) =>
    lines.push(`  ${i + 1}. ${r.full_name}  +${r.avgDailyGrowth}/天（★${fmt(r.stars)}）`),
  );

  lines.push("", "⚡ 爆发项目");
  if (!surges.length) lines.push("  （暂无）");
  surges.forEach((r, i) =>
    lines.push(`  ${i + 1}. ${r.full_name}  加速度 +${r.accel} 星/天²（近日均 ${r.recentAvg}）`),
  );

  return { title: `📊 GitHub Star Tracker 日报 ${today}`, text: lines.join("\n") };
}

/** 构建并发送摘要 */
export async function runDigest(opts) {
  const digest = buildDigest(opts);
  const result = await sendDigest(digest);
  if (!result.skipped) logger.info("摘要已触发", { ok: result.ok, status: result.status });
  return { ...digest, ...result };
}
