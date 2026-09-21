# GitHub Star Tracker

GitHub 星标追踪工具 —— 实时监控热门仓库的星数变化，支持自定义追踪、增长告警与趋势分析。

## ✨ 功能

### 数据采集
- 搜索 GitHub 热门仓库（支持自定义搜索语法，如 `language:rust stars:>5000`）
- **自定义仓库追踪** —— 追踪任意 `owner/repo`，不受搜索范围限制
- **📦 外部指标追踪** —— 同一套引擎追踪 GitHub 以外的公开指标：
  - npm / PyPI 周下载量、Docker Hub 拉取量、crates.io 下载量
  - **Hacker News 提及数、Homebrew 30天安装量、RubyGems / NuGet 下载量、Open VSX 安装量**
- **多指标对比** —— 星标 / 复刻 / Issue 三个维度可切换
- **📜 历史回填** —— 用 GitHub stargazers 的 `starred_at` 重建历史星数曲线（近似值）
- 定时自动刷新（cron 表达式可配置）
- 自动轮询（分钟级间隔，可动态开关）
- 并发刷新锁 + GitHub API 配额感知（指数退避重试）

### 分析视图
- **仓库列表** —— 多条件筛选（星数/增速/语言/关键词）、7 种排序、服务端分页
- **星数历史** —— 每条记录快照，绘制趋势图
- **日增/窗口增长** —— 24h / 7天 / 30天三个窗口
- **语言趋势** —— 各编程语言的星数增长排行
- **排名变化** —— 谁在上升、谁在下滑
- **🏆 排行榜** —— 左右分栏对比「总星数排行」与「日均新增排行」
- **日均增长** —— 基于近 7 天快照平滑，比单次差值稳定
- **🚀 爆发榜** —— 增速加速度（二阶导），识别「正在起飞」与「热度衰减」
- **🔎 异常检测** —— 对日增做 z-score（相对自身历史），区分「本来就热」与「突然被引爆」
- **🌊 事件聚类** —— 同一天多个仓库同时异常 → 自动归为一波趋势，并用语言/描述共同词命名
- **🐎 黑马榜** —— 低星高增速项目（星数上限缺省时自动取中位数）
- **🧪 告警规则回测** —— 用历史快照重放，预览给定阈值/开关会触发多少次，调参不再拍脑袋
- **⏪ 历史回放** —— 回看任意时刻的榜单
- **⚖️ 仓库对比** —— 最多 8 个仓库叠加，可按百分比变化归一化/对数轴
- **交叉预测** —— 「A 预计约 N 天后超过 B」，附置信度（R²）
- **📉 全局趋势** —— 每日总星数、快照活动、新收录与数据健康度
- **交互式图表** —— hover 光标与提示、范围切换（7/30天/全部）、对数轴
- **🔍 相似项目** —— 基于语言 + 描述相似度推荐
- **🧬 项目画像** —— topics / license / 贡献者数 / 关注数 / 最新 release / 归档状态（来自 GitHub）
- **💾 保存筛选视图** —— 把一组筛选/排序/窗口条件存为命名视图
- **🧭 自定义指数** —— 用语言/星数/关键词定义一组仓库，合成一条归一化曲线（等权 / 星数加权）
- **🌐 生态 / Topic 追踪** —— 用 GitHub 搜索语法（如 `topic:llm`）定义生态，刷新时自动抓取成员并跟踪整体走势
- **增长预测** —— 线性回归预测星速与里程碑达成时间

