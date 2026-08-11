# prism-demo 前端镜像（Vite build → nginx serve + 反代 /api 到 api 容器）
# 同时承担静态服务器和边缘 nginx 角色（PoC 简化：单 nginx 容器）

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/web ./apps/web
COPY packages/shared ./packages/shared
RUN pnpm --filter @prism/shared run build \
    && pnpm --filter @prism/web run build

FROM nginx:1.27-alpine AS runtime
COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
