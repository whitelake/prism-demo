# prism-demo API 镜像（NestJS）
# 多阶段构建：builder 编译 TS → runtime 仅含 dist + 运行时依赖
# 不变量 4：所有 LLM 调用走 LlmClient，无需在镜像层做特殊处理

FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json .npmrc ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared
RUN pnpm --filter @prism/shared run build \
    && pnpm --filter @prism/api run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget \
    && corepack enable && corepack prepare pnpm@11.1.2 --activate
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY config ./config
# pnpm@11.1.2 在 --prod 模式下不会为 workspace link: 依赖建立符号链接（已验证：
# 去掉 --prod 才会生成 apps/api/node_modules/@prism/shared -> ../../../../packages/shared，
# 带 --prod 无论是否 --frozen-lockfile 都不生成），手动补上避免运行时 MODULE_NOT_FOUND
RUN mkdir -p apps/api/node_modules/@prism \
    && ln -s ../../../../packages/shared apps/api/node_modules/@prism/shared
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O- http://localhost:3000/api/v1/health || exit 1
CMD ["node", "apps/api/dist/main.js"]
