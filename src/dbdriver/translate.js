/**
 * SQLite → PostgreSQL 方言转换
 *
 * 目标：让上层代码（db.js / tracker.js / 测试）继续使用原来那套 SQLite SQL，
 *      由这里统一翻译成等价的 PostgreSQL 语句。
 */
const NOW_ISO = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

// 含自增 id 的表：INSERT 时追加 RETURNING id 以模拟 lastInsertRowid
const TABLES_WITH_ID = new Set([
  "repos",
  "snapshots",
  "custom_repos",
  "favorites",
  "alerts",
  "api_stats",
  "tracked_metrics",
  "metric_snapshots",
  "indices",
  "tracked_queries",
  "push_subscriptions",
  "users",
]);

/** `?` → `$1..$n`（本项目 SQL 中不存在字符串字面量里的 `?`） */
export function toPositional(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function translateStrftime(sql) {
  return sql
    .replace(/strftime\('%Y-%m-%dT%H:%M:%SZ'\s*,\s*'now'\)/gi, NOW_ISO)
    .replace(/strftime\('%Y-%m-%d'\s*,\s*'now'\)/gi, `to_char(now() at time zone 'utc','YYYY-MM-DD')`)
    .replace(
      /strftime\('%Y-%m-%W'\s*,\s*([^)]+)\)/gi,
      (_m, col) => `to_char((${col.trim()})::timestamptz, 'IYYY-IW')`,
    )
    .replace(
      /strftime\('%Y-%W'\s*,\s*([^)]+)\)/gi,
      (_m, col) => `to_char((${col.trim()})::timestamptz, 'IYYY-IW')`,
    );
}

/** 标量 MAX(a, b) → GREATEST(a, b)（聚合 MAX(x) 不受影响） */
const toGreatest = (sql) => sql.replace(/\bMAX\s*\(([^()]*,[^()]*)\)/gi, "GREATEST($1)");

/** INSERT OR IGNORE → INSERT ... ON CONFLICT DO NOTHING */
function translateInsertOrIgnore(sql) {
  if (!/INSERT\s+OR\s+IGNORE/i.test(sql)) return sql;
  let out = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/gi, "INSERT INTO");
  if (!/ON\s+CONFLICT/i.test(out)) out = out.replace(/;\s*$/, "") + " ON CONFLICT DO NOTHING";
  return out;
}

/** INSERT OR REPLACE INTO t (c1, c2, ...) → ON CONFLICT (c1) DO UPDATE SET c2 = EXCLUDED.c2 ... */
function translateInsertOrReplace(sql) {
  const m = sql.match(/INSERT\s+OR\s+REPLACE\s+INTO\s+([\w.]+)\s*\(([^)]*)\)/i);
  if (!m) return sql;
  const cols = m[2]
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
  if (cols.length < 1) return sql;
  const pk = cols[0];
  const sets = cols
    .slice(1)
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  let out = sql.replace(/INSERT\s+OR\s+REPLACE\s+INTO/gi, "INSERT INTO");
  const conflict = sets ? `ON CONFLICT (${pk}) DO UPDATE SET ${sets}` : `ON CONFLICT (${pk}) DO NOTHING`;
  if (!/ON\s+CONFLICT/i.test(out)) out = out.replace(/;\s*$/, "") + " " + conflict;
  return out;
}

/** 为含自增 id 的 INSERT 追加 RETURNING id */
export function withReturningId(sql) {
  if (!/^\s*INSERT\s+INTO/i.test(sql)) return { sql, returnsId: false };
  if (/RETURNING/i.test(sql)) return { sql, returnsId: /\bRETURNING\s+id\b/i.test(sql) };
  const m = sql.match(/INSERT\s+INTO\s+([\w.]+)/i);
  const table = m ? m[1].replace(/"/g, "").toLowerCase() : "";
  if (!TABLES_WITH_ID.has(table)) return { sql, returnsId: false };
  return { sql: sql.replace(/;\s*$/, "") + " RETURNING id", returnsId: true };
}

/**
 * 把一条 SQLite SQL 翻译为 PostgreSQL SQL。
 * @returns {{ sql: string, returnsId: boolean }}
 */
export function translate(sql) {
  let out = String(sql);
  out = translateInsertOrReplace(out);
  out = translateInsertOrIgnore(out);
  out = translateStrftime(out);
  out = toGreatest(out);
  out = toPositional(out);
  // PG 要求子查询带别名；若形如 `FROM (...)` 结尾缺别名则补 ` AS _sq`
  out = out.replace(/FROM\s*\(\s*$/i, "FROM (");
  out = toGreatest(out);
  const { sql: finalSql, returnsId } = withReturningId(out);
  return { sql: finalSql, returnsId };
}

export { TABLES_WITH_ID };
