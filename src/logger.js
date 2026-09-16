/**
 * 极简结构化日志（零依赖）。
 * 通过 LOG_LEVEL 环境变量控制：debug | info | warn | error（默认 info）
 * 通过 LOG_FORMAT=json 输出 JSON 行，便于日志采集；默认输出可读文本。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = LEVELS[(process.env.LOG_LEVEL || "info").toLowerCase()] ?? LEVELS.info;
const asJson = (process.env.LOG_FORMAT || "").toLowerCase() === "json";

function emit(lvl, msg, meta) {
  if (LEVELS[lvl] < level) return;
  const ts = new Date().toISOString();
  if (asJson) {
    process.stdout.write(JSON.stringify({ ts, level: lvl, msg, ...(meta || {}) }) + "\n");
  } else {
    const extra = meta && Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    process.stdout.write(`${ts} [${lvl.toUpperCase()}] ${msg}${extra}\n`);
  }
}

export const logger = {
  debug: (msg, meta) => emit("debug", msg, meta),
  info:  (msg, meta) => emit("info", msg, meta),
  warn:  (msg, meta) => emit("warn", msg, meta),
  error: (msg, meta) => emit("error", msg, meta),
  child: (base) => ({
    debug: (m, meta) => emit("debug", m, { ...base, ...meta }),
    info:  (m, meta) => emit("info", m, { ...base, ...meta }),
    warn:  (m, meta) => emit("warn", m, { ...base, ...meta }),
    error: (m, meta) => emit("error", m, { ...base, ...meta }),
  }),
};
