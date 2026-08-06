# prism-demo

内部招聘AI素质测评PoC。详见 `docs/prd.md`、`docs/architecture.md`、`docs/api-spec.md`。

## 目录结构

```
apps/
  api/         NestJS 后端
  web/         Vite + React 前端
packages/
  shared/      前后端共享类型与枚举
config/        Prompt / 题目 / 阶段配置（产品团队维护，热更新）
docs/          PRD / 架构 / API Spec
.claude/       Claude Code 规则与约束
```

## 本地开发

```bash
# 安装依赖
pnpm install

# 启动本地 MySQL（首次需要）
docker compose up -d mysql

# 拷贝环境变量
cp .env.example .env

# 启动前后端（并行）
pnpm dev
```

前端：http://localhost:5173
后端：http://localhost:3000
Swagger：http://localhost:3000/api/v1/docs

## 常用命令

```bash
pnpm dev              # 启动所有 workspace dev server
pnpm build            # 构建所有 workspace
pnpm test             # 运行所有测试
pnpm test:invariants  # PoC 约束测试（详见 .claude/rules/testing.md）
pnpm typecheck        # 类型检查
```
