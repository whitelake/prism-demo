
**版本**：v0.1
**配套文档**：PRD v0.1、技术架构方案 v0.1
**用途**：前后端并行开发的契约文档

---

# 第1章 通用约定

## 1.1 基础信息

| 项 | 值 |
|----|----|
| Base URL | `https://{domain}/api/v1` |
| 编码 | UTF-8 |
| 请求/响应格式 | `application/json`（SSE接口除外） |
| 时间格式 | ISO 8601 带时区，如 `2025-03-14T10:23:45.123+08:00` |
| ID 格式 | UUID v4 字符串 |

## 1.2 鉴权

| 端 | 方式 | 说明 |
|----|------|------|
| 候选人 | URL 路径中的 `token` | 32位随机字符串，与测评一对一。**无需登录**，不带 Header |
| 面试官 | `Authorization: Bearer {jwt}` | 有效期 12 小时 |
| 管理 | `X-Admin-Key: {key}` | 仅配置重载接口，环境变量配置 |

## 1.3 响应约定

**成功**：HTTP 200/201，Body 直接是数据对象，无外层包裹。

**失败**：HTTP 4xx/5xx，Body 为统一错误结构：

```json
{
  "error": {
    "code": "TOKEN_INVALID",
    "message": "测评链接无效或已失效",
    "detail": null
  }
}
```

| 字段 | 说明 |
|------|------|
| `code` | 机器可读错误码，前端据此分支处理 |
| `message` | 面向用户的中文提示，前端可直接展示 |
| `detail` | 调试信息，生产环境可能为 null |

## 1.4 HTTP 状态码使用

| 码 | 使用场景 |
|----|---------|
| 200 | 成功 |
| 201 | 创建成功（新建测评） |
| 400 | 参数校验失败 |
| 401 | 未登录 / token 无效 / JWT 过期 |
| 403 | 越权（面试官访问非自己创建的测评） |
| 404 | 资源不存在 |
| 409 | 状态冲突（如重复提交判断B、上一轮未完成） |
| 422 | 业务规则不满足（如面试记录为空却提交判断） |
| 500 | 服务端错误 |
| 503 | 模型API不可用 |

---

# 第2章 枚举与公共结构

## 2.1 枚举定义

```typescript
/** 测评状态 */
type AssessmentStatus =
  | 'not_started'         // 未开始
  | 'in_progress'         // 进行中
  | 'evaluating'          // 评估中
  | 'completed'           // 已完成
  | 'pending_interview'   // 待现场验证   ★锁定
  | 'final_evaluating'    // 终判中       ★锁定
  | 'abandoned'           // 已放弃
  | 'eval_failed';        // 评估失败

/** 候选人端当前应渲染的步骤 */
type CandidateStep =
  | 'entry'           // 入口页（确认姓名）
  | 'questionnaire'   // 选择题
  | 'examiner'        // 考官模式对话
  | 'tool'            // 工具模式实操
  | 'finished';       // 结束页

/** 对话模式 */
type DialogueMode = 'examiner' | 'tool';

/** 阶段/任务代号 */
type StageCode = 'S1.1' | 'S1.2' | 'S1.3';
type TaskCode  = 'T1' | 'T2';

/** 等级 */
type Level          = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
type EvaluationLevel = Level | 'L3_pending' | 'L4_pending';

/** 轨道 */
type Track = '个人深度轨道' | '团队负责人轨道' | '无法判断';

/** 维度代号 */
type DimensionCode = 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';

/** 证据来源 */
type EvidenceSource =
  | 'questionnaire' | 'examiner_dialogue' | 'tool_task' | 'interview_transcript';

/** 落差程度 */
type GapLevel = '无' | '轻微' | '重大';
```

## 2.2 消息对象（候选人端渲染的统一结构）

前端只需按数组顺序渲染，不需要自己判断插入位置。

```typescript
interface Message {
  id: number;                    // 递增序号，用于去重
  type: 'ai' | 'candidate' | 'system_card';
  mode: DialogueMode | null;     // system_card 为 null
  content: string;               // ai/candidate 的文本内容
  card?: SystemCard;             // 仅 type='system_card'
  ts: string;                    // ISO 时间
}

interface SystemCard {
  variant: 'mode_switch' | 'task_brief' | 'task_done' | 'notice';
  title: string;
  body: string;                  // 支持简单 Markdown（换行、加粗、列表）
  attachment?: {                 // T2 的核查材料
    label: string;
    content: string;             // 纯文本材料全文
  };
}
```

**设计说明**：模式切换提示、任务说明卡片都作为 `system_card` 混在消息流中返回，前端无需感知业务逻辑。这样阶段推进、模式切换的时机完全由后端控制（对应架构文档"流程由后端控制"原则）。

## 2.3 计时对象

```typescript
interface TimerInfo {
  examinerTotalRemainingSec: number | null;  // 考官模式总剩余（仅 step=examiner）
  taskRemainingSec: number | null;           // 当前任务剩余（仅 step=tool）
  idleWarningAtSec: number;                  // 无操作提醒阈值，固定 300
  idleSkipAtSec: number;                     // 无操作跳过阈值，固定 600
  lastActivityTs: string;                    // 最后一次候选人操作时间
}
```

**空闲判定**：前端基于 `lastActivityTs` 自行计时，达到阈值后调用跳过接口。**服务端会二次校验**实际间隔，防止前端误触。

---

