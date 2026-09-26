/**
 * PostgreSQL worker：持有**单一连接**，串行执行主线程发来的查询。
 *
 * 为什么单连接：上层用 `db.exec("BEGIN") ... COMMIT` 表达事务，
 * 只有同一条连接才能让事务跨多次调用生效；本项目单进程、访问串行，
 * 与原有 node:sqlite 的同步模型一致。
 *
 * 两种后端共用同一套 SQL（已由 translate.js 转换）：
 *  - 设置了 DATABASE_URL → 用 pg 连接外部 PostgreSQL
 *  - 否则 → 用 PGlite（Postgres 16 WASM，进程内、免服务器）
 */
import { workerData } from "node:worker_threads";

const { sab, port, config } = workerData;
const i32 = new Int32Array(sab);

let backend = null;
let mode = "";

async function init() {
  if (config.databaseUrl) {
    const { default: pg } = await import("pg");
    const client = new pg.Client({
      connectionString: config.databaseUrl,
      ...(config.ssl ? { ssl: config.ssl } : {}),
    });
    await client.connect();
    backend = client;
    mode = "pg";
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const client = new PGlite(config.dataDir);
    await client.waitReady;
    backend = client;
    mode = "pglite";
  }
}

// PostgreSQL 会把 bigint/numeric 以字符串返回（避免精度丢失），
// 而 SQLite 返回 number。这里按列类型统一转成 number，保持上层行为一致。
const NUMERIC_OIDS = new Set([20 /* int8 */, 1700 /* numeric */, 700 /* float4 */, 701 /* float8 */]);
function coerceRows(rows, fields) {
  if (!fields || !rows.length) return rows;
  const numericCols = fields.filter((f) => NUMERIC_OIDS.has(f.dataTypeID)).map((f) => f.name);
  if (!numericCols.length) return rows;
  for (const row of rows) {
    for (const col of numericCols) {
      const v = row[col];
      if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) row[col] = Number(v);
    }
  }
  return rows;
}

async function runQuery(sql, params) {
  if (mode === "pg") {
    const r = await backend.query(sql, params);
    return { rows: coerceRows(r.rows || [], r.fields), rowCount: r.rowCount ?? 0 };
  }
  const r = await backend.query(sql, params);
  const rows = coerceRows(r.rows || [], r.fields);
  return { rows, rowCount: r.affectedRows ?? rows.length };
}

async function runExec(sql) {
  if (mode === "pg") await backend.query(sql);
  else await backend.exec(sql);
  return { rows: [], rowCount: 0 };
}

const handlers = {
  query: ({ sql, params }) => runQuery(sql, params),
  exec: ({ sql }) => runExec(sql),
  close: async () => {
    try {
      await backend?.close?.();
    } catch {
      /* ignore */
    }
    return {};
  },
  ping: async () => ({ mode }),
};

// 所有请求都等初始化完成后再执行，避免 backend 尚未就绪
const readyPromise = init();

/**
 * 把异常统一转成可读文本。
 * 之前错误路径只传了 3 个参数，消息落到了 result、error 恒为 undefined，
 * 主线程只能报 `Error: undefined` —— PostgreSQL 的任何故障都无法定位。
 */
const describeError = (e) => {
  if (e instanceof Error) return e.message || e.stack || e.name || "未知错误";
  if (typeof e === "string") return e;
  if (e === undefined || e === null) return "未知错误（原始异常为空）";
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e);
  }
};

const reply = (id, ok, result, error) => {
  port.postMessage(ok ? { id, ok, result } : { id, ok: false, error: describeError(error) });
  Atomics.store(i32, 0, 1);
  Atomics.notify(i32, 0);
};

let queue = Promise.resolve();
port.on("message", (msg) => {
  queue = queue
    .then(() => readyPromise)
    .then(() => (handlers[msg.op] ? handlers[msg.op](msg) : Promise.reject(new Error(`未知操作: ${msg.op}`))))
    .then((result) => reply(msg.id, true, result))
    .catch((e) => reply(msg.id, false, null, e));
});

// 初始化完成后通知主线程（主线程会先收到这条 id=-1 的消息）
readyPromise
  .then(() => reply(-1, true, { ready: true, mode }))
  .catch((e) => reply(-1, false, null, `数据库初始化失败: ${describeError(e)}`));
