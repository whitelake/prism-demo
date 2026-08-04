# 项目上下文：prism-demo (候选人AI应用能力和潜力评估PoC）

## 这是什么

一个用于**验证假设**的内部试点系统，不是要交付的产品。核心是让候选人先与"AI考官"对话、再在"干净的AI助手"下完成实操任务，最后由AI评估其AI应用能力等级（L0–L4）。

**PoC 要验证的四个假设**（决定了本项目所有技术约束的来源）：

| 编号 | 假设 |
|------|------|
| H1 | AI评估结论与面试官独立判断具有可比性 |
| H2 | 先隐藏AI结论再解锁，能观测到锚定效应 |
| H3 | 工具模式的上下文隔离能获得候选人真实的AI使用水平 |
| H4 | 现场验证能修正AI的误判 |

**这意味着：本项目的产出物是数据，不是功能。** 任何"为了开发方便"而牺牲数据可信度或可观测性的做法都不可接受。

---

## ⚠️ 五条铁律（违反即导致 PoC 数据作废）

改动任何代码前先确认不会破坏以下五条。**这些不是最佳实践建议，是硬约束。**

### 铁律 1：工具模式上下文必须绝对干净

工具模式（`mode='tool'`）调用模型时，上下文中**不得出现**：问卷答案、候选人姓名、考官模式任何对话、任务描述文本、其他任务的历史。

- 工具模式的 System Prompt 是**静态常量**，从 `config/prompts/tool.md` 读取，**函数签名不接受任何参数**，不做任何模板变量替换
- 任务描述通过 API 直接返回给前端渲染系统卡片，**不经过 `llm.client`**
- 调用百炼时不传 `user` 字段（或传随机 UUID），不传 `assessmentId`
- `buildToolContext()` 查询 `dialogue_log` 时必须同时过滤 `mode='tool'` 且 `taskId=当前任务`

### 铁律 2：AI 结论必须在服务端隐藏，不靠前端

测评状态为 `pending_interview` 或 `final_evaluating` 时，所有接口响应中**不得出现** `evaluationA`、`level`、`confidence`、`dimensions` 等键名——**是不返回该键，不是返回 null 或空值**。

- 所有报告类接口的返回必须经过 `report.filter.ts` 的 `filterReport()`，**禁止直接 `return evaluation` 实体**
- 列表接口在锁定态下 `levelDisplay` 返回固定字符串 `"待验证"`
- 解锁的唯一触发路径：`interviewer_judgment` 插入成功 → 终判C完成 → 状态置 `completed`。不允许任何其他路径解锁
- **前端不实现任何隐藏逻辑**，只按 `locked` 字段渲染

### 铁律 3：`signals` 绝不下发前端

模型返回的 `signals`（如 `goal_coverage`、`answer_vagueness`、`mentioned_asset`）仅落库供后端决策与评估使用。

- 候选人端接口、面试官报告接口一律不含 `signals` 键
- **唯一例外**：`GET /assessments/{id}/export`（PoC 数据分析用）
- 原因：从浏览器开发者工具可直接看到考察逻辑，会污染样本

### 铁律 4：模型调用只有一个出口，且必须全量落库

全系统**禁止**在 `llm/llm.client.ts` 之外调用模型 API。

- 请求**在发起前**先写入 `llm_call_log`，即使调用失败也有记录
- `request_messages` 必须存 Prompt 全文，`response_raw` 必须存模型原始返回全文（未经解析）
- 禁止使用百炼的应用编排 / 智能体 / 会话管理能力，**只调底层 OpenAI 兼容 API**。原因：编排层会自动管理上下文，我们无法验证铁律 1

### 铁律 5：流程走向由后端状态机决定，模型不决定

阶段推进、模式切换、任务流转的判定**只能**出自 `assessment.state.ts` 的 `shouldAdvanceStage()`，不得在别处出现分支。

- 模型返回的 `signals` 只是该函数的**输入**，不是决策
- 判定优先级固定：总时长超限 > 候选人卡住 > 达到最大轮次 > 信息采集充分
- 前端不做任何流程判断，按后端返回的 `step` 渲染

---

## 技术栈

### 前端（`apps/web`）
- React 18 + TypeScript 5
- Vite
- Tailwind CSS（**不引入 Ant Design 或其他组件库**，避免样式冲突；需要复杂交互组件时用 Headless UI 或自行封装）
- Zustand
- React Router v6
- Vitest + React Testing Library

