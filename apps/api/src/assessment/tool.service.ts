import { Injectable, Logger, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type OpenAI from 'openai';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { LlmClient } from '@/llm/llm.client';
import { ContextBuilder, type ChatMessage } from './context.builder';
import { getTask } from './tasks.config';
import { getCard } from './cards.config';
import {
  AssessmentStatus,
  canTransition,
} from './assessment.state';
import { AppError } from '@/common/app-error';
import { InitialEvaluationService } from './initial-evaluation.service';

// 工具模式 Service（架构 4.1 / PRD 4.3）
//
// 职责：
//   - handleCandidateMessage：候选人输入 → 落库 → 调 LlmClient（静态 system prompt，无 schema）→ 落 ai
//   - completeTask：候选人主动结束当前任务 → 校验 min_turns → T1→T2 / T2→提交
//
// 不变量：
//   - 1 上下文隔离：buildToolContext 三重过滤（assessmentId + mode=tool + taskId）
//      tool system prompt 静态（assertNoVariables 在 ContextBuilder 启动时验证）
//   - 3 signals 不下发：tool 模式不生成 signals（role=ai 行 signals=null）
//   - 4 LLM 统一出口
//   - 5 后端控制：任务切换由 completeTask 主导，模型不参与决策

export interface ToolMessage {
  id?: number;
  type: 'ai' | 'candidate' | 'system_card';
  mode: 'examiner' | 'tool' | null;
  content?: string;
  card?: { variant: string; title: string; body: string };
  stageOrTask: string;
  turnIndex: number;
  ts: string;
}

interface TimerInfo {
  examinerTotalRemainingSec: number | null;
  taskRemainingSec: number | null;
  idleWarningAtSec: number;
  idleSkipAtSec: number;
  lastActivityTs: string;
}

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

const IDLE_WARN_SEC = 450;
const IDLE_SKIP_SEC = 600;

export interface CompleteTaskResult {
  step: 'tool' | 'finished';
  currentStage: null;
  currentTask: 'T1' | 'T2' | null;
  turnIndex: number;
  newMessages: ToolMessage[];
  timer?: TimerInfo;
  status?: AssessmentStatus;
  submittedAt?: Date;
  finishMessage?: string;
  inputEnabled?: boolean;
}

// SSE 事件结构（api-spec 3.6）
//   accepted：candidate 已落库，aiMessageId 在 done 事件给出（PoC 简化）
//   delta：文本增量
//   done：流式完毕，ai 已落库
//   error：调用方捕获异常后转 error 事件
//   重试幂等性（api-spec 3.6）暂不实现，PoC 标注 TODO
export type SseEvent =
  | { event: 'accepted'; data: { candidateMessageId: string } }
  | { event: 'delta'; data: { text: string } }
  | {
      event: 'done';
      data: {
        aiMessageId: string;
        turnIndex: number;
        taskRemainingSec: number;
        finishReason: 'stop' | 'length';
      };
    }
  | { event: 'error'; data: { code: string; message: string } };

@Injectable()
export class ToolService {
  private readonly logger = new Logger(ToolService.name);

  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    private readonly contextBuilder: ContextBuilder,
    private readonly llmClient: LlmClient,
    @Inject(forwardRef(() => InitialEvaluationService))
    private readonly initialEval: InitialEvaluationService,
  ) {}

  // 候选人输入 → 落库 → 静态 tool prompt + 本任务历史 → LlmClient → 落 ai（signals=null）
  async handleCandidateMessage(
    assessmentId: string,
    content: string,
  ): Promise<{
    step: 'tool';
    currentStage: null;
    currentTask: 'T1' | 'T2';
    turnIndex: number;
    newMessages: ToolMessage[];
    timer: TimerInfo;
    inputEnabled: true;
  }> {
    const assessment = await this.requireAssessment(assessmentId);
    const progress = (assessment.progress as ProgressShape | null);
    if (!progress || progress.mode !== 'tool' || !progress.currentTask) {
      throw new Error(
        `[tool] handleCandidateMessage requires active tool task (assessment: ${assessmentId})`,
      );
    }
    const taskId = progress.currentTask as 'T1' | 'T2';
    const currentTurn = progress.turnIndex ?? 0;
    const lastActivityTs = progress.lastActivityTs ?? Date.now();
    const now = Date.now();

    // 1. 落 candidate 消息
    const candidateTs = new Date(now);
    const candidateTurnIndex = currentTurn + 1;
    await this.dialogueRepo.save({
      assessmentId,
      mode: 'tool',
      stageOrTask: taskId,
      turnIndex: candidateTurnIndex,
      role: 'candidate',
      content,
      signals: null,
      responseIntervalSec: Math.max(0, Math.floor((now - lastActivityTs) / 1000)),
      ts: candidateTs,
    });

    // 2. buildToolContext（已就绪）+ LlmClient（无 schema，静态 prompt）
    const messages = await this.contextBuilder.buildToolContext(assessmentId, taskId);
    const [systemMessage, ...rest] = messages;
    if (!systemMessage || systemMessage.role !== 'system') {
      throw new Error('[tool] buildToolContext must return system message first');
    }
    const result = await this.llmClient.call({
      assessmentId,
      purpose: 'tool',
      systemPrompt: systemMessage.content,
      userMessages: rest as OpenAI.ChatCompletionMessageParam[],
      // 不变量 1：tool prompt 静态；不传 schema —— tool 模式不要求结构化输出
    });
    const aiContent = result.raw;

    // 3. 落 ai 消息（signals=null）
    const aiTs = new Date();
    await this.dialogueRepo.save({
      assessmentId,
      mode: 'tool',
      stageOrTask: taskId,
      turnIndex: candidateTurnIndex,
      role: 'ai',
      content: aiContent,
      signals: null,
      responseIntervalSec: null,
      ts: aiTs,
    });

    // 4. 更新 progress
    await this.updateProgress(assessment, {
      ...progress,
      turnIndex: candidateTurnIndex,
      lastActivityTs: aiTs.getTime(),
    });

    return {
      step: 'tool',
      currentStage: null,
      currentTask: taskId,
      turnIndex: candidateTurnIndex,
      newMessages: [
        {
          type: 'candidate',
          mode: 'tool',
          content,
          stageOrTask: taskId,
          turnIndex: candidateTurnIndex,
          ts: candidateTs.toISOString(),
        },
        {
          type: 'ai',
          mode: 'tool',
          content: aiContent,
          stageOrTask: taskId,
          turnIndex: candidateTurnIndex,
          ts: aiTs.toISOString(),
        },
      ],
      timer: this.buildToolTimer(taskId, aiTs.getTime()),
      inputEnabled: true,
    };
  }

  // SSE 流式版本（api-spec 3.6）：落 candidate → yield accepted →
  // callStream → 每个 delta yield → 落 ai → yield done
  // 不变量 1：buildToolContext 三重过滤；不变量 3：tool 模式无 signals；
  // 不变量 4：callStream 走 LlmClient 唯一出口 + 全量落库
  async *handleCandidateMessageStream(
    assessmentId: string,
    content: string,
  ): AsyncGenerator<SseEvent> {
    const assessment = await this.requireAssessment(assessmentId);
    const progress = assessment.progress as ProgressShape | null;
    if (!progress || progress.mode !== 'tool' || !progress.currentTask) {
      yield {
        event: 'error',
        data: { code: 'PARAM_INVALID', message: 'not in tool mode' },
      };
      return;
    }
    const taskId = progress.currentTask as 'T1' | 'T2';
    const currentTurn = progress.turnIndex ?? 0;
    const lastActivityTs = progress.lastActivityTs ?? Date.now();
    const now = Date.now();

    // 1. 落 candidate 消息
    const candidateRow = await this.dialogueRepo.save({
      assessmentId,
      mode: 'tool',
      stageOrTask: taskId,
      turnIndex: currentTurn + 1,
      role: 'candidate',
      content,
      signals: null,
      responseIntervalSec: Math.max(0, Math.floor((now - lastActivityTs) / 1000)),
      ts: new Date(now),
    });

    yield { event: 'accepted', data: { candidateMessageId: candidateRow.id } };

    // 2. buildToolContext + callStream
    const messages = await this.contextBuilder.buildToolContext(assessmentId, taskId);
    const [systemMessage, ...rest] = messages;
    if (!systemMessage || systemMessage.role !== 'system') {
      yield {
        event: 'error',
        data: { code: 'INTERNAL_ERROR', message: 'tool context missing system message' },
      };
      return;
    }

    let fullText = '';
    let latencyMs = 0;
    try {
      for await (const chunk of this.llmClient.callStream({
        assessmentId,
        purpose: 'tool',
        systemPrompt: systemMessage.content,
        userMessages: rest as OpenAI.ChatCompletionMessageParam[],
      })) {
        if (chunk.type === 'delta') {
          fullText += chunk.text;
          yield { event: 'delta', data: { text: chunk.text } };
        } else if (chunk.type === 'done') {
          fullText = chunk.fullText;
          latencyMs = chunk.latencyMs;
        }
      }
    } catch (e) {
      yield {
        event: 'error',
        data: {
          code: 'LLM_FAILED',
          message: e instanceof Error ? e.message : String(e),
        },
      };
      return;
    }

    // 3. 落 ai 消息（signals=null）
    const aiTs = new Date();
    const aiRow = await this.dialogueRepo.save({
      assessmentId,
      mode: 'tool',
      stageOrTask: taskId,
      turnIndex: candidateRow.turnIndex,
      role: 'ai',
      content: fullText,
      signals: null,
      responseIntervalSec: null,
      ts: aiTs,
    });

    // 4. 更新 progress
    await this.updateProgress(assessment, {
      ...progress,
      turnIndex: candidateRow.turnIndex,
      lastActivityTs: aiTs.getTime(),
    });

    const task = getTask(taskId);
    yield {
      event: 'done',
      data: {
        aiMessageId: aiRow.id,
        turnIndex: candidateRow.turnIndex,
        taskRemainingSec: task.duration_minutes * 60,
        finishReason: 'stop',
      },
    };
    // latencyMs 用于调试，不进 SSE 事件（api-spec 3.6 done 不含此字段）
    void latencyMs;
  }

  // 候选人主动结束当前任务
  // PRD 4.3 / api-spec 3.7：T1→T2 切换；T2 完成进入 EVALUATING + 异步触发 A 评估
  async completeTask(assessmentId: string): Promise<CompleteTaskResult> {
    return this.completeTaskInternal(assessmentId, false);
  }

  // 强制完成当前任务（skip / idle_timeout 调用，跳过 min_turns 校验）
  async forceComplete(assessmentId: string): Promise<CompleteTaskResult> {
    return this.completeTaskInternal(assessmentId, true);
  }

  private async completeTaskInternal(assessmentId: string, force: boolean): Promise<CompleteTaskResult> {
    const assessment = await this.requireAssessment(assessmentId);
    const progress = (assessment.progress as ProgressShape | null);
    if (!progress || progress.mode !== 'tool' || !progress.currentTask) {
      throw new AppError('SKIP_NOT_ALLOWED', { reason: 'not in tool mode' });
    }
    const taskId = progress.currentTask as 'T1' | 'T2';
    const task = getTask(taskId);

    // 校验 min_turns（PRD 4.3 / api-spec 3.7 NO_INTERACTION）
    // force=true 时跳过校验（idle_timeout 强制推进）
    if (!force) {
      const candidateCount = await this.dialogueRepo.count({
        where: { assessmentId, mode: 'tool', stageOrTask: taskId, role: 'candidate' },
      });
      if (candidateCount < task.require_min_turns) {
        throw new AppError('SKIP_NOT_ALLOWED', {
          reason: 'min_turns not reached',
          candidateCount,
          requireMinTurns: task.require_min_turns,
        });
      }
    }

    if (taskId === 'T1') {
      // T1 → T2：写 task_done 卡 + T2 task_brief 卡
      const now = Date.now();
      const taskDoneCard = getCard('task_done');
      const t2 = getTask('T2', assessmentId);
      const ts = new Date(now);
      // 持久化 system_card 到 dialogue_log，否则 GET /state 重建时丢失卡片
      const taskDoneRow = await this.dialogueRepo.save({
        assessmentId,
        mode: 'tool',
        stageOrTask: 'T2',
        turnIndex: 0,
        role: 'system_card',
        content: JSON.stringify({ variant: 'task_done', title: taskDoneCard.title, body: '' }),
        signals: null,
        responseIntervalSec: null,
        ts,
      });
      const taskBriefRow = await this.dialogueRepo.save({
        assessmentId,
        mode: 'tool',
        stageOrTask: 'T2',
        turnIndex: 0,
        role: 'system_card',
        content: JSON.stringify({ variant: 'task_brief', title: t2.title, body: t2.description }),
        signals: null,
        responseIntervalSec: null,
        ts,
      });
      await this.updateProgress(assessment, {
        ...progress,
        currentTask: 'T2',
        turnIndex: 0,
        stageStartTs: now,
        lastActivityTs: now,
      });
      return {
        step: 'tool',
        currentStage: null,
        currentTask: 'T2',
        turnIndex: 0,
        newMessages: [
          {
            type: 'system_card',
            mode: null,
            id: Number(taskDoneRow.id),
            card: { variant: 'task_done', title: taskDoneCard.title, body: '' },
            stageOrTask: 'T2',
            turnIndex: 0,
            ts: ts.toISOString(),
          },
          {
            type: 'system_card',
            mode: null,
            id: Number(taskBriefRow.id),
            card: { variant: 'task_brief', title: t2.title, body: t2.description },
            stageOrTask: 'T2',
            turnIndex: 0,
            ts: ts.toISOString(),
          },
        ],
        timer: this.buildToolTimer('T2', now),
        inputEnabled: true,
      };
    }

    // T2 完成 → 提交测评
    if (!canTransition(AssessmentStatus.IN_PROGRESS, AssessmentStatus.EVALUATING)) {
      throw new AppError('INTERNAL_ERROR', {
        from: assessment.status,
        to: AssessmentStatus.EVALUATING,
      });
    }
    const now = new Date();
    assessment.status = AssessmentStatus.EVALUATING;
    assessment.submittedAt = now;
    await this.assessmentRepo.save(assessment);

    // 异步触发 A 评估（不变量 5：状态机推进由后端；A/B/C 隔离由 ReportFilter 保证）
    this.initialEval.triggerAsync(assessmentId);

    return {
      step: 'finished',
      currentStage: null,
      currentTask: null,
      turnIndex: 0,
      newMessages: [],
      status: AssessmentStatus.EVALUATING,
      submittedAt: now,
      finishMessage: '测评已提交，感谢你的参与。\n结果会由面试官统一查看，无需你做其他操作。',
      inputEnabled: false,
    };
  }

  private buildToolTimer(taskId: 'T1' | 'T2', now: number): TimerInfo {
    const task = getTask(taskId);
    return {
      examinerTotalRemainingSec: null,
      taskRemainingSec: task.duration_minutes * 60,
      idleWarningAtSec: IDLE_WARN_SEC,
      idleSkipAtSec: IDLE_SKIP_SEC,
      lastActivityTs: new Date(now).toISOString(),
    };
  }

  private async updateProgress(
    assessment: AssessmentEntity,
    next: ProgressShape,
  ): Promise<void> {
    assessment.progress = next as unknown as Record<string, unknown>;
    await this.assessmentRepo.save(assessment);
  }

  private async requireAssessment(assessmentId: string): Promise<AssessmentEntity> {
    const a = await this.assessmentRepo.findOne({ where: { id: assessmentId } });
    if (!a) throw new Error(`assessment not found: ${assessmentId}`);
    return a;
  }
}

export type { ChatMessage };
