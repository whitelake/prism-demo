import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { LlmClient } from '@/llm/llm.client';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate } from '@/llm/interpolator';
import { EvaluationResponseSchema, type EvaluationResponse } from '@/llm/schemas/evaluation.schema';
import { renderLevelDefinitions } from './levels.config';
import { renderDimensionDefinitions } from './dimensions.config';
import { computeConsistency, type ConsistencyInput } from './consistency';
import {
  AssessmentStatus,
  canTransition,
} from './assessment.state';
import { InputTooLongError } from '@/llm/input-too-long.error';
import { truncateFullLog, type FullLog, type FullLogDialogueTurn, type FullLogToolTurn, type FullLogToolTask } from './full-log-truncator';
import { assertEvaluationStageRules } from './evaluation-assertions';

// 终判C：提交B 后异步触发（架构 4.3 / PRD 4.5 / 988-1000）
//
// 输入：full_log + interview_transcript
//   - A：interview_transcript=null（pending 等级）
//   - C：interview_transcript=实际文本（确定等级 + judgment_change 对象）
//
// 状态机推进：
//   FINAL_EVALUATING → COMPLETED（C 成功，解锁）
//   FINAL_EVALUATING → EVAL_FAILED（C 失败，locked 仍 true）
//
// PoC 不引入 MQ：用进程内异步（fire-and-forget）。
// 失败时状态回退至 EVAL_FAILED，由 reevaluate 接口同步重试。
// FullLog / truncateFullLog 类型与截断实现见 ./full-log-truncator

