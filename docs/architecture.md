**版本**：v0.2
**配套文档**：《招聘AI素质测评系统 PRD（PoC版）v0.2》
**定位**：进入正式开发前的技术约束文档

## 变更记录

| 版本 | 日期 | 变更点 |
|---|---|---|
| v0.1 | 2026-08-14 | 初版 |
| v0.2 | 2026-08-25 | ① 2.1 模型按 purpose 分流；② 3.2 tasks.yaml schema 加 variants/gaps/defects 字段；③ 3.3 前端结构补 EvaluationView；④ 4.4 重试参数表更新为代码实际值；⑤ 4.5 区分"对外接口形态"vs"底层 LLM 调用 stream" |

---

# 第1章 架构原则

## 1.1 五条设计原则

| # | 原则 | 说明 |
|---|------|------|
| **P1** | **可观测优先于开发便利** | 所有模型调用必须自己发起、自己记录。不使用任何托管的会话/编排能力 |
| **P2** | **隔离在服务端强制，不依赖前端** | 上下文隔离、结论隐藏必须在服务端实现，前端只是展示 |
| **P3** | **最简可用** | 5并发、12–15人样本。任何为规模化做的设计都是浪费 |
| **P4** | **单体优先** | 不拆微服务，不引消息队列，不做缓存层 |
| **P5** | **数据不可丢** | 所有Prompt全文与模型原始返回必须落库。PoC的唯一产出就是这些数据 |

## 1.2 一个明确的技术禁令

**禁止使用百炼（Model Studio）的应用编排 / 智能体 / 会话管理能力，只调用底层模型API。**

| 理由 | 对应PRD要求 |
|------|-----------|
| 平台会自动管理会话上下文，无法100%确认工具模式上下文是干净的 | 附录3验收项5 |
| 编排层会封装Prompt组装过程，无法全量落库 | 附录3验收项8 |
| 无法抓包验证请求体内容 | 附录3验收项5、7 |

我们要的是**完全可控和可观测**，不是开发便利。

---

# 第2章 技术选型

## 2.1 选型总表

| 层次 | 选型 | 理由 |
|------|------|------|
| 前端 | React 18 + TypeScript + Vite + Ant Design | 团队通用；AntD 组件足够，不做自定义设计系统 |
| 后端 | Node.js 20 + NestJS + TypeScript | 前后端同语言，减少切换成本；NestJS 结构清晰，适合有明确模块边界的系统 |
| 数据库 | 阿里云 RDS MySQL 8.0（基础版，2C4G） | 需要存大文本 + 结构化查询。基础版单节点足够PoC |
| 部署 | 阿里云 ECS（2C4G，Ubuntu 22.04）+ Docker Compose | 最轻量。不用容器服务，不用K8s |
| 静态资源 | Nginx 直接托管前端产物（与后端同机） | 不用OSS+CDN，5并发无必要 |
| 模型 | 阿里云百炼 **底层模型API**（OpenAI 兼容模式）。按 purpose 分流：对话/工具用速度优先模型（`LLM_MODEL_DIALOG`，关闭思维链），评估/题纲用能力优先模型（`LLM_MODEL_EVAL`，默认开启思维链）；兜底 `LLM_MODEL`；api_base 用 `DASHSCOPE_BASE_URL` | 已完成Spike选型 |
| 域名/证书 | 阿里云域名 + 免费SSL证书 | 候选人链接需要HTTPS |
| 日志 | 文件日志（pino）+ 关键数据落库 | 不接SLS |
| 监控 | 无 | PRD第7章明确不做 |

## 2.2 为什么是 Node.js 而不是 Python

| 考量 | 说明 |
|------|------|
| **SSE流式响应** | 候选人对话需要流式输出，Node 原生支持好，实现最简 |
| **无AI工程需求** | 本系统不做向量检索、不做微调、不做数据分析管道，Python 的生态优势用不上 |
| **前后端同栈** | PoC 团队规模小，一个人可以同时改前后端 |

**如果技术团队 Python 更熟练**，可替换为 FastAPI，架构其余部分不变。这是唯一一个可以按团队情况调整的选型。

## 2.3 明确不引入的组件

| 组件 | 为什么不要 |
|------|-----------|
| Redis | 5并发，会话状态直接存DB即可 |
| 消息队列 | 评估任务用后端异步函数 + DB状态位即可 |
| 对象存储 OSS | 无文件上传（PRD已明确不做ASR、不接受音频） |
| 容器服务 ACK | 单机Docker Compose足够 |
| API网关 | 单体应用，Nginx反代即可 |
| WebSocket | SSE 单向推送已满足需求，比WS简单 |
| 微服务拆分 | 无 |

## 2.4 阿里云资源清单

| 资源 | 规格 | 数量 | 说明 |
|------|------|------|------|
| ECS | 2核4G，40G ESSD，5Mbps按量带宽 | 1 | 华东1（杭州） |
| RDS MySQL | 8.0 基础版 2核4G，100G | 1 | 同可用区，内网连接 |
| 百炼 | 按量付费 | — | 开通并获取 API Key |
| 域名 | .com 或子域名 | 1 | 需备案（若使用国内节点） |
| SSL证书 | 免费DV证书 | 1 | — |

**备案提醒**：国内ECS必须完成ICP备案才能绑定域名，周期通常 7–20 个工作日。**这是唯一可能阻塞项目上线的外部依赖，需立即启动。**

如果备案周期不可接受，备选方案：使用香港地域ECS（免备案），代价是国内访问延迟略高，但PoC场景可接受。

---

# 第3章 系统架构

## 3.1 部署拓扑

```
                        Internet
                            │
                            ▼
                  ┌──────────────────┐
                  │  阿里云 ECS 2C4G  │
                  │  ┌────────────┐  │
                  │  │   Nginx    │  │  :443 → SSL终止
                  │  │            │  │  /        → 前端静态资源
                  │  │            │  │  /api/v1/* → 反代 :3000
                  │  └─────┬──────┘  │  SSE 需关闭 buffering
                  │        │          │
                  │  ┌─────▼──────┐  │
                  │  │  NestJS    │  │  :3000
                  │  │  (Docker)  │  │
                  │  └─────┬──────┘  │
                  └────────┼──────────┘
                           │ 内网
              ┌────────────┴────────────┐
              ▼                         ▼
      ┌───────────────┐        ┌────────────────┐
      │ RDS MySQL 8.0 │        │  百炼模型API   │
      │  (内网连接)    │        │  (公网HTTPS)   │
      └───────────────┘        └────────────────┘
```

**Nginx SSE 关键配置**（容易踩坑，提前写明）：

