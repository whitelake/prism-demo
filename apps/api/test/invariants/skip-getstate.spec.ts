import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { DatabaseModule } from '@/db/database.module';
import { LlmModule } from '@/llm/llm.module';
import { QuestionnaireModule } from '@/questionnaire/questionnaire.module';
import { QuestionnaireService } from '@/questionnaire/questionnaire.config';
import { LlmClient } from '@/llm/llm.client';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { AssessmentService } from '@/assessment/assessment.service';
import { ExaminerService } from '@/assessment/examiner.service';
import { ToolService } from '@/assessment/tool.service';
import { InitialEvaluationService } from '@/assessment/initial-evaluation.service';
import { ContextBuilder } from '@/assessment/context.builder';
import { AppError } from '@/common/app-error';

// 步骤 5 简化测试：skip + getState 重建
// 不变量 3：getState 响应不含 signals，messages 仅含 role/content/stageOrTask/turnIndex/ts
// 不变量 5：skip 由后端状态机决策

describe('AssessmentService skip + getState (简化)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let llmClient: LlmClient;
  let assessmentService: AssessmentService;
  let examinerService: ExaminerService;
  let toolService: ToolService;
  let originalCall: typeof llmClient.call;
  const interviewerId = 'iv-skip-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule, QuestionnaireModule],
    }).compile();
    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    llmClient = moduleRef.get(LlmClient);
    const contextBuilder = new ContextBuilder(dialogueRepo, questionnaireRepo, assessmentRepo);
    examinerService = new ExaminerService(
      assessmentRepo, dialogueRepo, questionnaireRepo, contextBuilder, llmClient,
    );
    const initialEvalStub = { triggerAsync: () => undefined } as unknown as InitialEvaluationService;
    toolService = new ToolService(
      assessmentRepo, dialogueRepo, contextBuilder, llmClient, initialEvalStub,
    );
    const questionnaireService = moduleRef.get(QuestionnaireService);
    assessmentService = new AssessmentService(
      assessmentRepo, questionnaireRepo,
      moduleRef.get(getRepositoryToken(InterviewerJudgmentEntity)),
      dialogueRepo,
      { triggerAsync: () => undefined } as never,
      examinerService,
      toolService,
      { triggerAsync: () => undefined } as never,
      questionnaireService,
    );
    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: 'skip测试面试官',
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

  async function seed(mode: 'examiner' | 'tool', lastActivityTsOffsetSec: number): Promise<string> {
    const id = 'a-skip-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const lastActivityTs = now - lastActivityTsOffsetSec * 1000;
    await assessmentRepo.save({
      id, interviewerId, candidateName: 'skip候选人', position: 'TEST',
      token, status: AssessmentStatus.IN_PROGRESS,
      progress: {
        mode, currentStage: mode === 'examiner' ? 'S1.1' : null,
        currentTask: mode === 'tool' ? 'T1' : null, turnIndex: 0,
        stageStartTs: now, lastActivityTs,
        s13Triggered: false, totalElapsedSec: 0,
      } as unknown as Record<string, unknown>,
      createdAt: new Date(now), startedAt: new Date(now), submittedAt: null,
    });
    await questionnaireRepo.save({
      assessmentId: id, q1: 'A', q2: JSON.stringify(['A']), q3: 'A', q4: 'A', q5: 'A',
      submittedAt: new Date(now),
    });
    return id;
  }

  async function cleanup(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  it('skip idleSec<300 → SKIP_NOT_ALLOWED', async () => {
    const id = await seed('examiner', 100);
    await expect(assessmentService.skip(id)).rejects.toMatchObject({
      code: 'SKIP_NOT_ALLOWED',
    });
    await cleanup(id);
  });

  it('skip idleSec>=300 && <600 → warn_candidate', async () => {
    const id = await seed('examiner', 400);
    const result = await assessmentService.skip(id);
    expect(result.action).toBe('warn_candidate');
    await cleanup(id);
  });

  it('skip idleSec>=600 + examiner → force_advance_stage（切下一阶段）', async () => {
    const id = await seed('examiner', 700);
    // forceAdvance 调用 generateFirstTurn → 需要 mock LLM
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify({ question: 'S1.2 首问', signals: { goal_coverage: 0.2, answer_vagueness: 0.3, mentioned_process_change: false, mentioned_asset: false, mentioned_others_adoption: false, mentioned_team_driving: false } }),
      parsed: { question: 'S1.2 首问', signals: { goal_coverage: 0.2, answer_vagueness: 0.3, mentioned_process_change: false, mentioned_asset: false, mentioned_others_adoption: false, mentioned_team_driving: false } } as never,
      logId: 'mock', model: 'mock', latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await assessmentService.skip(id);
    expect(result.action).toBeUndefined();
    expect(result.result).toBeDefined();
    // 推进到 S1.2
    const r = result.result as { currentStage: string };
    expect(r.currentStage).toBe('S1.2');
    await cleanup(id);
  });

  it('skip idleSec>=600 + tool → forceComplete（切 T2）', async () => {
    const id = await seed('tool', 700);
    const result = await assessmentService.skip(id);
    const r = result.result as { currentTask: string };
    expect(r.currentTask).toBe('T2');
    await cleanup(id);
  });

  it('getState 重建 messages 且不含 signals 字段', async () => {
    const id = await seed('examiner', 50);
    const now = new Date();
    // 灌 2 条 dialogue（1 ai + 1 candidate），ai 含 signals
    await dialogueRepo.save({
      assessmentId: id, mode: 'examiner', stageOrTask: 'S1.1', turnIndex: 1,
      role: 'ai', content: 'AI 提问1',
      signals: { goal_coverage: 0.5, answer_vagueness: 0.3, mentioned_process_change: true },
      responseIntervalSec: null, ts: now,
    });
    await dialogueRepo.save({
      assessmentId: id, mode: 'examiner', stageOrTask: 'S1.1', turnIndex: 1,
      role: 'candidate', content: '候选人回答1',
      signals: null, responseIntervalSec: 5, ts: new Date(now.getTime() + 5000),
    });

    const state = await assessmentService.getState(id);

    // 不变量 3：响应不含 signals
    expect(JSON.stringify(state)).not.toContain('signals');
    expect(JSON.stringify(state)).not.toContain('goal_coverage');
    expect(JSON.stringify(state)).not.toContain('mentioned_process_change');

    // 重建顺序：ai 在前，candidate 在后
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0]!.type).toBe('ai');
    expect(state.messages[0]!.content).toBe('AI 提问1');
    expect(state.messages[1]!.type).toBe('candidate');
    expect(state.messages[1]!.content).toBe('候选人回答1');

    expect(state.currentStage).toBe('S1.1');
    expect(state.turnIndex).toBe(0);
    expect(state.inputEnabled).toBe(true);

    await cleanup(id);
  });
});
