/**
 * PostgreSQL 驱动 —— 对外暴露与 node:sqlite `DatabaseSync` 一致的**同步**接口：
 *   db.prepare(sql).get/all/run(...params)
 *   db.exec(sql)
 *   db.close()
 *
 * 实现方式：把异步的 pg / PGlite 放进 worker，主线程用
 * `Atomics.wait` + `receiveMessageOnPort` 做同步等待。
 * 这样 tracker/server/测试等全部上层代码**无需改成异步**。
 */
import { Worker, MessageChannel, receiveMessageOnPort } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { translate } from "./translate.js";

const WORKER_URL = new URL("./postgres.worker.js", import.meta.url);
const DEFAULT_TIMEOUT_MS = 60_000;

export function createPostgresDriver({
  databaseUrl = "",
  dataDir = "",
  ssl = null,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  const { port1, port2 } = new MessageChannel();

  const worker = new Worker(fileURLToPath(WORKER_URL), {
    workerData: { sab, port: port2, config: { databaseUrl, dataDir, ssl } },
    transferList: [port2],
  });
  worker.unref?.();

  let seq = 0;

  function call(op, payload = {}) {
    const id = ++seq;
    Atomics.store(i32, 0, 0); // 先复位再发请求，避免丢唤醒
    port1.postMessage({ id, op, ...payload });

    for (;;) {
      const w = Atomics.wait(i32, 0, 0, timeoutMs);
      if (w === "timed-out") throw new Error(`数据库操作超时（${op}）`);

      let matched = null;
      let m;
      while ((m = receiveMessageOnPort(port1))) {
        const reply = m.message;
        if (reply.id === -1) {
          // 初始化完成信号
          if (!reply.ok) throw new Error(reply.error);
          continue;
        }
        if (reply.id === id) {
          matched = reply;
          break;
        }
      }
      if (matched) {
        if (!matched.ok) throw new Error(matched.error);
        return matched.result;
      }
      // 只消费到无关消息（如 ready），继续等本次响应
    }
  }

  // 阻塞到 worker 初始化完成（连接建立 / PGlite 就绪）
  call("ping");

  const ok = (params) => (Array.isArray(params[0]) ? params[0] : params);

  return {
    driverName: "postgres",
    isPostgres: true,

    prepare(sql) {
      const t = translate(sql);
      return {
        get: (...params) => {
          const r = call("query", { sql: t.sql, params: ok(params) });
          return r.rows[0];
        },
        all: (...params) => call("query", { sql: t.sql, params: ok(params) }).rows,
        run: (...params) => {
          const r = call("query", { sql: t.sql, params: ok(params) });
          return {
            changes: r.rowCount ?? 0,
            lastInsertRowid: t.returnsId && r.rows[0] ? Number(r.rows[0].id) : 0,
          };
        },
      };
    },

    exec(sql) {
      call("exec", { sql: String(sql) });
    },

    close() {
      try {
        call("close");
      } catch {
        /* ignore */
      }
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
    },
  };
}