```nginx
location /api/v1/c/*/message/stream {
    proxy_pass http://localhost:3000;
    proxy_http_version 1.1;
    proxy_set_header Connection '';
    proxy_buffering off;          # 必须关闭，否则流式失效
    proxy_cache off;
    proxy_read_timeout 300s;      # 模型响应可能较慢
}
```

## 3.2 后端模块划分

```
src/
├── modules/
│   ├── auth/              面试官登录（JWT）
│   ├── assessment/        测评生命周期、状态机
│   ├── questionnaire/     问卷提交
│   ├── dialogue/          对话核心（考官/工具模式）
│   │   ├── examiner.service.ts
│   │   ├── tool.service.ts
│   │   └── context.builder.ts     ★ 上下文构造（隔离的实现点）
│   ├── evaluation/        评估与题纲生成（异步任务）
│   ├── interview/         面试记录录入、独立判断B
│   └── report/            报告数据组装
│       └── report.filter.ts       ★ 结论隐藏过滤器
├── llm/
│   ├── llm.client.ts      模型调用封装（唯一出口）
│   └── llm.logger.ts      调用日志落库
├── config/
│   ├── prompts/           4份Prompt（.md）
│   ├── stages.yaml        阶段目标、轮次上限配置
│   ├── tasks.yaml         工具任务描述、时长、require_min_turns、variants（含 gaps/defects 内部字段）
│   ├── questionnaire.yaml 5道选择题题目与选项
│   ├── levels.yaml        等级定义与必要证据（注入评估Prompt）
│   ├── outline_blacklist.yaml  题纲黑名单正则（见4.4）
│   └── cards.yaml         系统卡片文案（mode_switch/task_done/notice）
└── common/
    ├── guards/
    └── filters/
```

### tasks.yaml schema 示例

```yaml
tasks:
  - id: T1
    duration_minutes: 20
    require_min_turns: 0
    variants:
      - id: T1-A
        title: 交付延迟回复
        description: |
          <题面全文，含多渠道来源信息>
        gaps:                    # 仅 A 评估使用，严禁下发前端
          - <需要候选人自行判断的信息缺口>
  - id: T2
    duration_minutes: 20
    require_min_turns: 0
    variants:
      - id: T2-A
        title: 销量简报
        description: |
          <题面全文，含事实性陈述材料>
        defects:                 # 仅 A 评估使用，严禁下发前端
          - level: 低
            desc: <事实性问题>
```

字段含义：
- `variants`：每个任务的平行题面，按 `assessmentId` 确定性选取其中一个
- `gaps`（T1）/ `defects`（T2）：仅供 A 评估对照使用的内部字段，**前端接口不得返回**，避免泄露考察意图
- `duration_minutes`：任务时长（分钟），前端倒计时按此计算
- `require_min_turns`：0 表示不强制交互；候选人可直接点"完成这个任务"

### stages.yaml schema 示例

```yaml
S1.1:
  name: 开场校验
  goal: "验证Q1自述的使用强度是否真实；获取至少1个具体的近期使用案例"
  min_turns: 3
  max_turns: 5
  absolute_max_turns: 6       # 含 answer_vagueness +1 后的硬上限
S1.2:
  name: 核验意识
  goal: "搞清候选人是否有主动核实AI输出的行为..."
  min_turns: 3
  max_turns: 5
  absolute_max_turns: 6
S1.3:
  name: 深度探测
  goal: "搞清是否存在流程级改造、可复用资产、他人采纳、组织推动..."
  min_turns: 4
  max_turns: 7
  absolute_max_turns: 8
```

字段含义：`min_turns`/`max_turns` 来自 PRD 4.2；`absolute_max_turns` 是 PRD 5.1 "answer_vagueness ≥ 0.7 时本阶段最大轮次 +1（上限内）" 中"上限"的具体值。

★ 标记的两个文件是**PoC成败的关键实现点**，见第4、5章。

## 3.3 前端结构

```
src/
├── pages/
│   ├── candidate/         候选人（无需登录，token鉴权）
│   │   ├── Entry.tsx      P1 入口
│   │   ├── Quiz.tsx       P2 选择题
│   │   ├── Chat.tsx       P3 对话页 ★核心
│   │   └── Finish.tsx     P4 结束页
│   └── interviewer/       面试官（需登录）
│       ├── Login.tsx
│       ├── List.tsx       P5 列表
│       └── Report.tsx     P6 报告详情 ★核心
├── components/
│   ├── ChatMessage.tsx
│   ├── SystemCard.tsx     ★ 模式切换卡片
│   ├── StageTimer.tsx
│   └── EvaluationView.tsx  ★ 报告页评估视图（含 D1-D4 维度雷达图，L0-L4 五档固定刻度）
└── hooks/
    └── useToolStream.ts   工具模式 SSE 流式接收（仅工具模式；考官模式对外不做流式，见4.5）
```

**候选人端与面试官端在同一个前端应用**，用路由区分。理由：PoC规模小，拆两个应用增加部署复杂度，收益为零。

---

# 第4章 关键技术实现

本章是本文档的核心。这四个点做错，PoC 数据直接作废。

## 4.1 上下文隔离（对应 H3 假设）

### 实现方式：不存"会话"，每次调用现场构造上下文

**核心设计**：数据库中不存在"conversation"表。每次调用模型时，由 `context.builder.ts` 根据模式从 `dialogue_log` 现场拼装 messages 数组。

```typescript
// context.builder.ts —— 唯一的上下文构造入口

/** 考官模式：携带问卷 + 阶段目标 + 考官模式全部历史 */
async buildExaminerContext(assessmentId: string, stageCode: string) {
  const q = await this.getQuestionnaire(assessmentId);
  const stage = this.config.getStage(stageCode);

  // 关键：只取 mode='examiner' 的记录
  const history = await this.dialogueLog.find({
    where: { assessmentId, mode: 'examiner' },   // ← 硬过滤
    order: { ts: 'ASC' },
  });

  return [
    { role: 'system', content: renderExaminerPrompt(q, stage, ...) },
    ...history.map(toMessage),
  ];
}

/** 工具模式：只含本任务的候选人输入与AI回复 */
async buildToolContext(assessmentId: string, taskId: string) {
  // 关键：三重过滤
  const history = await this.dialogueLog.find({
    where: { 
      assessmentId, 
      mode: 'tool',        // ← 排除考官模式
      taskId: taskId,      // ← 排除其他任务
    },
    order: { ts: 'ASC' },
  });

  return [
    { role: 'system', content: TOOL_MODE_PROMPT },  // 静态常量，无变量注入
    ...history.map(toMessage),
  ];
  // 注意：无问卷、无阶段目标、无任务描述、无候选人姓名
}
```