# 第3章 候选人接口

> 所有接口路径前缀：`/api/v1/c/{token}`
> 所有接口在 token 无效时返回 `401 TOKEN_INVALID`

## 3.1 获取测评入口信息

```
GET /api/v1/c/{token}
```

**响应 200**

```json
{
  "assessmentId": "a1b2c3d4-...",
  "candidateName": "陈曦",
  "position": "运营专员",
  "status": "not_started",
  "step": "entry",
  "estimatedMinutes": 30,
  "notice": "本次测评包含选择题、对话交流和两个实操任务。\n请使用电脑完成，全程约30分钟。\n过程中请如实描述你的实际做法。",
  "canResume": false
}
```

| 字段 | 说明 |
|------|------|
| `candidateName` | 面试官创建时录入的姓名，入口页预填 |
| `step` | 前端据此跳转。若为 `finished` 直接显示结束页 |
| `canResume` | 是否有未完成的进度可续答 |

**响应 410 ASSESSMENT_ABANDONED**：测评已被标记放弃。

---

## 3.2 开始测评

```
POST /api/v1/c/{token}/start
```

**请求**

```json
{ "confirmedName": "陈曦" }
```

| 字段 | 必填 | 校验 |
|------|------|------|
| `confirmedName` | 是 | 1–20 字符，非空白 |

**响应 200**

```json
{
  "status": "in_progress",
  "step": "questionnaire",
  "startedAt": "2025-03-14T10:00:00.000+08:00"
}
```

**响应 409 ALREADY_STARTED**：已开始，前端应改调 `GET /state` 续答。

**说明**：候选人可修改姓名（如面试官录入有误），修改后覆盖 `assessment.candidate_name`。

---

## 3.3 获取问卷题目

```
GET /api/v1/c/{token}/questionnaire
```

**响应 200**

```json
{
  "questions": [
    {
      "code": "Q1",
      "type": "single",
      "title": "你使用AI工具的频率大概是？",
      "options": [
        { "value": "几乎不用", "label": "几乎不用" },
        { "value": "偶尔用", "label": "偶尔用（一周几次）" },
        { "value": "每天一次", "label": "每天一次左右" },
        { "value": "每天多次", "label": "每天多次" }
      ],
      "required": true
    },
    {
      "code": "Q2",
      "type": "multiple",
      "title": "你主要用AI做哪些事？（可多选）",
      "options": [
        { "value": "写文案", "label": "写文案/邮件/文档" },
        { "value": "查资料", "label": "查资料/找信息" },
        { "value": "数据处理", "label": "数据整理与分析" },
        { "value": "翻译", "label": "翻译" },
        { "value": "编程", "label": "写代码/脚本" },
        { "value": "其他", "label": "其他" }
      ],
      "required": true,
      "minSelect": 1
    }
  ]
}
```

**设计说明**：题目定义**从后端配置文件读取**（`config/questionnaire.yaml`），产品可自行修改题目与选项而无需改前端代码。前端按 `type` 渲染单选/多选。

---

## 3.4 提交问卷

```
POST /api/v1/c/{token}/questionnaire
```

**请求**

```json
{
  "answers": {
    "Q1": "每天多次",
    "Q2": ["写文案", "数据处理"],
    "Q3": "给过同事用",
    "Q4": "偶尔",
    "Q5": "本周"
  }
}
```

**校验**：必答题不得缺失；单选值必须在选项内；多选至少 `minSelect` 项。违反返回 `400 QUESTIONNAIRE_INVALID`，`detail` 指出具体题号。

**响应 200**

```json
{
  "step": "examiner",
  "currentStage": "S1.1",
  "turnIndex": 1,
  "messages": [
    {
      "id": 1,
      "type": "system_card",
      "mode": null,
      "card": {
        "variant": "mode_switch",
        "title": "接下来是对话交流",
        "body": "我会问你几个关于日常使用AI的问题，请按实际情况回答。\n没有标准答案，如实描述即可。"
      },
      "ts": "2025-03-14T10:02:10.000+08:00"
    },
    {
      "id": 2,
      "type": "ai",
      "mode": "examiner",
      "content": "你好陈曦，接下来我们聊聊你平时使用AI的情况。你提到每天会用多次，今天用AI做了什么吗？",
      "ts": "2025-03-14T10:02:11.500+08:00"
    }
  ],
  "timer": {
    "examinerTotalRemainingSec": 900,
    "taskRemainingSec": null,
    "idleWarningAtSec": 300,
    "idleSkipAtSec": 600,
    "lastActivityTs": "2025-03-14T10:02:10.000+08:00"
  }
}
```

**⚠ 重要**：响应中**不包含** `signals` 字段。模型返回的 signals 仅落库供后端决策与评估使用，**绝不下发前端**——避免通过浏览器开发者工具泄露考察逻辑。

---

## 3.5 提交回答（考官模式）

```
POST /api/v1/c/{token}/message
```

**请求**

