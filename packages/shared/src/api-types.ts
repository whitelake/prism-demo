// 候选人端 + 面试官端 API 类型。
// 前端只渲染后端返回的 step/locked 字段，不实现业务判断逻辑。

export type AssessmentStage =
  | 'examiner'
  | 'questionnaire'
  | 'tool'
  | 'pending_interview'
  | 'interview'
  | 'final_evaluating'
  | 'completed';

export type AssessmentLevel = 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
export type AssessmentTrack = 'A' | 'B' | 'C';

export type CandidateStep = 'entry' | 'questionnaire' | 'examiner' | 'tool' | 'finished';
export type DialogueMode = 'examiner' | 'tool';
export type StageCode = 'S1.1' | 'S1.2' | 'S1.3';
export type TaskCode = 'T1' | 'T2';

export type AssessmentStatus =
  | 'not_started'
  | 'in_progress'
  | 'evaluating'
  | 'completed'
  | 'pending_interview'
  | 'final_evaluating'
  | 'abandoned'
  | 'eval_failed';

export interface SystemCard {
  variant: 'mode_switch' | 'task_brief' | 'task_done' | 'notice';
  title: string;
  body: string;
  attachment?: {
    label: string;
    content: string;
  };
}

export interface DialogueMessage {
  id: number;
  type: 'ai' | 'candidate' | 'system_card';
  mode: DialogueMode | null;
  content: string;
  card?: SystemCard;
  ts: string;
}

export interface TimerInfo {
  examinerTotalRemainingSec: number | null;
  taskRemainingSec: number | null;
  idleWarningAtSec: number;
  idleSkipAtSec: number;
  lastActivityTs: string;
}

export interface EntryInfo {
  assessmentId: string;
  candidateName: string;
  position: string;
  status: AssessmentStatus;
  step: CandidateStep;
  estimatedMinutes: number;
  notice: string;
  canResume: boolean;
}

export interface StartResponse {
  status: AssessmentStatus;
  step: CandidateStep;
  startedAt: string;
}

export interface QuestionOption {
  value: string;
  label: string;
}
export interface QuestionItem {
  code: string;
  type: 'single' | 'multiple' | 'text';
  title: string;
  options?: QuestionOption[];
  required?: boolean;
  minSelect?: number;
  placeholder?: string;
}
export interface QuestionnaireData {
  questions: QuestionItem[];
}

export type QuestionnaireAnswers = Record<string, string | string[]>;

export interface StepResponse {
  step: CandidateStep;
  currentStage?: StageCode | null;
  currentTask?: TaskCode | null;
  turnIndex?: number;
  stageAdvanced?: boolean;
  newMessages?: DialogueMessage[];
  messages?: DialogueMessage[];
  timer?: TimerInfo;
  inputEnabled?: boolean;
  status?: AssessmentStatus;
  submittedAt?: string;
  finishMessage?: string;
}

export type SseEvent =
  | { event: 'accepted'; data: { candidateMessageId: number; aiMessageId?: number } }
  | { event: 'delta'; data: { text: string } }
  | { event: 'done'; data: { aiMessageId: number; turnIndex: number; taskRemainingSec: number; finishReason: 'stop' | 'length' } }
  | { event: 'error'; data: { code: string; message: string } };

export interface AppError {
  code: string;
  message: string;
  detail?: unknown;
}

// ===== 面试官端 =====

export interface Interviewer {
  id: string;
  name: string;
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  interviewer: Interviewer;
}

export interface ListItem {
  id: string;
  candidateName: string;
  position: string | null;
  status: AssessmentStatus;
  statusLabel: string;
  levelDisplay: string | null;
  submittedAt: string | null;
  createdAt: string;
}

export interface ListResponse {
  total: number;
  page: number;
  pageSize: number;
  items: ListItem[];
}

export interface CreateAssessmentResponse {
  id: string;
  token: string;
  link: string;
  status: AssessmentStatus;
  createdAt: string;
}

export interface AssessmentReportMeta {
  id: string;
  candidateName: string;
  position: string | null;
  submittedAt: string | null;
}

export interface OutlineSummary {
  assessmentId: string;
  status: string;
  resultJson: unknown | null;
  createdAt: string;
}

export interface DialogueLogItem {
  mode: DialogueMode;
  stageOrTask: string;
  turnIndex: number;
  role: 'ai' | 'candidate';
  content: string;
  responseIntervalSec: number | null;
  ts: string;
}

export interface RawLog {
  questionnaire: {
    q1: string | null;
    q2: unknown;
    q3: string | null;
    q4: string | null;
    q5: string | null;
    submittedAt: string;
  } | null;
  examinerDialogue: DialogueLogItem[];
  toolDialogue: DialogueLogItem[];
}

export interface EvaluationSummary {
  id: string;
  type: 'A' | 'C';
  level: string;
  track: string;
  confidence: number;
  recommendHumanReview: boolean;
  resultJson: unknown;
  createdAt: string;
}

export interface JudgmentSummary {
  assessmentId: string;
  level: string;
  track: string;
  reason: string;
  transcript: string;
  transcriptDraft: string | null;
  submittedAt: string | null;
}

export interface FailureInfo {
  stage: 'evaluation_a' | 'evaluation_c' | 'outline';
  reason: string;
  occurredAt: string;
  canRetry: boolean;
}

export interface LockedReport {
  locked: true;
  status: AssessmentStatus;
  statusLabel: string;
  assessment: AssessmentReportMeta;
  lockNotice: string;
  outline: OutlineSummary | null;
  rawLog: RawLog;
  transcriptDraft: string | null;
}

export interface UnlockedReport {
  locked: false;
  status: AssessmentStatus;
  statusLabel: string;
  assessment: AssessmentReportMeta;
  lockNotice: null;
  outline: OutlineSummary | null;
  rawLog: RawLog;
  evaluationA: EvaluationSummary | null;
  evaluationC: EvaluationSummary | null;
  judgmentB: JudgmentSummary | null;
  failureInfo: FailureInfo | null;
}

export type Report = LockedReport | UnlockedReport;

export interface StatusResponse {
  status: AssessmentStatus;
  statusLabel: string;
  locked: boolean;
  updatedAt: string;
}

export interface TranscriptSaveResponse {
  savedAt: string;
  charCount: number;
}

export interface JudgmentSubmitResponse {
  status?: AssessmentStatus;
  submittedAt?: string;
  message?: string;
  warn?: 'transcript_short';
  charCount?: number;
  needConfirm?: boolean;
}