### 三条强制约束

| # | 约束 | 实现 |
|---|------|------|
| 1 | 工具模式 System Prompt 是**静态常量**，不接受任何变量注入 | `const TOOL_MODE_PROMPT = readFileSync('prompts/tool.md')`，函数签名不含参数 |
| 2 | 任务描述**不进模型上下文** | 任务描述从 `tasks.yaml` 读取，直接由 API 返回给前端渲染系统卡片，不经过 `llm.client` |
| 3 | 请求元数据脱敏 | 调用百炼时不传 `user` 字段，或传随机UUID，不传 assessmentId |

### 自动化验证（必须写成测试用例）

```typescript
describe('工具模式上下文隔离', () => {
  it('不含问卷信息', async () => {
    const ctx = await builder.buildToolContext(id, 'T1');
    const text = JSON.stringify(ctx);
    expect(text).not.toContain('每天多次');      // 问卷选项
    expect(text).not.toContain(candidateName);   // 候选人姓名
  });

  it('不含考官模式对话', async () => {
    const ctx = await builder.buildToolContext(id, 'T1');
    expect(JSON.stringify(ctx)).not.toContain('测评');
  });

  it('不含任务描述', async () => {
    const ctx = await builder.buildToolContext(id, 'T1');
    expect(JSON.stringify(ctx)).not.toContain('供应商');  // T1任务关键词
  });

  it('T2 不含 T1 历史', async () => {
    const ctx = await builder.buildToolContext(id, 'T2');
    // T1 中候选人的提示词不应出现
  });
});
```

**这组测试必须在CI中运行，任何修改后自动回归。**

## 4.2 结论隐藏（对应 H2/H4 假设）

### 问题

PRD 附录3验收项6："抓包确认'待现场验证'状态下，前端接口返回中不含A的等级字段"。

**前端隐藏不够**，必须服务端过滤。

### 实现：报告数据的服务端过滤器

```typescript
// report.filter.ts

/**
 * 报告数据出口的唯一过滤点。
 * 所有报告相关接口必须经过此函数，禁止直接返回 evaluation 实体。
 */
export function filterReport(
  assessment: Assessment,
  evalA: Evaluation | null,
  evalC: Evaluation | null,
  judgmentB: InterviewerJudgment | null,
  outline: Outline | null,
  failureInfo: FailureInfo | null,
): ReportDto {

  const isLocked =
    assessment.status === 'pending_interview' ||   // 待现场验证
    assessment.status === 'final_evaluating';      // 终判中

  if (isLocked) {
    // 锁定期：只返回题纲和原始日志，A 的任何字段都不返回
    return {
      status: assessment.status,
      candidate: pick(assessment, ['candidateName', 'position']),
      outline: outline,                    // 题纲（已经过黑名单校验）
      rawLog: buildRawLog(assessment),     // 原始日志
      transcriptDraft: judgmentB?.transcriptDraft ?? null,
      evaluationA: null,                   // ← 强制 null
      evaluationC: null,
      judgmentB: judgmentB,                 // 草稿状态可返回
      failureInfo: null,
    };
  }

  // 解锁后：全部返回。eval_failed 状态时 evaluationA 可能为 null，failureInfo 必返回
  return {
    status: assessment.status,
    candidate: pick(assessment, ['candidateName', 'position']),
    outline,
    rawLog: buildRawLog(assessment),
    evaluationA: evalA,
    evaluationC: evalC,
    judgmentB: judgmentB ? { ...judgmentB, transcript: judgmentB.transcript } : null,
    failureInfo,                            // stage ∈ {evaluation_a | evaluation_c | outline} | null
  };
}

interface FailureInfo {
  stage: 'evaluation_a' | 'evaluation_c' | 'outline';
  reason: string;
  occurredAt: Date;
  canRetry: boolean;
}
```

### 三条强制约束

| # | 约束 | 说明 |
|---|------|------|
| 1 | **所有**报告接口必须调用 `filterReport`，禁止直接 `return evaluation` | Code Review 强制检查项 |
| 2 | 列表接口（P5）同样过滤：锁定状态下 `aiLevel` 字段返回 `"待验证"` 字符串而非真实等级 | 面试官会先看到列表 |
| 3 | 解锁触发点唯一：`interviewer_judgment` 表插入记录成功后，状态机推进 | 不允许其他路径解锁 |

### 自动化验证

```typescript
it('待现场验证状态下，接口不返回A的等级', async () => {
  const res = await request(app).get(`/api/v1/assessments/${id}/report`);
  const text = JSON.stringify(res.body);
  expect(res.body.evaluationA).toBeNull();
  expect(text).not.toMatch(/L[0-4]/);          // 全文无等级字符串
  expect(text).not.toContain('confidence');
});
```

## 4.3 状态机（后端控制流程推进）

### 设计：状态机在后端，模型只提供信号

PRD 2.5 明确要求：大模型不决定流程走向。

