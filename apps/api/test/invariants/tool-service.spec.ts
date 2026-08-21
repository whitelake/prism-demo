import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { DatabaseModule } from '@/db/database.module';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import type { StreamChunk } from '@/llm/llm.client';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { ToolService } from '@/assessment/tool.service';
import { ContextBuilder } from '@/assessment/context.builder';
import { InitialEvaluationService } from '@/assessment/initial-evaluation.service';
import { getTask } from '@/assessment/tasks.config';

// 步骤 4 简化测试：tool 模式上下文隔离 + 任务切换
// 不变量 1：LlmClient 收到的 systemPrompt 不含候选人姓名/问卷/T1 描述（currentTask=T2 时）
// 不变量 3：tool 模式 ai 行 signals=null
// 不变量 5：任务切换由 completeTask 主导

describe('ToolService 工具模式 + 任务切换 (简化)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let llmClient: LlmClient;
  let toolService: ToolService;
  let originalCall: typeof llmClient.call;
  const interviewerId = 'iv-tool-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule],
    }).compile();
    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    llmClient = moduleRef.get(LlmClient);
    const contextBuilder = new ContextBuilder(dialogueRepo, questionnaireRepo, assessmentRepo);
    const initialEvalStub = { triggerAsync: () => undefined } as unknown as InitialEvaluationService;
    toolService = new ToolService(
      assessmentRepo,
      dialogueRepo,
      contextBuilder,
      llmClient,
      initialEvalStub,
    );
    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: '工具测试面试官',
      account: 'acc-' + interviewerId,
      passwordHash: 'scrypt$16384$8$1$00$00',
    });
    originalCall = llmClient.call.bind(llmClient);
  });

  afterAll(async () => {
    if (llmClient) {
      (llmClient as unknown as { call: typeof llmClient.call }).call = originalCall;
    }
    if (moduleRef) await moduleRef.close();
  });

  async function seed(taskId: 'T1' | 'T2'): Promise<string> {
    const id = 'a-tool-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    await assessmentRepo.save({
      id, interviewerId, candidateName: '工具候选人', position: 'TEST',
      token, status: AssessmentStatus.IN_PROGRESS,
      progress: {
        mode: 'tool', currentStage: null, currentTask: taskId, turnIndex: 0,
        stageStartTs: now.getTime(), lastActivityTs: now.getTime(),
        s13Triggered: false, totalElapsedSec: 0,
      } as unknown as Record<string, unknown>,
      createdAt: now, startedAt: now, submittedAt: null,
    });
    await questionnaireRepo.save({
      assessmentId: id, q1: 'A', q2: 'A', q3: 'A', q4: 'A', q5: 'A',
      submittedAt: now,
    });
    return id;
  }

  async function cleanup(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  it('handleCandidateMessage → 落 candidate+ai，signals=null，response 含 signals 字样为否', async () => {
    const id = await seed('T1');
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: '尊敬的张经理：关于催货...',
      parsed: undefined,
      logId: 'mock',
      model: 'mock',
      latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await toolService.handleCandidateMessage(id, '帮我写催货邮件');

    expect(result.step).toBe('tool');
    expect(result.currentTask).toBe('T1');
    expect(result.turnIndex).toBe(1);
    expect(result.newMessages).toHaveLength(2);
    expect(result.newMessages[0]!.type).toBe('candidate');
    expect(result.newMessages[1]!.type).toBe('ai');
    expect(result.newMessages[1]!.content).toBe('尊敬的张经理：关于催货...');

    // 不变量 3：tool ai 行 signals=null
    const aiRows = await dialogueRepo.find({ where: { assessmentId: id, role: 'ai', mode: 'tool' } });
    expect(aiRows).toHaveLength(1);
    expect(aiRows[0]!.signals).toBeNull();
    // 不变量 3：响应体不含 signals
    expect(JSON.stringify(result)).not.toContain('signals');

    await cleanup(id);
  });

  it('completeTask T1 取消 min_turns 限制后,0 candidate 也能切 T2', async () => {
    // 产品决策 2026-08-20：取消 tool 模式 require_min_turns 限制（tasks.yaml T1/T2 均 0）
    // 不变量校验：count=0 >= require_min_turns=0 → 不抛 SKIP_NOT_ALLOWED，正常推进
    const id = await seed('T1');
    const result = await toolService.completeTask(id);
    expect(result.step).toBe('tool');
    expect(result.currentTask).toBe('T2');
    await cleanup(id);
  });

  it('completeTask T1 满足 min_turns → 切 T2 + task_brief 卡', async () => {
    const id = await seed('T1');
    // 灌 5 条 candidate tool 记录满足 require_min_turns=5
    const now = new Date();
    for (let i = 1; i <= 5; i++) {
      await dialogueRepo.save({
        assessmentId: id, mode: 'tool', stageOrTask: 'T1', turnIndex: i,
        role: 'candidate', content: `候选人输入${i}`, signals: null,
        responseIntervalSec: 1, ts: new Date(now.getTime() + i * 1000),
      });
    }

    const result = await toolService.completeTask(id);
    expect(result.step).toBe('tool');
    expect(result.currentTask).toBe('T2');
    expect(result.turnIndex).toBe(0);
    // newMessages 包含 task_done + T2 task_brief
    const cards = result.newMessages.filter((m) => m.type === 'system_card');
    expect(cards).toHaveLength(2);
    expect(cards[0]!.card!.variant).toBe('task_done');
    expect(cards[1]!.card!.variant).toBe('task_brief');
    // T2 题面按 hashIndex(assessmentId) 选 variant
    // 断言卡片 title 与 getTask('T2', id).title 一致,验证 variant 选择 + 卡片渲染端到端
    expect(cards[1]!.card!.title).toBe(getTask('T2', id).title);

    await cleanup(id);
  });

  it('completeTask T2 满足 min_turns → status=EVALUATING + 触发 A 评估', async () => {
    const id = await seed('T2');
    const now = new Date();
    for (let i = 1; i <= 5; i++) {
      await dialogueRepo.save({
        assessmentId: id, mode: 'tool', stageOrTask: 'T2', turnIndex: i,
        role: 'candidate', content: `候选人输入${i}`, signals: null,
        responseIntervalSec: 1, ts: new Date(now.getTime() + i * 1000),
      });
    }

    const result = await toolService.completeTask(id);
    expect(result.step).toBe('finished');
    expect(result.status).toBe(AssessmentStatus.EVALUATING);
    expect(result.submittedAt).toBeInstanceOf(Date);
    expect(result.inputEnabled).toBe(false);

    const a = await assessmentRepo.findOne({ where: { id } });
    expect(a!.status).toBe(AssessmentStatus.EVALUATING);

    await cleanup(id);
  });

  it('不变量 1：T2 上下文不含候选人姓名/问卷/T1 历史/任务描述', async () => {
    const id = await seed('T2');
    // 灌一条 T1 候选人历史（应被 buildToolContext 过滤掉）
    const now = new Date();
    await dialogueRepo.save({
      assessmentId: id, mode: 'tool', stageOrTask: 'T1', turnIndex: 1,
      role: 'candidate', content: 'T1 候选人历史不应出现在 T2 上下文',
      signals: null, responseIntervalSec: 1, ts: now,
    });

    let capturedSystemPrompt: string = '';
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async (params: any) => {
      capturedSystemPrompt = params.systemPrompt as string;
      return {
        raw: 'AI 工具模式回复',
        parsed: undefined,
        logId: 'mock',
        model: 'mock',
        latencyMs: 10,
      };
    }) as typeof llmClient.call;

    await toolService.handleCandidateMessage(id, 'T2 候选人输入');

    // 不变量 1：不含候选人姓名
    expect(capturedSystemPrompt).not.toContain('工具候选人');
    // 不含问卷 Q1-Q5 字段
    expect(capturedSystemPrompt).not.toMatch(/Q[1-5]/);
    // 不含 T1 历史
    expect(capturedSystemPrompt).not.toContain('T1 候选人历史不应出现在 T2 上下文');
    // 不含 T1 任务描述（"催收邮件"）
    expect(capturedSystemPrompt).not.toContain('催收邮件');
    // 不含 assessmentId（业务元数据脱敏）
    expect(capturedSystemPrompt).not.toContain(id);

    await cleanup(id);
  });

  it('handleCandidateMessageStream → accepted→delta+→done，signals=null，不变量1 仍生效', async () => {
    const id = await seed('T2');
    // 灌 T1 历史验证流式版本仍过滤
    const now = new Date();
    await dialogueRepo.save({
      assessmentId: id, mode: 'tool', stageOrTask: 'T1', turnIndex: 1,
      role: 'candidate', content: 'T1 历史不应进入 T2 流式上下文',
      signals: null, responseIntervalSec: 1, ts: now,
    });

    let capturedSystemPrompt: string = '';
    async function* fakeStream(): AsyncGenerator<StreamChunk> {
      yield { type: 'delta', text: '尊敬的' };
      yield { type: 'delta', text: '张经理' };
      yield {
        type: 'done',
        fullText: '尊敬的张经理',
        logId: 'mock', model: 'mock', latencyMs: 10,
      };
    }
    (llmClient as unknown as { callStream: typeof llmClient.callStream }).callStream = (
      (params: { systemPrompt: string }) => {
        capturedSystemPrompt = params.systemPrompt;
        return fakeStream();
      }
    ) as unknown as typeof llmClient.callStream;

    const events: { event: string; data: Record<string, unknown> }[] = [];
    for await (const ev of toolService.handleCandidateMessageStream(id, 'T2 流式输入')) {
      events.push({ event: ev.event, data: ev.data as Record<string, unknown> });
    }

    // 事件序列：accepted → delta → delta → done
    expect(events[0]!.event).toBe('accepted');
    expect(events[1]!.event).toBe('delta');
    expect(events[2]!.event).toBe('delta');
    expect(events[events.length - 1]!.event).toBe('done');
    expect(events[1]!.data.text).toBe('尊敬的');
    expect(events[2]!.data.text).toBe('张经理');

    // done 事件携带 aiMessageId + turnIndex + taskRemainingSec + finishReason
    const doneData = events[events.length - 1]!.data as {
      aiMessageId: string; turnIndex: number; taskRemainingSec: number; finishReason: string;
    };
    expect(doneData.aiMessageId).toBeTruthy();
    expect(doneData.turnIndex).toBe(1);
    expect(doneData.taskRemainingSec).toBeGreaterThan(0);
    expect(doneData.finishReason).toBe('stop');

    // 不变量 3：ai 行 signals=null
    const aiRow = await dialogueRepo.findOne({
      where: { assessmentId: id, mode: 'tool', role: 'ai' },
    });
    expect(aiRow).not.toBeNull();
    expect(aiRow!.signals).toBeNull();
    expect(aiRow!.content).toBe('尊敬的张经理');

    // 不变量 1：流式版本 systemPrompt 仍不含候选人姓名/问卷/T1 历史
    expect(capturedSystemPrompt).not.toContain('工具候选人');
    expect(capturedSystemPrompt).not.toMatch(/Q[1-5]/);
    expect(capturedSystemPrompt).not.toContain('T1 历史不应进入 T2 流式上下文');
    expect(capturedSystemPrompt).not.toContain(id);

    await cleanup(id);
  });
});
