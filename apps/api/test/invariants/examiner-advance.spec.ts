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
import { QuestionnaireModule } from '@/questionnaire/questionnaire.module';
import { LlmClient } from '@/llm/llm.client';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { ExaminerService } from '@/assessment/examiner.service';
import { ContextBuilder } from '@/assessment/context.builder';
import { getTask } from '@/assessment/tasks.config';
import type { ExaminerResponse } from '@/llm/schemas/examiner.schema';

// 步骤 3 简化测试：覆盖 S1.1 → S1.2 → S1.3 → T1 的关键路径
// 不变量 3：所有响应体 JSON.stringify 不含 "signals"
// 不变量 5：阶段推进由后端状态机决策

function fakeResponse(
  question: string,
  signals: Partial<ExaminerResponse['signals']> = {},
): ExaminerResponse {
  return {
    question,
    signals: {
      goal_coverage: 0.2,
      answer_vagueness: 0.3,
      mentioned_process_change: false,
      mentioned_asset: false,
      mentioned_others_adoption: false,
      mentioned_team_driving: false,
      ...signals,
    },
  };
}

describe('ExaminerService 阶段推进 (简化)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let llmClient: LlmClient;
  let examinerService: ExaminerService;
  let originalCall: typeof llmClient.call;
  const interviewerId = 'iv-adv-' + crypto.randomBytes(4).toString('hex');

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
      assessmentRepo,
      dialogueRepo,
      questionnaireRepo,
      contextBuilder,
      llmClient,
    );
    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: '推进测试面试官',
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

  async function seed(stage: 'S1.1' | 'S1.2' | 'S1.3'): Promise<string> {
    const id = 'a-adv-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    await assessmentRepo.save({
      id, interviewerId, candidateName: '推进候选人', position: 'TEST',
      token, status: AssessmentStatus.IN_PROGRESS,
      progress: {
        mode: 'examiner', currentStage: stage, currentTask: null, turnIndex: 0,
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

  function mockSequence(responses: ExaminerResponse[]): () => void {
    let i = 0;
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
      const r = responses[i] ?? responses[responses.length - 1]!;
      i += 1;
      return {
        raw: JSON.stringify(r),
        parsed: r as unknown as never,
        logId: 'mock',
        model: 'mock',
        latencyMs: 10,
      };
    }) as typeof llmClient.call;
    return () => { i = 0; };
  }

  it('S1.1 max_turns → 推进到 S1.2', async () => {
    const id = await seed('S1.1');
    // S1.1 max_turns=5；progress.turnIndex=5 表示当前正在第 5 轮（候选人正在回复第 5 个 AI）
    // 候选人回复后 shouldAdvanceStage(5, max=5) → advance=max_turns
    const a = await assessmentRepo.findOne({ where: { id } });
    (a!.progress as Record<string, unknown>).turnIndex = 5;
    await assessmentRepo.save(a!);

    mockSequence([
      // 切到 S1.2 时 generateFirstTurn 会调用一次 LLM
      fakeResponse('S1.2 首问'),
    ]);

    const result = await examinerService.handleCandidateMessage(id, '候选人第5轮回答');
    expect(result.stageAdvanced).toBe(true);
    expect(result.currentStage).toBe('S1.2');
    expect(result.turnIndex).toBe(1);
    // 不变量 3：响应体无 signals
    expect(JSON.stringify(result)).not.toContain('signals');
    // 新消息包含：候选人回显 + S1.2 首问
    expect(result.newMessages.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result.newMessages)).toContain('S1.2 首问');

    // 验证 dialogue_log 落了 S1.2 首问
    const s12Ai = await dialogueRepo.find({ where: { assessmentId: id, stageOrTask: 'S1.2', role: 'ai' } });
    expect(s12Ai).toHaveLength(1);

    await cleanup(id);
  });

  it('S1.2 + shouldRunS13 触发 → 切 S1.3', async () => {
    const id = await seed('S1.2');
    // 通过 S1.1 时塞一条 mentioned_process_change=true 的 signals 历史
    const now = new Date();
    await dialogueRepo.save({
      assessmentId: id, mode: 'examiner', stageOrTask: 'S1.1', turnIndex: 1,
      role: 'ai', content: 'S1.1 提问', signals: fakeResponse('', {
        mentioned_process_change: true,
      }).signals, responseIntervalSec: null, ts: now,
    });
    // 调整 progress 到 S1.2 turnIndex=1
    const a = await assessmentRepo.findOne({ where: { id } });
    (a!.progress as Record<string, unknown>).turnIndex = 1;
    (a!.progress as Record<string, unknown>).currentStage = 'S1.2';
    await assessmentRepo.save(a!);

    mockSequence([
      fakeResponse('S1.2 第2轮提问'), // S1.2 内的下一轮 AI
      fakeResponse('S1.3 首问'),
    ]);

    // 候选人回复 → shouldAdvanceStage(advance=false, turnIndex=1, min=3) → 生成下一轮 AI
    // 但 shouldRunS13 检查：S1.1 有 mentioned_process_change=true → 触发 S1.3
    // 触发优先于普通推进（按计划）
    const result = await examinerService.handleCandidateMessage(id, '候选人触发 S1.3');

    // 当前实现：shouldRunS13 触发时直接切 S1.3，跳过本轮 AI 生成
    expect(result.currentStage).toBe('S1.3');
    expect(result.stageAdvanced).toBe(true);
    expect(result.turnIndex).toBe(1);
    // S1.3 首问已落库
    const s13Ai = await dialogueRepo.find({ where: { assessmentId: id, stageOrTask: 'S1.3', role: 'ai' } });
    expect(s13Ai).toHaveLength(1);
    // s13Triggered=true
    const updated = await assessmentRepo.findOne({ where: { id } });
    expect((updated!.progress as Record<string, unknown>).s13Triggered).toBe(true);

    expect(JSON.stringify(result)).not.toContain('signals');

    await cleanup(id);
  });

  it('S1.3 max_turns → 切 T1（工具模式 + task_brief 卡片）', async () => {
    const id = await seed('S1.3');
    const a = await assessmentRepo.findOne({ where: { id } });
    (a!.progress as Record<string, unknown>).turnIndex = 5; // S1.3 max=6 但简化为 5+1=6 触发
    (a!.progress as Record<string, unknown>).s13Triggered = true;
    await assessmentRepo.save(a!);

    // S1.3 max_turns=6；turnIndex=5 → 候选人回答后下一轮 = 6 → 触发 max_turns
    // 实际：shouldAdvanceStage(ctx.turnIndex=5, max=6) 不触发；这里强制 turnIndex=6
    (a!.progress as Record<string, unknown>).turnIndex = 6;
    await assessmentRepo.save(a!);

    // shouldAdvanceStage(6, max=6) → advance=true, reason=max_turns
    // → computeNextStage(S1.3) → null → 切 T1
    mockSequence([]);

    const result = await examinerService.handleCandidateMessage(id, '候选人触发切 T1');
    expect(result.step).toBe('tool');
    expect(result.currentStage).toBeNull();
    expect(result.currentTask).toBe('T1');
    expect(result.stageAdvanced).toBe(true);
    // newMessages 包含候选人回显 + mode_switch 卡 + task_brief 卡
    const cards = result.newMessages.filter((m) => m.type === 'system_card');
    expect(cards.length).toBe(2);
    expect(cards[0]!.card!.variant).toBe('mode_switch');
    expect(cards[1]!.card!.variant).toBe('task_brief');
    // T1 题面按 hashIndex(assessmentId) 选 variant
    // 断言卡片 title 与 getTask('T1', id).title 一致,验证 variant 选择 + 卡片渲染端到端
    expect(cards[1]!.card!.title).toBe(getTask('T1', id).title);

    expect(JSON.stringify(result)).not.toContain('signals');

    await cleanup(id);
  });

  it('S1.1 goal_covered（turnIndex>=min_turns 且历史 goal_coverage>=0.8）→ 推进到 S1.2', async () => {
    const id = await seed('S1.1');
    // S1.1 min_turns=3；turnIndex=3 达成最小轮次
    // 历史最新一轮 AI signals.goal_coverage=0.85 → shouldAdvanceStage reason=goal_covered
    const now = new Date();
    await dialogueRepo.save({
      assessmentId: id, mode: 'examiner', stageOrTask: 'S1.1', turnIndex: 2,
      role: 'ai', content: 'S1.1 第2轮提问',
      signals: fakeResponse('', { goal_coverage: 0.85 }).signals,
      responseIntervalSec: null, ts: now,
    });
    const a = await assessmentRepo.findOne({ where: { id } });
    (a!.progress as Record<string, unknown>).turnIndex = 3;
    await assessmentRepo.save(a!);

    mockSequence([
      // 推进到 S1.2 后 generateFirstTurn 调一次 LLM
      fakeResponse('S1.2 首问'),
    ]);

    const result = await examinerService.handleCandidateMessage(id, '候选人回答覆盖目标');
    expect(result.stageAdvanced).toBe(true);
    expect(result.currentStage).toBe('S1.2');
    expect(result.turnIndex).toBe(1);
    expect(JSON.stringify(result)).not.toContain('signals');

    // 验证 dialogue_log 落了 S1.2 首问
    const s12Ai = await dialogueRepo.find({ where: { assessmentId: id, stageOrTask: 'S1.2', role: 'ai' } });
    expect(s12Ai).toHaveLength(1);

    await cleanup(id);
  });
});