```typescript
// assessment.state.ts

/**
 * 每轮对话结束后调用，决定是否在考官模式内部推进到下一阶段。
 * 仅处理阶段内推进；跨段（考官→工具）推进由 shouldEnterToolMode 决定。
 * 模型返回的 signals 只是输入，决策权在这里。
 *
 * signals 字段集合以 PRD 5.1 定义为准：
 * goal_coverage / mentioned_process_change / mentioned_asset /
 * mentioned_others_adoption / mentioned_team_driving / answer_vagueness
 * 不得读取 PRD 未定义的信号（例如 candidate_stuck）。
 */
function shouldAdvanceStage(ctx: StageContext): AdvanceDecision {
  const { stageCode, turnIndex, signals, totalElapsedSec } = ctx;
  const cfg = config.stages[stageCode];

  // 优先级1：第1段总时长上限15分钟。
  // PRD 4.2：到达上限时，当前阶段完成本轮回答后立即结束，进入第2段。
  // shouldAdvanceStage 在每轮回答结束后调用，因此命中此条件时
  // "本轮回答已完成"自然成立，可直接跳过考官模式剩余阶段。
  if (totalElapsedSec >= 900) {
    return { advance: true, reason: 'total_timeout', skipRemaining: true };
  }

  // 优先级2：达到最大轮次。
  // PRD 5.1：answer_vagueness >= 0.7 时本阶段最大轮次 +1，但不超出绝对上限。
  // absolute_max_turns 是阶段配置中的硬上限，确保任何 +1 都被框住。
  const maxTurns = signals.answer_vagueness >= 0.7
    ? Math.min(cfg.max_turns + 1, cfg.absolute_max_turns)
    : cfg.max_turns;
  if (turnIndex >= maxTurns) {
    return { advance: true, reason: 'max_turns' };
  }

  // 优先级3：信息采集充分。
  if (turnIndex >= cfg.min_turns && signals.goal_coverage >= 0.8) {
    return { advance: true, reason: 'goal_covered' };
  }

  return { advance: false };
}

/**
 * 单轮无响应超时，独立于 shouldAdvanceStage 运行（定时器触发，不在每轮结束后调用）。
 * PRD 4.7：单轮无输入超过5分钟，前端提示；超过10分钟，该阶段自动结束进入下一阶段。
 * 返回动作区分模式：考官模式推进到下一阶段，工具模式推进到下一任务或提交。
 */
function onCandidateIdle(assessmentId: string, idleSec: number, currentMode: 'examiner' | 'tool'): IdleAction {
  if (idleSec >= 600) {
    return currentMode === 'examiner'
      ? { action: 'force_advance_stage', reason: 'idle_timeout' }
      : { action: 'force_advance_task', reason: 'idle_timeout' };
  }
  if (idleSec >= 300) {
    return { action: 'warn_candidate', reason: 'idle_warn' };
  }
  return { action: 'none' };
}

/**
 * S1.2 结束后调用，决定下一步是进入 S1.3 还是直接进入第2段（工具模式）。
 * PRD 4.2：未触发 S1.3 时直接进入第2段，本身就是 L2 及以下的判定信号。
 */
function shouldRunS13(assessmentId): boolean {
  const q = getQuestionnaire(assessmentId);
  if (['给过同事用', '有人主动来找我要'].includes(q.q3)) return true;
  if (['经常', '我是团队里主要的答疑人'].includes(q.q4)) return true;

  // 累积信号：S1.1 / S1.2 任一轮次出现过即触发
  const anySignal = db.query(`
    SELECT 1 FROM dialogue_log
    WHERE assessment_id = ? AND mode='examiner' AND role='ai'
      AND stage_or_task IN ('S1.1', 'S1.2')
      AND (JSON_EXTRACT(signals,'$.mentioned_process_change') = true
        OR JSON_EXTRACT(signals,'$.mentioned_asset') = true
        OR JSON_EXTRACT(signals,'$.mentioned_others_adoption') = true
        OR JSON_EXTRACT(signals,'$.mentioned_team_driving') = true)
    LIMIT 1`, [assessmentId]);
  return anySignal.length > 0;
}

/**
 * 候选人放弃触发器。PRD 4.7：候选人中途关闭页面视为放弃。
 * beforeunload 不可靠，后端不能依赖前端事件。
 * 触发策略：候选人环节进行中超过 N 分钟（建议30分钟，等于总时长上限）
 * 仍无任何 dialogue_log 新增，且状态仍为 in_progress，则置为 abandoned。
 * 该检查由定时任务（每分钟一次）执行，不在请求路径上。
 */
function markAbandonedIfStale(assessmentId: string): void {
  const last = db.query(`
    SELECT MAX(ts) AS last_ts FROM dialogue_log WHERE assessment_id = ?`,
    [assessmentId]);
  if (last[0].last_ts && Date.now() - last[0].last_ts.getTime() > 30 * 60 * 1000) {
    assessmentRepo.setStatus(assessmentId, 'abandoned');
  }
}

/**
 * 评估A产出后立即调用，决定是否触发面试官环节（PRD 4.5）。
 * 满足任一条件即把状态从 evaluating 推到 pending_interview。
 */
function shouldTriggerInterview(assessmentId: string): boolean {
  const evalA = evaluationRepo.findAByAssessment(assessmentId);
  if (!evalA) return false;

  const { overall, claimRealityGap, redLines } = evalA;

  // 条件1：L4_pending（v0.4：L3_pending 已废除，L3 可在阶段 A 直接确定输出）
  if (overall.level === 'L4_pending') return true;

  // 条件2：团队负责人轨道
  if (overall.track === '团队负责人轨道') return true;

  // 条件3：置信度 < 0.6
  if (overall.confidence < 0.6) return true;

  // 条件4：自述实测落差重大
  if (claimRealityGap?.level === '重大') return true;

  // 条件5：触发任一安全红线
  if (redLines && redLines.length > 0) return true;

  return false;
}
```

### `shouldAdvanceStage` 适用范围说明

`shouldAdvanceStage` 仅处理**考官模式内部**的阶段推进（S1.1 → S1.2 → S1.3）。工具模式任务推进不走此函数：
- 候选人主动完成：由 `POST /api/v1/c/:token/task/complete` 触发
- 任务时长归零：前端在 SSE `done` 事件后调 `POST /api/v1/c/:token/skip`（`reason: task_timeout`）
- 单轮无响应超时：`onCandidateIdle` 触发，工具模式返回 `force_advance_task`，考官模式返回 `force_advance_stage`

### 跨段推进的编排

`shouldAdvanceStage` 只决定阶段内推进。跨段（考官模式 → 工具模式、工具模式 → 评估）的编排由调用方按以下顺序组合：

1. 考官模式内：S1.1 → S1.2 由 `shouldAdvanceStage` 决定
2. S1.2 结束时：调用 `shouldRunS13`
   - 返回 `true`：进入 S1.3，仍由 `shouldAdvanceStage` 决定何时结束
   - 返回 `false`：直接进入第2段（工具模式）。PRD 4.2 把此分支视为 L2 及以下的判定信号
3. S1.3 结束时：进入第2段（无条件）
4. 第2段内：T1 → T2 由任务完成事件或任务时长上限决定
5. 第2段结束：状态 → `evaluating`，触发评估

### 状态定义

```typescript
enum AssessmentStatus {
  NOT_STARTED       = 'not_started',        // 未开始
  IN_PROGRESS       = 'in_progress',        // 进行中
  EVALUATING        = 'evaluating',         // 评估中
  COMPLETED         = 'completed',          // 已完成
  PENDING_INTERVIEW = 'pending_interview',  // 待现场验证  ★锁定
  FINAL_EVALUATING  = 'final_evaluating',   // 终判中      ★锁定
  ABANDONED         = 'abandoned',          // 已放弃
  EVAL_FAILED       = 'eval_failed',        // 评估失败
}
```

**候选人当前进度**（阶段/任务/轮次）单独存 `assessment.progress` JSON字段，不进状态机，避免状态爆炸。

## 4.4 模型调用与全量落库

### 唯一出口原则

