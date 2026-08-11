import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { OutlineEntity } from '@/db/entities/outline.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
import { DatabaseModule } from '@/db/database.module';
import { LlmModule } from '@/llm/llm.module';
import { QuestionnaireModule } from '@/questionnaire/questionnaire.module';
import { LlmClient } from '@/llm/llm.client';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { ExaminerService } from '@/assessment/examiner.service';
import { ContextBuilder } from '@/assessment/context.builder';
import { AssessmentService } from '@/assessment/assessment.service';
import { QuestionnaireService } from '@/questionnaire/questionnaire.config';
import type { ExaminerResponse } from '@/llm/schemas/examiner.schema';

// PoC 不变量 3：signals 不下发
// 验证 ExaminerService.generateFirstTurn 返回体不含 signals，
// dialogue_log 恰 1 行 ai + signals 落库；progress.turnIndex=1
// 不变量 4：LLM 统一出口（mock LlmClient 验证调用参数）
// 不变量 5：首问生成由后端主导，状态机推进 NOT_STARTED → IN_PROGRESS

const VALID_ANSWERS = {
  q1: 'A',
  q2: ['A'],
  q3: 'A',
  q4: 'A',
  q5: 'A',
};

function makeFakeExaminerResponse(question: string): ExaminerResponse {
  return {
    question,
    signals: {
      goal_coverage: 0.2,
      answer_vagueness: 0.3,
      mentioned_process_change: false,
      mentioned_asset: false,
      mentioned_others_adoption: false,
      mentioned_team_driving: false,
    },
  };
}

