# 安全政策

## 报告漏洞

请**不要**公开开 issue。使用 GitHub 私密漏洞报告：

<https://github.com/unrealinux/github-star-tracker/security/advisories/new>

请附上：复现步骤、影响范围、受影响版本（commit / 镜像 tag），以及你希望如何署名。

## 支持范围

只维护 `master` 上的最新版本。

## 部署方需注意

- **公网部署务必启用访问控制**：设置 `API_KEY` 或创建首个管理员启用多用户模式，二选一；否则 `/api/*` 无鉴权。
- `API_KEY` / `FEED_TOKEN` 只认请求头（`?key=` / `?session=` 已移除）；RSS 用只读的 `FEED_TOKEN`，不要把主密钥写进 URL。
- 反代后要设 `TRUST_PROXY`，否则限流取到的是代理 IP。
- 本项目的运行时依赖只有 `express` 与 `node-cron`；`pg` / `@electric-sql/pglite` 为可选。升级依赖请走 Dependabot 的 PR 并等 CI 绿。