### 后端（`apps/api`）
- Node.js 20 + NestJS + TypeScript 5
- Prisma（ORM）
- MySQL 8.0（本地 Docker / 生产阿里云 RDS）
- Zod（模型返回的 Schema 校验）
- pino（日志）
- Jest + Supertest（单测 + 接口测试）

### 共享（`packages/shared-types`）
- 由 `openapi-typescript` 从后端 `/api/docs-json` 生成的 TS 类型
- 前端**只引用生成的类型**，禁止手写与后端重复的接口类型

### 基础设施
- 阿里云 ECS（2C4G）+ Docker Compose 单机部署
- 阿里云 RDS MySQL 8.0 基础版
- Nginx（SSL 终止 + 静态资源 + 反代，SSE 路径必须 `proxy_buffering off`）
- 阿里云百炼底层模型 API

### 明确不引入
Redis、消息队列、OSS、K8s/ACK、API 网关、WebSocket、微服务拆分、监控告警系统。

理由：5 并发、12–15 人样本。任何为规模化做的设计都是浪费。

---

## 目录结构
.
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── modules/
│   │   │   │   ├── auth/
│   │   │   │   ├── assessment/          # 生命周期 + 状态机
│   │   │   │   ├── questionnaire/
│   │   │   │   ├── dialogue/
│   │   │   │   │   ├── examiner.service.ts
│   │   │   │   │   ├── tool.service.ts
│   │   │   │   │   └── context.builder.ts    # ★铁律1 实现点
│   │   │   │   ├── evaluation/          # 评估A/C + 题纲（异步任务）
│   │   │   │   ├── interview/           # 面试记录 + 判断B
│   │   │   │   └── report/
│   │   │   │       └── report.filter.ts      # ★铁律2 实现点
│   │   │   ├── llm/
│   │   │   │   ├── llm.client.ts             # ★铁律4 唯一出口
│   │   │   │   ├── llm.logger.ts
│   │   │   │   └── json.parser.ts            # 三层防御解析
│   │   │   └── common/
│   │   ├── config/                      # ★挂载目录，支持热重载
│   │   │   ├── prompts/
│   │   │   │   ├── examiner.md
│   │   │   │   ├── tool.md
│   │   │   │   ├── evaluation.md
│   │   │   │   └── outline.md
│   │   │   ├── stages.yaml
│   │   │   ├── tasks.yaml
│   │   │   └── questionnaire.yaml
│   │   ├── prisma/schema.prisma
│   │   └── test/
│   └── web/
│       ├── src/
│       │   ├── features/
│       │   │   ├── candidate-entry/
│       │   │   ├── candidate-quiz/
│       │   │   ├── candidate-chat/      # ★核心
│       │   │   ├── interviewer-auth/
│       │   │   ├── interviewer-list/
│       │   │   └── interviewer-report/  # ★核心
│       │   ├── shared/
│       │   │   ├── api/                 # 请求封装 + SSE hook
│       │   │   ├── components/
│       │   │   └── hooks/
│       │   └── stores/
│       └── test/
├── packages/shared-types/
├── docs/
│   ├── prd.md                           # PRD v0.1
│   ├── architecture.md                  # 技术架构方案 v0.1
│   └── api-spec.md                       # 接口详细定义 v0.1
└── docker-compose.yml

---

## 架构规范

### 通用
- 禁止：循环依赖、`any` 类型、类组件、跨层直接访问（前端不直连 DB 概念、Controller 不写业务逻辑）
- 配置（Prompt、阶段参数、任务定义、问卷题目）一律放 `config/`，**禁止硬编码在代码里**。产品团队需要能自行修改 Prompt 而不改代码
- 所有业务规则（等级定义、触发条件、黑名单词表）必须能追溯到 PRD 章节，代码注释中标注来源章节号

### 后端
- 按 module 组织，每个 module 含 `controller / service / dto`
- Controller 只做参数校验与响应组装；业务逻辑在 Service
- 数据库访问统一走 Prisma，禁止裸 SQL（`JSON_EXTRACT` 等必要场景除外，需注释说明）
- 异步任务（评估、题纲、终判）用 `setImmediate` 或 `@nestjs/schedule` 一次性任务，**不引队列**。失败置状态 `eval_failed`，由面试官手动重试
- 所有 DTO 加 `@nestjs/swagger` 装饰器，OpenAPI 文档自动生成，**不手工维护 YAML**