describe('ExaminerService 首问 + 问卷提交闭环 (PoC 不变量 3/4/5)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let llmClient: LlmClient;
  let examinerService: ExaminerService;
  let assessmentService: AssessmentService;
  let originalCall: typeof llmClient.call;

  const interviewerId = 'iv-ex-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule, QuestionnaireModule],
    }).compile();

    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    llmClient = moduleRef.get(LlmClient);

    const contextBuilder = new ContextBuilder(
      dialogueRepo,
      questionnaireRepo,
      assessmentRepo,
    );
    examinerService = new ExaminerService(
      assessmentRepo,
      dialogueRepo,
      questionnaireRepo,
      contextBuilder,
      llmClient,
    );
    const questionnaireService = moduleRef.get(QuestionnaireService);
    assessmentService = new AssessmentService(
      assessmentRepo,
      questionnaireRepo,
      moduleRef.get(getRepositoryToken(InterviewerJudgmentEntity)),
      dialogueRepo,
      { triggerAsync: () => undefined } as never,
      examinerService,
      { handleCandidateMessage: async () => undefined, completeTask: async () => undefined, forceComplete: async () => undefined } as never,
      { triggerAsync: () => undefined } as never,
      questionnaireService,
    );

    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: '首问测试面试官',
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

  async function seedNotStarted(): Promise<string> {
    const id = 'a-ex-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    await assessmentRepo.save({
      id,
      interviewerId,
      candidateName: '首问候选人',
      position: 'TEST',
      token,
      status: AssessmentStatus.NOT_STARTED,
      progress: null,
      createdAt: now,
      startedAt: null,
      submittedAt: null,
    });
    return id;
  }

  async function cleanup(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  function mockLlmOnce(response: ExaminerResponse): void {
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(response),
      parsed: response as unknown as never,
      logId: 'mock',
      model: 'mock',
      latencyMs: 10,
    })) as typeof llmClient.call;
  }

  it('generateFirstTurn → dialogue_log 恰 1 行 ai + signals 落库 + progress.turnIndex=1', async () => {
    const id = await seedNotStarted();
    mockLlmOnce(makeFakeExaminerResponse('你好，今天用AI做了什么？'));

    // 模拟状态已 IN_PROGRESS（仅测 ExaminerService 本身）
    await assessmentRepo.update({ id }, {
      status: AssessmentStatus.IN_PROGRESS,
      progress: {
        mode: 'examiner', currentStage: 'S1.1', currentTask: null, turnIndex: 0,
        stageStartTs: Date.now(), lastActivityTs: Date.now(),
        s13Triggered: false, totalElapsedSec: 0,
      },
    } as unknown as Record<string, unknown>);

    const result = await examinerService.generateFirstTurn(id, 'S1.1');

    // 不变量 3：返回体不含 signals
    expect(JSON.stringify(result)).not.toContain('signals');
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.type).toBe('ai');
    expect(result.messages[0]!.mode).toBe('examiner');
    expect(result.messages[0]!.content).toBe('你好，今天用AI做了什么？');
    expect(result.messages[0]!.turnIndex).toBe(1);
    expect(result.currentStage).toBe('S1.1');
    expect(result.turnIndex).toBe(1);
    expect(result.inputEnabled).toBe(true);

    // dialogue_log：恰 1 行 ai，turnIndex=1，signals 落库
    const aiRows = await dialogueRepo.find({ where: { assessmentId: id, role: 'ai' } });
    expect(aiRows).toHaveLength(1);
    expect(aiRows[0]!.mode).toBe('examiner');
    expect(aiRows[0]!.stageOrTask).toBe('S1.1');
    expect(aiRows[0]!.turnIndex).toBe(1);
    expect(aiRows[0]!.signals).not.toBeNull();
    expect(aiRows[0]!.content).toBe('你好，今天用AI做了什么？');

    // progress.turnIndex=1
    const a = await assessmentRepo.findOne({ where: { id } });
    const progress = a!.progress as Record<string, unknown>;
    expect(progress.turnIndex).toBe(1);
    expect(progress.mode).toBe('examiner');
    expect(progress.currentStage).toBe('S1.1');
    expect(progress.lastActivityTs).not.toBeNull();

    await cleanup(id);
  });

  it('AssessmentService.submitQuestionnaire → NOT_STARTED→IN_PROGRESS + 写 progress + 生成首问', async () => {
    const id = await seedNotStarted();
    mockLlmOnce(makeFakeExaminerResponse('请描述你最近一次使用AI的场景'));

    const result = await assessmentService.submitQuestionnaire(id, VALID_ANSWERS);

    expect(result.submittedAt).toBeInstanceOf(Date);
    expect(result.next.step).toBe('examiner');
    expect(result.next.currentStage).toBe('S1.1');
    expect(result.next.turnIndex).toBe(1);
    expect(result.next.messages).toHaveLength(1);
    expect(result.next.messages[0]!.content).toBe('请描述你最近一次使用AI的场景');

    // 不变量 3：响应序列化后不含 signals
    expect(JSON.stringify(result)).not.toContain('signals');

    // 状态机推进（不变量 5）
    const a = await assessmentRepo.findOne({ where: { id } });
    expect(a!.status).toBe(AssessmentStatus.IN_PROGRESS);
    expect(a!.startedAt).not.toBeNull();
    const progress = a!.progress as Record<string, unknown>;
    expect(progress.mode).toBe('examiner');
    expect(progress.currentStage).toBe('S1.1');
    expect(progress.turnIndex).toBe(1); // generateFirstTurn 已推进到 1
    expect(progress.s13Triggered).toBe(false);
    expect(progress.totalElapsedSec).toBe(0);

    // 问卷已落库
    const q = await questionnaireRepo.findOne({ where: { assessmentId: id } });
    expect(q).not.toBeNull();
    expect(q!.q1).toBe('A');

    // dialogue_log 恰 1 行 ai
    const aiRows = await dialogueRepo.find({ where: { assessmentId: id, role: 'ai' } });
    expect(aiRows).toHaveLength(1);
    expect(aiRows[0]!.turnIndex).toBe(1);
    expect(aiRows[0]!.signals).not.toBeNull();

    await cleanup(id);
  });

  it('重复提交问卷 → ALREADY_SUBMITTED（QuestionnaireService 校验保留）', async () => {
    const id = await seedNotStarted();
    mockLlmOnce(makeFakeExaminerResponse('首问1'));
    await assessmentService.submitQuestionnaire(id, VALID_ANSWERS);

    // 第二次提交：QuestionnaireService.findOne 命中 existing
    await expect(assessmentService.submitQuestionnaire(id, VALID_ANSWERS)).rejects.toMatchObject({
      // AppError 的 code 字段
      code: 'ALREADY_SUBMITTED',
    });

    await cleanup(id);
  });

  it('LLM 调用失败 → 异常上抛，dialogue_log 不落 ai 行', async () => {
    const id = await seedNotStarted();
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
      throw new Error('forced examiner failure');
    }) as typeof llmClient.call;

    await assessmentRepo.update({ id }, { status: AssessmentStatus.IN_PROGRESS });

    await expect(examinerService.generateFirstTurn(id, 'S1.1')).rejects.toThrow(
      'forced examiner failure',
    );

    // 失败时不应落 ai 消息
    const aiRows = await dialogueRepo.find({ where: { assessmentId: id, role: 'ai' } });
    expect(aiRows).toHaveLength(0);

    await cleanup(id);
  });
});