```typescript
// llm.client.ts —— 全系统唯一的模型调用入口

async call(params: {
  assessmentId: string;
  purpose: 'examiner' | 'tool' | 'eval' | 'outline';
  messages: Message[];
  temperature: number;
  responseFormat?: 'json_object';
  stream?: boolean;
}): Promise<LlmResult> {

  const started = Date.now();

  // 1. 先落库请求（即使调用失败也有记录）
  const logId = await this.logger.logRequest({
    assessmentId: params.assessmentId,
    purpose: params.purpose,
    requestMessages: JSON.stringify(params.messages),   // ★ 全文
    model: MODEL_NAME,
    temperature: params.temperature,
    ts: new Date(),
  });

  try {
    const res = await this.openaiCompatClient.chat.completions.create({...});
  
    // 2. 落库原始返回
    await this.logger.logResponse(logId, {
      responseRaw: JSON.stringify(res),      // ★ 原始返回全文
      promptTokens: res.usage?.prompt_tokens,
      completionTokens: res.usage?.completion_tokens,
      latencyMs: Date.now() - started,
      status: 'success',
    });
  
    return parse(res);
  } catch (e) {
    await this.logger.logResponse(logId, { status: 'failed', error: String(e) });
    throw e;
  }
}
```

**约束**：全系统禁止在 `llm.client.ts` 之外调用模型API。Code Review 强制检查。

### JSON 输出的健壮性处理

模型输出JSON是PoC最常见的失败点，必须做防御：

```typescript
function parseJsonResponse<T>(raw: string, schema: ZodSchema<T>): T {
  // 1. 剥离可能的 markdown 包裹
  let s = raw.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  // 2. 提取第一个完整的 JSON 对象（应对前后有多余文字）
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);

  // 3. 解析 + Schema 校验
  return schema.parse(JSON.parse(s));
}
```

**重试策略**（与 `config/llm_params.yaml` 一致）：

| 场景 | 策略 |
|------|------|
| JSON 解析失败 | 重试 2 次（每次 temperature 降 0.1），仍失败则报错 |
| Schema 校验失败（如 dimensions 不足4项） | 重试 3 次（每次 temperature 降 0.1，给 LLM 机会退出 tool_calls 风格输出），仍失败则落库原始返回 + 标记 `eval_failed` |
| 网络/超时 | SDK 内部 maxRetries=2 已给 3 次尝试机会，LlmClient 外层不再叠加（max_attempts=1），避免 eval 最长累计 45 分钟 |

**评估失败不能静默**：必须落库原始返回，面试官侧显示"评估失败"并提供"重新评估"按钮（PRD 4.7）。

### 题纲黑名单校验

```typescript
// 题纲黑名单从 config/outline_blacklist.yaml 读取，便于产品调优
const BLACKLIST: RegExp[] = loadYaml('config/outline_blacklist.yaml').patterns
  .map((p: string) => new RegExp(p));

// 默认配置示例（实际以 config/outline_blacklist.yaml 为准）：
//   - L[0-4]                                  # 等级编号（含 L4_pending 中的 L4 前缀）
//   - 等级|评分|置信度|待验证                  # 评估术语
//   - 初级|中级|高级|入门|进阶|熟练|专家       # 档位中文名（含 levels.yaml v0.4 档位名）
//   - 优秀|出色|不足|薄弱|可疑|存疑|夸大|值得怀疑|落差
//   - 使用强度|场景广度|任务拆解|信息组织|核验意识|沉淀|外溢|影响力
//                                            # 当前 4 维度名 + 旧维度名"影响力"
//   - 个人深度轨道|团队负责人轨道              # 轨道名
//   - 流程改造|组织推动                        # 旧维度名仍禁止，避免用旧术语绕过

async function generateOutline(assessmentId): Promise<Outline> {
  for (let i = 0; i < 3; i++) {
    const res = await llm.call({ purpose: 'outline', ... });
    const text = JSON.stringify(res);
    if (!BLACKLIST.some(re => re.test(text))) return res;
    logger.warn(`题纲命中黑名单，第${i+1}次重试`);
  }
  // 3次失败：降级为"仅展示原始日志"
  await markOutlineFailed(assessmentId);
  return null;
}
```

## 4.5 SSE 流式对话

### 为什么用 SSE 而不是 WebSocket

| 维度 | SSE | WebSocket |
|------|-----|-----------|
| 通信方向 | 单向（服务端→客户端） | 双向 |
| 我们的需求 | 只需服务端推送流式内容，用户输入用普通POST | 双向能力用不上 |
| 实现复杂度 | 原生 EventSource，几行代码 | 需要连接管理、心跳、重连 |
| Nginx 配置 | 关 buffering 即可 | 需要 upgrade 头配置 |

### 接口设计

工具模式 SSE 端点（与 api-spec 3.6 对齐）：

```
POST /api/v1/c/:token/message/stream
Accept: text/event-stream

Body: { content: string }

Response: text/event-stream

event: accepted
data: {"candidateMessageId":31,"aiMessageId":32}

event: delta
data: {"text":"你好"}

event: done
data: {"aiMessageId":32,"turnIndex":1,"taskRemainingSec":540,"finishReason":"stop"}
```

**关键点**：

| # | 要点 |
|---|------|
| 1 | 工具模式无 signals 字段（PRD 5.4），SSE 流不涉及 signals 落库；考官模式 signals 仅落库、不进入任何前端响应（PoC 约束3） |
| 2 | 考官模式**对外接口不做流式**：考官返回 JSON，普通 POST + loading 动效即可；前端不解析流式 JSON |
| 3 | 工具模式直接返回文本，真流式 |
| 4 | `done` 事件**不携带阶段推进信号**；任务时长归零由前端在收到 `done` 后调用 `POST /api/v1/c/:token/skip`（`reason: task_timeout`）触发推进 |
| 5 | 前端需处理连接中断，展示"重试"按钮（PRD 6.4） |

**对外接口形态 vs 底层 LLM 调用 stream**：

- 考官模式**对外接口**是普通 POST（前端一次性拿到 JSON）——这一层不变
- 但考官模式**底层 LLM 调用** `stream: true`（`config/llm_params.yaml` 中 `examiner.stream: true`），目的是降低单次延迟（从思维链模式 30–70 秒降到 2–5 秒）；后端在收到完整流式响应后聚合成 JSON 再返回前端
- 即"对外非流式、底层流式"——前端无感知，后端用流式降低 TTFB 与单次延迟
- 工具模式则对外和底层都是真流式（SSE 直透）

**考官模式对外不做流式的理由**：考官模式回复很短（40 字以内），等待 2–3 秒可接受，前端流式解析 JSON 会显著增加复杂度。工具模式回复长，必须流式。这个取舍能省下一天开发时间。

---

# 第5章 数据模型

## 5.1 表结构

