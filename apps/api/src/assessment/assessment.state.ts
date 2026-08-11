// PoC 不变量 5：后端控制流程推进
// 模型只返回已定义 Schema 中的信号，状态机函数以 signals 为输入，
// 推进/任务切换/状态变化的决策全部在此处完成。
// 不读取 PRD 未定义的信号（例如 candidate_stuck）。
// 详见 docs/architecture.md 4.3、docs/prd.md 4.2/4.5/4.7/4.8。

export enum AssessmentStatus {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  EVALUATING = 'evaluating',
  COMPLETED = 'completed',
  PENDING_INTERVIEW = 'pending_interview',
  FINAL_EVALUATING = 'final_evaluating',
  ABANDONED = 'abandoned',
  EVAL_FAILED = 'eval_failed',
}

// PRD 4.5 / 架构 4.3：A 锁定状态——pending_interview / final_evaluating
// 此期间常规面试官接口不返回 A 的等级/轨道/置信度/维度/理由/落差/红线
// 详见 .claude/rules/poc-invariants.md 第2条
export function isALocked(status: AssessmentStatus): boolean {
  return (
    status === AssessmentStatus.PENDING_INTERVIEW ||
    status === AssessmentStatus.FINAL_EVALUATING
  );
}

// PRD 4.8 状态图
const ALLOWED_TRANSITIONS: Record<AssessmentStatus, AssessmentStatus[]> = {
  [AssessmentStatus.NOT_STARTED]: [
    AssessmentStatus.IN_PROGRESS,
    AssessmentStatus.ABANDONED,
  ],
  [AssessmentStatus.IN_PROGRESS]: [
    AssessmentStatus.EVALUATING,
    AssessmentStatus.ABANDONED,
  ],
  // 评估中：A 产出后由 shouldTriggerInterview 决定去 completed 还是 pending_interview
  // 评估失败由评估异常导致（架构 4.3 / PRD 4.7）
  [AssessmentStatus.EVALUATING]: [
    AssessmentStatus.COMPLETED,
    AssessmentStatus.PENDING_INTERVIEW,
    AssessmentStatus.EVAL_FAILED,
  ],
  // 提交 B 即进入终判中（PRD 4.8）
  [AssessmentStatus.PENDING_INTERVIEW]: [AssessmentStatus.FINAL_EVALUATING],
  // 终判 C 成功 → completed；C 失败 → eval_failed（PRD 4.7）
  [AssessmentStatus.FINAL_EVALUATING]: [
    AssessmentStatus.COMPLETED,
    AssessmentStatus.EVAL_FAILED,
  ],
  [AssessmentStatus.COMPLETED]: [],
  [AssessmentStatus.ABANDONED]: [],
  // 评估失败可重新评估（PRD 4.7）
  // EVAL_FAILED 来源有两类：初始评估失败（EVALUATING→EVAL_FAILED）与终判失败（FINAL_EVALUATING→EVAL_FAILED）
  // 重新评估入口（POST /:id/reevaluate）由 service 按 submitted_at 是否存在决定走 EVALUATING 还是 FINAL_EVALUATING
  [AssessmentStatus.EVAL_FAILED]: [
    AssessmentStatus.EVALUATING,
    AssessmentStatus.FINAL_EVALUATING,
  ],
};

export function canTransition(
  from: AssessmentStatus,
  to: AssessmentStatus,
): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

// PRD 5.1 signals 字段集合——只读这 6 个，禁止扩展
export interface ExaminerSignals {
  goal_coverage: number; // 0.0-1.0
  mentioned_process_change?: boolean;
  mentioned_asset?: boolean;
  mentioned_others_adoption?: boolean;
  mentioned_team_driving?: boolean;
  answer_vagueness: number; // 0.0-1.0
}

export interface StageContext {
  stageCode: 'S1.1' | 'S1.2' | 'S1.3';
  turnIndex: number; // 当前已完成轮数（1-based）
  signals: ExaminerSignals;
  totalElapsedSec: number; // 第1段已耗时
}

export interface StageConfig {
  name: string;
  goal: string;
  min_turns: number;
  max_turns: number;
  absolute_max_turns: number;
}

export type AdvanceReason = 'total_timeout' | 'max_turns' | 'goal_covered';

export interface AdvanceDecision {
  advance: boolean;
  reason?: AdvanceReason;
  // total_timeout 时为 true：跳过考官模式剩余阶段（架构 4.3）
  skipRemaining?: boolean;
}

