# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# prism-demo

## 当前仓库状态

仓库目前是脚手架阶段：

- 根目录尚无 `package.json`、无 workspace 配置；`src/` 和 `tests/` 为空目录
- `docs/prd.md`、`docs/architecture.md`、`docs/api-spec.md` 是当前唯一的"实现来源"
- `.claude/rules/*.md` 是针对具体代码范围的执行规则（含 `paths` frontmatter，对应 `apps/api/**`、`apps/web/**` 等）

不要假设命令、依赖或目录结构已存在。任务开始前先确认现状，再决定是按文档创建新代码还是修改已有代码。

## 项目目标

这是一个内部招聘AI素质测评PoC，用于验证对话式测评、工具模式实操和大模型评估能否产生可信、可比较的实验数据。

本项目不是正式招聘产品。优先级依次为：

1. 实验数据可信
2. 模型调用与决策过程可观测
3. 关键上下文和评估结论严格隔离
4. 实现简单且可审计
5. 开发便利和扩展性

不要为了性能、复用性或产品完整度增加PoC范围外能力。

## 实验假设

以 `docs/prd.md` 为准：

- H1：对话式测评能采集足够且有区分度的行为信息
- H2：大模型等级判定与面试官独立判断基本一致
- H3：工具模式能观测候选人的真实AI使用行为
- H4：加入面试记录后的大模型终判有效，并能接近面试官判断

## 不可破坏的约束

详细规则见 `.claude/rules/poc-invariants.md`。任何实现都必须满足：

1. 工具模式上下文与考官模式、问卷和其他任务严格隔离
2. 面试官提交B且终判C完成前，服务端不得返回A的评估结论
3. 模型内部signals不得进入常规前端接口
4. 所有模型调用只能通过统一LLM客户端，并完整记录请求和原始响应
5. 流程推进由后端状态机决定，模型只提供信号

修改以下文件前，先说明涉及哪条约束以及对应测试：

- `context.builder.ts`（约束1：工具模式上下文隔离）
- `report.filter.ts`（约束2：A结论锁定）
- `llm.client.ts`（约束4：模型调用唯一出口与全量落库）
- `assessment.state.ts`（约束5：后端控制流程推进）

这四个文件是 PoC 成败的关键实现点，详见 `docs/architecture.md` 第4章。不要通过削弱测试断言来绕过约束。

## 维度与等级体系

维度与等级的唯一来源是 yaml 配置，不要在代码或文档里硬编码档位文案：

- `config/dimensions.yaml`：4 个维度（D1 使用强度与场景广度 / D2 任务拆解与信息组织 / D3 核验意识 / D4 沉淀与外溢）。D4 由原流程改造/影响力/组织推动合并而来，旧维度名在 prompt 黑名单中仍禁止使用。
- `config/levels.yaml`：等级 L0 未达入门 / L1 入门 / L2 进阶 / L3 熟练 / L4 专家，以及唯一 pending 等级 L4_pending。
- v0.4 关键变更：L3_pending 已废除，L3 可在阶段 A 直接确定；L4 必须由现场追问补强，恒为 L4_pending，待面试后才能在阶段 C 升至 L4。一致性对比中 L4_pending ≡ L4。
- 代码层：`packages/shared/src/levels.ts` 的 `LEVELS` / `PENDING_LEVELS` / `EVALUATION_LEVELS` / `DIMENSION_CODES` / `TRACKS` / `EVIDENCE_GRADES` / `EVALUATION_A_LEVELS` 常量、`packages/shared/src/api-types.ts` 的类型别名（基于上述常量推导）、`apps/api/src/assessment/dimensions.config.ts` 的 `renderDimensionDefinitions()`、`apps/api/src/assessment/consistency.ts` 的 `levelValue` 必须与 yaml 保持一致。

Prompt 与代码 Schema 不一致时报告问题，不要静默兼容。

### outline 输出黑名单词表

题纲（outline）生成结果的 `ask` / `verify` / `follow_up` / `note` 字段不得命中以下正则（`quote` 字段为候选人原话，豁免校验）。完整实现见 `config/outline_blacklist.yaml` 与 `config/prompts/outline.md`：

| 类别 | 正则 |
|---|---|
| 等级编号 | `L[0-4]` |
| 评估术语 | `等级\|评分\|置信度\|待验证` |
| 档位中文名 | `初级\|中级\|高级\|入门\|进阶\|熟练\|专家` |
| 评价词 | `优秀\|出色\|不足\|薄弱\|可疑\|存疑\|夸大\|值得怀疑\|落差` |
| 维度名 | `使用强度\|场景广度\|任务拆解\|信息组织\|核验意识\|沉淀\|外溢\|影响力\|流程改造\|组织推动` |
| 轨道名 | `个人深度轨道\|团队负责人轨道` |

## 文档入口

- `docs/prd.md`：业务行为、实验规则、等级定义、验收标准
- `docs/architecture.md`：技术选型、数据模型、关键实现和部署
- `docs/api-spec.md`：接口契约、DTO、状态码和错误码
- `.claude/rules/`：针对具体代码范围的实现规则

不要把PRD或架构文档的大段内容复制到本文件。处理任务时只读取相关章节。

## 文档冲突

按以下原则处理：

1. 当前用户明确指令
2. 已确认的变更记录或ADR
3. PRD中的业务行为与实验约束
4. API Spec中的接口契约
5. Architecture中的实现约束
6. `.claude/` 中的执行规则

`.claude/` 文件不得自行创造业务需求。

如果文档冲突会影响实验结果、接口行为或数据结构，停止实现并报告冲突，不要自行推测。

## 工作方式

- 遇到未定义的业务行为时先提问
- 新增或变更需求时先更新正式文档，再修改代码
- Prompt内容由产品团队维护；不要自行改写 `config/prompts/*.md`
- 如果Prompt与代码Schema不一致，报告问题，不要静默兼容
- 完成模块后说明：
  - 修改内容
  - 涉及的PoC约束
  - 已运行的测试
  - 未解决风险
- 不主动增加缓存、队列、微服务、通用抽象或性能优化

## 技术基线

- 前端：React 18、TypeScript、Vite
- 后端：Node.js 20、NestJS、TypeScript
- 数据库：MySQL 8.0
- 部署：ECS + Docker Compose + Nginx
- 模型：阿里云百炼底层OpenAI兼容API
- 规模：最多5人并发，内部12–15人PoC

其他库和目录结构以 `docs/architecture.md`、ADR及现有代码为准。

## 常用命令

优先读取根目录 `package.json` 和 workspace 配置，不要假设命令存在。

核心逻辑修改后至少运行：

```bash
pnpm test
pnpm build

如果项目已定义专项约束测试，再运行：
```bash
pnpm test:invariants
```

不要编造未在 package.json 中定义的命令。
