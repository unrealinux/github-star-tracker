/**
 * 核心逻辑单元测试（node:test，零依赖）
 * 运行：npm test
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 用临时数据库，避免污染真实数据
const tmp = mkdtempSync(join(tmpdir(), "gst-test-"));
process.env.DB_DIR = tmp;
process.env.DB_PATH = join(tmp, "test.db");

const {
  db, setSetting, getSetting, toggleFavorite, listFavorites, countFavorites,
  addCustomRepo, listCustomRepos, countCustomRepos, removeCustomRepo, searchCustomRepo,
  insertAlert, getAlertsUnreadCount, markAlertsRead, hasRecentAlert,
  recordApiUsage, getApiQuotaInfo, cleanupOldSnapshots, getRepoIdMap, getRetentionDays,
  exportData, importData,
  addIndex, getIndex, listIndices, removeIndex,
  addTrackedQuery, listTrackedQueries, removeTrackedQuery, getTrackedQuery,
  replaceQueryMembers, getQueryMemberIds,
  renameRepo, markRepoStale, clearRepoStale, rollupOldSnapshots,
} = await import("../src/db.js");
const { listRepos, predictGrowth, getRankChanges, listLanguages, getLanguageTrends, getStats, getLeaderboard, getSurges, listReposAt, getBadgeData, evaluateAlertRules, windowBaseline, compareRepos, getOverview, findSimilarRepos, getAnomalies, getRisingStars, getSparkData, getEvents, backtestAlerts,
  resolveIndexMembers, getIndexSeries, getQueryAggregate, refreshTrackedQueries, refreshCustomRepos, getRepoHistory } = await import("../src/tracker.js");

// ── 测试数据填充 ──
function seed() {
  db.exec("DELETE FROM snapshots; DELETE FROM repos; DELETE FROM favorites; DELETE FROM custom_repos; DELETE FROM alerts;");
  const ins = db.prepare("INSERT INTO repos (full_name, name, owner, url, description, language, stars, is_custom) VALUES (?,?,?,?,?,?,?,?)");
  ins.run("alpha/python-tool", "python-tool", "alpha", "http://a", "A python utility", "Python", 5000, 0);
  ins.run("beta/rust-lib", "rust-lib", "beta", "http://b", "A rust library", "Rust", 3000, 0);
  ins.run("gamma/js-app", "js-app", "gamma", "http://c", "A javascript application", "JavaScript", 1000, 0);

  const ids = db.prepare("SELECT id, full_name FROM repos").all();
  const idOf = (n) => ids.find((r) => r.full_name === n).id;
  const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

  // alpha: 3天前 4000 → 今天 5000（+1000）
  snap.run(idOf("alpha/python-tool"), 4000, iso(3));
  snap.run(idOf("alpha/python-tool"), 5000, iso(0));
  // beta: 3天前 3500 → 今天 3000（-500）
  snap.run(idOf("beta/rust-lib"), 3500, iso(3));
  snap.run(idOf("beta/rust-lib"), 3000, iso(0));
  // gamma: 仅一条（待积累）
  snap.run(idOf("gamma/js-app"), 1000, iso(0));
  return { idOf };
}

describe("listRepos 过滤与分页", () => {
  let idOf;
  before(() => { ({ idOf } = seed()); });

  test("默认返回全部仓库", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10 });
    assert.equal(r.total, 3);
    assert.equal(r.repos.length, 3);
    assert.equal(r.repos[0].full_name, "alpha/python-tool"); // 星数最高
  });

  test("关键词命中名称/描述", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10, keyword: "python" });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "alpha/python-tool");
  });

  test("关键词命中描述", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10, keyword: "javascript" });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "gamma/js-app");
  });

  test("按语言过滤", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "Rust", sort: "stars", window: "day", page: 1, pageSize: 10 });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "beta/rust-lib");
  });

  test("minStars 过滤", () => {
    const r = listRepos({ minStars: 4000, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10 });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "alpha/python-tool");
  });

  test("分页不重叠且 total 正确", () => {
    const p1 = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 2 });
    const p2 = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 2, pageSize: 2 });
    assert.equal(p1.total, 3);
    assert.equal(p1.totalPages, 2);
    assert.equal(p1.repos.length, 2);
    assert.equal(p2.repos.length, 1);
    const names = new Set([...p1.repos, ...p2.repos].map((r) => r.full_name));
    assert.equal(names.size, 3);
  });

  test("页码越界自动收敛到最后一页", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 99, pageSize: 2 });
    assert.equal(r.page, 2);
  });

  test("onlyFavorite 过滤", () => {
    toggleFavorite(idOf("beta/rust-lib"));
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10, onlyFavorite: true });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "beta/rust-lib");
    assert.equal(r.repos[0].is_favorite, true);
    toggleFavorite(idOf("beta/rust-lib")); // 复原
  });

  test("onlyCustom 以 custom_repos 表为准（不依赖 repos.is_custom 标记）", () => {
    addCustomRepo("beta/rust-lib");
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10, onlyCustom: true });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "beta/rust-lib");
    assert.equal(r.repos[0].is_custom, true);
    assert.equal(getStats().customCount, 1);
    removeCustomRepo("beta/rust-lib");
    assert.equal(getStats().customCount, 0);
  });
});

describe("增长计算", () => {
  before(() => seed());

  test("有跨天基线时计算窗口增长", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "Python", sort: "stars", window: "day", page: 1, pageSize: 10 });
    const a = r.repos[0];
    assert.equal(a.growth, 1000);           // 4000 → 5000
    // 基准快照是 3 天前（seed 用 iso(3)），所以标签必须如实写 3 天，
    // 不能写「近24h」—— 那是把 3 天的增长谎报成一天。
    assert.equal(a.growthLabel, "近3天");
  });

  test("负增长被正确计算", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "Rust", sort: "stars", window: "day", page: 1, pageSize: 10 });
    assert.equal(r.repos[0].growth, -500);
  });

  test("仅一条快照时显示待积累", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "JavaScript", sort: "stars", window: "day", page: 1, pageSize: 10 });
    assert.equal(r.repos[0].growth, null);
    assert.equal(r.repos[0].growthLabel, "待积累");
  });

  test("minGrowth 过滤掉低速项目", () => {
    const r = listRepos({ minStars: 0, minGrowth: 100, language: "", sort: "stars", window: "day", page: 1, pageSize: 10 });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].full_name, "alpha/python-tool");
  });

  test("todayOnly 只保留正增长", () => {
    const r = listRepos({ minStars: 0, minGrowth: 0, language: "", sort: "stars", window: "day", page: 1, pageSize: 10, todayOnly: true });
    assert.equal(r.total, 1);
    assert.equal(r.repos[0].growth > 0, true);
  });
});

describe("增长窗口标签：采集中断后不得谎报近24h", () => {
  // 窗口基准取的是「不晚于窗口起点」的最近快照。采集中断过时，
  // 那个快照可能已经是很久以前 —— 差值覆盖的是整段跨度，
  // 若仍标窗口标签，就会把 7 天的增长说成 24 小时。
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare(
      "INSERT INTO repos (full_name, name, owner, url, language, stars, is_custom) VALUES (?,?,?,?,?,?,0)"
    );
    ins.run("gap/seven", "seven", "gap", "u", "Go", 10000);
    ins.run("gap/oneday", "oneday", "gap", "u", "Go", 10000);

    const ids = db.prepare("SELECT id, full_name FROM repos").all();
    const idOf = (n) => ids.find((r) => r.full_name === n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

    // 中断 7 天：只有 7 天前与现在两个快照
    snap.run(idOf("gap/seven"), 9000, iso(7));
    snap.run(idOf("gap/seven"), 10000, iso(0));
    // 正常：约 25 小时前的基线（略盖过 24h 窗口）
    snap.run(idOf("gap/oneday"), 9000, iso(25 / 24));
    snap.run(idOf("gap/oneday"), 10000, iso(0));
  });

  const find = (name) => listRepos({
    minStars: 0, minGrowth: 0, language: "Go", sort: "stars", window: "day", page: 1, pageSize: 10,
  }).repos.find((r) => r.full_name === name);

  test("中断 7 天：标「近7天」，而不是「近24h」", () => {
    const r = find("gap/seven");
    assert.equal(r.growth, 1000);
    assert.equal(r.growthLabel, "近7天");
  });

  test("正常约 24h 基线：仍标「近24h」（不要矫柉过正）", () => {
    const r = find("gap/oneday");
    assert.equal(r.growth, 1000);
    assert.equal(r.growthLabel, "近24h");
  });
});

describe("predictGrowth 线性回归", () => {
  test("数据不足返回 null", () => {
    assert.equal(predictGrowth([{ stars: 100, captured_at: new Date().toISOString() }]), null);
  });

  test("稳定增长可预测里程碑", () => {
    const snaps = [];
    for (let i = 0; i < 5; i++) {
      snaps.push({ stars: 100000 + i * 1000, captured_at: new Date(Date.now() - (4 - i) * 86400000).toISOString() });
    }
    const p = predictGrowth(snaps);
    assert.ok(p, "应返回预测");
    assert.ok(Math.abs(p.perDay - 1000) < 50, `增速应约 1000/天，实际 ${p.perDay}`);
    assert.ok(p.next100k, "应有下一里程碑");
    assert.ok(p.next100k.days > 0);
  });
});

describe("getRankChanges 排名变化", () => {
  before(() => {
    // 专用数据：制造真实的排名互换
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name, name, owner, url, description, language, stars, is_custom) VALUES (?,?,?,?,?,?,?,?)");
    ins.run("swap/up", "up", "swap", "u", "", "Go", 5000, 0);
    ins.run("swap/down", "down", "swap", "d", "", "Go", 3200, 0);
    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    // 3天前：down(3500) 领先 up(3000)；今天：up(5000) 反超 down(3200)
    snap.run(idOf("swap/up"), 3000, iso(3));
    snap.run(idOf("swap/up"), 5000, iso(0));
    snap.run(idOf("swap/down"), 3500, iso(3));
    snap.run(idOf("swap/down"), 3200, iso(0));
  });

  test("识别上升与下降", () => {
    const r = getRankChanges("day", 10);
    assert.ok(r.risers.some((x) => x.full_name === "swap/up"), "up 应上榜上升");
    assert.ok(r.fallers.some((x) => x.full_name === "swap/down"), "down 应上榜下降");
  });

  test("delta 反映名次变化幅度", () => {
    const r = getRankChanges("day", 10);
    const up = r.risers.find((x) => x.full_name === "swap/up");
    assert.equal(up.delta, 1);      // 从第2升到第1
    assert.equal(up.rank, 1);
    assert.equal(up.prevRank, 2);
    assert.equal(up.growth, 2000);  // 3000 → 5000
  });
});

describe("getLanguageTrends", () => {
  before(() => seed());
  test("按语言聚合增长", () => {
    const t = getLanguageTrends("day");
    const py = t.find((x) => x.language === "Python");
    assert.ok(py);
    assert.equal(py.totalGrowth, 1000);
  });
});

describe("数据库操作", () => {
  before(() => seed());

  test("设置读写", () => {
    setSetting("minStars", 1234);
    assert.equal(getSetting("minStars"), "1234");
    assert.equal(getSetting("nope", "fb"), "fb");
  });

  test("保留天数默认 90，可覆盖", () => {
    setSetting("retentionDays", "30");
    assert.equal(getRetentionDays(), 30);
    setSetting("retentionDays", "9999");
    assert.equal(getRetentionDays(), 365); // 上限
  });

  test("收藏 toggle 与分页", () => {
    const id = db.prepare("SELECT id FROM repos LIMIT 1").get().id;
    const a = toggleFavorite(id);
    assert.equal(a.added, true);
    assert.equal(countFavorites() >= 1, true);
    const b = toggleFavorite(id);
    assert.equal(b.added, false);
  });

  test("收藏不存在的仓库被拒绝", () => {
    const r = toggleFavorite(999999);
    assert.equal(r.added, false);
    assert.ok(r.error);
  });

  test("自定义仓库增删查", () => {
    assert.equal(addCustomRepo("foo/bar", "note"), true);
    assert.ok(searchCustomRepo("foo/bar"));
    assert.equal(addCustomRepo("foo/bar"), false); // 重复
    assert.equal(countCustomRepos(), 1);
    removeCustomRepo("foo/bar");
    assert.equal(countCustomRepos(), 0);
  });

  test("告警插入与已读", () => {
    const id = db.prepare("SELECT id FROM repos LIMIT 1").get().id;
    insertAlert(id, 10, 50, 5000);
    assert.equal(getAlertsUnreadCount(), 1);
    assert.equal(hasRecentAlert(id, 2), true);
    markAlertsRead();
    assert.equal(getAlertsUnreadCount(), 0);
  });

  test("hasRecentAlert 只统计窗口内告警（ISO 时间比较）", () => {
    db.exec("DELETE FROM alerts");
    const id = db.prepare("SELECT id FROM repos LIMIT 1").get().id;
    const ins = db.prepare("INSERT INTO alerts (repo_id, threshold, growth, current_stars, triggered_at) VALUES (?,?,?,?,?)");
    ins.run(id, 10, 50, 5000, new Date(Date.now() - 3 * 3600 * 1000).toISOString());
    assert.equal(hasRecentAlert(id, 2), false, "3 小时前的告警不应算作 2 小时内");
    ins.run(id, 10, 60, 5100, new Date(Date.now() - 1 * 3600 * 1000).toISOString());
    assert.equal(hasRecentAlert(id, 2), true, "1 小时前的告警应算作 2 小时内");
  });

  test("API 配额记录", () => {
    recordApiUsage(10, 30, new Date().toISOString());
    const q = getApiQuotaInfo();
    assert.equal(q.limit, 30);
    assert.equal(q.pct, 33);
  });

  test("清理旧快照", () => {
    const removed = cleanupOldSnapshots(0);
    assert.ok(removed >= 0);
  });

  test("getRepoIdMap 批量查询", () => {
    const m = getRepoIdMap(["alpha/python-tool", "beta/rust-lib", "nope/x"]);
    assert.equal(m.size, 2);
    assert.ok(m.get("alpha/python-tool"));
  });

  test("getStats 汇总", () => {
    const s = getStats();
    assert.equal(typeof s.repoCount, "number");
    assert.equal(typeof s.favoriteCount, "number");
  });
});

after(() => {
  try { db.close(); } catch {}
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("getLeaderboard 排行榜", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name, name, owner, url, description, language, stars, is_custom) VALUES (?,?,?,?,?,?,?,?)");
    ins.run("big/slow", "slow", "big", "u", "", "Go", 900000, 0);   // 星最多但增长慢
    ins.run("small/fast", "fast", "small", "u", "", "Rust", 5000, 0); // 星少但增长快
    ins.run("mid/normal", "normal", "mid", "u", "", "C", 100000, 0);
    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    // 6 天跨度
    snap.run(idOf("big/slow"), 899000, iso(6));  snap.run(idOf("big/slow"), 900000, iso(0));   // +1000/6天
    snap.run(idOf("small/fast"), 2000, iso(6));  snap.run(idOf("small/fast"), 5000, iso(0));   // +3000/6天
    snap.run(idOf("mid/normal"), 99000, iso(6)); snap.run(idOf("mid/normal"), 100000, iso(0)); // +1000/6天
  });

  test("总星榜按星数降序", () => {
    const lb = getLeaderboard({ limit: 3, window: "day", minStars: 0 });
    assert.equal(lb.byStars[0].full_name, "big/slow");
    assert.equal(lb.byStars[1].full_name, "mid/normal");
    assert.equal(lb.byStars[2].full_name, "small/fast");
  });

  test("日均增长榜按增速降序（不受总星影响）", () => {
    const lb = getLeaderboard({ limit: 3, window: "day", minStars: 0 });
    assert.equal(lb.byGrowth[0].full_name, "small/fast", "增长最快的应是 small/fast");
    assert.ok(lb.byGrowth[0].avgDailyGrowth > lb.byGrowth[1].avgDailyGrowth);
  });

  test("日均增长值正确（+3000 / 6天 = 500/天）", () => {
    const lb = getLeaderboard({ limit: 3, window: "day", minStars: 0 });
    const f = lb.byGrowth.find((x) => x.full_name === "small/fast");
    assert.ok(Math.abs(f.avgDailyGrowth - 500) < 5, `应为 ~500，实际 ${f.avgDailyGrowth}`);
  });

  test("minStars 过滤生效", () => {
    const lb = getLeaderboard({ limit: 10, window: "day", minStars: 50000 });
    assert.ok(lb.byStars.every((r) => r.stars >= 50000));
    assert.equal(lb.byStars.find((r) => r.full_name === "small/fast"), undefined);
  });

  test("sampleDays 反映采样跨度", () => {
    const lb = getLeaderboard({ limit: 3, window: "day", minStars: 0 });
    assert.ok(Math.abs(lb.sampleDays - 6) < 0.1, `应约 6 天，实际 ${lb.sampleDays}`);
  });
});

describe("getSurges 爆发检测（P0-1）", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name, name, owner, url, language, stars, is_custom) VALUES (?,?,?,?,?,?,0)");
    ins.run("a/surging", "surging", "a", "u", "Go", 620);
    ins.run("b/steady", "steady", "b", "u", "Rust", 350);
    ins.run("c/decaying", "decaying", "c", "u", "C", 415);
    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name=?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    let v;
    v = 0; [10,10,100,200,300].forEach((d,i) => { v += d; snap.run(idOf("a/surging"), v, iso(4-i)); });
    v = 0; [50,50,50,50,50].forEach((d,i) => { v += d; snap.run(idOf("b/steady"), v, iso(4-i)); });
    v = 0; [200,150,50,10,5].forEach((d,i) => { v += d; snap.run(idOf("c/decaying"), v, iso(4-i)); });
  });

  test("识别加速项目", () => {
    const { surges } = getSurges({ limit: 10, minStars: 0 });
    assert.equal(surges.length, 1);
    assert.equal(surges[0].full_name, "a/surging");
    assert.equal(surges[0].isSurge, true);
    assert.ok(surges[0].accel > 0);
  });

  test("稳定项目不误报", () => {
    const { surges } = getSurges({ limit: 10, minStars: 0 });
    assert.equal(surges.find((s) => s.full_name === "b/steady"), undefined);
  });

  test("衰减项目进入衰减榜且 accel 为负", () => {
    const { decaying } = getSurges({ limit: 10, minStars: 0, includeDecaying: true });
    const c = decaying.find((s) => s.full_name === "c/decaying");
    assert.ok(c);
    assert.ok(c.accel < 0);
  });

  test("minStars 过滤", () => {
    // a/surging 当前 620 星，b/steady 350，c/decaying 415
    assert.equal(getSurges({ limit: 10, minStars: 600 }).surges.length, 1);  // 仅 a/surging 过筛选
    assert.equal(getSurges({ limit: 10, minStars: 700 }).surges.length, 0);  // 全部被过滤
  });
});

describe("listReposAt 历史回放（P0-2）", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name, name, owner, url, language, stars, is_custom) VALUES (?,?,?,?,?,?,0)");
    ins.run("x/one", "one", "x", "u", "Go", 2000);
    ins.run("y/two", "two", "y", "u", "Rust", 1000);
    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name=?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    // 3天前：two 领先；现在：one 反超
    snap.run(idOf("x/one"), 500, iso(3));
    snap.run(idOf("x/one"), 2000, iso(0));
    snap.run(idOf("y/two"), 1500, iso(3));
    snap.run(idOf("y/two"), 1000, iso(0));
  });

  test("重建过去时刻的排名", () => {
    const at = new Date(Date.now() - 2 * 86400000).toISOString();
    const r = listReposAt({ at, window: "day", minStars: 0, sort: "stars", limit: 10, offset: 0 });
    assert.ok(!r.error);
    // 2天前，两者都已有快照（3天前那条），排名应按当时星数
    assert.equal(r.repos[0].full_name, "y/two"); // 1500 > 500
  });

  test("返回 sinceThen（至今变化）", () => {
    const at = new Date(Date.now() - 2 * 86400000).toISOString();
    const r = listReposAt({ at, window: "day", minStars: 0, sort: "stars", limit: 10, offset: 0 });
    const one = r.repos.find((x) => x.full_name === "x/one");
    assert.equal(one.stars, 500);
    assert.equal(one.sinceThen, 1500); // 2000 - 500
  });

  test("无数据时刻返回错误", () => {
    const r = listReposAt({ at: "2000-01-01T00:00:00.000Z", window: "day", minStars: 0, sort: "stars", limit: 10, offset: 0 });
    assert.ok(r.error);
  });

  test("无效时间参数报错", () => {
    const r = listReposAt({ at: "not-a-date", window: "day", minStars: 0, sort: "stars", limit: 10, offset: 0 });
    assert.ok(r.error);
  });
});

describe("badge 徽章生成（P2）", () => {
  test("renderBadge 生成合法 SVG", async () => {
    const { renderBadge } = await import("../src/badge.js");
    const svg = renderBadge("Stars", "1.2k (+34)", "#22c55e");
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("</svg>"));
    assert.ok(svg.includes("Stars"));
    assert.ok(svg.includes("1.2k (+34)"));
    assert.ok(svg.includes("#22c55e"));
  });

  test("XML 特殊字符被转义（防注入）", async () => {
    const { renderBadge } = await import("../src/badge.js");
    const svg = renderBadge("<script>", '"><xss>');
    assert.ok(!svg.includes("<script>"));
    assert.ok(svg.includes("&lt;script&gt;"));
  });

  test("colorForGrowth 分级", async () => {
    const { colorForGrowth } = await import("../src/badge.js");
    assert.equal(colorForGrowth(null), "#8b949e");
    assert.equal(colorForGrowth(0), "#8b949e");
    assert.equal(colorForGrowth(-5), "#ef4444");
    assert.equal(colorForGrowth(3), "#58a6ff");
    assert.equal(colorForGrowth(20), "#22c55e");
    assert.equal(colorForGrowth(500), "#f59e0b");
  });

  test("compactNumber 紧凑格式", async () => {
    const { compactNumber } = await import("../src/badge.js");
    assert.equal(compactNumber(999), "999");
    assert.equal(compactNumber(1500), "1.5k");
    assert.equal(compactNumber(12000), "12k");
    assert.equal(compactNumber(2500000), "2.5M");
    assert.equal(compactNumber(null), "–");
  });

  test("getBadgeData 返回仓库指标与增长", () => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    db.prepare("INSERT INTO repos (full_name, name, owner, url, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,0)")
      .run("badge/test", "test", "badge", "u", 1500, 300, 42);
    const id = db.prepare("SELECT id FROM repos WHERE full_name=?").get("badge/test").id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,?,?,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    snap.run(id, 1000, 200, 30, iso(2));
    snap.run(id, 1500, 300, 42, iso(0));

    const d = getBadgeData("badge/test");
    assert.equal(d.stars, 1500);
    assert.equal(d.forks, 300);
    assert.equal(d.ratio, 5);
    assert.ok(d.snapshots >= 2);
  });

  test("getBadgeData 未知仓库返回 null", () => {
    assert.equal(getBadgeData("no/such-repo"), null);
  });
});

describe("外部指标 / 数据源（P3）", () => {
  test("SOURCE_LIST 含预期数据源", async () => {
    const { SOURCE_LIST } = await import("../src/sources.js");
    const keys = SOURCE_LIST.map((s) => s.key);
    for (const k of ["npm", "pypi", "dockerhub", "crates"]) {
      assert.ok(keys.includes(k), `应包含 ${k}`);
    }
    assert.ok(SOURCE_LIST.every((s) => s.label && s.placeholder));
  });

  test("未知数据源抛错", async () => {
    const { fetchSource } = await import("../src/sources.js");
    await assert.rejects(() => fetchSource("nope", "x"), /未知数据源/);
  });

  test("listExternalMetrics 计算增长与日均", async () => {
    const {
      addTrackedMetric, insertMetricSnapshot, updateTrackedMetricValue, removeTrackedMetric,
    } = await import("../src/db.js");
    const { listExternalMetrics } = await import("../src/external.js");

    db.exec("DELETE FROM metric_snapshots; DELETE FROM tracked_metrics;");
    const r = addTrackedMetric({ source: "npm", key: "left-pad", label: "left-pad", unit: "次/周" });
    assert.ok(r.ok);
    const id = r.id;
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    insertMetricSnapshot(id, 1000, iso(3));
    insertMetricSnapshot(id, 4000, iso(0));
    updateTrackedMetricValue(id, 4000, null, null, null);

    const list = listExternalMetrics("day");
    assert.equal(list.length, 1);
    assert.equal(list[0].value, 4000);
    assert.equal(list[0].growth, 3000);          // 1000 → 4000
    assert.equal(list[0].snapshots, 2);
    assert.ok(list[0].avgDailyGrowth > 0);

    removeTrackedMetric(id);
    assert.equal(listExternalMetrics("day").length, 0);
  });

  test("重复添加同一指标被拒绝", async () => {
    const { addTrackedMetric, removeTrackedMetric } = await import("../src/db.js");
    db.exec("DELETE FROM metric_snapshots; DELETE FROM tracked_metrics;");
    const a = addTrackedMetric({ source: "npm", key: "dup-test" });
    const b = addTrackedMetric({ source: "npm", key: "dup-test" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    removeTrackedMetric(a.id);
  });

  test("getExternalMetricHistory 返回序列", async () => {
    const { addTrackedMetric, insertMetricSnapshot, removeTrackedMetric } = await import("../src/db.js");
    const { getExternalMetricHistory } = await import("../src/external.js");
    db.exec("DELETE FROM metric_snapshots; DELETE FROM tracked_metrics;");
    const { id } = addTrackedMetric({ source: "pypi", key: "hist-test" });
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    insertMetricSnapshot(id, 10, iso(2));
    insertMetricSnapshot(id, 20, iso(0));
    const h = getExternalMetricHistory(id);
    assert.equal(h.history.length, 2);
    assert.equal(h.history[0].stars, 10);
    removeTrackedMetric(id);
  });
});

describe("告警规则 evaluateAlertRules（B2）", () => {
  const base = { threshold: 50, repoThresholds: {}, alertOnDrop: false, dropThreshold: 50, alertOnMilestone: false };

  test("达到全局阈值触发 growth", () => {
    const r = evaluateAlertRules({ fullName: "a/b", repoStars: 1060, baseStars: 1000, prevStars: 1000, cfg: base });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "growth");
    assert.equal(r[0].growth, 60);
  });

  test("每仓库阈值覆盖全局", () => {
    const cfg = { ...base, threshold: 500, repoThresholds: { "a/b": 10 } };
    const r = evaluateAlertRules({ fullName: "a/b", repoStars: 1060, baseStars: 1000, prevStars: 1000, cfg });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "growth");
    assert.equal(r[0].threshold, 10);
  });

  test("未达阈值不触发", () => {
    const r = evaluateAlertRules({ fullName: "a/b", repoStars: 1010, baseStars: 1000, prevStars: 1000, cfg: base });
    assert.equal(r.length, 0);
  });

  test("掉星告警", () => {
    const cfg = { ...base, threshold: 999, alertOnDrop: true, dropThreshold: 30 };
    const r = evaluateAlertRules({ fullName: "a/b", repoStars: 950, baseStars: 1000, prevStars: 1000, cfg });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "drop");
    assert.equal(r[0].growth, -50);
  });

  test("突破里程碑告警", () => {
    const cfg = { ...base, threshold: 999, alertOnMilestone: true };
    const r = evaluateAlertRules({ fullName: "a/b", repoStars: 10020, baseStars: 9990, prevStars: 9990, cfg });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "milestone");
    assert.equal(r[0].threshold, 10000);
    assert.ok(r[0].message.includes("10,000"));
  });

  test("无基线不触发", () => {
    assert.equal(evaluateAlertRules({ fullName: "a/b", repoStars: 5000, baseStars: null, prevStars: null, cfg: base }).length, 0);
  });
});

describe("告警按日均归一（采集中断不再放大）", () => {
  // 阈值是「日增星数」；基准可能是多天前的快照，拿整段跨度直接比阈值
  // 会把 N 天的增量当成一天，产生大量假告警。
  const base = { threshold: 50, repoThresholds: {}, alertOnDrop: false, dropThreshold: 50, alertOnMilestone: false };

  test("中断 7 天：存的是日均，而不是整段跨度", () => {
    // 224,009 → 232,833，历时 7.3 天（真实场景：deepseek-ai/deepseek-harness）
    const r = evaluateAlertRules({
      fullName: "a/b", repoStars: 232833, baseStars: 224009, baseDays: 7.3, prevStars: 224009, cfg: base,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "growth");
    assert.equal(r[0].growth, 1209, "应与整段跨度 8824 区分开（8824 / 7.3 天）");
    assert.ok(r[0].days > 7, "应带上真实跨度");
  });

  test("中断 7 天但日均未达阈值：不误报（修前会报）", () => {
    const cfg = { ...base, threshold: 500 };
    // 7 天涨 700：整段跨度 700 会误触发，日均 100 不应触发
    const r = evaluateAlertRules({
      fullName: "a/b", repoStars: 10700, baseStars: 10000, baseDays: 7, prevStars: 10000, cfg,
    });
    assert.equal(r.length, 0);
  });

  test("掉星同样按日均归一", () => {
    const cfg = { ...base, threshold: 999, alertOnDrop: true, dropThreshold: 30 };
    const r = evaluateAlertRules({
      fullName: "a/b", repoStars: 9650, baseStars: 10000, baseDays: 7, prevStars: 10000, cfg,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "drop");
    assert.equal(r[0].growth, -50);          // -350 / 7
  });

  test("省略 baseDays 时按 1 天处理，原有语义不变", () => {
    const r = evaluateAlertRules({ fullName: "a/b", repoStars: 1060, baseStars: 1000, prevStars: 1000, cfg: base });
    assert.equal(r[0].growth, 60);
  });

  test("里程碑不受归一影响（它基于相邻快照 prevStars）", () => {
    const cfg = { ...base, threshold: 999, alertOnMilestone: true };
    const r = evaluateAlertRules({
      fullName: "a/b", repoStars: 10020, baseStars: 9990, baseDays: 7, prevStars: 9990, cfg,
    });
    assert.equal(r.length, 1);
    assert.equal(r[0].kind, "milestone");
  });
});

describe("windowBaseline：窗口基准及其真实跨度", () => {
  const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();

  test("有跳天基准时给出真实天数（采集中断场景）", () => {
    const b = windowBaseline([{ stars: 100, captured_at: iso(7) }, { stars: 200, captured_at: iso(0) }]);
    assert.equal(b.snap.stars, 100);
    assert.ok(Math.abs(b.days - 7) < 0.05, `天数应约 7，实际 ${b.days}`);
  });

  test("约 24h 基准时天数为 1", () => {
    const b = windowBaseline([{ stars: 100, captured_at: iso(1) }, { stars: 200, captured_at: iso(0) }]);
    assert.equal(b.snap.stars, 100);
    assert.ok(b.days >= 1 && b.days < 1.05, `天数应约 1，实际 ${b.days}`);
  });

  test("没有窗口内基准时退回相邻快照，天数下限为 1（不得放大日均）", () => {
    const b = windowBaseline([{ stars: 100, captured_at: iso(0.2) }, { stars: 200, captured_at: iso(0) }]);
    assert.equal(b.snap.stars, 100);
    assert.equal(b.days, 1);
  });

  test("快照不足时返回 null", () => {
    assert.equal(windowBaseline([]), null);
    assert.equal(windowBaseline([{ stars: 1, captured_at: iso(0) }]), null);
  });
});

describe("通知渠道编码（B1）", () => {
  test("WEBHOOK_TYPES 含各渠道", async () => {
    const { WEBHOOK_TYPES } = await import("../src/notify.js");
    for (const t of ["generic", "slack", "discord", "telegram", "feishu", "dingtalk", "ntfy", "bark", "serverchan"]) {
      assert.ok(WEBHOOK_TYPES.includes(t), `应包含 ${t}`);
    }
  });

  test("各渠道 payload 结构正确", async () => {
    const { encodeMessage } = await import("../src/notify.js");
    const msg = { title: "T", text: "hello", event: "star_growth_alert", data: { repo: "a/b" } };

    const slack = encodeMessage("slack", msg);
    assert.equal(slack.contentType, "application/json");
    assert.ok(JSON.parse(slack.body).text.includes("hello"));

    assert.ok(JSON.parse(encodeMessage("feishu", msg).body).content.text.includes("hello"));
    assert.ok(JSON.parse(encodeMessage("dingtalk", msg).body).text.content.includes("hello"));
    assert.ok(JSON.parse(encodeMessage("telegram", msg).body).text.includes("hello"));
    assert.ok(JSON.parse(encodeMessage("discord", msg).body).content.includes("hello"));

    const ntfy = encodeMessage("ntfy", msg);
    assert.ok(ntfy.contentType.startsWith("text/plain"));
    assert.ok(ntfy.body.includes("hello"));

    const sc = encodeMessage("serverchan", msg);
    assert.ok(sc.contentType.startsWith("application/x-www-form-urlencoded"));
    assert.ok(decodeURIComponent(sc.body).includes("hello"));

    const generic = JSON.parse(encodeMessage("generic", msg).body);
    assert.equal(generic.event, "star_growth_alert");
    assert.equal(generic.repo, "a/b");
  });
});

describe("JSON 导出 / 导入（D1）", () => {
  test("导出→清空→导入 可完整往返，且重复导入不产生重复快照", () => {
    db.exec("DELETE FROM alerts; DELETE FROM favorites; DELETE FROM snapshots; DELETE FROM custom_repos; DELETE FROM repos;");
    db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,forks,open_issues,is_custom) VALUES (?,?,?,?,?,?,?,1)")
      .run("io/round-trip", "round-trip", "io", "u", 777, 7, 1);
    const rid = db.prepare("SELECT id FROM repos WHERE full_name = ?").get("io/round-trip").id;
    db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,?,?,?)")
      .run(rid, 700, 7, 1, "2026-01-01T00:00:00Z");
    db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,?,?,?)")
      .run(rid, 777, 7, 1, "2026-01-02T00:00:00Z");
    addCustomRepo("io/round-trip");
    toggleFavorite(rid);

    const snapshot = exportData();
    assert.equal(snapshot.snapshots.length, 2);

    // 清空后 merge 导入
    db.exec("DELETE FROM alerts; DELETE FROM favorites; DELETE FROM snapshots; DELETE FROM custom_repos; DELETE FROM repos;");
    const r = importData(snapshot, { mode: "merge" });
    assert.equal(r.counts.repos, 1);
    assert.equal(r.counts.snapshots, 2);
    assert.equal(r.counts.custom_repos, 1);
    assert.equal(r.counts.favorites, 1);

    // 重复导入应被去重
    importData(snapshot, { mode: "merge" });
    assert.equal(exportData().snapshots.length, 2);
    assert.equal(exportData().repos.length, 1);
    assert.equal(exportData().custom_repos.length, 1);
  });

  test("无效数据抛错且不破坏现有数据", () => {
    assert.throws(() => importData(null), /无效的导入数据/);
  });
});

describe("历史回填 backfill（A1）", () => {
  test("resolveBackfillScope 返回若干仓库 id", async () => {
    const { resolveBackfillScope } = await import("../src/backfill.js");
    db.exec("DELETE FROM snapshots; DELETE FROM favorites; DELETE FROM custom_repos; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES (?,?,?,?,?,0)");
    ins.run("s/a", "a", "s", "u", 100);
    ins.run("s/b", "b", "s", "u", 200);
    addCustomRepo("s/a");
    const ids = resolveBackfillScope("custom", 10);
    assert.equal(ids.length, 2);
    assert.equal(typeof ids[0], "number");
  });

  test("backfillRepo 从 stargazers 重建按天快照", async () => {
    const { backfillRepo } = await import("../src/backfill.js");
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,forks,open_issues,is_custom) VALUES (?,?,?,?,?,?,?,0)")
      .run("bf/target", "target", "bf", "u", 5, 1, 0);
    const rid = db.prepare("SELECT id FROM repos WHERE full_name = ?").get("bf/target").id;

    const realFetch = globalThis.fetch;
    const now = Date.now();
    globalThis.fetch = async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      const items = page === 1
        ? [
            { starred_at: new Date(now - 2.5 * 86400000).toISOString(), user: { login: "u1" } },
            { starred_at: new Date(now - 3.5 * 86400000).toISOString(), user: { login: "u2" } },
          ]
        : [];
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json", etag: `"bf-p${page}"` },
      });
    };

    try {
      const r = await backfillRepo({ id: rid, token: undefined, days: 30, maxPages: 3 });
      assert.ok(!r.error, JSON.stringify(r));
      assert.equal(r.inserted, 2, "应写入 2 个按天历史点");
      const snaps = db.prepare("SELECT stars, captured_at FROM snapshots WHERE repo_id = ? ORDER BY captured_at ASC").all(rid);
      assert.equal(snaps.length, 2);
      assert.equal(snaps[0].stars, 4); // 当前 5 星，第 2 个 stargazer → 4
      assert.ok(snaps[0].captured_at.endsWith("T23:59:59Z"));

      // 再次回填不应重复插入
      const r2 = await backfillRepo({ id: rid, token: undefined, days: 30, maxPages: 3 });
      assert.equal(r2.inserted, 0);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshots WHERE repo_id = ?").get(rid).c, 2);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("backfillRepo 对未知仓库返回错误", async () => {
    const { backfillRepo } = await import("../src/backfill.js");
    const r = await backfillRepo({ id: 999999, token: undefined });
    assert.ok(r.error);
  });
});

describe("分析视图（C 组）", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name,name,owner,url,description,language,stars,is_custom) VALUES (?,?,?,?,?,?,?,0)");
    ins.run("cmp/a", "a", "cmp", "u", "A fast web framework in rust", "Rust", 5000);
    ins.run("cmp/b", "b", "cmp", "u", "Another fast web framework in rust", "Rust", 3000);
    ins.run("cmp/c", "c", "cmp", "u", "A python data library", "Python", 2000);
    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,?,?,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    snap.run(idOf("cmp/a"), 4000, 0, 0, iso(3));
    snap.run(idOf("cmp/a"), 5000, 0, 0, iso(0));
    snap.run(idOf("cmp/b"), 3000, 0, 0, iso(3));
    snap.run(idOf("cmp/b"), 3000, 0, 0, iso(0));
    snap.run(idOf("cmp/c"), 2000, 0, 0, iso(0));
  });

  test("compareRepos 返回序列与百分比变化", () => {
    const ids = db.prepare("SELECT id FROM repos ORDER BY full_name").all().map((r) => r.id);
    const r = compareRepos({ ids, window: "day", metric: "stars" });
    assert.equal(r.repos.length, 3);
    assert.ok(r.dates.length >= 2);
    const a = r.repos.find((x) => x.full_name === "cmp/a");
    assert.equal(a.change, 1000);
    assert.equal(a.changePct, 25); // 4000 → 5000
    assert.ok(a.series.some((p) => p.pct === 25));
  });

  test("compareRepos 忽略不存在的 id", () => {
    const r = compareRepos({ ids: [999999], window: "day", metric: "stars" });
    assert.equal(r.repos.length, 0);
  });

  test("getOverview 返回活动与健康度", () => {
    const o = getOverview({ days: 60 });
    assert.equal(o.health.totalRepos, 3);
    assert.ok(Array.isArray(o.totalStars) && o.totalStars.length >= 1);
    assert.ok(o.snapshotActivity.length >= 1);
    assert.ok(o.discoveries.length >= 1);
    assert.equal(typeof o.health.coveragePct, "number");
  });

  test("findSimilarRepos 优先同语言", () => {
    const id = db.prepare("SELECT id FROM repos WHERE full_name = ?").get("cmp/a").id;
    const r = findSimilarRepos(id, { limit: 5 });
    assert.equal(r.repo, "cmp/a");
    assert.ok(r.similar.length >= 1);
    assert.equal(r.similar[0].full_name, "cmp/b"); // 同语言且描述相近
    assert.ok(r.similar.every((x) => x.id !== id));
  });

  test("findSimilarRepos 未知仓库返回 null", () => {
    assert.equal(findSimilarRepos(999999), null);
  });

  test("保存视图 CRUD（C5）", async () => {
    const { getSavedViews, saveView, deleteView } = await import("../src/db.js");
    db.exec("DELETE FROM settings WHERE key = 'savedViews'");
    assert.deepEqual(getSavedViews(), []);

    let views = saveView({ name: "Rust 高增长", filters: { language: "Rust", sort: "growth" } });
    assert.equal(views.length, 1);
    assert.equal(views[0].name, "Rust 高增长");

    // 同名覆盖而非重复
    views = saveView({ name: "Rust 高增长", filters: { language: "Rust", sort: "stars" } });
    assert.equal(views.length, 1);
    assert.equal(views[0].filters.sort, "stars");

    views = deleteView("Rust 高增长");
    assert.deepEqual(views, []);

    assert.throws(() => saveView({ name: "", filters: {} }), /名称不能为空/);
    assert.throws(() => saveView({ name: "x" }), /缺少筛选条件/);
  });
});

describe("GitHub 仓库路径构造（回归：%2F → 404）", () => {
  test("owner/repo 的斜杠不应被编码", async () => {
    const { fetchCustomRepo, fetchStargazers } = await import("../src/github.js");
    const seen = [];
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      seen.push(String(url));
      if (String(url).includes("/stargazers")) {
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({
        full_name: "owner/repo", name: "repo", owner: { login: "owner" }, html_url: "u",
        stargazers_count: 1, forks_count: 0, open_issues_count: 0, created_at: "2020-01-01T00:00:00Z",
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      await fetchCustomRepo("owner/repo");
      await fetchStargazers("owner/repo");
    } finally {
      globalThis.fetch = real;
    }
    assert.ok(seen.length >= 2, seen.join("\n"));
    assert.ok(seen.every((u) => !u.includes("%2F")), "URL 不应包含 %2F:\n" + seen.join("\n"));
    assert.ok(seen.some((u) => u.includes("/repos/owner/repo/stargazers")));
    assert.ok(seen.some((u) => u.endsWith("/repos/owner/repo")));
  });
});

describe("信号层：异常检测 / 黑马榜 / 迷你走势图", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name,name,owner,url,description,language,stars,gh_created_at,is_custom) VALUES (?,?,?,?,?,?,?,?,0)");
    const old = new Date(Date.now() - 400 * 86400000).toISOString();
    ins.run("sig/spike", "spike", "sig", "u", "", "Go", 1000, old);
    ins.run("sig/steady", "steady", "sig", "u", "", "Rust", 5000, old);
    ins.run("sig/young", "young", "sig", "u", "", "Zig", 500, new Date(Date.now() - 20 * 86400000).toISOString());

    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,0,0,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();

    // sig/spike：稳定 +10/天 后突然 +300
    let v = 0;
    [10, 12, 8, 11, 9, 10, 300].forEach((d, i) => { v += d; snap.run(idOf("sig/spike"), v, iso(6 - i)); });
    // sig/steady：一直 +50/天
    v = 0;
    [50, 50, 50, 50, 50, 50, 50].forEach((d, i) => { v += d; snap.run(idOf("sig/steady"), v, iso(6 - i)); });
    // sig/young：+30/天（低星高百分比）
    v = 300;
    [30, 30, 30, 30, 30, 30, 30].forEach((d, i) => { snap.run(idOf("sig/young"), v + i * 30, iso(6 - i)); });
  });

  test("getAnomalies 抓到突增且给出样本量", () => {
    const r = getAnomalies({ days: 30, z: 2, minSamples: 5 });
    const hit = r.spikes.find((x) => x.full_name === "sig/spike");
    assert.ok(hit, "应抓到 sig/spike 突增");
    assert.ok(hit.z > 5);
    assert.equal(hit.direction, "spike");
    assert.ok(hit.samples >= 5);
    assert.ok(hit.sd > 0);
    assert.equal(r.spikes.find((x) => x.full_name === "sig/steady"), undefined, "稳定项目不应误报");
  });

  test("getAnomalies 高阈值下无结果", () => {
    const r = getAnomalies({ days: 30, z: 999 });
    assert.equal(r.spikes.length, 0);
    assert.equal(r.drops.length, 0);
  });

  test("getAnomalies 样本不足时不误报", () => {
    // 只有极少快照的仓库不应出现
    db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES (?,?,?,?,?,0)").run("sig/new", "new", "sig", "u", 10);
    const id = db.prepare("SELECT id FROM repos WHERE full_name='sig/new'").get().id;
    db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,0,0,?)").run(id, 10, new Date().toISOString());
    const r = getAnomalies({ days: 30, z: 1, minSamples: 5 });
    assert.equal(r.spikes.find((x) => x.full_name === "sig/new"), undefined);
  });

  test("getRisingStars 按日增百分比排序并受 maxStars 限制", () => {
    const r = getRisingStars({ limit: 10, maxStars: 2000, minDays: 14, minStars: 100 });
    const names = r.rising.map((x) => x.full_name);
    assert.ok(names.includes("sig/spike"));
    assert.ok(names.includes("sig/young"));
    assert.ok(!names.includes("sig/steady"), "5000 星超过 maxStars，应被排除");
    const young = r.rising.find((x) => x.full_name === "sig/young");
    assert.ok(young.pctPerDay > 0);
    assert.ok(young.ageDays >= 14);
  });

  test("getRisingStars 未指定上限时自动取中位数", () => {
    const r = getRisingStars({ limit: 10, minDays: 0, minStars: 0 });
    assert.ok(r.maxStars > 0, `应给出自动上限，实际 ${r.maxStars}`);
    assert.ok(r.rising.every((x) => x.stars <= r.maxStars));
  });

  test("getSparkData 返回升序序列", () => {
    const d = getSparkData("sig/spike", 10);
    assert.equal(d.full_name, "sig/spike");
    assert.ok(d.values.length >= 2);
    for (let i = 1; i < d.values.length; i++) assert.ok(d.values[i] >= d.values[i - 1]);
    assert.equal(getSparkData("no/such", 10), null);
  });

  test("predictGrowth 返回 R²", () => {
    const snaps = [];
    for (let i = 0; i < 5; i++) {
      snaps.push({ stars: 1000 + i * 100, captured_at: new Date(Date.now() - (4 - i) * 86400000).toISOString() });
    }
    const p = predictGrowth(snaps);
    assert.ok(p);
    assert.ok(p.r2 > 0.99, `完美线性应 R²≈1，实际 ${p.r2}`);
    assert.equal(p.samples, 5);
  });

  test("compareRepos 给出交叉预测", () => {
    // spike: 1000→? 递增；steady: 5000 平坦 —— spike 终将超过 steady
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    const ins = db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES (?,?,?,?,?,0)");
    ins.run("x/low", "low", "x", "u", 1000);
    ins.run("y/high", "high", "y", "u", 5000);
    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,0,0,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    [0, 1, 2, 3].forEach((i) => {
      snap.run(idOf("x/low"), 1000 + i * 500, iso(3 - i));   // +500/天
      snap.run(idOf("y/high"), 5000, iso(3 - i));            // 持平
    });
    const r = compareRepos({ ids: [idOf("x/low"), idOf("y/high")], window: "day" });
    assert.ok(r.crossings.length >= 1, "应给出交叉预测");
    const c = r.crossings[0];
    assert.equal(c.from, "x/low");
    assert.equal(c.to, "y/high");
    assert.ok(c.days > 0);
  });
});

describe("徽章与订阅渲染", () => {
  test("renderSparkline 生成合法 SVG，数据不足时降级", async () => {
    const { renderSparkline } = await import("../src/badge.js");
    const svg = renderSparkline([1, 3, 2, 5, 4, 8]);
    assert.ok(svg.startsWith("<svg"));
    assert.ok(svg.includes("</svg>"));
    assert.ok(svg.includes("polyline"));
    assert.ok(!svg.includes("undefined"));
    const empty = renderSparkline([5]);
    assert.ok(empty.includes("no data"));
  });

  test("shieldsPayload 符合 shields endpoint schema", async () => {
    const { shieldsPayload } = await import("../src/badge.js");
    const p = shieldsPayload("Stars", "547k (+222)", "#22c55e");
    assert.equal(p.schemaVersion, 1);
    assert.equal(p.label, "Stars");
    assert.equal(p.message, "547k (+222)");
    assert.equal(p.color, "#22c55e");
  });
});

describe("事件聚类与告警回测（第二批）", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos;");
    db.exec("DELETE FROM settings WHERE key = 'repoThresholds'");
    const ins = db.prepare("INSERT INTO repos (full_name,name,owner,url,description,language,stars,is_custom) VALUES (?,?,?,?,?,?,?,0)");
    for (const [n, d] of [
      ["ev/one", "machine learning agent framework one"],
      ["ev/two", "machine learning agent framework two"],
      ["ev/three", "machine learning agent framework three"],
    ]) ins.run(n, n.split("/")[1], "ev", "u", d, "Python", 1250);
    ins.run("ev/steady", "steady", "ev", "u", "unrelated database tool", "Go", 1060);
    ins.run("ev/milestone", "milestone", "ev", "u", "crossing milestone repo", "Rust", 10100);
    ins.run("ev/down", "down", "ev", "u", "a declining project", "C", 1000);

    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,0,0,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    const base = [8, 12, 9, 11, 10];

    for (const n of ["ev/one", "ev/two", "ev/three"]) {
      let v = 1000;
      base.forEach((d, i) => { v += d; snap.run(idOf(n), v, iso(6 - i)); });
      snap.run(idOf(n), v + 200, iso(0));                       // 同日突增
    }
    { let v = 1000; base.forEach((d, i) => { v += d; snap.run(idOf("ev/steady"), v, iso(6 - i)); }); snap.run(idOf("ev/steady"), v + 10, iso(0)); }
    { let v = 9750; base.forEach((d, i) => { v += d * 3; snap.run(idOf("ev/milestone"), v, iso(6 - i)); }); snap.run(idOf("ev/milestone"), 10100, iso(0)); }
    { let v = 1000; base.forEach((d, i) => { v += d; snap.run(idOf("ev/down"), v, iso(6 - i)); }); snap.run(idOf("ev/down"), v - 50, iso(0)); }
  });

  test("getEvents 把同日多个异常归为一个事件并自动命名", () => {
    const r = getEvents({ days: 30, z: 1.5, minRepos: 3, minSamples: 3 });
    assert.ok(r.events.length >= 1, "应至少识别出一个事件");
    const e = r.events[0];
    assert.equal(e.count >= 3, true);
    assert.ok(e.totalDelta > 0);
    assert.equal(e.dominantLanguage, "Python");
    assert.ok(e.terms.includes("machine") || e.terms.includes("learning") || e.terms.includes("agent"), `共同词应在 ${JSON.stringify(e.terms)} 中`);
    const names = e.repos.map((x) => x.full_name);
    assert.ok(names.includes("ev/one") && names.includes("ev/two") && names.includes("ev/three"));
  });

  test("getEvents 提高 minRepos 后不再成组", () => {
    const r = getEvents({ days: 30, z: 1.5, minRepos: 10, minSamples: 3 });
    assert.equal(r.events.length, 0);
  });

  test("backtestAlerts 统计增长告警并给出 Top 仓库", () => {
    const r = backtestAlerts({ days: 30, threshold: 100, alertOnDrop: false, alertOnMilestone: false });
    assert.ok(r.summary.byKind.growth >= 3, `应有 ≥3 次增长告警，实际 ${r.summary.byKind.growth}`);
    assert.ok(r.summary.repos >= 3);
    assert.ok(r.topRepos.some((x) => x.full_name === "ev/one"));
    assert.ok(r.summary.avgSampleDays > 0);
  });

  test("backtestAlerts 里程碑与掉星规则生效", () => {
    const ms = backtestAlerts({ days: 30, threshold: 100000, alertOnDrop: false, alertOnMilestone: true });
    assert.equal(ms.summary.byKind.milestone, 1);
    assert.equal(ms.fired.find((f) => f.kind === "milestone").full_name, "ev/milestone");

    const dp = backtestAlerts({ days: 30, threshold: 100000, alertOnDrop: true, dropThreshold: 20, alertOnMilestone: false });
    assert.ok(dp.summary.byKind.drop >= 1);
    assert.ok(dp.fired.some((f) => f.kind === "drop" && f.full_name === "ev/down"));
  });

  test("backtestAlerts 支持每仓库阈值覆盖", () => {
    setSetting("repoThresholds", JSON.stringify({ "ev/steady": 5 }));
    const r = backtestAlerts({ days: 30, threshold: 100000, alertOnDrop: false, alertOnMilestone: false });
    assert.ok(r.fired.some((f) => f.full_name === "ev/steady"), "覆盖阈值后 ev/steady 应触发");
    db.exec("DELETE FROM settings WHERE key = 'repoThresholds'");
  });
});

describe("泛化追踪对象：指数与生态（第三批）", () => {
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos; DELETE FROM query_members; DELETE FROM tracked_queries; DELETE FROM indices;");
    const ins = db.prepare("INSERT INTO repos (full_name,name,owner,url,description,language,stars,is_custom) VALUES (?,?,?,?,?,?,?,0)");
    ins.run("ix/a", "a", "ix", "u", "rust web framework", "Rust", 3000);
    ins.run("ix/b", "b", "ix", "u", "rust cli tool", "Rust", 2000);
    ins.run("ix/c", "c", "ix", "u", "python data lib", "Python", 1000);
    ins.run("ix/small", "small", "ix", "u", "rust tiny", "Rust", 50);

    const idOf = (n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, forks, open_issues, captured_at) VALUES (?,?,0,0,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    // a: +100/天；b: +50/天；c: +10/天
    [3000 - 300, 3000 - 200, 3000 - 100, 3000].forEach((v, i) => snap.run(idOf("ix/a"), v, iso(3 - i)));
    [2000 - 150, 2000 - 100, 2000 - 50, 2000].forEach((v, i) => snap.run(idOf("ix/b"), v, iso(3 - i)));
    [1000 - 30, 1000 - 20, 1000 - 10, 1000].forEach((v, i) => snap.run(idOf("ix/c"), v, iso(3 - i)));
  });

  test("resolveIndexMembers 按语言/星数筛选", () => {
    const rust = resolveIndexMembers({ language: "Rust", minStars: 1000 });
    assert.deepEqual(rust.map((r) => r.full_name).sort(), ["ix/a", "ix/b"]);
    const all = resolveIndexMembers({ minStars: 1000 });
    assert.equal(all.length, 3);
    const kw = resolveIndexMembers({ keyword: "framework" });
    assert.deepEqual(kw.map((r) => r.full_name), ["ix/a"]);
    const capped = resolveIndexMembers({ maxStars: 100 });
    assert.deepEqual(capped.map((r) => r.full_name), ["ix/small"]);
  });

  test("指数 CRUD 与曲线", () => {
    const r = addIndex("Rust 指数", { language: "Rust", minStars: 1000 });
    assert.equal(r.ok, true);
    assert.equal(listIndices().length, 1);
    assert.equal(getIndex(r.id).name, "Rust 指数");

    const s = getIndexSeries(r.id, { days: 30, weight: "equal" });
    assert.equal(s.memberCount, 2);
    assert.equal(s.dates.length, 4);
    assert.equal(s.index[0], 100);                     // 等权归一化起点
    assert.ok(s.index[s.index.length - 1] > 100);
    assert.ok(s.changePct > 0);
    assert.equal(s.members[0].full_name, "ix/a");      // 按当前星数排序
    assert.ok(s.members[0].sharePct > s.members[1].sharePct);

    const cap = getIndexSeries(r.id, { days: 30, weight: "cap" });
    assert.equal(cap.index[0], 100);
    assert.notEqual(cap.index, s.index);

    assert.equal(removeIndex(r.id), 1);
    assert.equal(getIndexSeries(r.id), null);
    assert.equal(removeIndex(r.id), 0);
  });

  test("指数重名被拒绝", () => {
    const a = addIndex("dup-index", {});
    const b = addIndex("dup-index", {});
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    removeIndex(a.id);
  });

  test("指数空成员时曲线安全返回", () => {
    const r = addIndex("空指数", { language: "COBOL" });
    const s = getIndexSeries(r.id, { days: 30 });
    assert.equal(s.memberCount, 0);
    assert.deepEqual(s.dates, []);
    assert.equal(s.changePct, null);
    removeIndex(r.id);
  });

  test("追踪查询 CRUD 与成员替换", () => {
    const q = addTrackedQuery("Rust 生态", "language:rust stars:>1000");
    assert.equal(q.ok, true);
    assert.throws(() => addTrackedQuery("", "x"), /名称不能为空/);
    assert.throws(() => addTrackedQuery("x", ""), /搜索语法不能为空/);
    assert.equal(addTrackedQuery("Rust 生态", "y").ok, false);

    const ids = ["ix/a", "ix/b"].map((n) => db.prepare("SELECT id FROM repos WHERE full_name = ?").get(n).id);
    replaceQueryMembers(q.id, ids, new Date().toISOString());
    assert.equal(getQueryMemberIds(q.id).length, 2);
    assert.equal(getTrackedQuery(q.id).member_count, 2);

    const agg = getQueryAggregate(q.id, { days: 30 });
    assert.equal(agg.label, "Rust 生态");
    assert.equal(agg.memberCount, 2);
    assert.equal(agg.dates.length, 4);
    assert.equal(getQueryAggregate(999999), null);

    // 再次替换为子集，成员应整体覆盖而非累加
    replaceQueryMembers(q.id, [ids[0]], new Date().toISOString());
    assert.equal(getQueryMemberIds(q.id).length, 1);

    assert.equal(removeTrackedQuery(q.id), 1);
    assert.equal(getTrackedQuery(q.id), undefined);
  });

  test("refreshTrackedQueries 抓取并写成员（stub 网络）", async () => {
    db.exec("DELETE FROM query_members; DELETE FROM tracked_queries;");
    const q = addTrackedQuery("Stub 生态", "language:stub");
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (String(url).includes("/search/repositories")) {
        return new Response(JSON.stringify({
          items: [
            { full_name: "q/one", name: "one", owner: { login: "q" }, html_url: "u", description: "d", language: "Stub", homepage: null, stargazers_count: 12000, forks_count: 1, open_issues_count: 0, created_at: "2020-01-01T00:00:00Z" },
            { full_name: "q/two", name: "two", owner: { login: "q" }, html_url: "u", description: "d", language: "Stub", homepage: null, stargazers_count: 8000, forks_count: 1, open_issues_count: 0, created_at: "2020-01-01T00:00:00Z" },
          ],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    };
    try {
      const r = await refreshTrackedQueries({ token: undefined, perQuery: 50 });
      assert.equal(r.queries, 1);
      assert.equal(r.updated, 1);
      assert.equal(r.members, 2);
      assert.equal(getQueryMemberIds(q.id).length, 2);
      assert.ok(db.prepare("SELECT id FROM repos WHERE full_name = 'q/one'").get());
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("运维健壮性：仓库健康 / rollup / 刷新频率（第四批）", () => {
  describe("重命名与删除检测", () => {
    before(() => {
      db.exec("DELETE FROM snapshots; DELETE FROM favorites; DELETE FROM alerts; DELETE FROM query_members; DELETE FROM custom_repos; DELETE FROM repos;");
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,forks,open_issues,is_custom) VALUES ('old/name','name','old','u',100,1,0,1)").run();
      const id = db.prepare("SELECT id FROM repos WHERE full_name='old/name'").get().id;
      db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,?,?,?)").run(id, 90, 1, 0, new Date(Date.now() - 2 * 86400000).toISOString());
      db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,?,?,?)").run(id, 100, 1, 0, new Date().toISOString());
      addCustomRepo("old/name");
      toggleFavorite(id);
    });

    test("renameRepo 迁移历史、收藏与自定义追踪", () => {
      const r = renameRepo("old/name", "new/name");
      assert.equal(r.renamed, true);
      assert.equal(r.merged, false);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM repos WHERE full_name='old/name'").get().c, 0);
      const row = db.prepare("SELECT id FROM repos WHERE full_name='new/name'").get();
      assert.ok(row);
      assert.ok(searchCustomRepo("new/name"));
      assert.equal(searchCustomRepo("old/name"), undefined);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshots WHERE repo_id=?").get(row.id).c, 2);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM favorites WHERE repo_id=?").get(row.id).c, 1);
    });

    test("新旧记录并存时合并快照", () => {
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('dup/old','old','dup','u',10,0)").run();
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('dup/new','new','dup','u',20,0)").run();
      const o = db.prepare("SELECT id FROM repos WHERE full_name='dup/old'").get().id;
      const n = db.prepare("SELECT id FROM repos WHERE full_name='dup/new'").get().id;
      db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,0,0,?)").run(o, 10, new Date().toISOString());

      const r = renameRepo("dup/old", "dup/new");
      assert.equal(r.merged, true);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM repos WHERE full_name='dup/old'").get().c, 0);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshots WHERE repo_id=?").get(n).c, 1);
    });

    test("stale 标记、清除与统计", () => {
      markRepoStale("new/name", "404 Not Found");
      assert.equal(getStats().staleCount, 1);
      const custom = listCustomRepos();
      assert.equal(custom.length, 1);
      assert.equal(custom[0].stale, true);
      assert.equal(custom[0].last_error, "404 Not Found");

      clearRepoStale("new/name");
      assert.equal(getStats().staleCount, 0);
      assert.equal(listCustomRepos()[0].stale, false);
    });

    test("refreshCustomRepos 区分 404 与改名（stub 网络）", async () => {
      db.exec("DELETE FROM snapshots; DELETE FROM custom_repos; DELETE FROM repos;");
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('old/name','name','old','u',100,1)").run();
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('gone/one','one','gone','u',50,1)").run();
      addCustomRepo("old/name");
      addCustomRepo("gone/one");

      const real = globalThis.fetch;
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes("/repos/gone/one")) {
          return new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
        }
        if (u.includes("/repos/old/name")) {
          // 模拟 GitHub 改名后的 301 跟随结果：full_name 已变
          return new Response(JSON.stringify({
            full_name: "new/name", name: "name", owner: { login: "new" }, html_url: "u",
            description: "d", language: "Go", homepage: null,
            stargazers_count: 150, forks_count: 1, open_issues_count: 0, created_at: "2020-01-01T00:00:00Z",
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        const r = await refreshCustomRepos({ token: undefined });
        assert.equal(r.renamed, 1);
        assert.equal(r.stale, 1);
        assert.equal(r.upserted, 1);
        assert.ok(db.prepare("SELECT id FROM repos WHERE full_name='new/name'").get());
        const gone = db.prepare("SELECT stale, last_error FROM repos WHERE full_name='gone/one'").get();
        assert.equal(gone.stale, 1);
        assert.match(gone.last_error, /404/);
      } finally {
        globalThis.fetch = real;
      }
    });
  });

  describe("快照 rollup", () => {
    test("老快照按周压缩，近期逐日保留", () => {
      db.exec("DELETE FROM snapshots; DELETE FROM repos;");
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('roll/one','one','roll','u',100,0)").run();
      const id = db.prepare("SELECT id FROM repos WHERE full_name='roll/one'").get().id;
      const ins = db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,0,0,?)");
      const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
      // 60 天前同一天内的 3 条旧快照（保证同一 ISO 周）
      [100, 101, 102].forEach((v, i) => ins.run(id, v, new Date(Date.now() - 60 * 86400000 + i * 3600000).toISOString()));
      // 最近 3 天 —— 应全部保留
      [103, 104, 105].forEach((v, i) => ins.run(id, v, iso(2 - i)));

      const r = rollupOldSnapshots(30);
      assert.equal(r.scanned, 3);
      assert.equal(r.removed, 2);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshots WHERE repo_id=?").get(id).c, 4);
      // 保留的是该周最新的一条
      assert.equal(db.prepare("SELECT stars FROM snapshots WHERE repo_id=? ORDER BY captured_at ASC LIMIT 1").get(id).stars, 102);
    });

    test("无旧快照时不误删", () => {
      db.exec("DELETE FROM snapshots; DELETE FROM repos;");
      db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('roll/two','two','roll','u',1,0)").run();
      const id = db.prepare("SELECT id FROM repos WHERE full_name='roll/two'").get().id;
      db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,0,0,?)").run(id, 1, new Date().toISOString());
      const r = rollupOldSnapshots(30);
      assert.equal(r.removed, 0);
      assert.equal(db.prepare("SELECT COUNT(*) c FROM snapshots").get().c, 1);
    });
  });

  describe("外部指标刷新频率", () => {
    test("间隔内跳过，force 绕过，可按时长覆盖", async () => {
      const { refreshExternalMetrics } = await import("../src/external.js");
      const { addTrackedMetric, removeTrackedMetric } = await import("../src/db.js");
      db.exec("DELETE FROM metric_snapshots; DELETE FROM tracked_metrics;");
      db.exec("DELETE FROM settings WHERE key IN ('sourceIntervals','externalIntervalHours')");

      const r = addTrackedMetric({ source: "npm", key: "freq-test" });
      let calls = 0;
      const real = globalThis.fetch;
      globalThis.fetch = async () => {
        calls++;
        return new Response(JSON.stringify({ downloads: 123 }), { status: 200, headers: { "content-type": "application/json" } });
      };
      try {
        // 刚写入 updated_at=now → 默认 24h 内应跳过
        const skipped = await refreshExternalMetrics();
        assert.equal(skipped.skipped, 1);
        assert.equal(skipped.fetched, 0);
        assert.equal(calls, 0);

        // force 绕过
        const forced = await refreshExternalMetrics({ force: true });
        assert.equal(forced.fetched, 1);
        assert.equal(calls, 1);

        // 按源覆盖为 0 小时 → 不再跳过
        setSetting("sourceIntervals", JSON.stringify({ npm: 0 }));
        const again = await refreshExternalMetrics();
        assert.equal(again.fetched, 1);
      } finally {
        globalThis.fetch = real;
        removeTrackedMetric(r.id);
        db.exec("DELETE FROM settings WHERE key = 'sourceIntervals'");
      }
    });
  });
});

describe("UX：时间线事件（第五批）", () => {
  test("getRepoHistory 返回里程碑与告警事件", () => {
    db.exec("DELETE FROM snapshots; DELETE FROM alerts; DELETE FROM repos;");
    db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('tl/one','one','tl','u',1600,0)").run();
    const id = db.prepare("SELECT id FROM repos WHERE full_name='tl/one'").get().id;
    const snap = db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,0,0,?)");
    const iso = (d) => new Date(Date.now() - d * 86400000).toISOString();
    snap.run(id, 900, iso(3));
    snap.run(id, 1600, iso(2));   // 跨过 1000
    snap.run(id, 2200, iso(1));
    snap.run(id, 5200, iso(0));   // 跨过 5000

    insertAlert(id, 50, 120, 1600, { kind: "growth" });
    insertAlert(id, 1000, 3000, 5200, { kind: "milestone", message: "突破 5,000 星" });

    const h = getRepoHistory(id, "stars");
    assert.ok(Array.isArray(h.events));
    const milestones = h.events.filter((e) => e.type === "milestone");
    assert.ok(milestones.some((m) => m.label.includes("1k")), JSON.stringify(h.events));
    assert.ok(milestones.some((m) => m.message.includes("5,000")));
    const growth = h.events.filter((e) => e.type === "growth");
    assert.equal(growth.length, 1);
    assert.equal(growth[0].label, "+120");
    // 事件按时间升序
    for (let i = 1; i < h.events.length; i++) assert.ok(h.events[i].date >= h.events[i - 1].date);
  });

  test("无事件时返回空数组", () => {
    db.exec("DELETE FROM snapshots; DELETE FROM alerts; DELETE FROM repos;");
    db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES ('tl/two','two','tl','u',10,0)").run();
    const id = db.prepare("SELECT id FROM repos WHERE full_name='tl/two'").get().id;
    db.prepare("INSERT INTO snapshots (repo_id,stars,forks,open_issues,captured_at) VALUES (?,?,0,0,?)").run(id, 10, new Date().toISOString());
    assert.deepEqual(getRepoHistory(id, "stars").events, []);
  });
});

describe("Web Push：VAPID 与 RFC 8291 加密（第六批）", () => {
  const makeClient = () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const auth = crypto.randomBytes(16);
    return { ecdh, auth, sub: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } };
  };

  const decrypt = (body, client) => {
    const salt = body.subarray(0, 16);
    const idlen = body[20];
    const serverPub = body.subarray(21, 21 + idlen);
    const header = body.subarray(0, 21 + idlen);
    const ct = body.subarray(21 + idlen);
    const shared = client.ecdh.computeSecret(serverPub);
    const authInfo = Buffer.concat([Buffer.from("WebPush: info\0"), client.ecdh.getPublicKey(), serverPub]);
    const ikm = Buffer.from(crypto.hkdfSync("sha256", shared, client.auth, authInfo, 32));
    const cek = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
    const nonce = Buffer.from(crypto.hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
    const dec = crypto.createDecipheriv("aes-128-gcm", cek, nonce);
    dec.setAAD(header);
    dec.setAuthTag(ct.subarray(ct.length - 16));
    const pt = Buffer.concat([dec.update(ct.subarray(0, ct.length - 16)), dec.final()]);
    return pt.subarray(0, pt.length - 1).toString();   // 去掉最后记录分隔符 0x02
  };

  test("加密结果可被客户端私钥解密（aes128gcm 往返）", async () => {
    const wp = await import("../src/webpush.js");
    const client = makeClient();
    const message = { title: "⭐ 告警", body: "octocat/Hello-World +42 星", url: "/" };
    const body = wp.encryptPayload(client.sub, Buffer.from(JSON.stringify(message)));
    assert.ok(body.length > 100);
    assert.equal(decrypt(body, client), JSON.stringify(message));
  });

  test("aes128gcm 头部结构正确", async () => {
    const wp = await import("../src/webpush.js");
    const client = makeClient();
    const body = wp.encryptPayload(client.sub, Buffer.from("x"));
    assert.equal(body[20], 65);                          // keyid 长度 = 未压缩点长度
    assert.equal(body[21], 4);                            // 未压缩点前缀 0x04
    const rs = body.readUInt32BE(16);
    assert.ok(rs >= 18);                                  // 记录大小合法
  });

  test("VAPID JWT 可被公钥验证且 aud/sub 正确", async () => {
    const wp = await import("../src/webpush.js");
    const { publicKey } = wp.getVapidKeys();
    const endpoint = "https://fcm.googleapis.com/fcm/send/abc";
    const auth = wp.vapidAuthHeader(endpoint, "mailto:me@example.com");
    const m = auth.match(/^vapid t=([^,]+), k=(.+)$/);
    assert.ok(m);
    assert.equal(m[2], publicKey);
    const [h, p, s] = m[1].split(".");
    const raw = Buffer.from(publicKey, "base64url");
    const pub = crypto.createPublicKey({
      format: "jwk",
      key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33, 65).toString("base64url") },
    });
    const ok = crypto.verify("sha256", Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url"));
    assert.equal(ok, true);
    const payload = JSON.parse(Buffer.from(p, "base64url").toString());
    assert.equal(payload.aud, "https://fcm.googleapis.com");
    assert.equal(payload.sub, "mailto:me@example.com");
    assert.ok(payload.exp > Math.floor(Date.now() / 1000));
  });

  test("VAPID 密钥持久化且稳定", async () => {
    const wp = await import("../src/webpush.js");
    const first = wp.getVapidKeys().publicKey;
    assert.equal(wp.getVapidKeys().publicKey, first);
    const { getSetting } = await import("../src/db.js");
    assert.equal(getSetting("vapidPublicKey"), first);
    const k = wp.generateVapidKeys();
    assert.notEqual(k.publicKey, first);
    assert.equal(Buffer.from(k.publicKey, "base64url").length, 65);
  });

  test("非法订阅参数被拒绝", async () => {
    const wp = await import("../src/webpush.js");
    assert.throws(() => wp.subscribePush({}), /缺少/);
    assert.throws(() => wp.subscribePush({ endpoint: "https://x/y", p256dh: "@@", auth: "!!" }), /65 字节/);
  });

  test("订阅 CRUD 与发送状态处理", async () => {
    const wp = await import("../src/webpush.js");
    const dbm = await import("../src/db.js");
    db.exec("DELETE FROM push_subscriptions");
    const c1 = makeClient(), c2 = makeClient();
    wp.subscribePush({ endpoint: "https://push.example/1", p256dh: c1.sub.p256dh, auth: c1.sub.auth, userAgent: "test" });
    wp.subscribePush({ endpoint: "https://push.example/2", p256dh: c2.sub.p256dh, auth: c2.sub.auth });
    // 重复订阅应更新而非新增
    wp.subscribePush({ endpoint: "https://push.example/2", p256dh: c2.sub.p256dh, auth: c2.sub.auth });
    assert.equal(dbm.countPushSubscriptions(), 2);

    const real = globalThis.fetch;
    let bodySeen = null;
    globalThis.fetch = async (url, opts) => {
      bodySeen = opts.body;
      if (String(url).endsWith("/2")) return new Response("", { status: 410 });   // 已失效
      return new Response("", { status: 201 });
    };
    try {
      const r = await wp.sendPushToAll({ title: "t", body: "b" });
      assert.equal(r.total, 2);
      assert.equal(r.sent, 1);
      assert.equal(r.removed, 1);
      assert.equal(dbm.countPushSubscriptions(), 1, "410 的订阅应被清理");
      assert.ok(Buffer.isBuffer(bodySeen) || bodySeen instanceof Uint8Array);

      // 500 → 记为失败
      globalThis.fetch = async () => new Response("", { status: 500 });
      const r2 = await wp.sendPushToAll({ title: "t" });
      assert.equal(r2.failed, 1);
      assert.match(dbm.listPushSubscriptions()[0].last_error, /500/);

      // 200 → 成功并清除错误
      globalThis.fetch = async () => new Response("", { status: 201 });
      const r3 = await wp.sendPushToAll({ title: "t" });
      assert.equal(r3.sent, 1);
      assert.equal(dbm.listPushSubscriptions()[0].last_error, null);
      assert.ok(dbm.listPushSubscriptions()[0].last_ok_at);
    } finally {
      globalThis.fetch = real;
      db.exec("DELETE FROM push_subscriptions");
    }
  });

  test("无订阅时发送直接返回 0", async () => {
    const wp = await import("../src/webpush.js");
    db.exec("DELETE FROM push_subscriptions");
    const r = await wp.sendPushToAll({ title: "t" });
    assert.deepEqual(r, { sent: 0, failed: 0, removed: 0, total: 0 });
  });
});

describe("认证：口令哈希与会话（第七批）", () => {
  test("scrypt 哈希可验证、盐随机、口令错误被拒", async () => {
    const { hashPassword, verifyPassword } = await import("../src/auth.js");
    const h1 = hashPassword("secret123");
    const h2 = hashPassword("secret123");
    assert.notEqual(h1, h2, "相同口令应生成不同哈希（随机盐）");
    assert.match(h1, /^scrypt\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
    assert.equal(verifyPassword("secret123", h1), true);
    assert.equal(verifyPassword("secret124", h1), false);
    assert.equal(verifyPassword("secret123", "garbage"), false);
    assert.equal(verifyPassword("secret123", null), false);
  });

  test("过短口令被拒绝", async () => {
    const { hashPassword } = await import("../src/auth.js");
    assert.throws(() => hashPassword("123"), /至少 6 位/);
  });

  test("会话创建/校验/过期/删除", async () => {
    const dbm = await import("../src/db.js");
    const { newSessionToken } = await import("../src/auth.js");
    db.exec("DELETE FROM sessions; DELETE FROM users");
    const u = dbm.createUser({ username: "sess-user", passwordHash: "x", role: "admin" });
    assert.equal(u.ok, true);

    const token = newSessionToken();
    dbm.createSession({ token, userId: u.id, expiresAt: new Date(Date.now() + 3600_000).toISOString(), userAgent: "t" });
    const s = dbm.getSession(token);
    assert.equal(s.user_id, u.id);
    assert.equal(s.username, "sess-user");
    assert.equal(s.role, "admin");

    // 过期会话会被清理并视为无效
    const expired = newSessionToken();
    dbm.createSession({ token: expired, userId: u.id, expiresAt: new Date(Date.now() - 1000).toISOString() });
    assert.equal(dbm.getSession(expired), undefined);
    assert.equal(dbm.getSession("nope"), undefined);

    dbm.deleteSession(token);
    assert.equal(dbm.getSession(token), undefined);
    db.exec("DELETE FROM sessions; DELETE FROM users");
  });

  test("用户名格式校验与重名拒绝", async () => {
    const dbm = await import("../src/db.js");
    db.exec("DELETE FROM sessions; DELETE FROM users");
    assert.throws(() => dbm.createUser({ username: "a b", passwordHash: "x" }), /用户名只能/);
    const a = dbm.createUser({ username: "dupuser", passwordHash: "x" });
    const b = dbm.createUser({ username: "dupuser", passwordHash: "y" });
    assert.equal(a.ok, true);
    assert.equal(b.ok, false);
    db.exec("DELETE FROM sessions; DELETE FROM users");
  });
});

describe("JSON 导出覆盖全部表（第八批）", () => {
  test("指数 / 追踪 / 成员 / 推送订阅 / 用户 可完整往返", async () => {
    const dbm = await import("../src/db.js");
    db.exec("DELETE FROM query_members; DELETE FROM tracked_queries; DELETE FROM indices");
    db.exec("DELETE FROM push_subscriptions; DELETE FROM sessions; DELETE FROM users");
    db.exec("DELETE FROM snapshots; DELETE FROM repos");

    db.prepare("INSERT INTO repos (full_name,name,owner,url,stars,is_custom) VALUES (?,?,?,?,?,0)").run("exp/one", "one", "exp", "u", 100);
    dbm.addIndex("导出指数", { language: "Go" }, 1);
    const q = dbm.addTrackedQuery("导出生态", "language:go", 1);
    const rid = db.prepare("SELECT id FROM repos WHERE full_name='exp/one'").get().id;
    dbm.replaceQueryMembers(q.id, [rid], new Date().toISOString());
    const ecdh = crypto.createECDH("prime256v1"); ecdh.generateKeys();
    dbm.addPushSubscription({ endpoint: "https://push.example/exp", p256dh: ecdh.getPublicKey().toString("base64url"), auth: crypto.randomBytes(16).toString("base64url"), userId: 1 });
    dbm.createUser({ username: "expuser", passwordHash: "scrypt$aa$bb", role: "admin" });

    const snap = dbm.exportData();
    assert.equal(snap.version, 2);
    assert.equal(snap.indices.length, 1);
    assert.equal(snap.tracked_queries.length, 1);
    assert.equal(snap.query_members.length, 1);
    assert.equal(snap.push_subscriptions.length, 1);
    assert.equal(snap.users.length, 1);

    db.exec("DELETE FROM query_members; DELETE FROM tracked_queries; DELETE FROM indices");
    db.exec("DELETE FROM push_subscriptions; DELETE FROM users");
    const r = dbm.importData(snap, { mode: "merge" });
    assert.equal(r.counts.indices, 1);
    assert.equal(r.counts.tracked_queries, 1);
    assert.equal(r.counts.query_members, 1);
    assert.equal(r.counts.push_subscriptions, 1);
    assert.equal(r.counts.users, 1);

    // 成员关系真的被还原了
    const q2 = dbm.getTrackedQuery(dbm.listTrackedQueries(1)[0].id);
    assert.equal(q2.member_count, 1);
    assert.equal(dbm.getQueryMemberIds(q2.id).length, 1);
    assert.equal(dbm.listIndices(1).length, 1);
    assert.equal(dbm.countPushSubscriptions(1), 1);

    // 重复导入不产生重复
    dbm.importData(snap, { mode: "merge" });
    assert.equal(dbm.listIndices(1).length, 1);
    assert.equal(dbm.listPushSubscriptions(1).length, 1);
    assert.equal(dbm.listUsers().length, 1);

    db.exec("DELETE FROM query_members; DELETE FROM tracked_queries; DELETE FROM indices");
    db.exec("DELETE FROM push_subscriptions; DELETE FROM users");
  });
});

describe("查询结果定序（SQLite / PostgreSQL 必须一致）", () => {
  // 背景：SQLite 按 rowid 返回、PostgreSQL 按堆物理序返回，
  // 没有显式 ORDER BY 的查询在两个后端上顺序不同，并列名次尤其不稳定。
  before(() => {
    db.exec("DELETE FROM snapshots; DELETE FROM repos; DELETE FROM favorites");
    db.exec("DELETE FROM custom_repos; DELETE FROM alerts; DELETE FROM settings");
    db.exec("DELETE FROM tracked_metrics; DELETE FROM metric_snapshots");

    // 故意按非字典序插入：导出必须按自然键而不是插入顺序
    const ins = db.prepare(
      "INSERT INTO repos (full_name, name, owner, url, language, stars, is_custom) VALUES (?,?,?,?,?,?,0)"
    );
    ins.run("zeta/one", "one", "zeta", "u", "Zeta", 1000);
    ins.run("alpha/two", "two", "alpha", "u", "Zeta", 1000);
    ins.run("mid/three", "three", "mid", "u", "Alpha", 1000);
    ins.run("beta/four", "four", "beta", "u", "Alpha", 1000);
    ins.run("omega/five", "five", "omega", "u", "Mid", 1000);
    ins.run("delta/six", "six", "delta", "u", "Mid", 1000);

    // 所有仓库星数相同、增长相同 → 排行榜必然出现并列
    const ids = db.prepare("SELECT id FROM repos").all();
    const snap = db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)");
    const iso = (daysAgo) => new Date(Date.now() - daysAgo * 86400000).toISOString();
    for (const { id } of ids) {
      snap.run(id, 1000, iso(3));
      snap.run(id, 1300, iso(0));
    }

    setSetting("zzzKey", "1");
    setSetting("aaaKey", "1");
  });

  test("exportData：repos 按 full_name 升序", () => {
    const names = exportData().repos.map((r) => r.full_name);
    assert.deepEqual(names, [...names].sort(), "应使用自然键排序，而非插入/物理顺序");
  });

  test("exportData：snapshots 按 (full_name, captured_at) 升序", () => {
    const keys = exportData().snapshots.map((s) => `${s.full_name}|${s.captured_at}`);
    assert.deepEqual(keys, [...keys].sort());
  });

  test("exportData：settings 按 key 升序", () => {
    const keys = exportData().settings.map((s) => s.key);
    assert.deepEqual(keys, [...keys].sort());
  });

  test("listLanguages：计数相同时按语言名升序", () => {
    const rows = listLanguages().filter((r) => ["Alpha", "Mid", "Zeta"].includes(r.language));
    assert.deepEqual(rows.map((r) => r.c), [2, 2, 2], "三个语言应计数相同（构造出并列）");
    assert.deepEqual(rows.map((r) => r.language), ["Alpha", "Mid", "Zeta"], "并列应按语言名升序");
  });

  test("getLeaderboard：并列名次按 id 升序（总星榜与增长榜）", () => {
    const asc = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);
    const lb = getLeaderboard({ limit: 10 });

    assert.equal(lb.byStars.length, 6, "6 个仓库星数相同，应全部入榜");
    assert.ok(asc(lb.byStars.map((r) => r.id)), "byStars 并列应按 id 升序");

    assert.equal(lb.byGrowth.length, 6, "6 个仓库增长相同，应全部入增长榜");
    assert.ok(asc(lb.byGrowth.map((r) => r.id)), "byGrowth 并列应按 id 升序");
  });
});