```sql
-- 面试官
CREATE TABLE interviewer (
  id          VARCHAR(36) PRIMARY KEY,
  name        VARCHAR(50)  NOT NULL,
  account     VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at  DATETIME NOT NULL
);

-- 测评主表
CREATE TABLE assessment (
  id             VARCHAR(36) PRIMARY KEY,
  interviewer_id VARCHAR(36) NOT NULL,
  candidate_name VARCHAR(50) NOT NULL,
  position       VARCHAR(100),
  token          VARCHAR(64) NOT NULL UNIQUE,   -- 候选人链接token
  status         VARCHAR(30) NOT NULL,
  progress       JSON,          -- {stage, taskId, turnIndex, stageStartTs}
  created_at     DATETIME NOT NULL,
  started_at     DATETIME,
  submitted_at   DATETIME,
  INDEX idx_interviewer (interviewer_id),
  INDEX idx_token (token)
);

-- 问卷结果
CREATE TABLE questionnaire_result (
  assessment_id VARCHAR(36) PRIMARY KEY,
  q1 VARCHAR(50), q2 JSON, q3 VARCHAR(50), q4 VARCHAR(50), q5 VARCHAR(50),
  submitted_at  DATETIME NOT NULL
);

-- 对话日志（考官+工具统一表）
CREATE TABLE dialogue_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  assessment_id VARCHAR(36) NOT NULL,
  mode          VARCHAR(10) NOT NULL,      -- examiner | tool
  stage_or_task VARCHAR(10) NOT NULL,      -- S1.1 | S1.2 | S1.3 | T1 | T2
  turn_index    INT NOT NULL,
  role          VARCHAR(10) NOT NULL,      -- ai | candidate
  content       MEDIUMTEXT NOT NULL,
  signals       JSON,                      -- 仅 role=ai 且 mode=examiner
  response_interval_sec INT,               -- 仅 role=candidate
  ts            DATETIME(3) NOT NULL,
  INDEX idx_assessment_mode (assessment_id, mode, stage_or_task, ts)
);

-- 模型调用日志 ★PoC核心数据
CREATE TABLE llm_call_log (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  assessment_id VARCHAR(36),
  purpose       VARCHAR(20) NOT NULL,      -- examiner|tool|eval|outline
  model         VARCHAR(50) NOT NULL,
  temperature   DECIMAL(3,2),
  request_messages LONGTEXT NOT NULL,      -- ★ Prompt全文
  response_raw     LONGTEXT,               -- ★ 原始返回全文
  prompt_tokens     INT,
  completion_tokens INT,
  latency_ms    INT,
  status        VARCHAR(20) NOT NULL,      -- success | failed
  error_msg     TEXT,
  ts            DATETIME(3) NOT NULL,
  INDEX idx_assessment (assessment_id, purpose, ts)
);

-- 追问题纲
CREATE TABLE outline (
  assessment_id VARCHAR(36) PRIMARY KEY,
  result_json   JSON,
  status        VARCHAR(20) NOT NULL,      -- success | blacklist_failed
  created_at    DATETIME NOT NULL
);

-- 评估结果（A 和 C）
CREATE TABLE evaluation (
  id            VARCHAR(36) PRIMARY KEY,
  assessment_id VARCHAR(36) NOT NULL,
  type          CHAR(1) NOT NULL,          -- A | C
  result_json   JSON NOT NULL,
  level         VARCHAR(15) NOT NULL,      -- L2 | L4_pending | L4 | ...（v0.4：仅 L4_pending）
  track         VARCHAR(20) NOT NULL,
  confidence    DECIMAL(3,2) NOT NULL,
  recommend_human_review BOOLEAN NOT NULL,
  created_at    DATETIME NOT NULL,
  UNIQUE KEY uk_assessment_type (assessment_id, type)
);

-- 面试官独立判断 B
CREATE TABLE interviewer_judgment (
  assessment_id VARCHAR(36) PRIMARY KEY,
  level         VARCHAR(5) NOT NULL,
  track         VARCHAR(20) NOT NULL,
  reason        TEXT NOT NULL,
  transcript    LONGTEXT NOT NULL,         -- 面试文字记录（提交B时从draft转正，锁定）
  transcript_draft LONGTEXT,               -- 草稿（提交前可多次保存）
  submitted_at  DATETIME
);
-- 草稿转正规则：POST /judgment 时把 transcript_draft 复制到 transcript，
-- 随后 transcript_draft 可保留也可清空，但 transcript 不可再编辑。
-- 列表/报告接口读取 transcript 字段；草稿编辑接口读写 transcript_draft。

-- 三方一致性（提交B并产出C后自动计算）
CREATE TABLE consistency (
  assessment_id VARCHAR(36) PRIMARY KEY,
  level_a       VARCHAR(15),
  level_b       VARCHAR(5),
  level_c       VARCHAR(15),
  a_eq_b        BOOLEAN,
  b_eq_c        BOOLEAN,
  a_eq_c        BOOLEAN,
  max_level_gap INT,
  computed_at   DATETIME
);
-- max_level_gap 计算规则（levels v0.4）：
-- 1. 把 level 归一化为数值：L0=0, L1=1, L2=2, L3=3, L4=4；
--    L4_pending=4（pending 视为对应等级参与比较，
--    "是否 pending"由前缀判断，不进入 gap 计算）
-- 2. max_level_gap = max(|a-b|, |b-c|, |a-c|) 的等级差绝对值
-- 3. a_eq_b / b_eq_c / a_eq_c 仅在数值相等时为 true，
--    pending 与确定等级视为相等（例如 A=L4_pending, C=L4 → a_eq_c=true, gap=0）
-- 4. B 的 level 字段不含 pending（面试官直接给确定等级），无需归一化特殊处理
-- v0.4 变更：L3_pending 已废除——L3 可在阶段 A 直接确定输出，不再 pending
```

## 5.2 两个设计说明

**为什么对话日志用统一表而不拆表**：查询时永远带 `mode` 条件，拆表没有收益，反而增加评估阶段组装 `full_log` 的复杂度。

**为什么 `llm_call_log` 用 LONGTEXT 而不是外部存储**：终判Prompt约 25000–40000 tokens ≈ 100KB，LONGTEXT 上限 4GB，完全够用。15人 × 约30次调用 × 平均50KB ≈ 22MB，RDS 100G 绰绰有余。

## 5.3 数据导出

PoC 结束需要导出全量数据做分析，分两种方式：

| 方式 | 用途 | 形态 |
|------|------|------|
| HTTP 接口 | 单份导出，临时取数 | `GET /api/v1/assessments/:id/export`（详见 api-spec 4.12，含 signals 字段，PoC 分析唯一开放出口） |
| CLI 脚本 | 批量导出，PoC 结束一次性产出 | `npm run export -- --output ./poc-data.json` |

