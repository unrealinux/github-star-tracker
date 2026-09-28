/**
 * 验证 PostgreSQL 备份 → 恢复链路（供 CI / 本地手动验证）。
 *
 * 分两段跑（db.js 是单例，读一次 DATABASE_URL，无法同进程连两个库）：
 *   # 源库：写入已知数据并 createBackup()，打印 dump 路径
 *   DB_DRIVER=postgres DATABASE_URL=<src> node scripts/verify-pg-backup.mjs seed
 *   # 目标库：pg_restore 之后核对数据
 *   DB_DRIVER=postgres DATABASE_URL=<dst> node scripts/verify-pg-backup.mjs verify
 */
const mode = process.argv[2];
if (mode !== "seed" && mode !== "verify") {
  console.error(
    "用法：node scripts/verify-pg-backup.mjs seed|verify（配合 DB_DRIVER=postgres + DATABASE_URL）",
  );
  process.exit(2);
}

const { db, createBackup, closeDb, isPostgres } = await import("../src/db.js");
if (!isPostgres) {
  console.error("需要 DB_DRIVER=postgres");
  process.exit(2);
}

const FULL = "restore/check";
const MARKER = "restore-marker-8f3a";

try {
  if (mode === "seed") {
    // 可重复执行
    db.prepare("DELETE FROM snapshots WHERE repo_id IN (SELECT id FROM repos WHERE full_name = ?)").run(FULL);
    db.prepare("DELETE FROM repos WHERE full_name = ?").run(FULL);
    db.prepare("DELETE FROM settings WHERE key = ?").run("restoreMarker");

    db.prepare(
      "INSERT INTO repos (full_name, name, owner, url, stars, forks, open_issues, is_custom) VALUES (?,?,?,?,?,?,?,0)",
    ).run(FULL, "check", "restore", "https://github.com/restore/check", 4242, 7, 1);
    const id = db.prepare("SELECT id FROM repos WHERE full_name = ?").get(FULL).id;
    db.prepare("INSERT INTO snapshots (repo_id, stars, captured_at) VALUES (?,?,?)").run(
      id,
      4242,
      "2026-01-01T00:00:00Z",
    );
    db.prepare("INSERT INTO settings (key, value) VALUES (?,?)").run("restoreMarker", MARKER);

    const { file, kind } = createBackup();
    console.log(`kind=${kind}`);
    console.log(`dump=${file}`);
  } else {
    const repo = db.prepare("SELECT stars, forks FROM repos WHERE full_name = ?").get(FULL);
    const snaps = Number(
      db
        .prepare(
          "SELECT COUNT(*) AS c FROM snapshots WHERE repo_id = (SELECT id FROM repos WHERE full_name = ?)",
        )
        .get(FULL).c,
    );
    const marker = db.prepare("SELECT value FROM settings WHERE key = ?").get("restoreMarker")?.value;

    console.log(`repo=${FULL} stars=${repo?.stars} forks=${repo?.forks} snapshots=${snaps} marker=${marker}`);
    const ok = repo?.stars === 4242 && repo?.forks === 7 && snaps >= 1 && marker === MARKER;
    if (!ok) {
      console.error("✗ 恢复后的数据与源库不一致");
      process.exitCode = 1;
    } else {
      console.log("✓ 恢复数据与源库一致");
    }
  }
} finally {
  closeDb();
}