### 效率工具
- **收藏夹** —— 标记关注项目，独立查看
- **增长告警** —— 支持每仓库阈值、掉星告警、里程碑告警；推送渠道 **Slack / Discord / Telegram / 飞书 / 钉钉 / ntfy / Bark / Server酱 / 通用 JSON**
- **📮 每日摘要** —— 定时把「日均增长 Top N + 爆发项目」推送到 Webhook
- **📲 Web Push** —— 浏览器/手机系统级通知（VAPID + RFC 8291 零依赖手写），无需第三方服务
- **SVG 徽章** —— 可嵌入 README：`/badge/owner/repo.svg`
- **shields.io endpoint** —— `/badge/owner/repo.json`，可配合 shields 自定义样式
- **迷你走势图** —— `/spark/owner/repo.svg`，真实折线 sparkline 可嵌 README
- **RSS / Atom 订阅** —— `/api/feed/surges.xml`、`/api/feed/new.xml`、`/api/feed/alerts.xml`
- **CSV 导出**
- **数据导入 / 导出** —— 支持 `.db` 备份与 JSON 导出；JSON 可跨实例合并或覆盖恢复
- **自动备份** —— 每日自动备份，保留最近 5 份
- **深色 / 浅色 / 高对比度** 三种主题
- **⌘K 命令面板** —— 快捷键搜索仓库、跳转页面、执行动作
- **时间线标注** —— 历史曲线上标出里程碑与告警触发点
- **热力图日历** —— GitHub 贡献图样式的每日新增星数可视化
- **PWA** —— 可安装到桌面/手机，离线可打开界面（`manifest` + Service Worker）

### 多用户 / 团队协作
- **可选多用户模式** —— 未创建用户时保持单用户模式；创建首个管理员后自动启用登录
- **数据按用户隔离** —— 收藏、自定义仓库、指数、生态追踪、保存视图、告警阈值、告警记录、推送订阅各自独立
- **角色权限** —— `admin` 可管理用户，`member` 只能使用；口令用 scrypt + 随机盐哈希，会话 30 天过期
- 浏览器/手机推送按用户定向，只推给订阅者本人

### 运维
- **API Key 认证**（可选，自动化/管理员通道）
- 接口速率限制
- 健康检查端点 `/health`
- **Prometheus 指标** `/metrics`（公开，不含敏感信息）
- **仓库重命名 / 删除检测** —— 改名自动迁移历史（快照/收藏/告警），失效仓库标记 `stale` 并在 UI 提醒
- **配额感知调度** —— 搜索配额低于安全线时自动跳过本轮刷新
- **快照降采样（rollup）** —— 超过 N 天的快照压缩为每周一条，长期部署不再无限增长
- **每源刷新频率** —— npm/HN 等慢变指标可单独设置最小刷新间隔
- 结构化日志（文本 / JSON）
- 优雅关闭
- Docker 部署支持
- **可选 PostgreSQL 后端**（外部 `pg` 或内嵌 PGlite，附 SQLite 数据迁移脚本）
- 默认零外部数据库依赖（使用 Node 内置 `node:sqlite`）

## 🧱 技术栈

| 组件 | 选型 |
|------|------|
| 运行时 | Node.js 22+（`node:sqlite` 需要 22+） |
| Web 框架 | Express 4 |
| 数据库 | SQLite（`node:sqlite`，无原生依赖）/ PostgreSQL 16（外部 `pg` 或内嵌 PGlite） |
| 定时任务 | node-cron |
| 前端 | 原生 HTML / CSS / JS（无构建步骤） |
| 测试 | `node:test`（零依赖） |

## 🚀 快速开始

```bash
git clone <repo>
cd github-star-tracker
npm install
cp .env.example .env   # 按需填写 GITHUB_TOKEN
npm start
```

访问 http://localhost:3001