```bash
npm run export -- --output ./poc-data.json
```

导出内容：每位候选人的完整日志 + A/B/C + 一致性 + 全部 `llm_call_log`。HTTP 接口与 CLI 脚本输出结构一致，仅范围不同。

---

# 第6章 接口清单

## 6.1 候选人接口（token 鉴权，无需登录）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/c/:token` | 获取测评基本信息，校验token有效性 |
| POST | `/api/v1/c/:token/start` | 提交姓名，状态置为进行中 |
| GET | `/api/v1/c/:token/questionnaire` | 获取问卷题目 |
| POST | `/api/v1/c/:token/questionnaire` | 提交问卷，返回第一个考官问题 |
| POST | `/api/v1/c/:token/message` | 提交回答（考官模式，普通POST） |
| POST | `/api/v1/c/:token/message/stream` | 提交提示词（工具模式，SSE） |
| POST | `/api/v1/c/:token/task/complete` | 主动完成当前实操任务 |
| POST | `/api/v1/c/:token/skip` | 超时跳过（PRD 4.7 单轮10分钟） |
| GET | `/api/v1/c/:token/state` | 获取当前进度（刷新页面用） |

**token 设计**：32位随机字符串，与 assessment 一对一。链接形如 `https://xxx.com/a/{token}`（前端路由，非 API 路径）。

## 6.2 面试官接口（JWT 鉴权）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/v1/auth/login` | 登录 |
| GET | `/api/v1/auth/me` | 当前登录信息 |
| GET | `/api/v1/assessments` | 列表（★经过锁定过滤） |
| POST | `/api/v1/assessments` | 新建，返回token链接 |
| POST | `/api/v1/assessments/:id/regenerate-link` | 重新生成链接 |
| GET | `/api/v1/assessments/:id/report` | 报告详情（★经过 filterReport） |
| GET | `/api/v1/assessments/:id/status` | 轻量轮询（终判进度） |
| PUT | `/api/v1/assessments/:id/transcript` | 保存面试记录草稿 |
| POST | `/api/v1/assessments/:id/judgment` | 提交B（★触发解锁 + 终判） |
| POST | `/api/v1/assessments/:id/reevaluate` | 重新评估（评估失败时） |
| POST | `/api/v1/assessments/:id/abandon` | 面试官手动标记放弃 |
| GET | `/api/v1/assessments/:id/export` | 单份数据导出（含 signals，PoC 分析用） |
| POST | `/api/v1/admin/reload-config` | 重载 Prompt / 阶段配置 / 任务配置（见9.2，热更新） |

## 6.3 开发辅助接口（不公开暴露）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/docs` | Swagger UI，需 X-Admin-Key 或仅内网可访问 |
| GET | `/api/v1/docs-json` | OpenAPI JSON，供前端 `openapi-typescript` 生成类型 |

**禁止公开暴露**：Swagger 文档会泄露 Prompt 线索与考察逻辑，必须用 X-Admin-Key 或内网 ACL 限制。

---

# 第7章 关键流程时序

## 7.1 候选人对话主流程

```
候选人           前端            后端                 模型API
  │               │               │                     │
  │─输入回答─────▶│               │                     │
  │               │──POST message▶│                     │
  │               │               │─落库candidate日志    │
  │               │               │  (含response_interval)│
  │               │               │                     │
  │               │               │─buildExaminerContext │
  │               │               │  (mode='examiner')   │
  │               │               │                     │
  │               │               │──llm.call───────────▶│
  │               │               │◀─────────JSON────────│
  │               │               │                     │
  │               │               │─落库llm_call_log     │
  │               │               │─parseJson + Schema   │
  │               │               │─落库ai日志+signals    │
  │               │               │                     │
  │               │               │─shouldAdvanceStage() │ ★后端决策
  │               │               │                     │
  │               │◀─question+meta│                     │
  │◀──展示────────│               │                     │
```

## 7.2 提交后的评估流程（异步）

```
候选人提交
    │
    ▼
状态 → EVALUATING，立即返回结束页
    │
    │  （后端异步任务，非阻塞）
    ▼
① 组装 full_log
    │
    ▼
② 生成题纲  ←─ 先执行，输入不含评估结果
    │        ←─ 黑名单校验，失败重试2次
    ▼
③ 执行评估A ←─ 独立调用
    │
    ▼
④ 判断触发条件
    │
    ├─ 不触发 ──▶ 状态 → COMPLETED
    │
    └─ 触发   ──▶ 状态 → PENDING_INTERVIEW  ★锁定开始
```

**异步实现**：NestJS 中直接用 `setImmediate` 或 `@nestjs/schedule` 的一次性任务，不引队列。失败则状态置 `EVAL_FAILED`，面试官手动重试。

## 7.3 面试官环节（解锁流程）

```
面试官打开报告 (PENDING_INTERVIEW)
    │
    ▼
GET /api/v1/assessments/:id/report → filterReport() → evaluationA: null  ★锁定生效
    │
    ▼
展示：题纲 + 原始日志 + 录入框 + 判断表单
    │
    ├─ PUT /api/v1/assessments/:id/transcript （可多次保存草稿）
    │
    ▼
POST /api/v1/assessments/:id/judgment  （提交B）
    │
    ├─ 校验：transcript 非空 + level/track/reason 完整
    ├─ 落库 interviewer_judgment（transcript 从草稿转正，锁定）
    ├─ 状态 → FINAL_EVALUATING
    │
    ▼
异步执行终判C（full_log + transcript）
    │
    ├─ 成功 → 落库 evaluation(type='C') → 计算 consistency → 状态 → COMPLETED   ★解锁
    │
    └─ 失败 → 状态回退至 EVAL_FAILED（locked 仍为 true）
                       │
                       ▼
              面试官调 POST /api/v1/assessments/:id/reevaluate (scope=evaluation)
              重新执行终判C，成功后状态 → COMPLETED 解锁
```

**终判C失败的处理**：
- 状态从 `final_evaluating` 回退到 `eval_failed`，`locked` 仍为 `true`（A 仍不能展示，因面试记录已提交但 C 未产出，B 已锁定不可改）
- 报告接口（4.6）返回 `failureInfo: { stage: 'evaluation_c', canRetry: true }`
- 面试官调 `POST /reevaluate` 时 `scope` 必须为 `evaluation`（不重跑题纲）
- 重试成功后状态 → `completed`，A/B/C 全部解锁

