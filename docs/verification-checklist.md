# 验证清单

用来在**能跑真实 PostgreSQL** 的机器上，把 PostgreSQL 后端与数据迁移验证到位。
本地基线（Step 1）与本地冒烟（Step 4）任何机器都能跑（内嵌 PGlite，无需服务器）；Step 2、3、5 需要真实 PostgreSQL。

每个 Step 都带**完成标准**，达不到就不要往下走。

---

## Step 0 · 前置条件

```bash
node -v            # 需要 >= 22（node:sqlite 依赖）
npm ci
docker info        # Step 2 起需要；没有 docker 就跳到附录
```

**完成标准**：`node -v` ≥ v22，`npm ci` 成功，`docker info` 有输出。

---

## Step 1 · 基线：两种后端各跑一遍全量测试

```bash
npm test               # SQLite
npm run test:postgres  # PostgreSQL（内嵌 PGlite，无需服务器）
```

**完成标准**：两次都是 `# fail 0`，且两边的 `# tests` **数字相同**（当前为 204）。
数字不同或有一边失败，就说明存在后端相关差异，先解决它再继续。

---

## Step 2 · 起一个真实 PostgreSQL

复用仓库自带的 compose 服务（`postgres:16-alpine`，用户/密码/库都是 `gst`）。
该服务默认**不对外发布端口**，所以用 override 临时映射出 5432：

```bash
cat > docker-compose.override.yml <<'YAML'
services:
  postgres:
    ports: ["5432:5432"]
YAML

docker compose --profile postgres up -d postgres

for i in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' github-star-tracker-pg 2>/dev/null)" = healthy ] && break
  sleep 1
done
[ "$(docker inspect -f '{{.State.Health.Status}}' github-star-tracker-pg 2>/dev/null)" = healthy ] \
  && echo "postgres ready" \
  || { echo "postgres 未就绪，看日志：docker compose --profile postgres logs postgres"; exit 1; }
```

**完成标准**：打印出 `postgres ready`，且
`docker exec github-star-tracker-pg pg_isready -U gst -d gst` 返回 `accepting connections`。

> 验证结束后删掉 `docker-compose.override.yml`，避免把端口映射带进部署。

---

## Step 3 · 在真实 PostgreSQL 上跑测试

**每个会碰数据库的测试文件必须用独立的库。** 测试文件在 `before()` 里做破坏性重置，
共用一个 `DATABASE_URL` 会互相污染——实测即使 `--test-concurrency=1` 也会产生假失败。

```bash
for db in gst_core gst_api; do
  docker exec github-star-tracker-pg psql -U gst -d gst \
    -c "DROP DATABASE IF EXISTS $db;" -c "CREATE DATABASE $db;"
done

DATABASE_URL=postgres://gst:gst@127.0.0.1:5432/gst_core DB_DRIVER=postgres \
  node --test tests/core.test.js

DATABASE_URL=postgres://gst:gst@127.0.0.1:5432/gst_api DB_DRIVER=postgres \
  node --test tests/api.test.js

node --test tests/migration.test.js   # 旧库升级；内部子进程固定走 SQLite
node --test tests/pg_migration.test.js # PG 迁移；用内嵌 PGlite，不需要外部 PG
node --test tests/driver.test.js      # 驱动报错；用内嵌 PGlite，不需要外部 PG
node --test tests/github.test.js      # GitHub API 封装；纯单元测试
```

**完成标准**：全部文件都是 `# fail 0`（只有 `core.test.js` 与 `api.test.js` 真正打到外部 PostgreSQL），
且所有文件用例数**之和**与 Step 1 的总数一致（当前 204）。
任一边红，就是真实 PostgreSQL 上的真问题——此时错误信息应能直接定位（见「已知坑」第 2 条）。

---

## Step 4 · 本地冒烟：真机启动服务并读写

Step 1–3 只证明测试过得去；这里再证明**服务本身**能在这套后端上启动、读写，并能在启动时自动补齐旧库。
用独立的临时 PGlite 数据目录 + 3002 端口，避免污染真实数据或与已运行实例冲突（**不需要**外部 PostgreSQL）。

```bash
SMOKE_PG=$(mktemp -d)

DB_DRIVER=postgres PG_DATA_DIR="$SMOKE_PG" PORT=3002 \
  node server.js > /tmp/gst-pg.log 2>&1 &
SMOKE_PID=$!

for i in $(seq 1 30); do
  curl -sf http://127.0.0.1:3002/health >/dev/null && break
  sleep 1
done
cat /tmp/gst-pg.log
```