```json
{
  "content": "今天早上让它帮我整理了一份周报的数据，把三个表格的数字合到一起。",
  "clientTs": "2025-03-14T10:03:40.000+08:00"
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `content` | 是 | 1–5000 字符 |
| `clientTs` | 否 | 客户端时间，仅作参考记录 |

**响应 200**

```json
{
  "step": "examiner",
  "currentStage": "S1.2",
  "turnIndex": 1,
  "stageAdvanced": true,
  "newMessages": [
    {
      "id": 5,
      "type": "candidate",
      "mode": "examiner",
      "content": "今天早上让它帮我整理了一份周报的数据...",
      "ts": "2025-03-14T10:03:40.000+08:00"
    },
    {
      "id": 6,
      "type": "ai",
      "mode": "examiner",
      "content": "那次它给出结果之后，你有去核对过里面的数字吗？",
      "ts": "2025-03-14T10:03:46.200+08:00"
    }
  ],
  "timer": { "examinerTotalRemainingSec": 684, "...": "..." }
}
```

| 字段 | 说明 |
|------|------|
| `stageAdvanced` | 本轮是否发生阶段推进。前端可用于埋点，不用于渲染 |
| `newMessages` | **增量**消息（含候选人自己的这条回显）。前端 append 即可 |
| `currentStage` | 推进后的阶段。**前端不展示阶段名称给候选人** |

**阶段推进时的响应**：后端会在 `newMessages` 中自动插入必要的 `system_card`，前端无需处理。

**考官模式结束、切换到工具模式时的响应**：

```json
{
  "step": "tool",
  "currentStage": null,
  "currentTask": "T1",
  "turnIndex": 0,
  "stageAdvanced": true,
  "newMessages": [
    { "id": 20, "type": "candidate", "...": "..." },
    {
      "id": 21,
      "type": "system_card",
      "card": {
        "variant": "mode_switch",
        "title": "接下来进入实操环节",
        "body": "下面的AI是一个**普通的AI助手**，它不了解本次测评的任何信息。\n请像平时使用AI一样，自己组织你的需求。"
      },
      "ts": "..."
    },
    {
      "id": 22,
      "type": "system_card",
      "card": {
        "variant": "task_brief",
        "title": "任务一",
        "body": "你需要给一家合作供应商写一封催货邮件。\n对方交付已延期，你希望对方尽快给出明确的交付时间，同时不希望破坏后续的合作关系。\n\n请在下方输入框中，自己组织语言让AI帮你完成。"
      },
      "ts": "..."
    }
  ],
  "timer": {
    "examinerTotalRemainingSec": null,
    "taskRemainingSec": 600,
    "...": "..."
  }
}
```

**⚠ 关键约束**：`card.body` 中的任务描述**由前端渲染展示，绝不进入工具模式的模型上下文**（架构文档 4.1 约束2）。前端只需展示，不要把它拼进后续的请求。

**响应 409 TURN_IN_PROGRESS**：上一轮模型调用未完成。前端应禁用输入框直到收到响应，此错误为兜底。

**响应 503 LLM_UNAVAILABLE**：模型调用失败。前端展示"网络异常，请重试"+重试按钮，**候选人的输入内容需保留在输入框，不得丢失**。

---

## 3.6 提交提示词（工具模式，SSE 流式）

```
POST /api/v1/c/{token}/message/stream
Accept: text/event-stream
```

**请求**（同 3.5）

```json
{ "content": "帮我写一封催货邮件，供应商延期了两周..." }
```

**响应 200**，`Content-Type: text/event-stream`

```
event: accepted
data: {"candidateMessageId":31,"aiMessageId":32}

event: delta
data: {"text":"尊敬的"}

event: delta
data: {"text":"张经理：\n\n"}

event: delta
data: {"text":"关于我方于..."}

