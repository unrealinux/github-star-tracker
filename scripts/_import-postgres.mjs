/** 内部脚本：从 stdin 读取 JSON 并导入 PostgreSQL */
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const data = JSON.parse(raw);
const { importData, closeDb } = await import("../src/db.js");
const result = importData(data, { mode: "merge" });
closeDb();
process.stdout.write("导入完成：" + JSON.stringify(result.counts) + "\n", () => process.exit(0));
