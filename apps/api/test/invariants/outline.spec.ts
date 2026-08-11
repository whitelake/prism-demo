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
import { LlmClient } from '@/llm/llm.client';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { OutlineService } from '@/assessment/outline.service';

// PoC 不变量 4：LLM 统一出口
// 验证：OutlineService 成功落 status=success + resultJson；失败落 blacklist_failed

interface MinimalOutlineResponse {
  questions: Array<{
    index: number;
    quote: string;
    ask: string;
    verify: string;
    follow_up: string[];
  }>;
  note: string;
}

function makeFakeOutlineResponse(asks: string[]): MinimalOutlineResponse {
  return {
    questions: asks.map((ask, i) => ({
      index: i + 1,
      quote: `候选人原话 ${i + 1}`,
      ask,
      verify: `验证点 ${i + 1}`,
      follow_up: [],
    })),
    note: '',
  };
}

describe('OutlineService 题纲生成 (PoC 不变量 4)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let outlineRepo: Repository<OutlineEntity>;
  let llmClient: LlmClient;
  let service: OutlineService;
  let originalCall: typeof llmClient.call;

  const interviewerId = 'iv-outline-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule],
    }).compile();

    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    outlineRepo = moduleRef.get(getRepositoryToken(OutlineEntity));
    llmClient = moduleRef.get(LlmClient);
    service = new OutlineService(
      assessmentRepo,
      questionnaireRepo,
      dialogueRepo,
      outlineRepo,
      llmClient,
    );

    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: '题纲测试面试官',
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

  async function seedAssessment(): Promise<string> {
    const id = 'a-ol-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    await assessmentRepo.save({
      id,
      interviewerId,
      candidateName: '题纲候选人',
      position: 'TEST',
      token,
      status: AssessmentStatus.EVALUATING,
      progress: null,
      createdAt: now,
      startedAt: now,
      submittedAt: now,
    });
    await questionnaireRepo.save({
      assessmentId: id,
      q1: 'A',
      q2: JSON.stringify(['B1', 'B2']),
      q3: 'C',
      q4: 'D',
      q5: 'E',
      submittedAt: now,
    });
    await dialogueRepo.save({
      assessmentId: id,
      mode: 'examiner',
      stageOrTask: 'S1.1',
      turnIndex: 1,
      role: 'ai',
      content: '请描述你最近一次使用AI的场景',
      signals: null,
      responseIntervalSec: null,
      ts: now,
    });
    return id;
  }

  async function cleanup(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await outlineRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  it('LLM 成功 + 无黑名单命中 → outline.status=success + resultJson 落库', async () => {
    const id = await seedAssessment();
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(makeFakeOutlineResponse(['你说的模板具体是几个字段？', '小李主动来要的还是你推的？', '现在还在用吗？'])),
      parsed: makeFakeOutlineResponse(['你说的模板具体是几个字段？', '小李主动来要的还是你推的？', '现在还在用吗？']) as unknown as never,
      logId: 'mock',
      model: 'mock',
      latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await service.runOutline(id);
    expect(result.status).toBe('success');

    const row = await outlineRepo.findOne({ where: { assessmentId: id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('success');
    expect(row!.resultJson).toBeTruthy();
    const parsed = row!.resultJson as MinimalOutlineResponse;
    expect(parsed.questions).toHaveLength(3);

    await cleanup(id);
  });

  it('LLM 成功但全部命中黑名单 → outline.status=blacklist_failed', async () => {
    const id = await seedAssessment();
    // 黑名单默认含 "脚手架占位" / "TODO" / "待产品团队补齐"
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(makeFakeOutlineResponse(['脚手架占位问题1', 'TODO 问题2'])),
      parsed: makeFakeOutlineResponse(['脚手架占位问题1', 'TODO 问题2']) as unknown as never,
      logId: 'mock',
      model: 'mock',
      latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await service.runOutline(id);
    expect(result.status).toBe('blacklist_failed');

    const row = await outlineRepo.findOne({ where: { assessmentId: id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('blacklist_failed');
    expect(row!.resultJson).toBeNull();

    await cleanup(id);
  });

  it('LLM 失败 → outline.status=blacklist_failed', async () => {
    const id = await seedAssessment();
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
      throw new Error('forced outline failure');
    }) as typeof llmClient.call;

    const result = await service.runOutline(id);
    expect(result.status).toBe('blacklist_failed');

    const row = await outlineRepo.findOne({ where: { assessmentId: id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('blacklist_failed');

    await cleanup(id);
  });

  it('LLM 成功但部分命中黑名单 → 仅保留未命中条目，status=success', async () => {
    const id = await seedAssessment();
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(makeFakeOutlineResponse(['脚手架占位问题1', '你说的模板具体几个字段？', 'TODO 问题3'])),
      parsed: makeFakeOutlineResponse(['脚手架占位问题1', '你说的模板具体几个字段？', 'TODO 问题3']) as unknown as never,
      logId: 'mock',
      model: 'mock',
      latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await service.runOutline(id);
    expect(result.status).toBe('success');

    const row = await outlineRepo.findOne({ where: { assessmentId: id } });
    expect(row!.status).toBe('success');
    const parsed = row!.resultJson as MinimalOutlineResponse;
    expect(parsed.questions).toHaveLength(1);
    expect(parsed.questions[0]!.ask).toBe('你说的模板具体几个字段？');

    await cleanup(id);
  });

  it('triggerAsync 不阻塞调用方（fire-and-forget）', async () => {
    const id = await seedAssessment();
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(makeFakeOutlineResponse(['追问1', '追问2', '追问3'])),
      parsed: makeFakeOutlineResponse(['追问1', '追问2', '追问3']) as unknown as never,
      logId: 'mock',
      model: 'mock',
      latencyMs: 10,
    })) as typeof llmClient.call;

    const start = Date.now();
    service.triggerAsync(id);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100);

    // 轮询等待完成
    for (let i = 0; i < 20; i++) {
      const row = await outlineRepo.findOne({ where: { assessmentId: id } });
      if (row) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const row = await outlineRepo.findOne({ where: { assessmentId: id } });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('success');

    await cleanup(id);
  });
});