**完成标准**：日志出现 `已启动 ... "token":true|false`；配了 token 时还应看到 `GITHUB_TOKEN 校验通过`。

```bash
curl -s http://127.0.0.1:3002/health
curl -s http://127.0.0.1:3002/api/stats

# 读写往返：写一个自定义仓库再读回
curl -s -X POST http://127.0.0.1:3002/api/custom-repos \
  -H 'Content-Type: application/json' \
  -d '{"full_name":"facebook/react","note":"smoke"}'
curl -s http://127.0.0.1:3002/api/custom-repos
```

**完成标准**：`/health` 返回 `"status":"ok"`；写入返回 `{"ok":true}`；再读能查到 `facebook/react`。

停下服务，直接查库确认迁移已落库（脚本写成文件，**不要**用 `-e`，见「已知坑」第 4 条）：

```bash
kill "$SMOKE_PID"; sleep 2

cat > ./_smoke.mjs <<'EOF'
const { db, closeDb } = await import('./src/db.js');
console.log('schema_migrations:', db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(r => r.version).join(','));
console.log('is_custom exists:', db.prepare("SELECT 1 FROM information_schema.columns WHERE table_name='repos' AND column_name='is_custom'").all().length === 1);
console.log('custom repos    :', db.prepare('SELECT full_name, user_note FROM custom_repos').all());
closeDb();
EOF

DB_DRIVER=postgres PG_DATA_DIR="$SMOKE_PG" node ./_smoke.mjs
rm ./_smoke.mjs
```

**完成标准**：`schema_migrations` 为 `1,2,3,4,5,6`（等于 `POSTGRES_MIGRATIONS` 的长度），
`is_custom exists: true`，且能查到上一步写入的自定义仓库。

### 验证「旧库自动补齐」

模拟一个停在旧版本的库，再走一次启动迁移：

```bash
cat > ./_upgrade.mjs <<'EOF'
const { db, closeDb } = await import('./src/db.js');
const { migratePostgres, POSTGRES_MIGRATIONS } = await import('./src/dbdriver/migrate.postgres.js');
const has = () => db.prepare("SELECT 1 FROM information_schema.columns WHERE table_name='repos' AND column_name='is_custom'").all().length === 1;
const ver = () => db.prepare('SELECT COALESCE(MAX(version),0) v FROM schema_migrations').get().v;
console.log('latest     -> %s 条迁移', POSTGRES_MIGRATIONS.length);
console.log('before     -> is_custom=%s version=%s', has(), ver());
db.exec('ALTER TABLE repos DROP COLUMN is_custom;');
db.prepare('DELETE FROM schema_migrations WHERE version >= 6').run();
console.log('downgraded -> is_custom=%s version=%s', has(), ver());
console.log('migratePostgres ->', migratePostgres(db));
console.log('after      -> is_custom=%s version=%s', has(), ver());
closeDb();
EOF

DB_DRIVER=postgres PG_DATA_DIR="$SMOKE_PG" node ./_upgrade.mjs
rm ./_upgrade.mjs
```

**完成标准**：`before` 为 `is_custom=true version=6`，`downgraded` 为 `false version=5`，
`migratePostgres` 返回 `{ fresh: false, from: 5, to: 6 }`，`after` 回到 `true version=6`。

> 新增迁移后，上面的 `version >= 6` / 预期 `from:5,to:6` 要跟着改；判定标准是「缺列被补回、版本号推进到最新」。

清理：

```bash
rm -rf "$SMOKE_PG" /tmp/gst-pg.log
```

---

## Step 5 · 迁移既有数据并「对拍」两端

```bash
[ -f data/tracker.db ] || { echo "没有 data/tracker.db：先在 SQLite 模式跑一次 npm start 生成，或把 --from 指到你自己的备份"; exit 1; }
cp data/tracker.db data/tracker.db.bak

npm run migrate:postgres -- \
  --from data/tracker.db \
  --database-url postgres://gst:gst@127.0.0.1:5432/gst
```

**完成标准**：输出 `导入完成`，且各表条数与源库一致：

```bash
for t in repos snapshots alerts tracked_metrics metric_snapshots; do
  printf "%-18s sqlite=%s pg=%s\n" "$t" \
    "$(node -e "const{DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync('data/tracker.db').prepare('select count(*) c from $t').get().c)" 2>/dev/null)" \
    "$(docker exec github-star-tracker-pg psql -U gst -d gst -tAc "select count(*) from $t")"
done
```

然后**对拍**：同一份数据分别从两端启动服务，抓同样的端点再 diff。