event: done
data: {"aiMessageId":32,"turnIndex":1,"taskRemainingSec":540,"finishReason":"stop"}
```

### 事件定义

| 事件 | data 结构 | 说明 |
|------|----------|------|
| `accepted` | `{candidateMessageId, aiMessageId}` | 已受理并落库候选人输入，即将开始流式输出 |
| `delta` | `{text}` | 文本增量。前端追加拼接 |
| `done` | `{aiMessageId, turnIndex, taskRemainingSec, finishReason}` | 输出完毕，AI 回复已落库 |
| `error` | `{code, message}` | 出错。前端展示重试按钮 |

`finishReason` 取值：`stop`（正常结束）| `length`（达到长度上限）。

### 前端实现要点

| # | 要点 |
|---|------|
| 1 | 用 `fetch` + `ReadableStream` 而非 `EventSource`（EventSource 不支持 POST） |
| 2 | 收到 `accepted` 后即可清空输入框并显示候选人气泡 |
| 3 | 流式过程中禁用输入框；收到 `done` 或 `error` 后恢复 |
| 4 | 连接中断（无 `done` 也无 `error`）：显示"连接中断，请重试"，重试时重新发送原内容。后端已落库的孤立记录由评估时忽略 |
| 5 | **不做打字机动效延迟**，收到即渲染，保证候选人体感真实 |

---

## 3.7 完成当前实操任务

```
POST /api/v1/c/{token}/task/complete
```

候选人点击"完成这个任务"按钮时调用。

**请求**：无 Body

**响应 200 —— 还有下一个任务**

```json
{
  "step": "tool",
  "currentTask": "T2",
  "turnIndex": 0,
  "newMessages": [
    {
      "id": 40,
      "type": "system_card",
      "card": { "variant": "task_done", "title": "任务一已完成", "body": "" }
    },
    {
      "id": 41,
      "type": "system_card",
      "card": {
        "variant": "task_brief",
        "title": "任务二",
        "body": "下面这段材料是从一份行业报告里摘出来的...\n请让AI帮你判断这段材料是否可以直接用在你的方案中。",
        "attachment": {
          "label": "待核查材料",
          "content": "2024年国内某细分市场规模达到 480 亿元，同比增长 62%..."
        }
      }
    }
  ],
  "timer": { "taskRemainingSec": 600, "...": "..." }
}
```

**响应 200 —— 全部任务完成，测评提交**

```json
{
  "step": "finished",
  "status": "evaluating",
  "submittedAt": "2025-03-14T10:28:30.000+08:00",
  "finishMessage": "测评已提交，感谢你的参与。\n结果会由面试官统一查看，无需你做其他操作。"
}
```

**响应 422 NO_INTERACTION**：当前任务候选人一轮都没有输入就点完成。返回提示"请至少与AI交流一次"。是否强制由配置 `tasks.yaml` 的 `requireMinTurns` 控制（默认 1）。

---

## 3.8 超时跳过

```
POST /api/v1/c/{token}/skip
```

前端检测到无操作达 `idleSkipAtSec`（600秒）后调用。

**请求**

```json
{ "reason": "idle_timeout" }
```

**服务端校验**：实际 `now - lastActivityTs >= 600s`。不满足返回 `422 SKIP_NOT_ALLOWED`。

**响应 200**：结构同 3.5 / 3.7（推进到下一阶段或任务，或直接提交）。

**说明**：任务倒计时（`taskRemainingSec`）归零同样调用此接口，`reason` 传 `task_timeout`。

---

## 3.9 获取当前完整状态（续答/刷新）

```
GET /api/v1/c/{token}/state
```

页面刷新、意外关闭后重进时调用，返回全量消息用于恢复现场。

**响应 200**

```json
{
  "assessmentId": "a1b2c3d4-...",
  "candidateName": "陈曦",
  "status": "in_progress",
  "step": "tool",
  "currentStage": null,
  "currentTask": "T1",
  "turnIndex": 2,
  "messages": [ "...全量消息数组，含所有 system_card..." ],
  "timer": { "taskRemainingSec": 421, "...": "..." },
  "inputEnabled": true
}
```

| 字段 | 说明 |
|------|------|
| `messages` | **全量**（区别于 3.5 的 `newMessages`），前端直接替换整个列表 |
| `inputEnabled` | false 表示当前不接受输入（如已提交） |

**说明**：倒计时按服务端 `lastActivityTs` 重新计算，不因刷新而重置——避免候选人通过刷新页面刷新时间。

---

# 第4章 面试官接口

## 4.1 登录

```
POST /api/v1/auth/login
```

**请求**

```json
{ "account": "zhangwei", "password": "******" }
```

**响应 200**

```json
{
  "token": "eyJhbGciOi...",
  "expiresAt": "2025-03-14T22:00:00.000+08:00",
  "interviewer": { "id": "u-001", "name": "张伟" }
}
```

**响应 401 CREDENTIAL_INVALID**：账号或密码错误。**不区分账号不存在与密码错误。**

---

## 4.2 获取当前登录信息

```
GET /api/v1/auth/me
```

**响应 200**：`{ "id": "u-001", "name": "张伟" }`

---

## 4.3 测评列表

```
GET /api/v1/assessments?status={status}&keyword={kw}&page=1&pageSize=20
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `status` | 否 | 按状态筛选，多值逗号分隔 |
| `keyword` | 否 | 按候选人姓名/岗位模糊搜索 |
| `page` / `pageSize` | 否 | 默认 1 / 20 |

**响应 200 ★含锁定过滤**

```json
{
  "total": 12,
  "page": 1,
  "pageSize": 20,
  "items": [
    {
      "id": "a1b2c3d4-...",
      "candidateName": "陈曦",
      "position": "运营专员",
      "status": "completed",
      "statusLabel": "已完成",
      "levelDisplay": "L2",
      "trackDisplay": "个人深度轨道",
      "needsHumanReview": false,
      "createdAt": "2025-03-14T09:50:00.000+08:00",
      "submittedAt": "2025-03-14T10:28:30.000+08:00"
    },
    {
      "id": "e5f6g7h8-...",
      "candidateName": "李明",
      "position": "市场经理",
      "status": "pending_interview",
      "statusLabel": "待现场验证",
      "levelDisplay": "待验证",
      "trackDisplay": "待验证",
      "needsHumanReview": true,
      "createdAt": "...",
      "submittedAt": "..."
    }
  ]
}
```

### ⚠ 锁定规则（架构文档 4.2 约束2）

当 `status ∈ {pending_interview, final_evaluating}` 时：

| 字段 | 值 |
|------|----|
| `levelDisplay` | 固定字符串 `"待验证"` |
| `trackDisplay` | 固定字符串 `"待验证"` |

**响应中不存在 `level` / `confidence` 等原始字段**——不是置空，是**不返回该键**。列表接口不返回任何数值型等级信息。

`needsHumanReview` 允许返回，因为它不泄露具体等级方向。

---

## 4.4 新建测评

```
POST /api/v1/assessments
```

**请求**

