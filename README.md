# GitHub Star Tracker

GitHub 星标追踪工具，实时监控热门仓库的星数变化。

## 功能

- 搜索 GitHub 热门仓库（按星标数排序）
- 记录星数历史快照
- 计算不同时间窗口的星数增长（24h/7天/30天）
- Web 界面查看统计和趋势图表
- 定时自动刷新（可配置 cron 表达式）
- 今日新增榜：仅显示今日获星的热门项目
- 导出 CSV 报告

## 技术栈

- **运行时**: Node.js 24+
- **框架**: Express.js
- **数据库**: SQLite (node:sqlite)
- **定时任务**: node-cron
- **前端**: 原生 HTML/CSS/JS

## 安装

```bash
npm install
```

## 配置

复制 `.env.example` 到 `.env` 并填写配置：

```bash
cp .env.example .env
```

环境变量：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `GITHUB_TOKEN` | GitHub 个人访问令牌（可选，提升 API 配额） | 空 |
| `PORT` | 服务端口 | `3001` |
| `CRON_SCHEDULE` | 定时刷新 cron 表达式 | `0 9 * * *` (每天9点) |

### 获取 GitHub Token

1. 访问 https://github.com/settings/tokens
2. 点击 "Generate new token (classic)"
3. 无需任何权限，仅需用于提升 API 配额限制

## 运行

```bash
npm start
```

访问 http://localhost:3001

## 作为系统服务运行

使用 NSSM 将应用注册为 Windows 服务：

```powershell
powershell -File setup-service.ps1
```

服务名称：`github-star-tracker`

## API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/repos` | 获取仓库列表 |
| GET | `/api/repos/:id/history` | 获取仓库星数历史 |
| GET | `/api/stats` | 获取统计信息 |
| POST | `/api/refresh` | 立即刷新数据 |
| GET | `/api/settings` | 获取设置 |
| PUT | `/api/settings` | 更新设置 |

## 项目结构

```
├── public/          # 前端静态文件
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── src/             # 后端模块
│   ├── db.js        # 数据库操作
│   ├── github.js    # GitHub API 调用
│   ├── tracker.js   # 追踪逻辑
│   └── scheduler.js # 定时任务
├── server.js        # 入口文件
├── package.json
└── .env.example
```

## License

MIT
