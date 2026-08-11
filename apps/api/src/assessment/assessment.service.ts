import { Injectable, forwardRef, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import {
  AssessmentEntity,
} from '@/db/entities/assessment.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import {
  AssessmentStatus,
  canTransition,
  onCandidateIdle,
} from '@/assessment/assessment.state';
import { AppError } from '@/common/app-error';
import { FinalEvaluationService } from './final-evaluation.service';
import { ExaminerService, type FirstTurnResult } from './examiner.service';
import { ToolService } from './tool.service';
import { InitialEvaluationService } from './initial-evaluation.service';
import { QuestionnaireService } from '@/questionnaire/questionnaire.config';

export interface CreateAssessmentInput {
  candidateName: string;
  position: string | null;
  interviewerId: string;
}

export interface CreatedAssessment {
  id: string;
  token: string;
  status: AssessmentStatus;
  createdAt: Date;
}

export type CandidateStep =
  | 'entry'
  | 'questionnaire'
  | 'examiner'
  | 'tool'
  | 'finished';

interface ProgressShape {
  mode?: string;
  currentStage?: string | null;
  currentTask?: string | null;
  turnIndex?: number;
  stageStartTs?: number;
  lastActivityTs?: number;
  s13Triggered?: boolean;
  totalElapsedSec?: number;
}

const STEP_FOR_STATUS: Record<AssessmentStatus, CandidateStep> = {
  [AssessmentStatus.NOT_STARTED]: 'entry',
  [AssessmentStatus.IN_PROGRESS]: 'examiner',
  [AssessmentStatus.EVALUATING]: 'finished',
  [AssessmentStatus.COMPLETED]: 'finished',
  [AssessmentStatus.PENDING_INTERVIEW]: 'finished',
  [AssessmentStatus.FINAL_EVALUATING]: 'finished',
  [AssessmentStatus.ABANDONED]: 'finished',
  [AssessmentStatus.EVAL_FAILED]: 'finished',
};

// api-spec 3.2 / 3.4：IN_PROGRESS 期间需按 progress 区分 questionnaire 与 examiner
// - status=IN_PROGRESS 且 progress 未初始化 → 还在问卷阶段
// - status=IN_PROGRESS 且 progress 已初始化 → 进入考官/工具对话
function stepFor(a: AssessmentEntity): CandidateStep {
  if (a.status === AssessmentStatus.IN_PROGRESS) {
    return a.progress ? 'examiner' : 'questionnaire';
  }
  return STEP_FOR_STATUS[a.status as AssessmentStatus];
}