```json
{ "candidateName": "陈曦", "position": "运营专员", "isTest": false }
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `candidateName` | 是 | 1–20 字符 |
| `position` | 否 | 0–100 字符 |
| `isTest` | 否 | 标记为内部测试数据，默认 false。用于 PoC 阶段区分测试与真实样本 |

**响应 201**

```json
{
  "id": "a1b2c3d4-...",
  "token": "kX9mP2vQ8nR4tY6wZ1aB3cD5eF7gH0jL",
  "link": "https://xxx.com/a/kX9mP2vQ8nR4tY6wZ1aB3cD5eF7gH0jL",
  "status": "not_started",
  "createdAt": "2025-03-14T09:50:00.000+08:00"
}
```

前端提供"复制链接"按钮。

---

## 4.5 重新生成链接

```
POST /api/v1/assessments/{id}/regenerate-link
```

**响应 200**：同 4.4 结构（新 token 与 link）。

**响应 409 CANNOT_REGENERATE**：测评已开始（`status != not_started`），不允许重新生成。

---

## 4.6 报告详情 ★核心接口

```
GET /api/v1/assessments/{id}/report
```

**权限**：仅创建者可访问，否则 `403 FORBIDDEN`。

响应根据状态分为**两种形态**，前端按 `locked` 字段分支渲染。

### 形态一：锁定态（`pending_interview` / `final_evaluating`）

```json
{
  "locked": true,
  "status": "pending_interview",
  "statusLabel": "待现场验证",
  "assessment": {
    "id": "e5f6g7h8-...",
    "candidateName": "李明",
    "position": "市场经理",
    "submittedAt": "2025-03-14T14:20:00.000+08:00"
  },
  "lockNotice": "本次测评触发了现场验证流程。请先与候选人完成面对面追问，录入记录并提交你的独立判断后，才会展示AI的评估结论。",
  "outline": {
    "status": "success",
    "questions": [
      {
        "index": 1,
        "quote": "做了一套东西把三个人的表格格式统一",
        "ask": "请让他具体描述这套东西的形态——是文档规范、表格模板、固定的提示词，还是别的形式？",
        "verify": "改造成果的具体形态",
        "follow_up": ["如果是模板，请了解包含哪些字段", "请了解这套东西目前是否还在使用"]
      }
    ],
    "note": ""
  },
  "rawLog": {
    "questionnaire": {
      "Q1": { "title": "你使用AI工具的频率大概是？", "answer": "每天多次" },
      "Q2": { "title": "你主要用AI做哪些事？", "answer": ["写文案", "数据处理"] }
    },
    "examinerDialogue": [
      {
        "stage": "S1.1",
        "stageName": "开场校验",
        "turns": [
          { "turnIndex": 1, "role": "ai", "content": "你好李明，...", "ts": "..." },
          { "turnIndex": 1, "role": "candidate", "content": "今天早上...", "ts": "...", "responseIntervalSec": 34 }
        ]
      }
    ],
    "toolTasks": [
      {
        "task": "T1",
        "taskTitle": "任务一：催货邮件",
        "turns": [
          { "turnIndex": 1, "role": "candidate", "content": "帮我写一封催货邮件...", "ts": "...", "responseIntervalSec": 52 },
          { "turnIndex": 1, "role": "ai", "content": "尊敬的张经理：...", "ts": "..." }
        ]
      }
    ]
  },
  "transcriptDraft": "面试官：你说做了一套东西...",
  "judgmentB": null
}
```

**锁定态响应中绝不出现的键**：`evaluationA`、`evaluationC`、`consistency`、`level`、`confidence`、`dimensions`。

### 形态二：解锁态（`completed` / `eval_failed`）

```json
{
  "locked": false,
  "status": "completed",
  "statusLabel": "已完成",
  "assessment": { "...": "..." },
  "outline": { "...": "..." },
  "rawLog": { "...": "..." },

  "evaluationA": {
    "type": "A",
    "createdAt": "2025-03-14T14:22:10.000+08:00",
    "dimensions": [
      {
        "code": "D1",
        "name": "使用强度与场景广度",
        "level": "L2",
        "insufficientEvidence": false,
        "confidence": 0.85,
        "reasoning": "有今日具体案例，覆盖文案与数据两类任务",
        "evidence": [
          {
            "source": "examiner_dialogue",
            "location": "S1.1 turn 2",
            "quote": "今天早上让它帮我整理了一份周报的数据",
            "note": "具体、近期、可核查的使用案例"
          }
        ]
      }
    ],
    "claimRealityGap": {
      "level": "轻微",
      "description": "问卷自述会主动提供背景，但T1首轮提示词仅一句话",
      "interpretation": "缺乏自我认知"
    },
    "anomalySignals": [
      {
        "type": "响应时间异常",
        "evidence": "T1 turn 1，提示词380字，responseIntervalSec=18",
        "description": "输入速度与内容长度不匹配"
      }
    ],
    "redLines": [],
    "overall": {
      "level": "L3_pending",
      "track": "个人深度轨道",
      "confidence": 0.72,
      "reasoning": "具备L2全部证据，且描述了流程级改造与他人采纳...",
      "keyUncertainties": ["模板的具体形态未说明", "他人采纳是主动还是被动未确认"],
      "recommendHumanReview": true,
      "humanReviewReason": "L3_pending 需现场验证"
    }
  },

  "judgmentB": {
    "level": "L3",
    "track": "个人深度轨道",
    "reason": "现场追问后能说出模板的7个字段和两次具体修改",
    "submittedAt": "2025-03-14T15:10:00.000+08:00",
    "transcript": "面试官：你说做了一套东西...\n候选人：对，是一个Excel模板..."
  },

  "evaluationC": {
    "type": "C",
    "createdAt": "2025-03-14T15:10:40.000+08:00",
    "dimensions": [ "...同A结构..." ],
    "claimRealityGap": { "...": "..." },
    "anomalySignals": [],
    "redLines": [],
    "overall": {
      "level": "L3",
      "track": "个人深度轨道",
      "confidence": 0.88,
      "...": "..."
    },
    "judgmentChange": {
      "changed": true,
      "fromLevel": "L3_pending",
      "toLevel": "L3",
      "reason": "面试记录中候选人当场描述了模板的字段结构，并说明了两次具体迭代内容，自述得到验证",
      "keyNewEvidence": ["模板里有7个字段，其中'数据口径'那一列是第二版才加的"]
    }
  },

  "consistency": {
    "levelA": "L3_pending",
    "levelB": "L3",
    "levelC": "L3",
    "aEqB": true,
    "bEqC": true,
    "aEqC": true,
    "maxLevelGap": 0,
    "computedAt": "2025-03-14T15:10:45.000+08:00"
  }
}
```

### 未触发验证的简化情形

若测评未触发现场验证（直接 `completed`），则 `locked: false`，且 `judgmentB` / `evaluationC` / `consistency` 均为 `null`。前端只渲染 `evaluationA`。

### 评估失败情形

```json
{
  "locked": false,
  "status": "eval_failed",
  "statusLabel": "评估失败",
  "assessment": { "...": "..." },
  "outline": null,
  "rawLog": { "...": "..." },
  "evaluationA": null,
  "failureInfo": {
    "stage": "evaluation_a",
    "reason": "模型返回JSON格式校验失败（dimensions 仅5项）",
    "occurredAt": "2025-03-14T14:22:00.000+08:00",
    "canRetry": true
  }
}
```

前端展示"评估失败"提示 + "重新评估"按钮 + 原始日志（日志始终可看）。

### ★ 一致性对比说明

`aEqB` 的比较规则：**`L3_pending` 与 `L3` 视为相等**（`L4_pending` 与 `L4` 同理）。`_pending` 只是"待验证"标记，不代表等级不同。这一规则由后端实现，前端直接使用布尔值。

`maxLevelGap` = 三者中最大等级差的绝对值（按 L0=0…L4=4 计算，`_pending` 去后缀）。

---

## 4.7 保存面试记录草稿

```
PUT /api/v1/assessments/{id}/transcript
```

**请求**

```json
{ "transcript": "面试官：你说做了一套东西...\n候选人：对，是一个Excel模板..." }
```

**响应 200**

```json
{ "savedAt": "2025-03-14T15:05:00.000+08:00", "charCount": 4820 }
```

**说明**：
- 可重复调用。前端建议**每 30 秒自动保存一次** + 失焦时保存，防止面试官辛苦录入的内容丢失
- 无字数下限校验（草稿阶段）
- 上限 100000 字符，超出返回 `400 TRANSCRIPT_TOO_LONG`
- 提交判断B后此接口返回 `409 JUDGMENT_SUBMITTED`（记录已锁定）

---

## 4.8 提交独立判断 B ★关键接口

```
POST /api/v1/assessments/{id}/judgment
```

**请求**

```json
{
  "level": "L3",
  "track": "个人深度轨道",
  "reason": "现场追问后能说出模板的7个字段和两次具体修改内容，自述可验证",
  "transcript": "面试官：你说做了一套东西...\n候选人：对，是一个Excel模板..."
}
```

| 字段 | 必填 | 校验 |
|------|------|------|
| `level` | 是 | 枚举 `L0`–`L4`。**不接受 `_pending` 后缀** |
| `track` | 是 | 枚举三值 |
| `reason` | 是 | 10–2000 字符 |
| `transcript` | 是 | **≥ 100 字符**，防止空提交 |

**响应 200**

```json
{
  "status": "final_evaluating",
  "submittedAt": "2025-03-14T15:10:00.000+08:00",
  "message": "已提交。正在生成终判结论，约需30秒。"
}
```

**响应 409 JUDGMENT_ALREADY_SUBMITTED**：已提交，不可修改。

**响应 422 TRANSCRIPT_TOO_SHORT**：面试记录不足 100 字符。`message`："请先录入面试过程的文字记录（至少100字）"。

### ⚠ 该接口的三重语义

调用成功会同时触发三件事，前端需知晓：

| # | 后端动作 |
|---|---------|
| 1 | 落库判断B，`transcript` 从草稿转正并**锁定不可再改** |
| 2 | 状态 `pending_interview` → `final_evaluating`，**A的结论此时仍未解锁** |
| 3 | 异步触发终判C，完成后状态 → `completed`，**此时才解锁** |

前端提交后应跳转至"生成中"过渡态并开始轮询 4.9。

**⚠ 不可逆提示**：前端在提交前必须弹出二次确认："提交后将不可修改，且会展示AI的评估结论。确认提交？"

---

## 4.9 轮询状态（终判进度）

```
GET /api/v1/assessments/{id}/status
```

轻量接口，仅返回状态，供前端轮询。

**响应 200**

```json
{
  "status": "final_evaluating",
  "statusLabel": "终判中",
  "locked": true,
  "updatedAt": "2025-03-14T15:10:05.000+08:00"
}
```

**前端轮询策略**：每 3 秒一次，最多 40 次（120 秒）。`locked` 变为 `false` 时停止轮询并重新调用 4.6 获取完整报告。超时后展示"生成时间较长，请手动刷新"。

---

## 4.10 重新评估

```
POST /api/v1/assessments/{id}/reevaluate
```

仅 `status = eval_failed` 时可用。

**请求**

```json
{ "scope": "all" }
```

`scope` 取值：`all`（题纲+评估全部重跑）| `evaluation`（仅评估）| `outline`（仅题纲）。

**响应 200**

```json
{ "status": "evaluating", "message": "已重新触发评估" }
```

**响应 409 CANNOT_REEVALUATE**：当前状态不允许重新评估。

---

## 4.11 标记放弃

```
POST /api/v1/assessments/{id}/abandon
```

候选人未完成且不再继续时，面试官手动标记。

**请求**：`{ "reason": "候选人主动退出" }`

**响应 200**：`{ "status": "abandoned" }`

**响应 409**：已完成的测评不可标记放弃。

---

## 4.12 单份数据导出

```
GET /api/v1/assessments/{id}/export
```

**响应 200**，`Content-Type: application/json`，`Content-Disposition: attachment`

包含该测评的全部数据：`assessment` + `questionnaire` + `dialogueLog`（全量原始记录含 signals）+ `evaluationA/C` + `judgmentB` + `consistency` + `llmCallLog`（Prompt 全文与原始返回）。

**说明**：这是**唯一会返回 `signals` 字段的接口**，仅供 PoC 分析使用，不用于前端渲染。

---

# 第5章 管理接口

## 5.1 配置热重载

```
POST /api/v1/admin/reload-config
X-Admin-Key: {key}
```

重载 `config/` 目录下的 Prompt 与配置文件，无需重启容器（架构文档 9.2）。

**响应 200**

```json
{
  "reloaded": [
    "prompts/examiner.md",
    "prompts/tool.md",
    "prompts/evaluation.md",
    "prompts/outline.md",
    "stages.yaml",
    "tasks.yaml",
    "questionnaire.yaml"
  ],
  "warnings": [],
  "reloadedAt": "2025-03-14T16:00:00.000+08:00"
}
```

**响应 400 CONFIG_INVALID**：配置文件语法错误。`detail` 指出文件与行号。**校验失败时保持旧配置生效，不会导致服务中断。**

**⚠ 使用约束**：正在进行中的测评会话，其考官模式已产生的对话不受影响，但**后续轮次会使用新 Prompt**。PoC 期间修改 Prompt 应在无人作答时进行。

---

# 第6章 错误码总表

## 6.1 通用

| Code | HTTP | message |
|------|------|---------|
| `PARAM_INVALID` | 400 | 请求参数有误 |
| `UNAUTHORIZED` | 401 | 请先登录 |
| `FORBIDDEN` | 403 | 无权访问该测评 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `INTERNAL_ERROR` | 500 | 服务异常，请稍后重试 |

## 6.2 候选人端

| Code | HTTP | message | 前端处理 |
|------|------|---------|---------|
| `TOKEN_INVALID` | 401 | 测评链接无效或已失效 | 展示失效页 |
| `ASSESSMENT_ABANDONED` | 410 | 本次测评已结束 | 展示结束页 |
| `ALREADY_STARTED` | 409 | 测评已开始 | 改调 `/state` 续答 |
| `ALREADY_SUBMITTED` | 409 | 测评已提交 | 跳转结束页 |
| `QUESTIONNAIRE_INVALID` | 400 | 请完成所有必答题 | 高亮 `detail` 中的题号 |
| `TURN_IN_PROGRESS` | 409 | 上一条还在处理中 | 保持输入禁用 |
| `NO_INTERACTION` | 422 | 请至少与AI交流一次 | Toast 提示 |
| `SKIP_NOT_ALLOWED` | 422 | 尚未达到跳过条件 | 静默忽略，重置计时 |
| `LLM_UNAVAILABLE` | 503 | 网络异常，请重试 | **保留输入内容** + 重试按钮 |
| `CONTENT_TOO_LONG` | 400 | 内容超出长度限制 | 提示字数上限 |

## 6.3 面试官端

| Code | HTTP | message |
|------|------|---------|
| `CREDENTIAL_INVALID` | 401 | 账号或密码错误 |
| `CANNOT_REGENERATE` | 409 | 测评已开始，无法重新生成链接 |
| `REPORT_LOCKED` | 403 | 需先提交现场判断（**兜底，正常流程不应出现**） |
| `JUDGMENT_ALREADY_SUBMITTED` | 409 | 判断已提交，不可修改 |
| `TRANSCRIPT_TOO_SHORT` | 422 | 请先录入面试记录（至少100字） |
| `TRANSCRIPT_TOO_LONG` | 400 | 面试记录超出长度限制 |
| `CANNOT_REEVALUATE` | 409 | 当前状态不支持重新评估 |
| `EVALUATION_NOT_READY` | 409 | 评估尚未完成 |

---

# 第7章 前端状态渲染契约

前端**不实现任何业务判断逻辑**，完全按后端返回的 `step` / `locked` 渲染。

## 7.1 候选人端

| `step` | 渲染页面 | 输入区形态 |
|--------|---------|-----------|
| `entry` | P1 入口页 | 姓名输入 + 开始按钮 |
| `questionnaire` | P2 选择题 | 题目表单 + 提交按钮 |
| `examiner` | P3 对话页 | 文本输入框 + 发送。**无"完成"按钮** |
| `tool` | P3 对话页 | 文本输入框 + 发送 + **"完成这个任务"按钮** |
| `finished` | P4 结束页 | 无输入 |

**P3 对话页的两种模式在视觉上必须有区分**（如顶部条颜色/标识不同），让候选人明确感知"现在对面是普通AI助手"。

## 7.2 面试官报告页

| 条件 | 渲染 |
|------|------|
| `locked === true` | 追问题纲 + 原始日志 + 面试记录录入框 + 判断B表单。**页面不含任何AI结论区块** |
| `locked === false && evaluationC` | 三方对比区（A/B/C）+ A详情 + C详情 + 原始日志 |
| `locked === false && !judgmentB` | A详情 + 原始日志 |
| `status === 'eval_failed'` | 失败提示 + 重新评估按钮 + 原始日志 |

**⚠ 前端实现禁令**：不得在锁定态尝试从任何接口拼凑 A 的结论；不得缓存解锁前后的响应做对比。锁定由服务端保证，前端不需要也不应该做任何"隐藏"逻辑。

---

# 第8章 接口自动化测试清单

以下用例必须写成自动化测试并纳入 CI（对应架构文档附录A）。

## 8.1 锁定验证（最高优先级）

| # | 用例 | 断言 |
|---|------|------|
| A1 | `pending_interview` 状态调 `/report` | 响应 JSON 序列化后**不含** `evaluationA`、`level`、`confidence`、`dimensions` 任一键名 |
| A2 | `pending_interview` 状态调 `/report` | 全文正则 `/L[0-4]/` 无匹配 |
| A3 | `final_evaluating` 状态调 `/report` | 同 A1、A2 |
| A4 | `pending_interview` 状态调 `/assessments` 列表 | `levelDisplay === "待验证"`，且响应不含 `level` 键 |
| A5 | 提交判断B后立即调 `/report` | 仍为 `locked: true`（终判未完成） |
| A6 | 终判完成后调 `/report` | `locked: false`，`evaluationA` 与 `evaluationC` 均存在 |

## 8.2 上下文隔离验证

| # | 用例 | 断言 |
|---|------|------|
| B1 | 工具模式调用后检查 `llm_call_log` | `request_messages` 不含候选人姓名、问卷选项文本 |
| B2 | 同上 | `request_messages` 不含任务描述关键词（如"供应商"） |
| B3 | T2 调用的 `request_messages` | 不含 T1 任何轮次内容 |
| B4 | 工具模式 system message | 与 `prompts/tool.md` 文件内容完全一致，无变量替换痕迹 |

## 8.3 signals 不下发验证

| # | 用例 | 断言 |
|---|------|------|
| C1 | `POST /message` 响应 | 不含 `signals` 键 |
| C2 | `GET /state` 响应 | 不含 `signals` 键 |
| C3 | `GET /report` 响应 | 不含 `signals` 键 |
| C4 | `GET /export` 响应 | **含** `signals`（唯一例外） |

## 8.4 越权与状态机

| # | 用例 | 断言 |
|---|------|------|
| D1 | 面试官A访问面试官B创建的测评 | 403 `FORBIDDEN` |
| D2 | 重复提交判断B | 409 `JUDGMENT_ALREADY_SUBMITTED` |
| D3 | 提交B后调 `PUT /transcript` | 409 `JUDGMENT_SUBMITTED` |
| D4 | `transcript` 传 50 字符提交判断 | 422 `TRANSCRIPT_TOO_SHORT` |
| D5 | 已开始的测评调重新生成链接 | 409 `CANNOT_REGENERATE` |
| D6 | 未达 600 秒调 `/skip` | 422 `SKIP_NOT_ALLOWED` |
| D7 | 同一 token 并发发两条 message | 第二条返回 409 `TURN_IN_PROGRESS` |

---

# 第9章 OpenAPI 文档生成

**不手工维护 YAML 文件。** 使用 `@nestjs/swagger` 从 DTO 装饰器自动生成，避免文档与代码脱节。

```typescript
// main.ts
const config = new DocumentBuilder()
  .setTitle('AI素质测评系统 API')
  .setVersion('v1')
  .addBearerAuth()
  .build();
SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
```

| 项 | 说明 |
|----|------|
| 访问地址 | `https://{domain}/api/docs` |
| 访问控制 | 需 `X-Admin-Key` 或仅内网可访问（**不得公开暴露**，会泄露考察逻辑线索） |
| 前端类型 | 用 `openapi-typescript` 从 `/api/docs-json` 生成 TS 类型，前端直接引用，保证类型一致 |

**本文档与自动生成文档的分工**：本文档描述**语义、约束、锁定规则、错误处理策略**（这些是装饰器表达不了的）；自动生成文档描述**字段类型与结构**。两者互补，本文档为准。

---

# 第10章 需确认事项

| # | 事项 | 需确认方 |
|---|------|---------|
| 1 | 候选人链接路径用 `/a/{token}` 还是 `/assessment/{token}` | 产品（影响链接观感） |
| 2 | 面试记录最短字数 100 是否合适 | 产品 |
| 3 | 实操任务是否强制至少交互 1 轮才能点"完成" | 产品 |
| 4 | 候选人端是否需要"退出/暂停"按钮 | 产品 |
| 5 | 面试官账号如何初始化（脚本预置 or 简易管理页） | 技术 + 产品 |
| 6 | JWT 有效期 12 小时是否合适 | 技术 |

---
