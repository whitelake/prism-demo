import { AssessmentStatus } from './assessment.state';

// PoC 不变量 2：A 结论锁定
// 详见 docs/architecture.md 4.2、.claude/rules/poc-invariants.md 第2条
//
// 三条强制约束（架构 4.2）：
// 1. 所有报告接口必须调用 filterReport，禁止直接 return evaluation
// 2. 列表接口同样过滤：锁定状态下 levelDisplay 返回 "待验证" 而非真实等级
// 3. 解锁触发点唯一：interviewer_judgment 表插入记录成功后状态机推进
//
// PoC 不变量 3：signals 不下发
// 常规接口（report/list/state/message）的 rawLog 必须用 stripSignals 过滤；
// 唯一例外是 export 接口，由 buildExportPayload 单独构造。
//
// api-spec 8.1 A1/A3 要求：锁定期 JSON 序列化后不含
//   evaluationA / level / confidence / dimensions 任一键名。
// 为满足此约束，锁定态 ReportDto 不带这些键（联合类型），而非赋 null。

export interface AssessmentReportMeta {
  id: string;
  candidateName: string;
  position: string | null;
  status: AssessmentStatus;
  submittedAt: Date | null;
  createdAt: Date;
}

export interface EvaluationSummary {
  id: string;
  type: 'A' | 'C';
  level: string; // 'L2' | 'L3_pending' | 'L4_pending' | 'L3' | 'L4' ...
  track: string;
  confidence: number;
  recommendHumanReview: boolean;
  resultJson: unknown;
  createdAt: Date;
}

export interface JudgmentSummary {
  assessmentId: string;
  level: string;
  track: string;
  reason: string;
  transcript: string;
  transcriptDraft: string | null;
  submittedAt: Date | null;
}

export interface OutlineSummary {
  assessmentId: string;
  status: string; // 'success' | 'blacklist_failed'
  resultJson: unknown | null;
  createdAt: Date;
}

export interface FailureInfo {
  stage: 'evaluation_a' | 'evaluation_c' | 'outline';
  reason: string;
  occurredAt: Date;
  canRetry: boolean;
}

// rawLog 中每条对话记录——常规接口不含 signals
export interface DialogueLogDtoItem {
  mode: 'examiner' | 'tool';
  stageOrTask: string;
  turnIndex: number;
  role: 'ai' | 'candidate';
  content: string;
  responseIntervalSec: number | null;
  ts: Date;
  // 仅在 buildExportPayload 中填充
  signals?: unknown;
}

export interface RawLogDto {
  questionnaire: {
    q1: string | null;
    q2: string | null;
    q3: string | null;
    q4: string | null;
    q5: string | null;
    submittedAt: Date;
  } | null;
  examinerDialogue: DialogueLogDtoItem[];
  toolDialogue: DialogueLogDtoItem[];
}

// 锁定态：不含 evaluationA / evaluationC / failureInfo / judgmentB 键
// 仅返回 transcriptDraft（架构 4.2 原版语义）
export interface LockedReportDto {
  locked: true;
  status: AssessmentStatus;
  statusLabel: string;
  assessment: {
    id: string;
    candidateName: string;
    position: string | null;
    submittedAt: Date | null;
  };
  lockNotice: string;
  outline: OutlineSummary | null;
  rawLog: RawLogDto;
  transcriptDraft: string | null;
}

// 解锁态：包含 A/B/C/failureInfo
export interface UnlockedReportDto {
  locked: false;
  status: AssessmentStatus;
  statusLabel: string;
  assessment: {
    id: string;
    candidateName: string;
    position: string | null;
    submittedAt: Date | null;
  };
  lockNotice: null;
  outline: OutlineSummary | null;
  rawLog: RawLogDto;
  evaluationA: EvaluationSummary | null;
  evaluationC: EvaluationSummary | null;
  judgmentB: JudgmentSummary | null;
  failureInfo: FailureInfo | null;
}

export type ReportDto = LockedReportDto | UnlockedReportDto;

export interface ReportFilterInput {
  assessment: AssessmentReportMeta;
  evaluationA: EvaluationSummary | null;
  evaluationC: EvaluationSummary | null;
  judgmentB: JudgmentSummary | null;
  outline: OutlineSummary | null;
  rawLog: RawLogDto;
  failureInfo: FailureInfo | null;
}

const LOCK_NOTICE =
  '本次测评触发了现场验证流程。请先与候选人完成面对面追问，' +
  '录入记录并提交你的独立判断后，才会展示AI的评估结论。';

const STATUS_LABELS: Record<AssessmentStatus, string> = {
  [AssessmentStatus.NOT_STARTED]: '未开始',
  [AssessmentStatus.IN_PROGRESS]: '进行中',
  [AssessmentStatus.EVALUATING]: '评估中',
  [AssessmentStatus.COMPLETED]: '已完成',
  [AssessmentStatus.PENDING_INTERVIEW]: '待现场验证',
  [AssessmentStatus.FINAL_EVALUATING]: '终判中',
  [AssessmentStatus.ABANDONED]: '已放弃',
  [AssessmentStatus.EVAL_FAILED]: '评估失败',
};