```bash
grab() { # $1=port $2=outdir
  mkdir -p "$2"
  for ep in "/api/stats" "/api/repos?limit=5&sort=stars" "/api/leaderboard?limit=5" \
            "/api/languages/trends" "/api/maintenance/export?format=json"; do
    f=$(echo "$ep" | tr '/?=&' '____' | sed 's/__*/_/g')
    curl -s "http://127.0.0.1:$1$ep" > "$2/$f.json"
  done
}

PORT=3990 node server.js > /tmp/gst-lite.log 2>&1 &          # SQLite
PORT=3991 DB_DRIVER=postgres DATABASE_URL=postgres://gst:gst@127.0.0.1:5432/gst \
  node server.js > /tmp/gst-pg.log 2>&1 &                    # 真实 PostgreSQL
sleep 12

grab 3990 /tmp/cmp-lite
grab 3991 /tmp/cmp-pg
diff -rq /tmp/cmp-lite /tmp/cmp-pg
```

**完成标准**：差异**只出现在下表列出的位置**——除此之外应逐字节一致。
若出现其它差异（尤其是列表顺序或数值），即为真问题。

`/api/repos`、`/api/leaderboard`、`/api/languages/trends` 的**顺序必须完全一致**：
这三处曾经因为没有 `ORDER BY` 而在两个后端上给出不同顺序，现已修复，可作为回归探针。

---

## 预期差异（出现了不算问题）

| 位置 | 为什么不同 |
|------|-----------|
| 列表项里的 `id` | 导入时 PostgreSQL 重新分配自增主键。导出/导入按自然键（`full_name`）关联，所以**按 `full_name` 比对**，忽略 `id` |
| 导出 JSON 的 `exportedAt` | 就是导出时间戳 |
| `/api/stats` 的 `quota.*` 与 `auto.lastAuto*` | `api_stats`、`scheduled_state` **不在导出/导入范围内**（属于瞬时运维状态）。迁移后配额历史与「上次自动抓取」为空，属预期 |

---

## 已知坑

1. **测试文件不能共用 `DATABASE_URL`**（原因与做法见 Step 3）。
2. **`DB_DRIVER=postgres` 的错误信息现在会带真实原因。** 若看到 `Error: undefined`，
   说明 `src/dbdriver/postgres.worker.js` 的错误上报又退化了（`tests/driver.test.js` 会拦住）。
3. **连接失败会一直等到 60s 超时才报错**，而不是立刻失败。
   实测：端口无人监听、非法 `DATABASE_URL`、无效 PGlite 数据目录，都会耗尽 60s。
   所以脚本里要给够时间，别误判成卡死。
4. **跑 PostgreSQL 驱动时用文件。** 写成 `.mjs` 或直接用 `server.js`；
   用 `node --input-type=module -e` 加载它会出现初始化不回应。
5. **macOS 13 + Intel 装不上 colima/docker。** Homebrew 7 已不为该配置构建 bottle，
   `colima.rb` 的 bottle 只有 `sonoma` 与 arm64，且 `depends_on "go" => :build`，
   会退化成源码编译。这类机器请换一台宿主，或直接连一台已有的 PostgreSQL。

---

## 本清单**不**覆盖

- 前端在浏览器中的实际行为（只验到静态资源可达与服务可启动）。
- 真实 PostgreSQL 的**版本差异**：这里只跑了 `postgres:16-alpine`。其它大版本请各跑一次 Step 3。
- SSL、PG 角色/权限模型、多连接并发：`DATABASE_URL` 里的 `sslmode` 与受限角色未验证。
- `pg_dump` / 备份恢复链路。

---

## 附录 · 没有真实 PostgreSQL 时的降级方案

可以用 `@electric-sql/pglite-socket` 把内嵌 PGlite 以 **Postgres 线协议**暴露成 TCP 服务，
让项目真实的 `pg` 客户端连上去。这能覆盖 `mode === "pg"` 分支，但**不能替代**上面的真实服务器验证。

```bash
mkdir -p /tmp/pgsock && cd /tmp/pgsock && npm init -y >/dev/null && npm i @electric-sql/pglite-socket @electric-sql/pglite
cat > server.mjs <<'EOF'
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
const db = await PGlite.create(process.env.PGDATA || '/tmp/pgsock/data');
const srv = new PGLiteSocketServer({ db, port: Number(process.env.PORT || 5432), host: '127.0.0.1' });
await srv.start();
console.log('listening');
EOF
PORT=55432 node server.mjs &
```

**局限**：该代理不稳定，`core.test.js` 在它上面会间歇性在初始化阶段断连；
而且它是单连接多路复用，官方明确说明「并非所有用法都保证可用」。
因此它适合快速冒烟，**判定以真实 PostgreSQL 为准**。