// 架构 4.3 shouldAdvanceStage：考官模式内阶段推进
// 调用时机：每轮候选人回答结束后
// 仅处理阶段内推进；跨段推进由调用方按 shouldRunS13/任务完成事件编排
export function shouldAdvanceStage(
  ctx: StageContext,
  cfg: StageConfig,
): AdvanceDecision {
  // 优先级1：PRD 4.2 第1段总时长上限 15 分钟
  // 命中时本轮回答已完成（调用时机保证），直接跳过剩余考官阶段
  if (ctx.totalElapsedSec >= 900) {
    return { advance: true, reason: 'total_timeout', skipRemaining: true };
  }

  // 优先级2：PRD 5.1 answer_vagueness >= 0.7 → 本阶段最大轮次 +1，不超出 absolute_max_turns
  const maxTurns =
    ctx.signals.answer_vagueness >= 0.7
      ? Math.min(cfg.max_turns + 1, cfg.absolute_max_turns)
      : cfg.max_turns;
  if (ctx.turnIndex >= maxTurns) {
    return { advance: true, reason: 'max_turns' };
  }

  // 优先级3：PRD 5.1 goal_coverage >= 0.8 且已达最小轮次
  if (ctx.turnIndex >= cfg.min_turns && ctx.signals.goal_coverage >= 0.8) {
    return { advance: true, reason: 'goal_covered' };
  }

  return { advance: false };
}

export type IdleAction =
  | { action: 'none' }
  | { action: 'warn_candidate'; reason: 'idle_warn' }
  | { action: 'force_advance_stage'; reason: 'idle_timeout' }
  | { action: 'force_advance_task'; reason: 'idle_timeout' };

// PRD 4.7 单轮无响应超时
// 5 分钟 → 前端提示；10 分钟 → 自动结束当前阶段/任务
// 调用时机：定时器触发，不在每轮结束后调用
export function onCandidateIdle(
  idleSec: number,
  currentMode: 'examiner' | 'tool',
): IdleAction {
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

export interface QuestionnaireAnswers {
  q3?: string | null;
  q4?: string | null;
}

export interface ExaminerSignalRecord {
  stageOrTask: string; // 'S1.1' | 'S1.2' | 'S1.3'
  signals: ExaminerSignals;
}

export interface S13TriggerInput {
  questionnaire: QuestionnaireAnswers;
  examinerSignals: ExaminerSignalRecord[];
}

// PRD 4.2 S1.3 触发条件：满足任一即触发
// 1) Q3 命中"给过同事用"/"有人主动来找我要"
// 2) Q4 命中"经常"/"我是团队里主要的答疑人"
// 3) S1.1 / S1.2 任一轮次出现过 mentioned_process_change / mentioned_asset /
//    mentioned_others_adoption / mentioned_team_driving
export function shouldRunS13(input: S13TriggerInput): boolean {
  if (
    input.questionnaire.q3 &&
    ['给过同事用', '有人主动来找我要'].includes(input.questionnaire.q3)
  ) {
    return true;
  }
  if (
    input.questionnaire.q4 &&
    ['经常', '我是团队里主要的答疑人'].includes(input.questionnaire.q4)
  ) {
    return true;
  }
  for (const r of input.examinerSignals) {
    if (r.stageOrTask !== 'S1.1' && r.stageOrTask !== 'S1.2') continue;
    const s = r.signals;
    if (
      s.mentioned_process_change ||
      s.mentioned_asset ||
      s.mentioned_others_adoption ||
      s.mentioned_team_driving
    ) {
      return true;
    }
  }
  return false;
}

export interface InterviewTriggerInput {
  level: string; // A 的等级，例如 'L3_pending' / 'L4_pending' / 'L2' / 'L3' / 'L4'
  track: string;
  confidence: number;
  claimRealityGapLevel?: '重大' | '一般' | null;
  redLinesCount: number;
}

// PRD 4.5 面试官环节触发条件（满足任一即触发）
// 模型返回的 recommend_human_review 仅作辅助提示，不参与触发决策
export function shouldTriggerInterview(input: InterviewTriggerInput): boolean {
  if (['L3_pending', 'L4_pending'].includes(input.level)) return true;
  if (input.track === '团队负责人轨道') return true;
  if (input.confidence < 0.6) return true;
  if (input.claimRealityGapLevel === '重大') return true;
  if (input.redLinesCount > 0) return true;
  return false;
}

// PRD 4.7 候选人放弃触发器
// 30 分钟无 dialogue_log 新增 + 状态仍 in_progress → 置为 abandoned
// 该检查由定时任务执行，不在请求路径上
export function shouldMarkAbandoned(
  lastTs: Date | null,
  now: Date = new Date(),
): boolean {
  if (!lastTs) return false;
  return now.getTime() - lastTs.getTime() > 30 * 60 * 1000;
}
