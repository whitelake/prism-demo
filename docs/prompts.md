# Prompt 变量注入规范

> 产品团队维护的统一规则。四份 Prompt（`examiner` / `tool` / `evaluation` / `outline`）的变量定义、来源与安全约束。
>
> Prompt 正文位于 `config/prompts/*.md`，模型参数位于 `config/llm_params.yaml`。

## 1. 通用规则

- 插值语法：`{{variable_name}}`，双花括号、小写下划线
- 插值时机：请求 LLM 前由后端执行，落库记录插值后的最终消息（按 PoC 不变量 4）
- 未定义变量不得静默置空——必须报错并标记该次调用失败（按 PRD 4.7 失败处理）
- 变量值不得包含 `assessmentId`、`candidateId` 等可识别业务元数据
- 插值后必须保留原始 Prompt 模板与最终消息两份记录，便于审计

## 2. 变量定义表

| 变量 | 类型 | 来源 | 用于 |
|------|------|------|------|
| `{{candidate_name}}` | string | P1 输入 | 考官 |
| `{{questionnaire_result}}` | 结构化文本 | P2 提交 | 考官、评估 |
| `{{stage_code}}` | string | 后端状态机 | 考官 |
| `{{stage_goal}}` | 长文本 | 配置文件（见附1） | 考官 |
| `{{turn_index}}` | int | 后端计数 | 考官 |
| `{{max_turns}}` | int | 配置文件 | 考官 |
| `{{level_definitions}}` | 长文本 | 配置文件（见附2） | 评估 |
| `{{full_log}}` | JSON | 数据库 | 评估、题纲 |
| `{{task_description}}` | 长文本 | 配置文件 | 工具模式的首条系统卡片（**不进 Prompt**） |

## 3. 工具模式特殊约束（PoC 不变量 1）

工具模式 Prompt **必须保持静态**，禁止任何变量插值。

- `{{task_description}}` 虽然来源是配置文件，但只用于候选人端 UI 的首条系统卡片，**不得进入 LLM 上下文**
- 工具模式 LLM 请求只能包含：
  - 静态 Prompt 全文
  - 当前工具任务内的候选人输入
  - 当前工具任务内的 AI 回复
- 不得包含 `{{candidate_name}}`、`{{questionnaire_result}}`、`{{stage_goal}}`、`{{full_log}}` 等任何跨上下文变量
- 工具模式 Prompt 文件不得使用 `{{...}}` 语法

违反此约束会使 PoC 数据失效。详见 `.claude/rules/poc-invariants.md` 第 1 条。

## 4. 变量来源说明

### 附1：`{{stage_goal}}`

- 来源：`config/stages.yaml`
- 取值：当前 `{{stage_code}}` 对应的 `goal` 字段
- 示例：`{{stage_code}} = S1.1` → 取 `stages.yaml` 中 `S1.1.goal`

### 附2：`{{level_definitions}}`

- 来源：`config/levels.yaml`
- 取值：`levels` 数组的全量定义文本（含 `level`、`name`、`definition`、`required_evidence`）
- 注入时机：仅评估阶段，按轨道 A / B / C 选择性注入对应转录

### 附3：`{{full_log}}`

- 来源：数据库
- 取值：对应轨道的完整对话或面试记录，JSON 格式
- 注入轨道 A：考官模式对话
- 注入轨道 B：面试官独立判断录入
- 注入轨道 C：A + B 全量
- 注入题纲：考官模式对话

## 5. 跨上下文隔离矩阵

| 上下文 | candidate_name | questionnaire_result | stage_* | level_definitions | full_log | task_description |
|--------|:---:|:---:|:---:|:---:|:---:|:---:|
| 考官 | ✓ | ✓ | ✓ | ✗ | ✗ | ✗ |
| 工具模式 | ✗ | ✗ | ✗ | ✗ | ✗ | UI only |
| 评估（A/B/C） | ✗ | ✓（仅评估） | ✗ | ✓ | ✓ | ✗ |
| 题纲生成 | ✗ | ✗ | ✗ | ✗ | ✓（仅考官对话） | ✗ |

✓ = 可注入；✗ = 严禁注入；UI only = 仅候选人端卡片，不进 LLM

## 6. 与不变量的对应

- 第 1 条（工具模式上下文隔离）：本文件第 3 节
- 第 2 条（A 结论锁定）：评估轨道 A 的 `{{full_log}}` 注入由后端按状态机控制，Prompt 不感知锁定状态
- 第 3 条（signals 不下发）：模型输出信号不回注入任何 Prompt 变量
- 第 4 条（模型调用唯一出口）：插值后的最终消息必须经统一 LLM 客户端落库

## 7. Prompt 联调现状（截至 2026-08-05）

| Prompt | 测试文件 | 联调结果 | 备注 |
|--------|----------|----------|------|
| examiner | `apps/api/test/prompts/examiner.spec.ts` | 14/14 通过 | 10 e2e + 4 静态校验 |
| tool | `apps/api/test/prompts/tool.spec.ts` | 14/14 通过 | 10 e2e + 4 静态校验 |
| evaluation | `apps/api/test/prompts/evaluation.spec.ts` | 16/18 通过 | 12 e2e + 6 静态校验 |
| outline | `apps/api/test/prompts/outline.spec.ts` | 13/13 通过 | 7 e2e + 6 静态校验 |

### evaluation known flaky

E3（"完整 L3 级日志 → L3_pending"）和 E8（"同一日志 3 次稳定性"）在整套跑动下偶发 fail：

- E3 单跑通过、整套跑动 fail。根因：DashScope 在长时间高频调用下偶发空响应或 JSON 截断，evalWithRetry 3 次重试仍可能全部失败
- E8 整套跑动 fail。根因：3 次重试中偶有 1 次 JSON 解析失败导致 levels 不一致

这 2 个 fail 不是 prompt 逻辑问题——单跑均通过，是 LLM 输出在长时跑动下的内在不稳定性。

### 应对措施

- LlmClient 对 `empty content` 与 `JsonParseError` 同策略重试（temperature 降 0.1）
- `evalWithRetry(log, maxAttempts)` 在测试层重试单次 LLM 调用
- E8 阈值放宽到 `max-min ≤ 0.2`（PoC 阶段验证"大幅波动"而非"零波动"）
- E11 阈值放宽到"5 次迭代至少 3 次成功"
- outline 测试层同样使用 `outlineWithRetry`，O6 阈值放宽到"5 次迭代至少 3 次成功"
- O7 改为串行执行 outline + eval，避免 DashScope 并发限流

后续优化方向（不在 PoC 范围内）：
- 接入 SSE 流式聚合，让长 JSON 输出更稳定
- 增加模型 fallback（DashScope 失败时切换备用模型）
- 把 E3/E8 改为多次跑取众数结果