### 前端
- 按 feature 组织，feature 内含组件、hooks、类型
- 跨 feature 复用放 `src/shared/`
- 候选人端与面试官端在同一应用内，用路由区分
- 候选人端 P3 对话页的两种模式**必须有明显视觉区分**（顶部条颜色/标识不同），让候选人明确感知"现在对面是普通 AI 助手"
- 系统卡片（模式切换提示、任务说明）由后端作为 `system_card` 类型消息返回，前端**按数组顺序渲染即可，不自行判断插入位置**

---

## 编码规范

- 组件：函数组件 + 具名导出，单文件不超过 200 行
- Service：单文件不超过 300 行，超出按职责拆分
- 命名：组件 PascalCase，变量/函数 camelCase，常量 UPPER_SNAKE_CASE，数据库字段 snake_case
- 导入顺序：第三方库 → 内部模块 → 类型 → 样式
- 提交信息：Conventional Commits（feat/fix/chore/docs/test/refactor）
- 涉及五条铁律的代码改动，提交信息中标注 `[铁律N]`，便于后续审计

---

## 关键实现约定

### 模型返回 JSON 的三层防御

模型输出 JSON 格式崩坏是最常见失败点，`json.parser.ts` 必须实现：

1. 剥离可能的 markdown 代码块包裹（```json ... ```）
2. 提取第一个 `{` 到最后一个 `}` 之间的内容（应对前后有多余说明文字）
3. `JSON.parse` 后用 Zod Schema 校验

重试策略：

| 场景 | 策略 |
|------|------|
| JSON 解析失败 | 重试 1 次（temperature 降 0.1），仍失败则报错 |
| Schema 校验失败（如 dimensions 不足 6 项） | 重试 1 次，仍失败则落库原始返回 + 状态置 `eval_failed` |
| 网络/超时 | 指数退避重试 3 次（1s/2s/4s） |

**评估失败不得静默**：必须落库原始返回，面试官侧显示"评估失败"+"重新评估"按钮，原始日志始终可看。

### 追问题纲的黑名单校验

题纲绝不能泄露 AI 的评估倾向。生成后必须过黑名单，命中则重试，3 次失败降级为"仅展示原始日志"。

黑名单正则至少包含：`/L[0-4]/`、等级词（初级/中级/高级）、评价词（优秀/出色/不足/薄弱/可疑/存疑/夸大/怀疑）、维度名（使用强度/任务拆解/核验意识/流程改造/影响力/组织推动）、`/等级|评分|置信度/`。

**题纲生成必须是独立的一次 `llm.call`，输入中不得包含评估结果。**

### 终判输入超限时的截断优先级

终判输入约 25000–40000 tokens。若超模型上下文上限，按此顺序截断：

| 优先级 | 内容 | 处理 |
|--------|------|------|
| 1（最先截） | 工具模式的 AI 回复 | 保留前 500 字 + `...(已截断)` |
| 2 | 考官模式的 AI 提问 | 保留全文（很短） |
| 3（绝不截） | 候选人的全部输入、面试文字记录 | 完整保留 |

理由：评估的证据来源是候选人的表达，AI 的输出只是上下文。

### 一致性对比的等级相等规则

比较 A/B/C 等级时，**`L3_pending` 与 `L3` 视为相等**（`L4_pending` 与 `L4` 同理）。`_pending` 只是"待验证"标记，不代表等级不同。此规则在后端实现，前端直接使用布尔值。

### SSE 流式（仅工具模式）

- 考官模式**不做流式**（返回 JSON，需完整解析），用普通 POST + loading
- 工具模式用 SSE，事件：`accepted` → `delta`* → `done` / `error`
- 前端用 `fetch` + `ReadableStream`（`EventSource` 不支持 POST）
- 前端**不做打字机延迟动效**，收到即渲染，保证候选人体感真实
- 模型调用失败时（`LLM_UNAVAILABLE`）**必须保留候选人已输入的内容**，不得清空输入框

### 计时

- 倒计时按服务端 `lastActivityTs` 计算，**刷新页面不重置**（防止候选人通过刷新刷时间）
- 前端基于 `lastActivityTs` 自行计时，达阈值调 `/skip`；**服务端会二次校验**实际间隔

