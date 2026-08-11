import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { OutlineEntity } from '@/db/entities/outline.entity';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
import { DatabaseModule } from '@/db/database.module';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import { InputTooLongError } from '@/llm/input-too-long.error';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { InitialEvaluationService } from '@/assessment/initial-evaluation.service';
import { OutlineService } from '@/assessment/outline.service';

// 步骤 6 简化测试：A 评估状态机推进
// 不变量 2：A 锁定——pending_interview 期间 ReportFilter 已隔离（report-filter.spec.ts 覆盖）
// 不变量 4：LLM 统一出口
// 不变量 5：状态机推进由 shouldTriggerInterview 决策

interface MinimalEvalResponse {
  dimensions: Array<{ code: string; name: string; level: string | null; insufficient_evidence: boolean; evidence: Array<{ source: string; location: string; quote: string; note: string }>; confidence: number; reasoning: string }>;
  claim_reality_gap: { level: string; description: string; interpretation: string };
  anomaly_signals: Array<{ type: string; evidence: string; description: string }>;
  red_lines: Array<{ code: string; quote: string; description: string }>;
  overall: { level: string; track: string; confidence: number; reasoning: string; key_uncertainties: string[]; recommend_human_review: boolean; human_review_reason: string };
  judgment_change: { changed: boolean; from_level: string; to_level: string; reason: string; key_new_evidence: string[] } | null;
}

function makeFakeEval(level: string, track = '个人深度轨道', confidence = 0.8): MinimalEvalResponse {
  return {
    dimensions: [
      { code: 'D1', name: '使用强度', level: 'L2', insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D2', name: '核验意识', level: 'L2', insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D3', name: '迭代能力', level: 'L2', insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D4', name: '修改具体性', level: 'L2', insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D5', name: '复用资产', level: null, insufficient_evidence: true, evidence: [], confidence: 0.5, reasoning: 'r' },
      { code: 'D6', name: '组织推动', level: null, insufficient_evidence: true, evidence: [], confidence: 0.5, reasoning: 'r' },
    ],
    claim_reality_gap: { level: '无', description: '', interpretation: '无' },
    anomaly_signals: [],
    red_lines: [],
    overall: { level, track, confidence, reasoning: 'r', key_uncertainties: [], recommend_human_review: false, human_review_reason: '' },
    judgment_change: null,
  };
}

