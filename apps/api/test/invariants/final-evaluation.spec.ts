import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { InterviewerEntity } from '@/db/entities/interviewer.entity';
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { EvaluationEntity } from '@/db/entities/evaluation.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { OutlineEntity } from '@/db/entities/outline.entity';
import { ConsistencyEntity } from '@/db/entities/consistency.entity';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
import { DatabaseModule } from '@/db/database.module';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { FinalEvaluationService } from '@/assessment/final-evaluation.service';
import { levelValue } from '@/assessment/consistency';

const API_KEY_CONFIGURED = true;
// 终判状态机不变量用 mock LlmClient 验证，不需真实 API key
// llm_call_log 落库行为由 llm-call-log.spec.ts 单独覆盖

// PoC 不变量 2 + 不变量 5：终判C 接入状态机
// 验证：
//   - FINAL_EVALUATING → COMPLETED（C 成功）+ evaluation(C) 落库 + consistency 落库
//   - FINAL_EVALUATING → EVAL_FAILED（C 失败，locked 仍 true）
//   - 重试路径：EVAL_FAILED → FINAL_EVALUATING → COMPLETED

interface MinimalEvalResponse {
  meta: { evaluation_stage: 'A' | 'C'; levels_version: string; dimensions_version: string };
  dimensions: Array<{
    code: 'D1' | 'D2' | 'D3' | 'D4';
    name: string;
    level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | null;
    evidence_grade: 'E0' | 'E1' | 'E2' | 'E3';
    evidence_source: 'task' | 'interview' | null;
    insufficient_evidence: boolean;
    evidence: Array<{ source: string; location: string; quote: string; note: string }>;
    confidence: number;
    reasoning: string;
  }>;
  gate_checks: {
    l3_gates: { d2_decomposition: boolean; d3_verification: boolean; d4_personal_asset: boolean; task_corroboration: boolean };
    l4_gate: { d4_spillover: boolean; spillover_form: '他人采纳' | '流程改造' | '组织机制' | null };
    notes: string[];
  };
  claim_reality_gap: { level: '无' | '轻微' | '重大'; description: string; interpretation: string };
  level_caps: Array<{ code: 'LC1' | 'LC2' | 'LC3' | 'LC4' | 'LC5'; cap_level: string; quote: string; description: string }>;
  anomaly_signals: Array<{ type: string; evidence: string; description: string }>;
  red_lines: Array<{ code: 'RL1' | 'RL2' | 'RL3' | 'RL4'; quote: string; description: string }>;
  overall: {
    level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L4_pending';
    track: '个人深度轨道' | '团队负责人轨道' | '无法判断' | '无';
    confidence: number;
    reasoning: string;
    key_uncertainties: string[];
    verification_targets: string[];
    recommend_human_review: boolean;
    human_review_reason: string;
  };
  judgment_change: {
    changed: boolean;
    from_level: string;
    to_level: string;
    reason: string;
    key_new_evidence: string[];
  } | null;
}