**前端轮询**：终判耗时约 20–40 秒，每 3 秒轮询一次 `/status`，`locked` 变 false 后停止轮询并调 `/report` 获取完整数据，不做 SSE。

---

# 第8章 非功能约束

| 项 | 约束 | 说明 |
|----|------|------|
| 并发 | ≤5人同时作答 | 无需压测 |
| 模型超时 | 单次调用 120s | 评估调用输入大，需放宽 |
| 接口超时 | Nginx 300s | 覆盖SSE长连接 |
| 浏览器 | Chrome 最新版 | 不做兼容性处理 |
| 移动端 | 不适配 | 候选人需用电脑 |
| 安全 | HTTPS + JWT + token随机化 | 不做防作弊、不做限流、不做WAF |
| 数据合规 | 内部试点，不接触真实客户数据 | 不做加密、脱敏、审计 |
| 备份 | RDS 自动备份（默认7天） | 不做额外备份策略 |

---

# 第9章 环境与交付

## 9.1 环境规划

| 环境 | 说明 |
|------|------|
| 本地开发 | Docker Compose 起 MySQL；模型API直连百炼 |
| 生产 | 单台ECS，即测试环境 |

**不做独立测试环境**。PoC规模下，生产即测试，通过测试数据标记（`assessment.position` 填 "TEST"）区分。

## 9.2 部署方式

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports: ["3000:3000"]
    environment:
      - DB_HOST=${RDS_HOST}
      - DASHSCOPE_API_KEY=${API_KEY}
    volumes:
      - ./config:/app/config      # ★ Prompt配置挂载，支持热更新
      - ./logs:/app/logs
    restart: always
```

**Prompt 热更新**：配置目录挂载到宿主机，修改 `.md` 文件后调用 `POST /api/v1/admin/reload-config` 重载，无需重启容器。这是PRD第7章的要求（产品团队可直接修改Prompt）。

## 9.3 开发排期建议

| 阶段 | 内容 | 人天 |
|------|------|------|
| 1 | 环境搭建（ECS/RDS/域名/备案启动）、项目脚手架 | 2 |
| 2 | 数据模型、认证、测评CRUD、列表页 | 3 |
| 3 | ★ LLM Client + 全量落库 + JSON健壮性 | 2 |
| 4 | ★ 上下文构造 + 隔离测试用例 | 2 |
| 5 | 对话页（考官模式 + 工具模式 + SSE） | 4 |
| 6 | 状态机 + 阶段推进 + 计时 | 2 |
| 7 | 评估 + 题纲生成 + 黑名单校验 | 3 |
| 8 | ★ 报告页 + 锁定过滤器 + 三方对比 | 3 |
| 9 | 联调、Prompt自测用例执行（附录3清单） | 4 |
| **合计** | | **25人天** |

单人开发约 5 周，两人并行（前后端分工）约 3 周。

**关键路径提醒**：域名备案 7–20 工作日，必须**第1天启动**，否则会成为上线瓶颈。

---

# 第10章 风险与应对

| # | 风险 | 影响 | 应对 |
|---|------|------|------|
| R1 | **域名备案周期超预期** | 阻塞上线 | 第1天启动；备选香港地域ECS免备案 |
| R2 | **评估JSON格式不稳定** | 评估失败率高 | 已设计三层防御（剥离/提取/重试）；Spike已初步验证 |
| R3 | **终判输入超模型上下文上限** | 终判失败 | 配置项 `purposes.eval.max_input_tokens=40000`；`llm.client.ts` 调用前估算输入 tokens，超限抛 `INPUT_TOO_LONG`；`final-evaluation.service.ts` 的 `buildFullLog` 按 R3 优先级截断后重试 |
| R4 | **工具模式AI仍表现出"知道在被测评"** | H3无法验证 | 附录3验收项2（U1–U10）必须全通过才进入测试 |
| R5 | **结论隐藏被绕过** | H2/H4数据作废 | 服务端过滤 + 自动化测试 + Code Review三重保障 |
| R6 | 模型API限流 | 对话卡顿 | 5并发下概率极低；已有指数退避重试 |

## R3 的截断策略（提前定义，避免临时决策）

终判输入上限由 `config/llm_params.yaml` 的 `purposes.eval.max_input_tokens` 配置（默认 40000）。`llm.client.ts` 在每次调用前用启发式 token 估算器（中文 1 token/字符，ASCII 约 0.25 token/字符）估算 system+user 消息总 tokens；超限时抛 `INPUT_TOO_LONG`，`llm_call_log` 落 `status=failed` + `error_msg`。

`final-evaluation.service.ts` 在收到 `INPUT_TOO_LONG` 后，调用 `truncateFullLog` 按 R3 优先级截断后重试一次；仍超限则状态回退 `EVAL_FAILED`。

若终判输入超限，按以下优先级截断：

| 优先级 | 内容 | 处理 |
|--------|------|------|
| 1（最先截） | 工具模式的 AI 回复 | 保留前500字 + "...(已截断)" |
| 2 | 考官模式的 AI 提问 | 保留全文（很短，不需截） |
| 3（绝不截） | 候选人的全部输入、面试记录 | 完整保留 |

理由：评估的证据来源是候选人的表达，AI的输出只是上下文。

---

# 附录A：Code Review 强制检查项

| # | 检查项 | 对应风险 |
|---|--------|---------|
| 1 | 除 `llm.client.ts` 外，无任何文件直接调用模型API | 落库完整性 |
| 2 | `buildToolContext` 函数签名不接受问卷/姓名/任务描述参数 | 上下文隔离 |
| 3 | `TOOL_MODE_PROMPT` 为静态常量，无模板变量 | 上下文隔离 |
| 4 | 所有报告类接口的返回均经过 `filterReport` | 结论隐藏 |
| 5 | 列表接口在锁定状态下不返回真实等级字符串 | 结论隐藏 |
| 6 | 题纲生成与评估为两次独立 `llm.call`，题纲输入不含评估结果 | 题纲泄露 |
| 7 | 阶段推进决策仅由 `shouldAdvanceStage` 产出，无其他分支 | 流程可控 |
| 8 | `llm_call_log` 在请求前落库，失败也有记录 | 数据不可丢 |

---

# 附录B：需确认事项

| # | 事项 | 需要谁确认 |
|---|------|-----------|
| 1 | 后端语言：Node.js 还是 Python（FastAPI） | 技术负责人 |
| 2 | 域名归属与备案主体 | 行政/IT |
| 3 | 是否接受"生产即测试环境" | 技术负责人 |
| 4 | 考官模式不做流式（普通POST）是否可接受 | 产品 |
| 5 | 阿里云账号开通与百炼 API Key 获取 | IT |

---
