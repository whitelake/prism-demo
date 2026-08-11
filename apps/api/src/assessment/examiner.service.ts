import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type OpenAI from 'openai';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { LlmClient } from '@/llm/llm.client';
import { ContextBuilder, type ChatMessage } from './context.builder';
import { ExaminerResponseSchema, type ExaminerResponse } from '@/llm/schemas/examiner.schema';
import {
  shouldAdvanceStage,
  shouldRunS13,
  type ExaminerSignals,
  type ExaminerSignalRecord,
  type QuestionnaireAnswers,
} from './assessment.state';
import { getStageConfig } from './stages.config';
import { getTask } from './tasks.config';
import { getCard } from './cards.config';

// 考官模式 Service（架构 4.1 / PRD 4.2）
//
// 职责：
//   - generateFirstTurn：阶段切换后生成第 1 轮 AI 提问
//   - handleCandidateMessage：候选人回复 → 落库 → 生成下一轮 AI → 推进阶段/触发 S1.3/切工具
//
// 不变量：
//   - 1 上下文隔离：buildExaminerContext 已就绪
//   - 3 signals 不下发：返回体仅含 AI 文本，signals 仅落 dialogue_log
//   - 4 LLM 统一出口
//   - 5 后端控制：状态机推进由 shouldAdvanceStage/shouldRunS13 决策

export interface ExaminerMessage {
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

export interface FirstTurnResult {
  step: 'examiner';
  currentStage: 'S1.1' | 'S1.2' | 'S1.3';
  currentTask: null;
  turnIndex: number;
  messages: ExaminerMessage[];
  timer?: TimerInfo;
  inputEnabled: boolean;
}

export interface HandleCandidateMessageResult {
  step: 'examiner' | 'tool';
  currentStage: 'S1.1' | 'S1.2' | 'S1.3' | null;
  currentTask: 'T1' | 'T2' | null;
  turnIndex: number;
  newMessages: ExaminerMessage[];
  stageAdvanced: boolean;
  timer: TimerInfo;
  inputEnabled: true;
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

const EXAMINER_TOTAL_BUDGET_SEC = 900; // PRD 4.2 第1段总时长上限 15 分钟
const IDLE_WARN_SEC = 300; // PRD 4.7 单轮无响应 5 分钟提示
const IDLE_SKIP_SEC = 600; // PRD 4.7 单轮无响应 10 分钟自动结束

type StageCode = 'S1.1' | 'S1.2' | 'S1.3';

@Injectable()
export class ExaminerService {
  private readonly logger = new Logger(ExaminerService.name);

  constructor(
    @InjectRepository(AssessmentEntity)
    private readonly assessmentRepo: Repository<AssessmentEntity>,
    @InjectRepository(DialogueLogEntity)
    private readonly dialogueRepo: Repository<DialogueLogEntity>,
    @InjectRepository(QuestionnaireResultEntity)
    private readonly questionnaireRepo: Repository<QuestionnaireResultEntity>,
    private readonly contextBuilder: ContextBuilder,
    private readonly llmClient: LlmClient,
  ) {}