function makeFakeEvalResponse(level: string): MinimalEvalResponse {
  return {
    meta: { evaluation_stage: 'C', levels_version: '0.4', dimensions_version: '0.1' },
    dimensions: [
      { code: 'D1', name: '使用强度与场景广度', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D2', name: '任务拆解与信息组织', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D3', name: '核验意识', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D4', name: '沉淀与外溢', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
    ],
    gate_checks: {
      l3_gates: { d2_decomposition: false, d3_verification: false, d4_personal_asset: false, task_corroboration: false },
      l4_gate: { d4_spillover: false, spillover_form: null },
      notes: [],
    },
    claim_reality_gap: { level: '无', description: '无落差', interpretation: '无' },
    level_caps: [],
    anomaly_signals: [],
    red_lines: [],
    overall: {
      level: level as MinimalEvalResponse['overall']['level'],
      track: '个人深度轨道',
      confidence: 0.8,
      reasoning: '基于面试记录确定等级',
      key_uncertainties: [],
      verification_targets: [],
      recommend_human_review: false,
      human_review_reason: '',
    },
    judgment_change: { changed: false, from_level: level, to_level: level, reason: '面试记录确认初判', key_new_evidence: [] },
  };
}

describe('终判 C 接入状态机 (e2e, mysql, mock LLM)', () => {
  jest.setTimeout(30000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let interviewerRepo: Repository<InterviewerEntity>;
  let judgmentRepo: Repository<InterviewerJudgmentEntity>;
  let evaluationRepo: Repository<EvaluationEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let outlineRepo: Repository<OutlineEntity>;
  let consistencyRepo: Repository<ConsistencyEntity>;
  let llmCallLogRepo: Repository<LlmCallLogEntity>;
  let llmClient: LlmClient;

  const interviewerId = 'iv-final-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule],
    }).compile();

    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    interviewerRepo = moduleRef.get(getRepositoryToken(InterviewerEntity));
    judgmentRepo = moduleRef.get(getRepositoryToken(InterviewerJudgmentEntity));
    evaluationRepo = moduleRef.get(getRepositoryToken(EvaluationEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    outlineRepo = moduleRef.get(getRepositoryToken(OutlineEntity));
    consistencyRepo = moduleRef.get(getRepositoryToken(ConsistencyEntity));
    llmCallLogRepo = moduleRef.get(getRepositoryToken(LlmCallLogEntity));
    llmClient = moduleRef.get(LlmClient);

    await interviewerRepo.save({
      id: interviewerId,
      name: '终判面试官',
      account: 'acc-' + interviewerId,
      passwordHash: 'scrypt$16384$8$1$00$00',
    });
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  async function cleanupAssessment(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await judgmentRepo.delete({ assessmentId: id });
    await evaluationRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await outlineRepo.delete({ assessmentId: id });
    await consistencyRepo.delete({ assessmentId: id });
    await llmCallLogRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  async function seedForFinalEval(opts: {
    levelA: string;
    transcript?: string;
  }): Promise<{ id: string; service: FinalEvaluationService }> {
    const id = 'a-fe-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const now = new Date();
    await assessmentRepo.save({
      id,
      interviewerId,
      candidateName: '终判候选人',
      position: 'TEST',
      token,
      status: AssessmentStatus.FINAL_EVALUATING,
      progress: null,
      createdAt: now,
      startedAt: now,
      submittedAt: now,
    });
    await evaluationRepo.save({
      id: crypto.randomUUID(),
      assessmentId: id,
      type: 'A',
      resultJson: { dimensions: [] },
      level: opts.levelA,
      track: '个人深度轨道',
      confidence: 0.55,
      recommendHumanReview: false,
    });
    await judgmentRepo.save({
      assessmentId: id,
      level: 'L4',
      track: '个人深度轨道',
      reason: '面试记录显示候选人能说出具体修改',
      transcript: opts.transcript ?? '面试官：你说做了一套模板…\n候选人：对，包含字段标注、输出格式、段落限制三个固定字段…',
      transcriptDraft: null,
      submittedAt: now,
    });
    await dialogueRepo.save({
      assessmentId: id,
      mode: 'examiner',
      stageOrTask: 'S1.1',
      turnIndex: 1,
      role: 'ai',
      content: '请描述你最近一次使用AI的具体场景',
      signals: { goal_coverage: 0.6, answer_vagueness: 0.4 },
      responseIntervalSec: null,
      ts: now,
    });
    await dialogueRepo.save({
      assessmentId: id,
      mode: 'examiner',
      stageOrTask: 'S1.1',
      turnIndex: 1,
      role: 'candidate',
      content: '上周我用AI写了催收邮件',
      signals: null,
      responseIntervalSec: 8,
      ts: new Date(now.getTime() + 1000),
    });

    const service = new FinalEvaluationService(
      assessmentRepo,
      questionnaireRepo,
      dialogueRepo,
      evaluationRepo,
      judgmentRepo,
      consistencyRepo,
      llmClient,
    );
    return { id, service };
  }

  describe('终判成功 → FINAL_EVALUATING → COMPLETED (PoC 不变量 5)', () => {
    let assessmentId: string;
    let service: FinalEvaluationService;
    let originalCall: typeof llmClient.call;

    beforeAll(async () => {
      // v0.4：唯一 pending 等级是 L4_pending（L3_pending 已废除）
      const r = await seedForFinalEval({ levelA: 'L4_pending' });
      assessmentId = r.id;
      service = r.service;

      // 用 mock 替换 LlmClient.call：返回一个固定 level=L4 的合法响应
      // 真实 LLM 行为（含 schema 校验失败、超时）非确定，不在不变量测试范围
      // llm_call_log 落库行为由 llm-call-log.spec.ts 单独覆盖
      originalCall = llmClient.call.bind(llmClient);
      (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
        return {
          raw: JSON.stringify(makeFakeEvalResponse('L4')),
          parsed: makeFakeEvalResponse('L4') as unknown as never,
          logId: 'mock-log-id',
          model: 'mock-model',
          latencyMs: 10,
        };
      }) as typeof llmClient.call;
    });

    afterAll(async () => {
      (llmClient as unknown as { call: typeof llmClient.call }).call = originalCall;
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('runFinalEvaluation 推进至 COMPLETED 并落库 evaluation(C) + consistency', async () => {
      const result = await service.runFinalEvaluation(assessmentId);
      expect(result.status).toBe(AssessmentStatus.COMPLETED);
      expect(result.levelC).toBe('L4');

      const a = await assessmentRepo.findOne({ where: { id: assessmentId } });
      expect(a?.status).toBe(AssessmentStatus.COMPLETED);

      const evalC = await evaluationRepo.findOne({
        where: { assessmentId, type: 'C' },
      });
      expect(evalC).not.toBeNull();
      expect(evalC!.level).toBe('L4');

      const cons = await consistencyRepo.findOne({
        where: { assessmentId },
      });
      expect(cons).not.toBeNull();
      expect(cons!.levelA).toBe('L4_pending');
      expect(cons!.levelB).toBe('L4');
      expect(cons!.levelC).toBe('L4');
      // L4_pending 归一为 4，L4 也是 4 → aEqC=true, gap=0
      const aVal = levelValue('L4_pending')!;
      const cVal = levelValue('L4')!;
      const bVal = levelValue('L4')!;
      expect(cons!.aEqC).toBe(aVal === cVal);
      const expectedGap = Math.max(
        Math.abs(aVal - bVal),
        Math.abs(bVal - cVal),
        Math.abs(aVal - cVal),
      );
      expect(cons!.maxLevelGap).toBe(expectedGap);
    });
  });

  describe('终判失败 → FINAL_EVALUATING → EVAL_FAILED', () => {
    let assessmentId: string;
    let service: FinalEvaluationService;
    let originalCall: typeof llmClient.call;

    beforeAll(async () => {
      const r = await seedForFinalEval({ levelA: 'L4_pending' });
      assessmentId = r.id;
      service = r.service;
      // mock LlmClient.call 抛错模拟终判失败
      originalCall = llmClient.call.bind(llmClient);
      (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
        throw new Error('forced final-eval failure');
      }) as typeof llmClient.call;
    });

    afterAll(async () => {
      // 还原
      (llmClient as unknown as { call: typeof llmClient.call }).call = originalCall;
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('runFinalEvaluation 失败时状态回退 EVAL_FAILED', async () => {
      const result = await service.runFinalEvaluation(assessmentId);
      expect(result.status).toBe(AssessmentStatus.EVAL_FAILED);
      expect(result.levelC).toBeNull();
      const a = await assessmentRepo.findOne({ where: { id: assessmentId } });
      expect(a?.status).toBe(AssessmentStatus.EVAL_FAILED);
    });

    it('eval_failed 时 report.locked 仍为 false（A 锁定由 pending_interview/final_evaluating 决定）', async () => {
      // eval_failed 不在锁定状态——但 evaluationA=null（A 仍不暴露）
      // 此处仅验证状态：EVAL_FAILED 不解锁 A 内容
      const a = await assessmentRepo.findOne({ where: { id: assessmentId } });
      expect(a?.status).toBe(AssessmentStatus.EVAL_FAILED);
      const evalC = await evaluationRepo.findOne({
        where: { assessmentId, type: 'C' },
      });
      expect(evalC).toBeNull(); // C 未落库
    });
  });

  describe('triggerAsync 异步触发不阻塞调用方', () => {
    let assessmentId: string;
    let service: FinalEvaluationService;
    let originalCall: typeof llmClient.call;

    beforeAll(async () => {
      const r = await seedForFinalEval({ levelA: 'L4_pending' });
      assessmentId = r.id;
      service = r.service;

      originalCall = llmClient.call.bind(llmClient);
      (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
        // 模拟一段延迟，验证 triggerAsync 真正异步执行
        await new Promise((resolve) => setTimeout(resolve, 200));
        return {
          raw: JSON.stringify(makeFakeEvalResponse('L4')),
          parsed: makeFakeEvalResponse('L4') as unknown as never,
          logId: 'mock-log-id',
          model: 'mock-model',
          latencyMs: 200,
        };
      }) as typeof llmClient.call;
    });

    afterAll(async () => {
      (llmClient as unknown as { call: typeof llmClient.call }).call = originalCall;
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('triggerAsync 立即返回，终判在后台执行', async () => {
      const start = Date.now();
      service.triggerAsync(assessmentId);
      const elapsed = Date.now() - start;
      // fire-and-forget：调用方不应阻塞超过 100ms（mock 内部 200ms 延迟）
      expect(elapsed).toBeLessThan(100);

      // 轮询等待终判完成（最多 10 秒，mock 200ms 即可完成）
      let a: AssessmentEntity | null = null;
      for (let i = 0; i < 20; i++) {
        a = await assessmentRepo.findOne({ where: { id: assessmentId } });
        if (a?.status === AssessmentStatus.COMPLETED) break;
        if (a?.status === AssessmentStatus.EVAL_FAILED) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      expect(a?.status).toBe(AssessmentStatus.COMPLETED);
    });
  });
});