export function statusLabel(status: AssessmentStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// PoC 不变量 2：报告数据出口的唯一过滤点
// 所有报告相关接口（GET /report）必须调用此函数；禁止直接返回 evaluation 实体
// GET /export 单独走 buildExportPayload
export function filterReport(input: ReportFilterInput): ReportDto {
  const base = {
    status: input.assessment.status,
    statusLabel: statusLabel(input.assessment.status),
    assessment: {
      id: input.assessment.id,
      candidateName: input.assessment.candidateName,
      position: input.assessment.position,
      submittedAt: input.assessment.submittedAt,
    },
    outline: input.outline,
    rawLog: stripSignals(input.rawLog),
  };

  if (isLockedStatus(input.assessment.status)) {
    // 锁定期：不返回 evaluationA/evaluationC/judgmentB/failureInfo 键
    // 仅返回 transcriptDraft 供面试官继续编辑草稿
    // api-spec 8.1 A1/A3：序列化后不含 evaluationA / level / confidence / dimensions 键名
    const locked: LockedReportDto = {
      ...base,
      locked: true,
      lockNotice: LOCK_NOTICE,
      transcriptDraft: input.judgmentB?.transcriptDraft ?? null,
    };
    return locked;
  }

  const unlocked: UnlockedReportDto = {
    ...base,
    locked: false,
    lockNotice: null,
    evaluationA: input.evaluationA,
    evaluationC: input.evaluationC,
    judgmentB: input.judgmentB,
    failureInfo: input.failureInfo,
  };
  return unlocked;
}

// 锁定判定：与 assessment.state.ts 的 isALocked 一致
// 此处独立实现，避免循环依赖；测试需保证二者一致
export function isLockedStatus(status: AssessmentStatus): boolean {
  return (
    status === AssessmentStatus.PENDING_INTERVIEW ||
    status === AssessmentStatus.FINAL_EVALUATING
  );
}

// PoC 不变量 3：常规接口的 rawLog 不含 signals 字段
// stripSignals 返回新对象，不修改入参
export function stripSignals(rawLog: RawLogDto): RawLogDto {
  const stripArr = (arr: DialogueLogDtoItem[]): DialogueLogDtoItem[] =>
    arr.map((r) => ({
      mode: r.mode,
      stageOrTask: r.stageOrTask,
      turnIndex: r.turnIndex,
      role: r.role,
      content: r.content,
      responseIntervalSec: r.responseIntervalSec,
      ts: r.ts,
    }));
  return {
    questionnaire: rawLog.questionnaire,
    examinerDialogue: stripArr(rawLog.examinerDialogue),
    toolDialogue: stripArr(rawLog.toolDialogue),
  };
}

// 列表项过滤（架构 4.2 强制约束2）
// levelDisplay: A 锁定状态或 eval_failed → "待验证"
//               evaluating 且 A 未产出 → null
//               其他 → A.level（如 "L2"）
// 列表项不返回 level/confidence 等原始字段
export interface ListItemDto {
  id: string;
  candidateName: string;
  position: string | null;
  status: AssessmentStatus;
  statusLabel: string;
  levelDisplay: string | null; // "L2" / "待验证" / null
  submittedAt: Date | null;
  createdAt: Date;
}

export function filterListItem(
  assessment: AssessmentReportMeta,
  evalA: EvaluationSummary | null,
): ListItemDto {
  const locked = isLockedStatus(assessment.status);
  let levelDisplay: string | null;
  if (locked) {
    levelDisplay = '待验证';
  } else if (assessment.status === AssessmentStatus.EVAL_FAILED) {
    levelDisplay = '待验证';
  } else if (assessment.status === AssessmentStatus.EVALUATING) {
    levelDisplay = null;
  } else if (evalA) {
    levelDisplay = evalA.level;
  } else {
    levelDisplay = null;
  }

  return {
    id: assessment.id,
    candidateName: assessment.candidateName,
    position: assessment.position,
    status: assessment.status,
    statusLabel: statusLabel(assessment.status),
    levelDisplay,
    submittedAt: assessment.submittedAt,
    createdAt: assessment.createdAt,
  };
}

// export 接口专用：唯一允许返回 signals 的入口（api-spec 8.3 C4 例外）
// 仍需遵守 A 锁定规则——锁定期 export 同样不返回 evaluationA/C
export interface ExportPayload {
  assessment: AssessmentReportMeta;
  questionnaire: RawLogDto['questionnaire'];
  dialogueLog: DialogueLogDtoItem[]; // 含 signals
  evaluationA: EvaluationSummary | null;
  evaluationC: EvaluationSummary | null;
  judgmentB: JudgmentSummary | null;
  outline: OutlineSummary | null;
  consistency: unknown;
  llmCallLog: unknown[];
}

export function buildExportPayload(
  input: ReportFilterInput,
  consistency: unknown,
  llmCallLog: unknown[],
): ExportPayload {
  const locked = isLockedStatus(input.assessment.status);
  const dialogueLog: DialogueLogDtoItem[] = [
    ...input.rawLog.examinerDialogue,
    ...input.rawLog.toolDialogue,
  ]; // 保留 signals 字段
  return {
    assessment: input.assessment,
    questionnaire: input.rawLog.questionnaire,
    dialogueLog,
    evaluationA: locked ? null : input.evaluationA,
    evaluationC: locked ? null : input.evaluationC,
    judgmentB: input.judgmentB,
    outline: input.outline,
    consistency,
    llmCallLog,
  };
}