@Injectable()
export class AssessmentService {
  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    @InjectRepository(InterviewerJudgmentEntity)
    private readonly judgmentRepo: Repository<InterviewerJudgmentEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @Inject(forwardRef(() => FinalEvaluationService))
    private readonly finalEval: FinalEvaluationService,
    readonly examiner: ExaminerService,
    readonly tool: ToolService,
    private readonly initialEval: InitialEvaluationService,
    private readonly questionnaireService: QuestionnaireService,
  ) {}

  // POST /assessments
  async create(input: CreateAssessmentInput): Promise<CreatedAssessment> {
    if (
      !input.candidateName ||
      input.candidateName.trim().length < 1 ||
      input.candidateName.length > 20
    ) {
      throw new AppError('PARAM_INVALID', 'candidateName must be 1–20 chars');
    }
    if (input.position && input.position.length > 100) {
      throw new AppError('PARAM_INVALID', 'position must be ≤ 100 chars');
    }
    const id = crypto.randomUUID();
    const token = crypto.randomBytes(16).toString('hex'); // 32 char hex
    const now = new Date();
    const assessment = this.assessmentRepo.create({
      id,
      interviewerId: input.interviewerId,
      candidateName: input.candidateName.trim(),
      position: input.position ?? null,
      token,
      status: AssessmentStatus.NOT_STARTED,
      progress: null,
      createdAt: now,
      startedAt: null,
      submittedAt: null,
    });
    await this.assessmentRepo.save(assessment);
    return {
      id,
      token,
      status: AssessmentStatus.NOT_STARTED,
      createdAt: now,
    };
  }

  // GET /c/:token
  async getEntry(assessmentId: string) {
    const a = await this.requireAssessment(assessmentId);
    return {
      assessmentId: a.id,
      candidateName: a.candidateName,
      position: a.position,
      status: a.status,
      step: stepFor(a),
      estimatedMinutes: 30,
      notice:
        '本次测评包含选择题、对话交流和两个实操任务。\n请使用电脑完成，全程约30分钟。\n过程中请如实描述你的实际做法。',
      canResume: a.status === AssessmentStatus.IN_PROGRESS,
    };
  }

  // POST /c/:token/start
  async start(assessmentId: string, confirmedName: string) {
    if (
      !confirmedName ||
      confirmedName.trim().length < 1 ||
      confirmedName.trim().length > 20
    ) {
      throw new AppError('PARAM_INVALID', 'confirmedName must be 1–20 chars');
    }
    const a = await this.requireAssessment(assessmentId);
    if (a.status !== AssessmentStatus.NOT_STARTED) {
      throw new AppError('ALREADY_STARTED');
    }
    a.candidateName = confirmedName.trim();
    a.status = AssessmentStatus.IN_PROGRESS;
    a.startedAt = new Date();
    await this.assessmentRepo.save(a);
    return {
      status: a.status,
      step: stepFor(a),
      startedAt: a.startedAt,
    };
  }

  // POST /c/:token/questionnaire
  // 候选人提交问卷 → 落库 → 触发状态机推进 NOT_STARTED → IN_PROGRESS
  // → 写 progress（mode=examiner, currentStage=S1.1, turnIndex=0）
  // → 同步生成 S1.1 第 1 轮 AI 提问 → 返回完整 next 结构
  // PRD 4.8 / api-spec 3.4：返回 messages 不含 signals（不变量 3）
  async submitQuestionnaire(
    assessmentId: string,
    answers: { q1?: string; q2?: unknown; q3?: string; q4?: string; q5?: string },
  ): Promise<{ submittedAt: Date; next: FirstTurnResult }> {
    const { submittedAt } = await this.questionnaireService.submit(assessmentId, answers);
    const next = await this.startQuestionnaireFlow(assessmentId);
    return { submittedAt, next };
  }

  // 轻量提交：落库问卷 + 推进状态 + 初始化 progress，立即返回；
  // 首问异步触发（examiner.triggerAsync），前端进对话页后轮询 GET /state 拉取
  // 与 submitQuestionnaire（同步等 LLM）并存：后者供 invariants 测试与同步契约使用
  async submitQuestionnaireLight(
    assessmentId: string,
    answers: { q1?: string; q2?: unknown; q3?: string; q4?: string; q5?: string },
  ): Promise<{ submittedAt: Date; next: FirstTurnResult }> {
    const { submittedAt } = await this.questionnaireService.submit(assessmentId, answers);
    const a = await this.requireAssessment(assessmentId);
    if (a.progress) {
      throw new AppError('ALREADY_STARTED', { status: a.status });
    }
    if (a.status === AssessmentStatus.NOT_STARTED) {
      if (!canTransition(AssessmentStatus.NOT_STARTED, AssessmentStatus.IN_PROGRESS)) {
        throw new AppError('INTERNAL_ERROR', { from: a.status, to: AssessmentStatus.IN_PROGRESS });
      }
      a.status = AssessmentStatus.IN_PROGRESS;
      if (!a.startedAt) a.startedAt = new Date();
    } else if (a.status !== AssessmentStatus.IN_PROGRESS) {
      throw new AppError('ALREADY_STARTED', { status: a.status });
    }
    const now = Date.now();
    a.progress = {
      mode: 'examiner',
      currentStage: 'S1.1',
      currentTask: null,
      turnIndex: 0,
      stageStartTs: now,
      lastActivityTs: now,
      s13Triggered: false,
      totalElapsedSec: 0,
    } as Record<string, unknown>;
    await this.assessmentRepo.save(a);
    // 异步触发首问生成，不阻塞响应
    this.examiner.triggerAsync(assessmentId, 'S1.1');
    return {
      submittedAt,
      next: {
        step: 'examiner',
        currentStage: 'S1.1',
        currentTask: null,
        turnIndex: 0,
        messages: [],
        inputEnabled: false,
      },
    };
  }

  // 状态机推进 NOT_STARTED → IN_PROGRESS + 初始化 progress + 同步生成首问
  // 兼容已 start（status=IN_PROGRESS 但 progress=null）的情况：跳过状态推进，仅初始化 progress
  // 不变量 5：流程推进由后端执行；首问同步生成（PoC 简化：非 SSE）
  // 不变量 3：首问 messages 仅含 AI 文本，不含 signals
  async startQuestionnaireFlow(assessmentId: string): Promise<FirstTurnResult> {
    const a = await this.requireAssessment(assessmentId);

    // 已有 progress → 重复提交
    if (a.progress) {
      throw new AppError('ALREADY_STARTED', { status: a.status });
    }

    if (a.status === AssessmentStatus.NOT_STARTED) {
      if (!canTransition(AssessmentStatus.NOT_STARTED, AssessmentStatus.IN_PROGRESS)) {
        throw new AppError('INTERNAL_ERROR', {
          from: a.status,
          to: AssessmentStatus.IN_PROGRESS,
        });
      }
      a.status = AssessmentStatus.IN_PROGRESS;
      if (!a.startedAt) a.startedAt = new Date();
    } else if (a.status !== AssessmentStatus.IN_PROGRESS) {
      throw new AppError('ALREADY_STARTED', { status: a.status });
    }

    const now = Date.now();
    a.progress = {
      mode: 'examiner',
      currentStage: 'S1.1',
      currentTask: null,
      turnIndex: 0,
      stageStartTs: now,
      lastActivityTs: now,
      s13Triggered: false,
      totalElapsedSec: 0,
    } as Record<string, unknown>;
    await this.assessmentRepo.save(a);

    return this.examiner.generateFirstTurn(assessmentId, 'S1.1');
  }

  // GET /c/:token/state
  // PRD 4.7 / api-spec 3.9：续答/刷新时返回全量 messages（不含 signals）+ progress + timer
  // 不变量 3：messages 仅含 role/content/stageOrTask/turnIndex/ts，绝不返回 signals
  async getState(assessmentId: string) {
    const a = await this.requireAssessment(assessmentId);
    const progress = (a.progress as ProgressShape | null) ?? null;

    const rows = await this.dialogueRepo.find({
      where: { assessmentId },
      order: { ts: 'ASC' },
    });

    const messages = rows.map((r) => {
      if (r.role === 'system_card') {
        // system_card 行：content 存 JSON {variant, title, body}，重建为前端卡片
        let card: { variant: string; title: string; body: string } | undefined;
        try {
          card = JSON.parse(r.content);
        } catch {
          card = undefined;
        }
        return {
          id: Number(r.id),
          type: 'system_card' as const,
          mode: null as 'examiner' | 'tool' | null,
          card,
          stageOrTask: r.stageOrTask,
          turnIndex: r.turnIndex,
          ts: r.ts.toISOString(),
        };
      }
      return {
        id: Number(r.id),
        type: r.role === 'ai' ? ('ai' as const) : ('candidate' as const),
        mode: r.mode as 'examiner' | 'tool',
        content: r.content,
        stageOrTask: r.stageOrTask,
        turnIndex: r.turnIndex,
        ts: r.ts.toISOString(),
      };
    });

    return {
      assessmentId: a.id,
      candidateName: a.candidateName,
      status: a.status,
      step: stepFor(a),
      currentStage: progress?.currentStage ?? null,
      currentTask: progress?.currentTask ?? null,
      turnIndex: progress?.turnIndex ?? 0,
      messages,
      timer: this.buildTimerFromProgress(progress, a.status as AssessmentStatus),
      inputEnabled: a.status === AssessmentStatus.IN_PROGRESS,
    };
  }

  // POST /c/:token/skip
  // PRD 4.7 / api-spec 3.8：idle_timeout 触发；服务端二次校验 idleSec
  // 不变量 5：推进由后端状态机决策
  async skip(assessmentId: string): Promise<{
    action?: 'warn_candidate';
    result?: unknown;
  }> {
    const a = await this.requireAssessment(assessmentId);
    if (a.status !== AssessmentStatus.IN_PROGRESS) {
      throw new AppError('SKIP_NOT_ALLOWED', { reason: 'not in progress', status: a.status });
    }
    const progress = (a.progress as ProgressShape | null);
    if (!progress || !progress.lastActivityTs || !progress.mode) {
      throw new AppError('SKIP_NOT_ALLOWED', { reason: 'no progress' });
    }
    const idleSec = Math.floor((Date.now() - progress.lastActivityTs) / 1000);
    const decision = onCandidateIdle(idleSec, progress.mode as 'examiner' | 'tool');

    if (decision.action === 'none') {
      throw new AppError('SKIP_NOT_ALLOWED', { idleSec, reason: 'idle not long enough' });
    }
    if (decision.action === 'warn_candidate') {
      return { action: 'warn_candidate' };
    }
    if (decision.action === 'force_advance_stage') {
      const result = await this.examiner.forceAdvance(assessmentId);
      return { result };
    }
    const result = await this.tool.forceComplete(assessmentId);
    return { result };
  }

  private buildTimerFromProgress(
    progress: ProgressShape | null,
    status: AssessmentStatus,
  ): {
    examinerTotalRemainingSec: number | null;
    taskRemainingSec: number | null;
    idleWarningAtSec: number;
    idleSkipAtSec: number;
    lastActivityTs: string | null;
  } {
    if (status !== AssessmentStatus.IN_PROGRESS || !progress) {
      return {
        examinerTotalRemainingSec: null,
        taskRemainingSec: null,
        idleWarningAtSec: 300,
        idleSkipAtSec: 600,
        lastActivityTs: null,
      };
    }
    const elapsed = progress.totalElapsedSec ?? 0;
    const isExaminer = progress.mode === 'examiner';
    return {
      examinerTotalRemainingSec: isExaminer ? Math.max(0, 900 - elapsed) : null,
      taskRemainingSec: isExaminer ? null : null, // PoC 简化：任务时长未在 progress 落库，由前端 lastActivityTs 推算
      idleWarningAtSec: 300,
      idleSkipAtSec: 600,
      lastActivityTs: progress.lastActivityTs
        ? new Date(progress.lastActivityTs).toISOString()
        : null,
    };
  }

  // GET /assessments/:id
  async getByIdForInterviewer(
    id: string,
    interviewerId: string,
): Promise<AssessmentEntity> {
    const a = await this.assessmentRepo.findOne({ where: { id } });
    if (!a) throw new AppError('NOT_FOUND', { id });
    if (a.interviewerId !== interviewerId) {
      throw new AppError('FORBIDDEN', { id, interviewerId });
    }
    return a;
  }

  // GET /assessments?status=&keyword=&page=&pageSize=
  async list(
    interviewerId: string,
    opts: {
      status?: string | undefined;
      keyword?: string | undefined;
      page: number;
      pageSize: number;
    },
  ): Promise<{ total: number; page: number; pageSize: number; items: AssessmentEntity[] }> {
    const qb = this.assessmentRepo
      .createQueryBuilder('a')
      .where('a.interviewer_id = :iid', { iid: interviewerId });

    if (opts.status) {
      const statuses = opts.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length > 0) {
        qb.andWhere('a.status IN (:...statuses)', { statuses });
      }
    }
    if (opts.keyword) {
      qb.andWhere('(a.candidate_name LIKE :kw OR a.position LIKE :kw)', {
        kw: `%${opts.keyword}%`,
      });
    }

    const total = await qb.getCount();
    const items = await qb
      .orderBy('a.created_at', 'DESC')
      .skip((opts.page - 1) * opts.pageSize)
      .take(opts.pageSize)
      .getMany();

    return { total, page: opts.page, pageSize: opts.pageSize, items };
  }

  // POST /assessments/:id/judgment
  // 提交B：状态机推进 PENDING_INTERVIEW → FINAL_EVALUATING
  // 解锁触发点唯一（架构 4.2 强制约束3）：B 落库后状态机推进，
  // 但 A 仍未解锁——需 C 成功（架构 4.3 / PRD 4.8）
  async submitJudgment(
    assessmentId: string,
    interviewerId: string,
    input: {
      level: string;
      track: string;
      reason: string;
      transcript: string;
      confirm?: boolean;
    },
  ): Promise<
    | { status: AssessmentStatus; submittedAt: Date; message: string }
    | { warn: 'transcript_short'; charCount: number; message: string; needConfirm: true }
  > {
    const a = await this.getByIdForInterviewer(assessmentId, interviewerId);

    if (a.status !== AssessmentStatus.PENDING_INTERVIEW) {
      throw new AppError('JUDGMENT_ALREADY_SUBMITTED', {
        status: a.status,
      });
    }

    // 已存在判断 → 防重放
    const existing = await this.judgmentRepo.findOne({
      where: { assessmentId },
    });
    if (existing && existing.submittedAt) {
      throw new AppError('JUDGMENT_ALREADY_SUBMITTED');
    }

    // 校验
    if (!input.level || !/^L[0-4]$/.test(input.level)) {
      throw new AppError('PARAM_INVALID', 'level must be L0–L4 (no _pending)');
    }
    if (
      !input.track ||
      !['个人深度轨道', '团队负责人轨道', '无法判断'].includes(input.track)
    ) {
      throw new AppError('PARAM_INVALID', 'track invalid');
    }
    if (!input.reason || input.reason.length < 30 || input.reason.length > 2000) {
      throw new AppError('PARAM_INVALID', 'reason must be 30–2000 chars');
    }
    if (!input.transcript || input.transcript.length < 1 || input.transcript.length > 100000) {
      throw new AppError('PARAM_INVALID', 'transcript must be 1–100000 chars');
    }

    // 短记录确认态：不落库，返回 needConfirm
    // PRD 5.6 / api-spec 4.8：少于 200 字不阻断，需 confirm
    if (input.transcript.length < 200 && !input.confirm) {
      return {
        warn: 'transcript_short',
        charCount: input.transcript.length,
        message: `面试记录较短（${input.transcript.length}字），可能影响终判质量。是否确认提交？`,
        needConfirm: true,
      };
    }

    const now = new Date();
    // 草稿转正：transcript 锁定，transcriptDraft 清空
    const judgment =
      existing ?? this.judgmentRepo.create({ assessmentId });
    judgment.level = input.level;
    judgment.track = input.track;
    judgment.reason = input.reason;
    judgment.transcript = input.transcript;
    judgment.transcriptDraft = null;
    judgment.submittedAt = now;
    await this.judgmentRepo.save(judgment);

    // 状态机推进：PENDING_INTERVIEW → FINAL_EVALUATING
    if (!canTransition(a.status as AssessmentStatus, AssessmentStatus.FINAL_EVALUATING)) {
      // 不应到达——上面已校验 status===PENDING_INTERVIEW
      throw new AppError('INTERNAL_ERROR', {
        from: a.status,
        to: AssessmentStatus.FINAL_EVALUATING,
      });
    }
    a.status = AssessmentStatus.FINAL_EVALUATING;
    await this.assessmentRepo.save(a);

    // 异步触发终判 C（fire-and-forget，进程内）
    // 成功 → COMPLETED + consistency；失败 → EVAL_FAILED（locked 仍 true）
    // 前端通过 GET /:id/status 轮询，locked 变 false 时停止
    this.finalEval.triggerAsync(a.id);

    return {
      status: a.status as AssessmentStatus,
      submittedAt: now,
      message: '已提交。正在生成终判结论，约需30秒。',
    };
  }

  // POST /assessments/:id/reevaluate
  // 同步重试终判 C（用于 EVAL_FAILED → 重新评估）
  async reevaluate(id: string, interviewerId: string): Promise<{
    status: AssessmentStatus;
    levelC: string | null;
    message: string;
  }> {
    const a = await this.getByIdForInterviewer(id, interviewerId);
    if (a.status !== AssessmentStatus.EVAL_FAILED) {
      throw new AppError('SKIP_NOT_ALLOWED', {
        status: a.status,
        reason: 'reevaluate only allowed from EVAL_FAILED',
      });
    }
    // 回到 FINAL_EVALUATING 再跑终判
    if (!canTransition(AssessmentStatus.EVAL_FAILED, AssessmentStatus.FINAL_EVALUATING)) {
      throw new AppError('INTERNAL_ERROR', { from: a.status });
    }
    a.status = AssessmentStatus.FINAL_EVALUATING;
    await this.assessmentRepo.save(a);
    const r = await this.finalEval.runFinalEvaluation(a.id);
    return {
      status: r.status,
      levelC: r.levelC,
      message:
        r.status === AssessmentStatus.COMPLETED
          ? '终判完成。'
          : '终判失败，请重试。',
    };
  }

  // GET /assessments/:id/status（轮询）
  async getStatus(id: string, interviewerId: string) {
    const a = await this.getByIdForInterviewer(id, interviewerId);
    const status = a.status as AssessmentStatus;
    const isLocked =
      status === AssessmentStatus.PENDING_INTERVIEW ||
      status === AssessmentStatus.FINAL_EVALUATING;
    return {
      status,
      statusLabel: statusLabel(status),
      locked: isLocked,
      updatedAt: a.submittedAt ?? a.createdAt,
    };
  }

  // PUT /assessments/:id/transcript（草稿保存）
  async saveTranscriptDraft(
    id: string,
    interviewerId: string,
    transcriptDraft: string,
  ): Promise<{ savedAt: Date }> {
    const a = await this.getByIdForInterviewer(id, interviewerId);
    if (a.status !== AssessmentStatus.PENDING_INTERVIEW) {
      throw new AppError('JUDGMENT_SUBMITTED', { status: a.status });
    }
    if (transcriptDraft.length > 100000) {
      throw new AppError('PARAM_INVALID', 'transcriptDraft too long');
    }
    const existing = await this.judgmentRepo.findOne({
      where: { assessmentId: id },
    });
    const judgment =
      existing ?? this.judgmentRepo.create({ assessmentId: id });
    judgment.transcriptDraft = transcriptDraft;
    await this.judgmentRepo.save(judgment);
    return { savedAt: new Date() };
  }

  async getQuestionnaire(assessmentId: string): Promise<QuestionnaireResultEntity | null> {
    return this.questionnaireRepo.findOne({ where: { assessmentId } });
  }

  async requireAssessment(assessmentId: string): Promise<AssessmentEntity> {
    const a = await this.assessmentRepo.findOne({ where: { id: assessmentId } });
    if (!a) throw new AppError('NOT_FOUND', { id: assessmentId });
    return a;
  }

  // POST /assessments/:id/abandon（api-spec 4.11）
  // 只允许 NOT_STARTED / IN_PROGRESS → ABANDONED；
  // COMPLETED / PENDING_INTERVIEW / FINAL_EVALUATING / EVAL_FAILED 等终态不可放弃
  async abandon(
    assessmentId: string,
    interviewerId: string,
    reason: string,
  ): Promise<{ status: AssessmentStatus }> {
    const a = await this.getByIdForInterviewer(assessmentId, interviewerId);
    const from = a.status as AssessmentStatus;
    if (!canTransition(from, AssessmentStatus.ABANDONED)) {
      throw new AppError('ABANDON_NOT_ALLOWED', { id: assessmentId, status: from });
    }
    a.status = AssessmentStatus.ABANDONED;
    await this.assessmentRepo.save(a);
    // reason 暂不落库（PoC 简化，entity 无对应字段）；记日志便于事后追溯
    // eslint-disable-next-line no-console
    console.log(
      `[AssessmentService] abandon id=${assessmentId} by=${interviewerId} reason=${reason}`,
    );
    return { status: AssessmentStatus.ABANDONED };
  }
}

// 状态标签镜像 report.filter.ts 的 STATUS_LABELS
// 此处独立实现，避免 assessment.service 直接依赖 report.filter
function statusLabel(status: AssessmentStatus): string {
  const map: Record<AssessmentStatus, string> = {
    [AssessmentStatus.NOT_STARTED]: '未开始',
    [AssessmentStatus.IN_PROGRESS]: '进行中',
    [AssessmentStatus.EVALUATING]: '评估中',
    [AssessmentStatus.COMPLETED]: '已完成',
    [AssessmentStatus.PENDING_INTERVIEW]: '待现场验证',
    [AssessmentStatus.FINAL_EVALUATING]: '终判中',
    [AssessmentStatus.ABANDONED]: '已放弃',
    [AssessmentStatus.EVAL_FAILED]: '评估失败',
  };
  return map[status] ?? status;
}
