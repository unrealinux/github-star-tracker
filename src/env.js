/**
 * 尽早加载 .env —— 必须作为 server.js 的第一个 import。
 *
 * 原因：ESM 的静态 import 会先于模块体执行。如果把 process.loadEnvFile() 写在
 * server.js 的模块体里，db.js / auth.js 在 import 时读到的 process.env 还没有
 * .env 的值（DB_DRIVER、DATABASE_URL、SESSION_TTL_DAYS 等会被静默忽略）。
 *
 * env 文件路径可用 GST_ENV_FILE 覆盖（默认：仓库根目录的 .env）。
 */
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const custom = process.env.GST_ENV_FILE;
const envPath = custom ? (isAbsolute(custom) ? custom : join(process.cwd(), custom)) : join(repoRoot, ".env");

try {
  process.loadEnvFile(envPath);
} catch {
  /* 没有该文件就忽略 */
}