  // fire-and-forget：用于问卷提交后立即返回响应、首问异步生成的场景
  // 失败仅记日志（与 outline/initial-evaluation 一致）
  triggerAsync(assessmentId: string, stageCode: StageCode): void {
    void this.generateFirstTurn(assessmentId, stageCode).catch((e: unknown) => {
      this.logger.error(
        `[ExaminerService] triggerAsync failed id=${assessmentId} stage=${stageCode} err=${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  // 阶段切换后生成第 1 轮 AI 提问
  async generateFirstTurn(
    assessmentId: string,
    stageCode: StageCode,
  ): Promise<FirstTurnResult> {
    const assessment = await this.requireAssessment(assessmentId);

    const messages = await this.contextBuilder.buildExaminerContext(
      assessmentId,
      stageCode,
      1,
    );
    const parsed = await this.callExaminer(assessmentId, messages);
    const now = new Date();
    const savedAi = await this.dialogueRepo.save({
      assessmentId,
      mode: 'examiner',
      stageOrTask: stageCode,
      turnIndex: 1,
      role: 'ai',
      content: parsed.question,
      signals: parsed.signals,
      responseIntervalSec: null,
      ts: now,
    });

    await this.updateProgress(assessment, {
      mode: 'examiner',
      currentStage: stageCode,
      currentTask: null,
      turnIndex: 1,
      stageStartTs: (assessment.progress as ProgressShape | null)?.stageStartTs ?? now.getTime(),
      lastActivityTs: now.getTime(),
      s13Triggered: (assessment.progress as ProgressShape | null)?.s13Triggered ?? false,
      totalElapsedSec: (assessment.progress as ProgressShape | null)?.totalElapsedSec ?? 0,
    });

    return {
      step: 'examiner',
      currentStage: stageCode,
      currentTask: null,
      turnIndex: 1,
      messages: [
        {
          id: Number(savedAi.id),
          type: 'ai',
          mode: 'examiner',
          content: parsed.question,
          stageOrTask: stageCode,
          turnIndex: 1,
          ts: now.toISOString(),
        },
      ],
      timer: this.buildExaminerTimer(now.getTime(), 0),
      inputEnabled: true,
    };
  }

  // 候选人回复 → 落库 → 生成 AI → 阶段推进/S1.3 触发/切工具
  // PRD 4.2 / 架构 4.3：shouldAdvanceStage 决定阶段内推进；
  // S1.3 触发由 shouldRunS13（Q3/Q4 + 历史信号）决策
  async handleCandidateMessage(
    assessmentId: string,
    content: string,
  ): Promise<HandleCandidateMessageResult> {
    const assessment = await this.requireAssessment(assessmentId);
    const progress = (assessment.progress as ProgressShape | null);
    if (!progress || progress.mode !== 'examiner' || !progress.currentStage) {
      throw new Error(
        `[examiner] handleCandidateMessage requires active examiner stage (assessment: ${assessmentId})`,
      );
    }
    const stageCode = progress.currentStage as StageCode;
    const currentTurn = progress.turnIndex ?? 1;
    const lastActivityTs = progress.lastActivityTs ?? Date.now();
    const now = Date.now();

    // 1. 落 candidate 消息（responseIntervalSec = now - lastActivityTs）
    const candidateTs = new Date(now);
    const savedCandidate = await this.dialogueRepo.save({
      assessmentId,
      mode: 'examiner',
      stageOrTask: stageCode,
      turnIndex: currentTurn,
      role: 'candidate',
      content,
      signals: null,
      responseIntervalSec: Math.max(0, Math.floor((now - lastActivityTs) / 1000)),
      ts: candidateTs,
    });

    const newMessages: ExaminerMessage[] = [
      {
        id: Number(savedCandidate.id),
        type: 'candidate',
        mode: 'examiner',
        content,
        stageOrTask: stageCode,
        turnIndex: currentTurn,
        ts: candidateTs.toISOString(),
      },
    ];

    // 2. 更新 totalElapsedSec（PRD 4.2 第1段总时长）
    const stageStartTs = progress.stageStartTs ?? now;
    const totalElapsedSec = (progress.totalElapsedSec ?? 0) +
      Math.floor((now - lastActivityTs) / 1000);
    const totalRemaining = Math.max(0, EXAMINER_TOTAL_BUDGET_SEC - totalElapsedSec);

    // 3. 读全历史 signals 决策 S1.3 触发（仅 currentStage=S1.2 时检查触发）
    const [examinerSignals, questionnaire] = await Promise.all([
      this.loadExaminerSignalHistory(assessmentId),
      this.questionnaireRepo.findOne({ where: { assessmentId } }),
    ]);
    const s13ShouldTrigger =
      stageCode === 'S1.2' &&
      !progress.s13Triggered &&
      shouldRunS13({
        questionnaire: {
          q3: questionnaire?.q3 ?? null,
          q4: questionnaire?.q4 ?? null,
        },
        examinerSignals,
      });

    // 4. 生成 AI 提问（除非 total_timeout 直接切工具）
    // total_timeout：本轮候选人回答已完成，直接跳过剩余考官阶段
    const advanceDecision = shouldAdvanceStage(
      {
        stageCode,
        turnIndex: currentTurn,
        signals: examinerSignals[examinerSignals.length - 1]?.signals ?? {
          goal_coverage: 0,
          answer_vagueness: 0,
        },
        totalElapsedSec,
      },
      getStageConfig(stageCode),
    );

    let stageAdvanced = false;
    let nextStage: StageCode | null = null;
    let nextTask: 'T1' | 'T2' | null = null;

    if (advanceDecision.advance && advanceDecision.reason === 'total_timeout') {
      // 跳过剩余考官阶段 → 切 T1
      await this.transitionToTool(assessment, totalElapsedSec);
      newMessages.push(...(await this.buildToolIntroMessages(assessmentId, 'T1', new Date())));
      return this.buildToolResult(assessment, 'T1', newMessages, true);
    }

    if (s13ShouldTrigger) {
      // 切 S1.3：先更新 progress.s13Triggered=true，然后递归 generateFirstTurn
      await this.updateProgress(assessment, {
        ...progress,
        s13Triggered: true,
        currentStage: 'S1.3',
        turnIndex: 0,
        stageStartTs: now,
        lastActivityTs: now,
        totalElapsedSec,
      });
      const firstTurnInS13 = await this.generateFirstTurn(assessmentId, 'S1.3');
      newMessages.push(...firstTurnInS13.messages);
      stageAdvanced = true;
      nextStage = 'S1.3';
      const updated = await this.requireAssessment(assessmentId);
      const updatedProgress = (updated.progress as ProgressShape)!;
      return {
        step: 'examiner',
        currentStage: 'S1.3',
        currentTask: null,
        turnIndex: updatedProgress.turnIndex ?? 1,
        newMessages,
        stageAdvanced,
        timer: this.buildExaminerTimer(now, totalElapsedSec),
        inputEnabled: true,
      };
    }

    if (advanceDecision.advance) {
      // max_turns 或 goal_covered：切下一阶段
      const next = this.computeNextStage(stageCode);
      if (next === null) {
        // S1.3 完成 → 切 T1
        await this.transitionToTool(assessment, totalElapsedSec);
        newMessages.push(...(await this.buildToolIntroMessages(assessmentId, 'T1', new Date())));
        return this.buildToolResult(assessment, 'T1', newMessages, true);
      }
      // 切下一考官阶段
      await this.updateProgress(assessment, {
        ...progress,
        currentStage: next,
        turnIndex: 0,
        stageStartTs: now,
        lastActivityTs: now,
        totalElapsedSec,
      });
      const firstTurn = await this.generateFirstTurn(assessmentId, next);
      newMessages.push(...firstTurn.messages);
      stageAdvanced = true;
      nextStage = next;
      const updated = await this.requireAssessment(assessmentId);
      const updatedProgress = (updated.progress as ProgressShape)!;
      return {
        step: 'examiner',
        currentStage: next,
        currentTask: null,
        turnIndex: updatedProgress.turnIndex ?? 1,
        newMessages,
        stageAdvanced,
        timer: this.buildExaminerTimer(now, totalElapsedSec),
        inputEnabled: true,
      };
    }

    // 不推进：生成下一轮 AI 提问
    const nextTurn = currentTurn + 1;
    const aiMessages = await this.contextBuilder.buildExaminerContext(
      assessmentId,
      stageCode,
      nextTurn,
    );
    const aiParsed = await this.callExaminer(assessmentId, aiMessages);
    const aiTs = new Date();
    const savedNextAi = await this.dialogueRepo.save({
      assessmentId,
      mode: 'examiner',
      stageOrTask: stageCode,
      turnIndex: nextTurn,
      role: 'ai',
      content: aiParsed.question,
      signals: aiParsed.signals,
      responseIntervalSec: null,
      ts: aiTs,
    });
    newMessages.push({
      id: Number(savedNextAi.id),
      type: 'ai',
      mode: 'examiner',
      content: aiParsed.question,
      stageOrTask: stageCode,
      turnIndex: nextTurn,
      ts: aiTs.toISOString(),
    });

    await this.updateProgress(assessment, {
      ...progress,
      turnIndex: nextTurn,
      lastActivityTs: aiTs.getTime(),
      totalElapsedSec,
    });

    return {
      step: 'examiner',
      currentStage: stageCode,
      currentTask: null,
      turnIndex: nextTurn,
      newMessages,
      stageAdvanced: false,
      timer: this.buildExaminerTimer(aiTs.getTime(), totalElapsedSec),
      inputEnabled: true,
    };
  }

  // 强制推进阶段（skip / idle_timeout 调用）
  // 不调 LLM、不落 candidate 消息，直接状态机推进
  // 复用 handleCandidateMessage 的推进分支逻辑（仅跳过 candidate 落库与 AI 生成）
  async forceAdvance(assessmentId: string): Promise<HandleCandidateMessageResult> {
    const assessment = await this.requireAssessment(assessmentId);
    const progress = (assessment.progress as ProgressShape | null);
    if (!progress || progress.mode !== 'examiner' || !progress.currentStage) {
      throw new Error(
        `[examiner] forceAdvance requires active examiner stage (assessment: ${assessmentId})`,
      );
    }
    const stageCode = progress.currentStage as StageCode;
    const now = Date.now();
    const totalElapsedSec = (progress.totalElapsedSec ?? 0) +
      Math.floor((now - (progress.lastActivityTs ?? now)) / 1000);

    // total_timeout 优先：直接切 T1
    if (totalElapsedSec >= EXAMINER_TOTAL_BUDGET_SEC) {
      await this.transitionToTool(assessment, totalElapsedSec);
      const msgs = await this.buildToolIntroMessages(assessmentId, 'T1', new Date(now));
      return this.buildToolResult(assessment, 'T1', msgs, true);
    }

    const next = this.computeNextStage(stageCode);
    if (next === null) {
      // S1.2 / S1.3 结束 → 切 T1
      await this.transitionToTool(assessment, totalElapsedSec);
      const msgs = await this.buildToolIntroMessages(assessmentId, 'T1', new Date(now));
      return this.buildToolResult(assessment, 'T1', msgs, true);
    }

    await this.updateProgress(assessment, {
      ...progress,
      currentStage: next,
      turnIndex: 0,
      stageStartTs: now,
      lastActivityTs: now,
      totalElapsedSec,
    });
    const firstTurn = await this.generateFirstTurn(assessmentId, next);
    return {
      step: 'examiner',
      currentStage: next,
      currentTask: null,
      turnIndex: firstTurn.turnIndex,
      newMessages: [...firstTurn.messages],
      stageAdvanced: true,
      timer: this.buildExaminerTimer(now, totalElapsedSec),
      inputEnabled: true,
    };
  }

  private computeNextStage(current: StageCode): StageCode | null {
    if (current === 'S1.1') return 'S1.2';
    if (current === 'S1.2') return null; // S1.3 由 shouldRunS13 决定；否则进 T1
    return null; // S1.3 结束 → T1
  }

  private async transitionToTool(
    assessment: AssessmentEntity,
    totalElapsedSec: number,
  ): Promise<void> {
    const now = Date.now();
    assessment.progress = {
      mode: 'tool',
      currentStage: null,
      currentTask: 'T1',
      turnIndex: 0,
      stageStartTs: now,
      lastActivityTs: now,
      s13Triggered: (assessment.progress as ProgressShape | null)?.s13Triggered ?? false,
      totalElapsedSec,
    } as Record<string, unknown>;
    await this.assessmentRepo.save(assessment);
  }

  private async buildToolIntroMessages(
    assessmentId: string,
    taskId: 'T1' | 'T2',
    ts: Date,
  ): Promise<ExaminerMessage[]> {
    const task = getTask(taskId);
    const modeSwitch = getCard('mode_switch');
    const cards = [
      {
        variant: 'mode_switch' as const,
        title: modeSwitch.title,
        body: modeSwitch.body,
      },
      {
        variant: 'task_brief' as const,
        title: task.title,
        body: task.description,
      },
    ];
    // 持久化 system_card 到 dialogue_log（role=system_card, content 存 JSON）
    // 否则 GET /state 重建时丢失任务卡片，刷新后用户看不到任务内容
    const saved: ExaminerMessage[] = [];
    for (const c of cards) {
      const row = await this.dialogueRepo.save({
        assessmentId,
        mode: 'tool',
        stageOrTask: taskId,
        turnIndex: 0,
        role: 'system_card',
        content: JSON.stringify(c),
        signals: null,
        responseIntervalSec: null,
        ts,
      });
      saved.push({
        id: Number(row.id),
        type: 'system_card',
        mode: null,
        card: c,
        stageOrTask: taskId,
        turnIndex: 0,
        ts: ts.toISOString(),
      });
    }
    return saved;
  }

  private buildToolResult(
    assessment: AssessmentEntity,
    taskId: 'T1' | 'T2',
    newMessages: ExaminerMessage[],
    stageAdvanced: boolean,
  ): HandleCandidateMessageResult {
    const progress = (assessment.progress as ProgressShape)!;
    const task = getTask(taskId);
    const now = Date.now();
    return {
      step: 'tool',
      currentStage: null,
      currentTask: taskId,
      turnIndex: 0,
      newMessages,
      stageAdvanced,
      timer: {
        examinerTotalRemainingSec: null,
        taskRemainingSec: task.duration_minutes * 60,
        idleWarningAtSec: IDLE_WARN_SEC,
        idleSkipAtSec: IDLE_SKIP_SEC,
        lastActivityTs: new Date(progress.lastActivityTs ?? now).toISOString(),
      },
      inputEnabled: true,
    };
  }

  private buildExaminerTimer(now: number, totalElapsedSec: number): TimerInfo {
    return {
      examinerTotalRemainingSec: Math.max(0, EXAMINER_TOTAL_BUDGET_SEC - totalElapsedSec),
      taskRemainingSec: null,
      idleWarningAtSec: IDLE_WARN_SEC,
      idleSkipAtSec: IDLE_SKIP_SEC,
      lastActivityTs: new Date(now).toISOString(),
    };
  }

  private async callExaminer(
    assessmentId: string,
    messages: ChatMessage[],
  ): Promise<ExaminerResponse> {
    const [systemMessage, ...rest] = messages;
    if (!systemMessage || systemMessage.role !== 'system') {
      throw new Error('[examiner] buildExaminerContext must return system message first');
    }
    const result = await this.llmClient.call({
      assessmentId,
      purpose: 'examiner',
      systemPrompt: systemMessage.content,
      userMessages: rest as OpenAI.ChatCompletionMessageParam[],
      schema: ExaminerResponseSchema,
    });
    return result.parsed as ExaminerResponse;
  }

  private async loadExaminerSignalHistory(
    assessmentId: string,
  ): Promise<ExaminerSignalRecord[]> {
    const rows = await this.dialogueRepo.find({
      where: { assessmentId, mode: 'examiner', role: 'ai' },
      order: { ts: 'ASC' },
    });
    const records: ExaminerSignalRecord[] = [];
    for (const r of rows) {
      if (!r.signals) continue;
      records.push({
        stageOrTask: r.stageOrTask,
        signals: r.signals as unknown as ExaminerSignals,
      });
    }
    return records;
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

// re-export for callers wanting the chat message type
export type { ChatMessage };