describe('InitialEvaluationService A 评估 (简化)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let evaluationRepo: Repository<EvaluationEntity>;
  let consistencyRepo: Repository<ConsistencyEntity>;
  let outlineRepo: Repository<OutlineEntity>;
  let llmCallLogRepo: Repository<LlmCallLogEntity>;
  let llmClient: LlmClient;
  let service: InitialEvaluationService;
  let originalCall: typeof llmClient.call;

  const interviewerId = 'iv-ieval-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule],
    }).compile();

    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    evaluationRepo = moduleRef.get(getRepositoryToken(EvaluationEntity));
    consistencyRepo = moduleRef.get(getRepositoryToken(ConsistencyEntity));
    outlineRepo = moduleRef.get(getRepositoryToken(OutlineEntity));
    llmCallLogRepo = moduleRef.get(getRepositoryToken(LlmCallLogEntity));
    llmClient = moduleRef.get(LlmClient);

    // OutlineService stub：triggerAsync 不做实际工作
    const outlineStub = {
      triggerAsync: () => undefined,
    } as unknown as OutlineService;

    service = new InitialEvaluationService(
      assessmentRepo,
      questionnaireRepo,
      dialogueRepo,
      evaluationRepo,
      consistencyRepo,
      llmClient,
      outlineStub,
    );

    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: 'A评估测试面试官',
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

  async function seedEvaluating(): Promise<string> {
    const id = 'a-ieval-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    await assessmentRepo.save({
      id, interviewerId, candidateName: 'A评估候选人', position: 'TEST',
      token, status: AssessmentStatus.EVALUATING, progress: null,
      createdAt: now, startedAt: now, submittedAt: now,
    });
    await questionnaireRepo.save({
      assessmentId: id, q1: 'A', q2: JSON.stringify(['A']), q3: 'A', q4: 'A', q5: 'A',
      submittedAt: now,
    });
    await dialogueRepo.save({
      assessmentId: id, mode: 'examiner', stageOrTask: 'S1.1', turnIndex: 1,
      role: 'ai', content: '请描述使用场景',
      signals: { goal_coverage: 0.5, answer_vagueness: 0.3, mentioned_process_change: false, mentioned_asset: false, mentioned_others_adoption: false, mentioned_team_driving: false },
      responseIntervalSec: null, ts: now,
    });
    return id;
  }

  async function cleanup(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await evaluationRepo.delete({ assessmentId: id });
    await consistencyRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await outlineRepo.delete({ assessmentId: id });
    await llmCallLogRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  it('L3_pending → PENDING_INTERVIEW + evaluation(A) 落库', async () => {
    const id = await seedEvaluating();
    const fake = makeFakeEval('L3_pending', '团队负责人轨道', 0.55);
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(fake),
      parsed: fake as unknown as never,
      logId: 'mock', model: 'mock', latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await service.runInitialEvaluation(id);
    expect(result.status).toBe(AssessmentStatus.PENDING_INTERVIEW);
    expect(result.levelA).toBe('L3_pending');

    // evaluation(A) 落库
    const evalA = await evaluationRepo.findOne({ where: { assessmentId: id, type: 'A' } });
    expect(evalA).not.toBeNull();
    expect(evalA!.level).toBe('L3_pending');

    // consistency 落库（仅 levelA，其他 null）
    const cons = await consistencyRepo.findOne({ where: { assessmentId: id } });
    expect(cons).not.toBeNull();
    expect(cons!.levelA).toBe('L3_pending');
    expect(cons!.levelB).toBeNull();
    expect(cons!.levelC).toBeNull();

    // 评估状态
    const a = await assessmentRepo.findOne({ where: { id } });
    expect(a!.status).toBe(AssessmentStatus.PENDING_INTERVIEW);

    await cleanup(id);
  });

  it('L2 高置信 + 个人深度轨道 → COMPLETED', async () => {
    const id = await seedEvaluating();
    const fake = makeFakeEval('L2', '个人深度轨道', 0.85);
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(fake),
      parsed: fake as unknown as never,
      logId: 'mock', model: 'mock', latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await service.runInitialEvaluation(id);
    expect(result.status).toBe(AssessmentStatus.COMPLETED);
    expect(result.levelA).toBe('L2');

    await cleanup(id);
  });

  it('LLM 失败 → EVAL_FAILED', async () => {
    const id = await seedEvaluating();
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
      throw new Error('forced eval failure');
    }) as typeof llmClient.call;

    const result = await service.runInitialEvaluation(id);
    expect(result.status).toBe(AssessmentStatus.EVAL_FAILED);
    expect(result.levelA).toBeNull();

    // 不应落 evaluation(A)
    const evalA = await evaluationRepo.findOne({ where: { assessmentId: id, type: 'A' } });
    expect(evalA).toBeNull();

    const a = await assessmentRepo.findOne({ where: { id } });
    expect(a!.status).toBe(AssessmentStatus.EVAL_FAILED);

    await cleanup(id);
  });

  it('低置信度 → PENDING_INTERVIEW（confidence<0.6 触发）', async () => {
    const id = await seedEvaluating();
    const fake = makeFakeEval('L2', '个人深度轨道', 0.45);
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
      raw: JSON.stringify(fake),
      parsed: fake as unknown as never,
      logId: 'mock', model: 'mock', latencyMs: 10,
    })) as typeof llmClient.call;

    const result = await service.runInitialEvaluation(id);
    expect(result.status).toBe(AssessmentStatus.PENDING_INTERVIEW);

    await cleanup(id);
  });

  it('R3 截断重试：第一次抛 InputTooLongError，第二次返回 fakeEval → COMPLETED', async () => {
    const id = await seedEvaluating();
    // 灌一条 >500 字的 tool assistant 行，使 truncateFullLog 实际截断并返回新引用
    const longToolAi = 'A'.repeat(600);
    await dialogueRepo.save({
      assessmentId: id, mode: 'tool', stageOrTask: 'T1', turnIndex: 1,
      role: 'ai', content: longToolAi, signals: null,
      responseIntervalSec: null, ts: new Date(),
    });
    const fake = makeFakeEval('L2', '个人深度轨道', 0.85);
    let attempt = 0;
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
      attempt += 1;
      if (attempt === 1) {
        // 第一次调用前估算超长 → 抛 InputTooLongError
        throw new InputTooLongError({
          purpose: 'eval',
          estimatedTokens: 50000,
          maxInputTokens: 32000,
        });
      }
      // 第二次（截断后）返回评估结果
      return {
        raw: JSON.stringify(fake),
        parsed: fake as unknown as never,
        logId: 'mock', model: 'mock', latencyMs: 10,
      };
    }) as typeof llmClient.call;

    const result = await service.runInitialEvaluation(id);
    expect(result.status).toBe(AssessmentStatus.COMPLETED);
    expect(result.levelA).toBe('L2');
    // 验证调用了两次（第一次抛错 → 截断 → 重试）
    expect(attempt).toBe(2);

    // evaluation(A) 落库
    const evalA = await evaluationRepo.findOne({ where: { assessmentId: id, type: 'A' } });
    expect(evalA).not.toBeNull();
    expect(evalA!.level).toBe('L2');

    await cleanup(id);
  });

  it('R3 截断重试仍失败 → EVAL_FAILED', async () => {
    const id = await seedEvaluating();
    await dialogueRepo.save({
      assessmentId: id, mode: 'tool', stageOrTask: 'T1', turnIndex: 1,
      role: 'ai', content: 'A'.repeat(600), signals: null,
      responseIntervalSec: null, ts: new Date(),
    });
    let attempt = 0;
    (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
      attempt += 1;
      // 两次都抛 InputTooLongError → 第二次 catch 后落 EVAL_FAILED
      throw new InputTooLongError({
        purpose: 'eval',
        estimatedTokens: 50000,
        maxInputTokens: 32000,
      });
    }) as typeof llmClient.call;

    const result = await service.runInitialEvaluation(id);
    expect(result.status).toBe(AssessmentStatus.EVAL_FAILED);
    expect(result.levelA).toBeNull();
    expect(attempt).toBe(2);

    const evalA = await evaluationRepo.findOne({ where: { assessmentId: id, type: 'A' } });
    expect(evalA).toBeNull();

    await cleanup(id);
  });
});
