# syntax=docker/dockerfile:1
FROM node:22-alpine

# node:sqlite 在 Alpine 上需要的基础库（musl 版 Node 已内置）
WORKDIR /app

# 先装依赖（利用层缓存）
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 拷贝源码
COPY src ./src
COPY public ./public
COPY server.js ./
COPY .env.example ./

# 数据目录（挂载卷）。注意：不加 VOLUME 指令——Railway 不支持
# Dockerfile 的 VOLUME，需用 Railway 自身的 Volume 机制（Railway 的
# Postgres 服务已自带卷；web 服务在 DB_DRIVER=postgres 模式下不落本地盘）
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# 健康检查
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 使用非 root 用户运行
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

CMD ["node", "server.js"]