---

## 测试要求

以下用例**必须**写成自动化测试并纳入 CI。任何修改后自动回归，红灯不得合并。

### 优先级最高：铁律验证

| 组 | 内容 |
|----|------|
| A. 结论锁定 | 锁定态 `/report` 与列表响应序列化后不含 `evaluationA`/`level`/`confidence`/`dimensions` 键；全文正则 `/L[0-4]/` 无匹配；提交B后仍锁定；终判完成后解锁 |
| B. 上下文隔离 | 工具模式 `llm_call_log.request_messages` 不含候选人姓名、问卷选项文本、任务描述关键词；T2 不含 T1 任何内容；tool system message 与 `prompts/tool.md` 文件内容完全一致 |
| C. signals 不下发 | `/message`、`/state`、`/report` 响应均不含 `signals` 键；`/export` **含** `signals`（唯一例外） |

### 其次：状态机与越权

跨面试官访问返回 403；重复提交判断B返回 409；提交B后改 transcript 返回 409；transcript 不足 100 字返回 422；已开始的测评重新生成链接返回 409；未达 600s 调 `/skip` 返回 422；并发发消息第二条返回 409。

### 前端测试

只测关键渲染分支：`locked=true` 时报告页不渲染任何结论区块；`step` 各值对应正确页面与输入区形态。不追求覆盖率。

---

## 常用命令

```bash
# 安装
pnpm install

# 本地依赖（MySQL）
docker compose -f docker-compose.dev.yml up -d

# 开发
pnpm dev              # 前后端并行
pnpm dev:api
pnpm dev:web

# 数据库
pnpm db:migrate       # prisma migrate dev
pnpm db:studio

# 类型同步（后端 DTO 改动后必须执行）
pnpm gen:types        # 从 /api/docs-json 生成 shared-types

# 测试
pnpm test             # 全部
pnpm test:invariants  # ★仅五条铁律相关用例，改动核心逻辑后必跑
pnpm test:api
pnpm test:web

# 构建与部署
pnpm build
docker compose up -d --build

# PoC 数据导出
pnpm export -- --output ./poc-data.json

## 文档来源与优先级
| 文档 | 内容 | 位置 |
|------|------|------|
| PRD v0.1 | 业务规则、等级定义、Prompt 设计、验收清单 | `docs/prd.md` |
| 技术架构方案 v0.1 | 选型、数据模型、关键实现、风险 | `docs/architecture.md` |
| 接口详细定义 v0.1 | 接口契约、枚举、错误码、测试清单 | `docs/api-spec.md` |

冲突时的优先级：本文件（CLAUDE.md）> 接口定义 > 技术架构 > PRD。

已知需覆盖的历史内容：架构文档 2.1 中的「Ant Design」选型作废，改用 Tailwind。

新增或变更需求：先更新对应文档，再改代码。 代码与文档不一致时以文档为准，并提示我修正。

##工作方式约定

遇到文档未定义的业务行为，停下来问我，不要自行发挥。 本项目的业务规则本身就是实验对象，你的"合理推测"会引入不受控变量。

改动 context.builder.ts / report.filter.ts / llm.client.ts / assessment.state.ts 这四个文件前，先复述你要动的部分对应哪条铁律、如何确保不破坏它。 这四个文件是 PoC 成败的关键实现点。

不要为了让测试通过而修改断言。 铁律相关的测试断言即需求本身，红灯说明实现错了。

不主动做性能优化、缓存、抽象封装。 5 并发场景下这些都是负收益，会增加审计难度。

Prompt 文件（config/prompts/*.md）不要自行改写。 内容归产品负责，你只负责读取与注入机制。如发现 Prompt 与代码期望的输出结构不匹配，报告给我。

每次完成一个模块后，主动列出该模块触及的铁律与对应测试是否已覆盖。

##明确不做的事（PoC 范围外）

界面美观优化、移动端适配、浏览器兼容（只支持最新版 Chrome）、防作弊、限流、WAF、数据加密脱敏、审计日志、多租户、权限分级、国际化、监控告警、性能压测、ASR 语音转写、文件上传、批量导入、邮件通知、独立测试环境（生产即测试，用 isTest 标记区分数据）。

如果你认为某项确实必要，先告诉我理由，由我决定。
