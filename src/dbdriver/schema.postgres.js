/**
 * PostgreSQL schema（与 SQLite 版最终结构等价）
 * - 时间戳统一用 TEXT 存 ISO 字符串，保证与 SQLite 行为一致（字符串比较/substr 都成立）
 * - 自增主键用 BIGSERIAL，配合驱动追加的 RETURNING id 模拟 lastInsertRowid
 */
const NOW = `to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')`;

export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS repos (
  id            BIGSERIAL PRIMARY KEY,
  full_name     TEXT UNIQUE NOT NULL,
  owner         TEXT,
  name          TEXT,
  url           TEXT,
  description   TEXT,
  language      TEXT,
  homepage      TEXT,
  stars         INTEGER NOT NULL DEFAULT 0,
  forks         INTEGER NOT NULL DEFAULT 0,
  open_issues   INTEGER NOT NULL DEFAULT 0,
  gh_created_at TEXT,
  first_seen_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at    TEXT NOT NULL DEFAULT (${NOW}),
  is_custom     INTEGER NOT NULL DEFAULT 0,
  stale         INTEGER NOT NULL DEFAULT 0,
  stale_since   TEXT,
  last_error    TEXT
);

CREATE TABLE IF NOT EXISTS snapshots (
  id          BIGSERIAL PRIMARY KEY,
  repo_id     BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  stars       INTEGER NOT NULL,
  forks       INTEGER NOT NULL DEFAULT 0,
  open_issues INTEGER NOT NULL DEFAULT 0,
  captured_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS custom_repos (
  id        BIGSERIAL PRIMARY KEY,
  user_id   INTEGER NOT NULL DEFAULT 0,
  full_name TEXT NOT NULL,
  user_note TEXT,
  added_at  TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(user_id, full_name)
);

CREATE TABLE IF NOT EXISTS favorites (
  id       BIGSERIAL PRIMARY KEY,
  user_id  INTEGER NOT NULL DEFAULT 0,
  repo_id  BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  added_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(user_id, repo_id)
);

CREATE TABLE IF NOT EXISTS alerts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL DEFAULT 0,
  repo_id       BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  threshold     INTEGER NOT NULL,
  growth        INTEGER NOT NULL,
  current_stars INTEGER NOT NULL,
  triggered_at  TEXT NOT NULL DEFAULT (${NOW}),
  read          INTEGER NOT NULL DEFAULT 0,
  kind          TEXT NOT NULL DEFAULT 'growth',
  message       TEXT
);

CREATE TABLE IF NOT EXISTS api_stats (
  id              BIGSERIAL PRIMARY KEY,
  date            TEXT NOT NULL UNIQUE,
  requests_used   INTEGER NOT NULL DEFAULT 0,
  requests_limit  INTEGER NOT NULL DEFAULT 60,
  last_refresh_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS scheduled_state (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS tracked_metrics (
  id            BIGSERIAL PRIMARY KEY,
  source        TEXT NOT NULL,
  key           TEXT NOT NULL,
  label         TEXT,
  url           TEXT,
  unit          TEXT,
  current_value DOUBLE PRECISION,
  first_seen_at TEXT NOT NULL DEFAULT (${NOW}),
  updated_at    TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(source, key)
);

CREATE TABLE IF NOT EXISTS metric_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  metric_id   BIGINT NOT NULL REFERENCES tracked_metrics(id) ON DELETE CASCADE,
  value       DOUBLE PRECISION NOT NULL,
  captured_at TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS indices (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL DEFAULT 0,
  name       TEXT NOT NULL,
  spec       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS tracked_queries (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL DEFAULT 0,
  label        TEXT NOT NULL,
  query        TEXT NOT NULL,
  member_count INTEGER NOT NULL DEFAULT 0,
  last_run_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (${NOW}),
  UNIQUE(user_id, label)
);

CREATE TABLE IF NOT EXISTS query_members (
  query_id BIGINT NOT NULL REFERENCES tracked_queries(id) ON DELETE CASCADE,
  repo_id  BIGINT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  PRIMARY KEY (query_id, repo_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL DEFAULT 0,
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  last_ok_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member',
  created_at    TEXT NOT NULL DEFAULT (${NOW})
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (${NOW}),
  expires_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_repo_captured ON snapshots(repo_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_snapshots_captured_at   ON snapshots(captured_at);
CREATE INDEX IF NOT EXISTS idx_repos_language          ON repos(language);
CREATE INDEX IF NOT EXISTS idx_repos_stars             ON repos(stars DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_triggered        ON alerts(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_unread           ON alerts(read);
CREATE INDEX IF NOT EXISTS idx_metric_snapshots_metric ON metric_snapshots(metric_id, captured_at);
CREATE INDEX IF NOT EXISTS idx_query_members_query     ON query_members(query_id);
`;