## ⚙️ 配置（`.env`）

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GITHUB_TOKEN` | GitHub 个人访问令牌，**强烈建议配置**（匿名搜索仅 10 次/分钟） | 空 |
| `PORT` | 服务端口 | `3001` |
| `CRON_SCHEDULE` | 定时抓取的 cron 表达式 | `0 9 * * *`（每天 9:00） |
| `API_KEY` | 若设置，则所有 `/api/*` 需要该密钥 | 空（不启用认证） |
| `TRUST_PROXY` | 反代部署时设为 `true` 或 `loopback`，使限流/日志取到真实 IP | 空（关闭） |
| `VAPID_SUBJECT` | Web Push 的 VAPID `sub` 字段（一般为 `mailto:you@example.com`）| `mailto:admin@example.com` |
| `LOG_LEVEL` | 日志级别：`debug`/`info`/`warn`/`error` | `info` |
| `LOG_FORMAT` | 设为 `json` 输出 JSON 行日志 | 文本 |

### 获取 GitHub Token

1. 访问 https://github.com/settings/tokens
2. **Generate new token (classic)**
3. 无需勾选任何权限（仅用于提升 API 配额）
4. 填入 `.env` 的 `GITHUB_TOKEN`

> 认证用户搜索配额 30 次/分钟，匿名仅 10 次/分钟。
> 热门榜每轮抓取消耗 3 次搜索配额，每个「生态/Topic 追踪」额外消耗 1 次，请控制追踪数量。

**token 失效时会自动回退匿名**：启动时用 `/rate_limit`（不消耗配额）校验一次，
若 GitHub 返回 401 则记下失效、后续请求全部改用匿名，不会把整条采集链路停摆。
页面右上角会如实显示 `Token ✅` / `Token 失效·已回退匿名` / `匿名模式`，
`/api/stats` 也提供 `tokenState`（`none`/`unknown`/`ok`/`invalid`）。
失效时服务端日志会给出告警，按上面步骤重新生成 token 即可。

### 多用户模式

首次访问时若数据库中没有用户，页面会引导**创建管理员账号**；也可直接调用：

```bash
curl -X POST http://localhost:3001/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"username":"alice","password":"secret123"}'
```

之后：管理员在「设置 → 👥 用户管理」添加成员；成员用用户名/密码登录，只能看到自己的收藏、自定义仓库、指数、追踪、视图、告警与推送订阅。

### 运行时设置（页面「⚙️ 设置」Tab）

最低星数、增速下限、快照保留天数、告警阈值、掉星阈值、里程碑告警开关、自动轮询间隔、自定义搜索语法、Webhook 地址与类型、每日摘要时间、自动备份开关、**配额保护下限**、**外部指标刷新间隔**、**快照降采样天数**、主题、API Key。

> 每仓库的告警阈值可在仓库详情弹窗中单独覆盖（见 `PUT /api/repos/:id/alert`）。
> 浏览器通知在「设置 → 📲 浏览器通知」启用；VAPID 密钥对首次使用时自动生成并存入数据库，**无需手工配置**。
> Web Push 需要 **HTTPS 或 localhost**（浏览器限制）；订阅失效（404/410）会被自动清理。

## 🐘 数据库后端

默认用 SQLite（零依赖）。也可以切到 **PostgreSQL**：

```bash
# A) 内嵌 PGlite（Postgres 16 WASM，免服务器，最省事）
npm run start:postgres

# B) 外部 PostgreSQL
DATABASE_URL=postgres://user:pass@localhost:5432/gst DB_DRIVER=postgres node server.js
```

| 环境变量 | 说明 |
|----------|------|
| `DB_DRIVER` | `sqlite`（默认）或 `postgres` |
| `DATABASE_URL` | 外部 PostgreSQL 连接串；设置后优先使用（需要可选依赖 `pg`） |
| `PG_DATA_DIR` | 未设 `DATABASE_URL` 时，内嵌 PGlite 的数据目录（默认 `<DB_DIR>/pg`） |

**实现方式（重要）**：`node:sqlite` 是同步 API，而 `pg`/PGlite 是异步的。项目**没有**把整个数据层改成异步，而是把异步驱动放进 worker 线程，主线程用 `Atomics.wait` + `receiveMessageOnPort` 做**同步等待**（单次调用开销约 0.04ms）。因此上层代码、测试与调用约定完全不变——**同一套测试可以直接跑在两个后端上**：

```bash
npm test              # SQLite
npm run test:postgres # PostgreSQL（内嵌 PGlite）
```

代价与 SQLite 模式相同：数据库访问会阻塞事件循环；对本项目「单进程、串行访问」的定位不构成额外限制。

### 从 SQLite 迁移已有数据

```bash
npm run migrate:postgres -- --pg-data-dir data/pg
# 或迁移到外部 PostgreSQL：
npm run migrate:postgres -- --database-url postgres://user:pass@host/gst
```

采用**合并**语义（按唯一键去重），可安全重复执行；覆盖仓库、快照、告警、自定义仓库、收藏、指数、生态追踪、外部指标、推送订阅与用户。

> `/api/maintenance/export` 的 `.db` 备份仅适用于 SQLite；PostgreSQL 模式请用 `?format=json` 或 `pg_dump`。
>
> `pg` 与 `@electric-sql/pglite` 都是 **optionalDependencies**：只用 SQLite 时可以用 `npm ci --omit=optional` 跳过安装。

## 🐳 Docker 部署

```bash
# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f
```

或使用原生 Docker：

```bash
docker build -t github-star-tracker .
docker run -d -p 3001:3001 \
  -e GITHUB_TOKEN=ghp_xxx \
  -e API_KEY=your-secret \
  -v "$PWD/data:/app/data" \
  --name gst github-star-tracker
```

## 📡 API 端点

| 方法 | 路径 | 认证 | 说明 |
|------|------|:----:|------|
| GET | `/api/auth/status` | — | 登录状态 / 是否已有用户 |
| POST | `/api/auth/register` | — | 创建首个管理员（仅无用户时） |
| POST | `/api/auth/login` | — | 登录，返回会话令牌 |
| POST | `/api/auth/logout` | ✓ | 注销当前会话 |
| GET | `/api/auth/users` | 管理员 | 用户列表 |
| POST | `/api/auth/users` | 管理员 | 创建用户 |
| DELETE | `/api/auth/users/:id` | 管理员 | 删除用户 |
| PUT | `/api/auth/password` | ✓ | 修改自己的密码 |
| GET | `/health` | — | 健康检查 |
| GET | `/metrics` | — | Prometheus 指标（公开）|
| GET | `/api/settings` | ✓ | 获取设置 |
| PUT | `/api/settings` | ✓ | 更新设置 |
| GET | `/api/repos` | ✓ | 仓库列表（筛选/排序/分页/关键词） |
| GET | `/api/repos/:id/history` | ✓ | 星数历史 + 增长预测 |
| GET | `/api/repos/:id/alert` | ✓ | 读取该仓库的告警阈值覆盖 |
| PUT | `/api/repos/:id/alert` | ✓ | 设置/清除该仓库的告警阈值 |
| POST | `/api/repos/:id/backfill` | ✓ | 回填单个仓库历史（stargazers）|
| POST | `/api/backfill` | ✓ | 批量回填（scope=custom\|favorites\|all）|
| GET | `/api/favorites` | ✓ | 收藏列表（分页） |
| POST | `/api/favorites/:id/toggle` | ✓ | 收藏/取消 |
| GET | `/api/custom-repos` | ✓ | 自定义仓库（分页） |
| POST | `/api/custom-repos` | ✓ | 添加自定义仓库 |
| DELETE | `/api/custom-repos/:name` | ✓ | 删除自定义仓库 |
| GET | `/api/alerts` | ✓ | 告警列表（分页） |
| POST | `/api/alerts/read` | ✓ | 标记全部已读 |
| GET | `/api/languages/trends` | ✓ | 语言增长趋势 |
| GET | `/api/trends/rank` | ✓ | 排名变化（上升/下降） |
| GET | `/api/leaderboard` | ✓ | 排行榜（总星 Top N + 日均增长 Top N） |
| GET | `/api/trends/surge` | ✓ | 爆发榜（增速加速度） |
| GET | `/api/trends/anomaly` | ✓ | 异常检测（z-score）|
| GET | `/api/trends/rising` | ✓ | 黑马榜（低星高增速）|
| GET | `/api/trends/events` | ✓ | 事件聚类（同日多仓库异动）|
| GET | `/api/alerts/backtest` | ✓ | 告警规则回测 |
| GET | `/api/feed/:kind.xml` | ✓ | Atom 订阅（`surges`/`new`/`alerts`）|
| GET | `/api/compare` | ✓ | 多仓库对比（`ids=1,2&window=&metric=`）|
| GET | `/api/overview` | ✓ | 全局趋势与数据健康度 |
| GET | `/api/repos/:id/similar` | ✓ | 相似仓库推荐 |
| GET | `/api/repos/:id/enrich` | ✓ | 项目画像（topics/license/release/contributors）|
| GET | `/api/views` | ✓ | 保存的筛选视图列表 |
| POST | `/api/views` | ✓ | 保存/覆盖筛选视图 |
| DELETE | `/api/views/:name` | ✓ | 删除筛选视图 |
| GET | `/api/indices` | ✓ | 指数列表 |
| POST | `/api/indices` | ✓ | 创建指数（name + language/minStars/maxStars/keyword）|
| DELETE | `/api/indices/:id` | ✓ | 删除指数 |
| GET | `/api/indices/:id/series` | ✓ | 指数走势（`days`、`weight=equal\|cap`）|
| GET | `/api/queries` | ✓ | 生态/topic 追踪列表 |
| POST | `/api/queries` | ✓ | 新增追踪（label + GitHub 搜索语法）|
| DELETE | `/api/queries/:id` | ✓ | 删除追踪 |
| GET | `/api/queries/:id` | ✓ | 生态聚合走势与成员 |
| POST | `/api/queries/refresh` | ✓ | 立即抓取追踪成员 |
| GET | `/api/replay?at=ISO` | ✓ | 历史回放（重建某时刻榜单） |
| GET | `/api/sources` | ✓ | 可用外部数据源 |
| GET | `/api/metrics` | ✓ | 外部指标列表（含增长） |
| POST | `/api/metrics` | ✓ | 添加外部指标 |
| DELETE | `/api/metrics/:id` | ✓ | 删除外部指标 |
| POST | `/api/metrics/refresh` | ✓ | 刷新外部指标 |
| GET | `/badge/:owner/:repo.svg` | — | SVG 徽章（公开，可嵌入 README）|
| GET | `/badge/:owner/:repo.json` | — | shields.io endpoint（公开）|
| GET | `/spark/:owner/:repo.svg` | — | 迷你走势图（公开）|
| GET | `/api/stats` | ✓ | 全局统计、配额与失效仓库数 |
| POST | `/api/refresh` | ✓ | 立即刷新（限流 6 次/分钟） |
| POST | `/api/notify/test` | ✓ | 测试 Webhook |
| GET | `/api/webhook-types` | ✓ | 支持的推送渠道列表 |
| POST | `/api/notify/digest` | ✓ | 立即发送一次摘要 |
| GET | `/api/push/public-key` | ✓ | VAPID 公钥（浏览器订阅用）|
| POST | `/api/push/subscribe` | ✓ | 保存推送订阅 |
| POST | `/api/push/unsubscribe` | ✓ | 取消推送订阅 |
| GET | `/api/push/subscriptions` | ✓ | 推送订阅列表 |
| POST | `/api/push/test` | ✓ | 发送测试推送 |
| POST | `/api/maintenance/cleanup` | ✓ | 清理过期快照 + 降采样（rollup）|
| GET | `/api/maintenance/export` | ✓ | 导出备份（`.db`，加 `?format=json` 导出 JSON）|
| POST | `/api/maintenance/import` | ✓ | 导入 JSON（`mode=merge\|replace`）|

认证方式（按优先级）：
1. **会话**：请求头 `X-Session: <token>` 或查询参数 `?session=<token>`
2. **API Key**：请求头 `X-API-Key: <key>` 或 `?key=<key>`（视为管理员，适合自动化）
3. **单用户模式**：未创建任何用户时，`/api` 直接放行（与早期版本行为一致）

> 若配置了 `API_KEY`，即使未创建用户也仍需携带 Key（保持原有安全语义）。

## 🧩 嵌入与订阅

徽章、走势图、订阅均为公开端点（不占用 `/api` 认证，除非另行反代）：

```markdown
<!-- 星数徽章 -->
![stars](https://your-host/badge/vitejs/vite.svg)

<!-- 带增速、切换指标 -->
![forks](https://your-host/badge/vitejs/vite.svg?metric=forks&window=week)

<!-- 迷你走势图 -->
![trend](https://your-host/spark/vitejs/vite.svg?points=30)

<!-- shields.io endpoint（可用官方样式参数自定义） -->
![stars](https://img.shields.io/endpoint?url=https://your-host/badge/vitejs/vite.json)
```

RSS 阅读器订阅（若启用了 `API_KEY`，需在 URL 加 `?key=`）：

```
https://your-host/api/feed/surges.xml
https://your-host/api/feed/new.xml
https://your-host/api/feed/alerts.xml
```

## 🧪 测试

```bash
npm test          # 运行全部单元测试
npm run test:watch
```

覆盖：增长计算、过滤/分页、排名变化、预测、数据库操作、告警规则、多渠道编码、回填、导入导出、保存视图，以及 `tests/api.test.js` 中的 HTTP 路由集成测试（真启动 Express + fetch）。

要在真实 PostgreSQL 上验证（起库、每文件独立库、迁移后两端对拍、预期差异与已知坑）：见 [`docs/verification-checklist.md`](docs/verification-checklist.md)。

## 📁 项目结构

```
├── public/                # 前端（无构建）
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── manifest.webmanifest
│   ├── icon.svg
│   └── sw.js              # Service Worker（离线 shell）
├── src/
│   ├── db.js              # 数据库 schema、迁移、索引、CRUD
│   ├── dbdriver/          # 驱动层：sqlite / postgres（同步桥）+ SQL 方言转换
│   ├── github.js          # GitHub API 封装（重试、配额解析）
│   ├── tracker.js         # 采集与计算核心
│   ├── windows.js         # 时间窗口 / 增长计算共享定义（tracker+external 复用）
│   ├── external.js        # 外部指标采集与计算（P3）
│   ├── sources.js         # 数据源插件（npm/PyPI/Docker/crates）
│   ├── badge.js           # SVG 徽章生成
│   ├── backfill.js        # 历史回填（stargazers）
│   ├── digest.js          # 每日摘要构建与发送
│   ├── auth.js            # 口令哈希与会话令牌（scrypt）
│   ├── notify.js          # 多渠道推送
│   ├── webpush.js         # Web Push（VAPID + aes128gcm，零依赖）
│   ├── scheduler.js       # 定时任务、刷新锁与摘要调度
│   └── logger.js          # 结构化日志
├── scripts/
│   └── migrate-to-postgres.mjs  # SQLite → PostgreSQL 数据迁移
├── docs/
│   └── verification-checklist.md # 真实 PostgreSQL 验证清单（起库/对拍/已知坑）
├── tests/
│   ├── core.test.js       # 核心逻辑单元测试
│   └── api.test.js        # HTTP 路由集成测试
├── server.js              # 入口与路由
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── package.json
```

## 🔒 安全建议

- 部署到公网时**务必设置 `API_KEY`** 或**启用多用户模式**（二选一，否则 `/api` 无鉴权）
- 多用户模式下会话令牌保存在浏览器 `localStorage`，建议置于 HTTPS 之后
- `/api/maintenance/export` 会导出完整数据库（含 Webhook 地址等配置），请勿公开
- `/api/maintenance/import` 会写入数据，对外暴露时务必设置 `API_KEY`
- 默认仅监听端口，建议置于反向代理（Nginx/Caddy）之后并启用 HTTPS

## License

MIT