@Injectable()
export class FinalEvaluationService {
  private readonly logger = new Logger(FinalEvaluationService.name);

  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @InjectRepository(EvaluationEntity)
    private readonly evaluationRepo: Repository<EvaluationEntity>,
    @InjectRepository(InterviewerJudgmentEntity)
    private readonly judgmentRepo: Repository<InterviewerJudgmentEntity>,
    @InjectRepository(ConsistencyEntity)
    private readonly consistencyRepo: Repository<ConsistencyEntity>,
    private readonly llmClient: LlmClient,
  ) {}

  // 异步触发：不抛错（异常内部记录，状态由 runFinalEvaluation 自己回退）
  // fire-and-forget：调用方不 await
  triggerAsync(assessmentId: string): void {
    void this.runFinalEvaluation(assessmentId).catch((e: unknown) => {
      this.logger.error(
        `[final-eval] unexpected error for ${assessmentId}: ${
          e instanceof Error ? e.stack : String(e)
        }`,
      );
    });
  }

  // 同步执行：用于 POST /:id/reevaluate 重试入口
  async runFinalEvaluation(assessmentId: string): Promise<{ status: AssessmentStatus; levelC: string | null }> {
    const assessment = await this.assessmentRepo.findOne({ where: { id: assessmentId } });
    if (!assessment) {
      throw new Error(`assessment not found: ${assessmentId}`);
    }
    if (assessment.status !== AssessmentStatus.FINAL_EVALUATING) {
      throw new Error(
        `assessment not in FINAL_EVALUATING (current: ${assessment.status})`,
      );
    }

    let fullLog = await this.buildFullLog(assessment);

    let evalResponse: EvaluationResponse;
    try {
      const systemPrompt = interpolate(loadPrompt('evaluation'), {
        level_definitions: renderLevelDefinitions(),
        dimension_definitions: renderDimensionDefinitions(),
        full_log: fullLog,
      });

      const result = await this.llmClient.call({
        assessmentId,
        purpose: 'eval',
        systemPrompt,
        userMessages: [
          { role: 'user', content: '请基于上述日志输出评估结果。' },
        ],
        schema: EvaluationResponseSchema,
      });
      evalResponse = result.parsed as EvaluationResponse;
      // R3 三条禁止：阶段 C 禁止输出 L4_pending；仅 L4_pending 合法
      assertEvaluationStageRules(evalResponse);
    } catch (e) {
      // R3：输入超长时按优先级截断后重试一次
      if (e instanceof InputTooLongError) {
        const truncated = truncateFullLog(fullLog);
        if (truncated !== fullLog) {
          this.logger.warn(
            `[final-eval] input too long (${e.estimatedTokens} > ${e.maxInputTokens}), applying R3 truncation and retrying for ${assessmentId}`,
          );
          fullLog = truncated;
          try {
            const systemPrompt = interpolate(loadPrompt('evaluation'), {
              level_definitions: renderLevelDefinitions(),
              dimension_definitions: renderDimensionDefinitions(),
              full_log: fullLog,
            });
            const result = await this.llmClient.call({
              assessmentId,
              purpose: 'eval',
              systemPrompt,
              userMessages: [
                { role: 'user', content: '请基于上述日志输出评估结果。' },
              ],
              schema: EvaluationResponseSchema,
            });
            evalResponse = result.parsed as EvaluationResponse;
            assertEvaluationStageRules(evalResponse);
            return await this.finalizeSuccess(assessment, evalResponse);
          } catch (e2) {
            this.logger.warn(
              `[final-eval] C failed after truncation for ${assessmentId}: ${
                e2 instanceof Error ? e2.message : String(e2)
              }`,
            );
            assessment.status = AssessmentStatus.EVAL_FAILED;
            await this.assessmentRepo.save(assessment);
            return { status: AssessmentStatus.EVAL_FAILED, levelC: null };
          }
        }
      }
      // 失败：状态回退至 EVAL_FAILED，A 仍锁定
      this.logger.warn(
        `[final-eval] C failed for ${assessmentId}: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      assessment.status = AssessmentStatus.EVAL_FAILED;
      await this.assessmentRepo.save(assessment);
      return { status: AssessmentStatus.EVAL_FAILED, levelC: null };
    }

    return await this.finalizeSuccess(assessment, evalResponse);
  }

  private async finalizeSuccess(
    assessment: AssessmentEntity,
    evalResponse: EvaluationResponse,
  ): Promise<{ status: AssessmentStatus; levelC: string | null }> {
    // 成功：落 evaluation(type=C) + consistency + 推进 COMPLETED
    const levelC = evalResponse.overall.level;
    await this.persistEvaluationC(assessment.id, evalResponse);
    await this.recomputeConsistency(assessment.id, levelC);

    if (!canTransition(AssessmentStatus.FINAL_EVALUATING, AssessmentStatus.COMPLETED)) {
      throw new Error('invalid transition FINAL_EVALUATING → COMPLETED');
    }
    assessment.status = AssessmentStatus.COMPLETED;
    await this.assessmentRepo.save(assessment);
    return { status: AssessmentStatus.COMPLETED, levelC };
  }

  private async buildFullLog(assessment: AssessmentEntity): Promise<FullLog> {
    const [questionnaire, dialogues, judgment] = await Promise.all([
      this.questionnaireRepo.findOne({ where: { assessmentId: assessment.id } }),
      this.dialogueRepo.find({
        where: { assessmentId: assessment.id },
        order: { ts: 'ASC' },
      }),
      this.judgmentRepo.findOne({ where: { assessmentId: assessment.id } }),
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

    const stageReached = Array.from(
      new Set(examinerDialogue.map((d) => d.stage)),
    );

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
        duration_sec: null, // PoC 骨架：任务时长未在 dialogue_log 落库，由定时器侧推算
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
            Q2: questionnaire.q2,
            Q3: questionnaire.q3,
            Q4: questionnaire.q4,
            Q5: questionnaire.q5,
          }
        : {},
      examiner_dialogue: examinerDialogue,
      stage_reached: stageReached,
      tool_tasks: toolTasks,
      interview_transcript: judgment?.transcript ?? null,
    };
  }

  private async persistEvaluationC(
    assessmentId: string,
    response: EvaluationResponse,
  ): Promise<EvaluationEntity> {
    // 删除旧 C（重试时可能有遗留）
    await this.evaluationRepo.delete({ assessmentId, type: 'C' });
    const row = this.evaluationRepo.create({
      id: crypto.randomUUID(),
      assessmentId,
      type: 'C',
      // snake_case → camelCase 转换在 report.service.toEvaluationSummary 完成
      // 这里 resultJson 直接存原始 snake_case response，由 ReportService 透传
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
    levelC: string,
  ): Promise<ConsistencyEntity> {
    const [evalA, judgmentB] = await Promise.all([
      this.evaluationRepo.findOne({ where: { assessmentId, type: 'A' } }),
      this.judgmentRepo.findOne({ where: { assessmentId } }),
    ]);
    const input: ConsistencyInput = {
      levelA: evalA?.level ?? null,
      levelB: judgmentB?.level ?? null,
      levelC,
    };
    const result = computeConsistency(input);

    // upsert：先删后插
    await this.consistencyRepo.delete({ assessmentId });
    const row = this.consistencyRepo.create({
      assessmentId,
      levelA: result.levelA,
      levelB: result.levelB,
      levelC: result.levelC,
      aEqB: result.aEqB,
      bEqC: result.bEqC,
      aEqC: result.aEqC,
      maxLevelGap: result.maxLevelGap,
      computedAt: new Date(),
    });
    return this.consistencyRepo.save(row);
  }
}
