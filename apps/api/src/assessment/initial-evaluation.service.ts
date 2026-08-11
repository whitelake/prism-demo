import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { LlmClient } from '@/llm/llm.client';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate } from '@/llm/interpolator';
import { EvaluationResponseSchema, type EvaluationResponse } from '@/llm/schemas/evaluation.schema';
import { renderLevelDefinitions } from './levels.config';
import { computeConsistency, type ConsistencyInput } from './consistency';
import {
  AssessmentStatus,
  canTransition,
  shouldTriggerInterview,
} from './assessment.state';
import { InputTooLongError } from '@/llm/input-too-long.error';
import {
  truncateFullLog,
  type FullLog,
  type FullLogDialogueTurn,
  type FullLogToolTurn,
  type FullLogToolTask,
} from './full-log-truncator';
import { OutlineService } from './outline.service';

// A 评估 Service（架构 4.3 / PRD 4.5）
//
// 输入：full_log（questionnaire + examiner_dialogue + tool_tasks，interview_transcript=null）
// 输出：evaluation(type='A')，可能为 L3_pending / L4_pending
//
// 状态机推进：
//   EVALUATING → PENDING_INTERVIEW（shouldTriggerInterview=true）
//   EVALUATING → COMPLETED（shouldTriggerInterview=false）
//   EVALUATING → EVAL_FAILED（A 失败）
//
// 与 outline 并行触发（PoC 简化：fire-and-forget 同进程）
//
// 不变量 2：A 锁定——pending_interview 期间不返回 A 字段（由 ReportFilter 保证）
// 不变量 4：LLM 统一出口
// 不变量 5：状态机推进由 shouldTriggerInterview 决策

