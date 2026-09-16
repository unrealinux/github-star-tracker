/** 内部脚本：把 SQLite 数据以 JSON 形式输出到 stdout（供迁移使用） */
process.env.DB_DRIVER = "sqlite";
const { exportData } = await import("../src/db.js");
// 必须等 stdout 落盘再退出，否则管道写入会被 process.exit 截断
process.stdout.write(JSON.stringify(exportData()), () => process.exit(0));