@Injectable()
export class InitialEvaluationService {
  private readonly logger = new Logger(InitialEvaluationService.name);

  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @InjectRepository(EvaluationEntity)
    private readonly evaluationRepo: Repository<EvaluationEntity>,
    @InjectRepository(ConsistencyEntity)
    private readonly consistencyRepo: Repository<ConsistencyEntity>,
    private readonly llmClient: LlmClient,
    private readonly outlineService: OutlineService,
  ) {}

  // fire-and-forget：调用方不 await
  // 同时触发 outline（与 A 评估并行，互不依赖）
  triggerAsync(assessmentId: string): void {
    // outline 与 A 评估并行触发（PoC 简化：进程内并发）
    this.outlineService.triggerAsync(assessmentId);
    void this.runInitialEvaluation(assessmentId).catch((e: unknown) => {
      this.logger.error(
        `[initial-eval] unexpected error for ${assessmentId}: ${
          e instanceof Error ? e.stack : String(e)
        }`,
      );
    });
  }

  async runInitialEvaluation(assessmentId: string): Promise<{ status: AssessmentStatus; levelA: string | null }> {
    const assessment = await this.assessmentRepo.findOne({ where: { id: assessmentId } });
    if (!assessment) {
      throw new Error(`assessment not found: ${assessmentId}`);
    }
    if (assessment.status !== AssessmentStatus.EVALUATING) {
      throw new Error(
        `[initial-eval] assessment not in EVALUATING (current: ${assessment.status})`,
      );
    }

    let fullLog = await this.buildFullLog(assessment);

    let evalResponse: EvaluationResponse;
    try {
      const systemPrompt = interpolate(loadPrompt('evaluation'), {
        level_definitions: renderLevelDefinitions(),
        full_log: fullLog,
      });
      const result = await this.llmClient.call({
        assessmentId,
        purpose: 'eval',
        systemPrompt,
        userMessages: [{ role: 'user', content: '请基于上述日志输出评估结果。' }],
        schema: EvaluationResponseSchema,
      });
      evalResponse = result.parsed as EvaluationResponse;
    } catch (e) {
      // R3：输入超长 → 截断重试一次
      if (e instanceof InputTooLongError) {
        const truncated = truncateFullLog(fullLog);
        if (truncated !== fullLog) {
          this.logger.warn(
            `[initial-eval] input too long (${e.estimatedTokens} > ${e.maxInputTokens}), applying R3 truncation and retrying for ${assessmentId}`,
          );
          fullLog = truncated;
          try {
            const systemPrompt = interpolate(loadPrompt('evaluation'), {
              level_definitions: renderLevelDefinitions(),
              full_log: fullLog,
            });
            const result = await this.llmClient.call({
              assessmentId,
              purpose: 'eval',
              systemPrompt,
              userMessages: [{ role: 'user', content: '请基于上述日志输出评估结果。' }],
              schema: EvaluationResponseSchema,
            });
            evalResponse = result.parsed as EvaluationResponse;
            return await this.finalizeSuccess(assessment, evalResponse);
          } catch (e2) {
            this.logger.warn(
              `[initial-eval] A failed after truncation for ${assessmentId}: ${
                e2 instanceof Error ? e2.message : String(e2)
              }`,
            );
            assessment.status = AssessmentStatus.EVAL_FAILED;
            await this.assessmentRepo.save(assessment);
            return { status: AssessmentStatus.EVAL_FAILED, levelA: null };
          }
        }
      }
      // 失败：状态回退至 EVAL_FAILED，A 仍锁定
      this.logger.warn(
        `[initial-eval] A failed for ${assessmentId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      assessment.status = AssessmentStatus.EVAL_FAILED;
      await this.assessmentRepo.save(assessment);
      return { status: AssessmentStatus.EVAL_FAILED, levelA: null };
    }

    return await this.finalizeSuccess(assessment, evalResponse);
  }

  private async finalizeSuccess(
    assessment: AssessmentEntity,
    evalResponse: EvaluationResponse,
  ): Promise<{ status: AssessmentStatus; levelA: string | null }> {
    const levelA = evalResponse.overall.level;
    await this.persistEvaluationA(assessment.id, evalResponse);
    await this.recomputeConsistency(assessment.id, levelA);

    // shouldTriggerInterview 决策：触发 → PENDING_INTERVIEW，否则 → COMPLETED
    const trigger = shouldTriggerInterview({
      level: levelA,
      track: evalResponse.overall.track,
      confidence: evalResponse.overall.confidence,
      claimRealityGapLevel: (evalResponse.claim_reality_gap.level as '重大' | '一般' | '无') === '重大'
        ? '重大'
        : null,
      redLinesCount: evalResponse.red_lines.length,
    });

    const nextStatus = trigger ? AssessmentStatus.PENDING_INTERVIEW : AssessmentStatus.COMPLETED;
    if (!canTransition(AssessmentStatus.EVALUATING, nextStatus)) {
      throw new Error(`invalid transition EVALUATING → ${nextStatus}`);
    }
    assessment.status = nextStatus;
    await this.assessmentRepo.save(assessment);
    return { status: nextStatus, levelA };
  }

  private async buildFullLog(assessment: AssessmentEntity): Promise<FullLog> {
    const [questionnaire, dialogues] = await Promise.all([
      this.questionnaireRepo.findOne({ where: { assessmentId: assessment.id } }),
      this.dialogueRepo.find({
        where: { assessmentId: assessment.id },
        order: { ts: 'ASC' },
      }),
    ]);

    const examinerDialogue: FullLogDialogueTurn[] = dialogues
      .filter((d) => d.mode === 'examiner')
      .map((d) => ({
        stage: d.stageOrTask,
        turn: d.turnIndex,
        role: d.role === 'ai' ? 'examiner' : 'candidate',
        content: d.content,
        ts: d.ts.toISOString(),
        ...(d.responseIntervalSec != null
          ? { response_interval_sec: d.responseIntervalSec }
          : {}),
      }));

    const stageReached = Array.from(new Set(examinerDialogue.map((d) => d.stage)));

    const toolTasks: FullLogToolTask[] = [];
    // 排除 system_card 行（role=system_card 是前端展示卡，不进模型上下文）
    const toolRows = dialogues.filter(
      (d) => d.mode === 'tool' && d.role !== 'system_card',
    );
    const byTask = new Map<string, DialogueLogEntity[]>();
    for (const d of toolRows) {
      const arr = byTask.get(d.stageOrTask) ?? [];
      arr.push(d);
      byTask.set(d.stageOrTask, arr);
    }
    for (const [taskId, rows] of byTask.entries()) {
      const turns: FullLogToolTurn[] = rows.map((d, idx) => ({
        turn: idx + 1,
        role: d.role === 'ai' ? 'assistant' : 'candidate',
        content: d.content,
        ts: d.ts.toISOString(),
        ...(d.responseIntervalSec != null
          ? { response_interval_sec: d.responseIntervalSec }
          : {}),
      }));
      toolTasks.push({
        task_id: taskId,
        turns,
        total_turns: turns.length,
        duration_sec: null,
        ended_by: null,
      });
    }

    return {
      candidate: {
        name: assessment.candidateName,
        position: assessment.position,
      },
      questionnaire: questionnaire
        ? {
            Q1: questionnaire.q1,
            Q2: questionnaire.q2 as string[] | null,
            Q3: questionnaire.q3,
            Q4: questionnaire.q4,
            Q5: questionnaire.q5,
          }
        : {},
      examiner_dialogue: examinerDialogue,
      stage_reached: stageReached,
      tool_tasks: toolTasks,
      // A 评估时无 interview_transcript
      interview_transcript: null,
    };
  }

  private async persistEvaluationA(
    assessmentId: string,
    response: EvaluationResponse,
  ): Promise<EvaluationEntity> {
    // 删除旧 A（重试时可能有遗留）
    await this.evaluationRepo.delete({ assessmentId, type: 'A' });
    const row = this.evaluationRepo.create({
      id: crypto.randomUUID(),
      assessmentId,
      type: 'A',
      resultJson: response as unknown as Record<string, unknown>,
      level: response.overall.level,
      track: response.overall.track,
      confidence: response.overall.confidence,
      recommendHumanReview: response.overall.recommend_human_review,
    });
    return this.evaluationRepo.save(row);
  }

  async recomputeConsistency(
    assessmentId: string,
    levelA: string,
  ): Promise<ConsistencyEntity> {
    // A 评估时 B/C 均未产出 → 仅落 levelA，其他字段 null
    // FinalEvaluationService 在 C 产出时会重算并覆盖
    const input: ConsistencyInput = {
      levelA,
      levelB: null,
      levelC: null,
    };
    const result = computeConsistency(input);

    await this.consistencyRepo.delete({ assessmentId });
    const row = this.consistencyRepo.create({
      assessmentId,
      levelA: result.levelA,
      levelB: null,
      levelC: null,
      aEqB: null,
      bEqC: null,
      aEqC: null,
      maxLevelGap: null,
      computedAt: new Date(),
    });
    return this.consistencyRepo.save(row);
  }
}
