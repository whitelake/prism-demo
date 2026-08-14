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
import { InterviewerJudgmentEntity } from '@/db/entities/interviewer-judgment.entity';
import { LlmCallLogEntity } from '@/db/entities/llm-call-log.entity';
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
import { OutlineService } from '@/assessment/outline.service';
import { ContextBuilder } from '@/assessment/context.builder';
import { ReportService } from '@/assessment/report.service';
import type { ExaminerResponse } from '@/llm/schemas/examiner.schema';
import type { EvaluationResponse } from '@/llm/schemas/evaluation.schema';

// 步骤 7 端到端：候选人测评全流程
// 创建测评 → 问卷 → S1.1→S1.2→S1.3 → T1→T2 → A 评估 → PENDING_INTERVIEW
// 不变量 2：PENDING_INTERVIEW 期间 GET 报告 A 字段被过滤
// 不变量 3：全流程响应体不含 signals

interface MinimalEvalResponse {
  meta: { evaluation_stage: 'A' | 'C'; levels_version: string; dimensions_version: string };
  dimensions: Array<{ code: string; name: string; level: string | null; evidence_grade: string; evidence_source: string | null; insufficient_evidence: boolean; evidence: Array<{ source: string; location: string; quote: string; note: string }>; confidence: number; reasoning: string }>;
  gate_checks: { l3_gates: { d2_decomposition: boolean; d3_verification: boolean; d4_personal_asset: boolean; task_corroboration: boolean }; l4_gate: { d4_spillover: boolean; spillover_form: string | null }; notes: string[] };
  claim_reality_gap: { level: string; description: string; interpretation: string };
  level_caps: Array<{ code: string; cap_level: string; quote: string; description: string }>;
  anomaly_signals: Array<{ type: string; evidence: string; description: string }>;
  red_lines: Array<{ code: string; quote: string; description: string }>;
  overall: { level: string; track: string; confidence: number; reasoning: string; key_uncertainties: string[]; verification_targets: string[]; recommend_human_review: boolean; human_review_reason: string };
  judgment_change: { changed: boolean; from_level: string; to_level: string; reason: string; key_new_evidence: string[] } | null;
}

function examinerResponse(question: string, signals: Partial<ExaminerResponse['signals']> = {}): ExaminerResponse {
  return {
    question,
    signals: {
      goal_coverage: 0.5,
      answer_vagueness: 0.3,
      mentioned_process_change: false,
      mentioned_asset: false,
      mentioned_others_adoption: false,
      mentioned_team_driving: false,
      ...signals,
    },
  };
}

function evalResponseA(): MinimalEvalResponse {
  return {
    meta: { evaluation_stage: 'A', levels_version: '0.4', dimensions_version: '0.1' },
    dimensions: [
      { code: 'D1', name: '使用强度与场景广度', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D2', name: '任务拆解与信息组织', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D3', name: '核验意识', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
      { code: 'D4', name: '沉淀与外溢', level: 'L2', evidence_grade: 'E2', evidence_source: null, insufficient_evidence: false, evidence: [], confidence: 0.8, reasoning: 'r' },
    ],
    gate_checks: {
      // L4_pending 要求 l3_gates 三门槛全 true（R6 管理者拦截）+ d4_spillover=true
      l3_gates: { d2_decomposition: true, d3_verification: true, d4_personal_asset: true, task_corroboration: true },
      l4_gate: { d4_spillover: true, spillover_form: '他人采纳' },
      notes: [],
    },
    claim_reality_gap: { level: '重大', description: 'gap', interpretation: '倾向夸大' },
    level_caps: [],
    anomaly_signals: [],
    red_lines: [],
    // v0.4：L4_pending + 团队负责人轨道 → 触发 shouldTriggerInterview
    // 跨字段断言要求：confidence≤0.80、verification_targets≥3、recommend_human_review=true 时 reason 非空
    overall: {
      level: 'L4_pending',
      track: '团队负责人轨道',
      confidence: 0.55,
      reasoning: 'r',
      key_uncertainties: [],
      verification_targets: [
        '候选人提到的核对清单，目前有哪些人在用、用在什么场景',
        '该做法从第一版到现在改过哪些地方，为什么改',
        '最近一次发现 AI 给出错误信息的具体情况',
      ],
      recommend_human_review: true,
      human_review_reason: 'L4_pending 需现场验证外溢事实',
    },
    judgment_change: null,
  };
}

describe('候选人测评端到端 (e2e, mock LLM)', () => {
  jest.setTimeout(60000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let evaluationRepo: Repository<EvaluationEntity>;
  let consistencyRepo: Repository<ConsistencyEntity>;
  let outlineRepo: Repository<OutlineEntity>;
  let judgmentRepo: Repository<InterviewerJudgmentEntity>;
  let llmCallLogRepo: Repository<LlmCallLogEntity>;
  let llmClient: LlmClient;
  let originalCall: typeof llmClient.call;
  let assessmentService: AssessmentService;
  let examinerService: ExaminerService;
  let toolService: ToolService;
  let initialEvalService: InitialEvaluationService;
  let reportService: ReportService;

  const interviewerId = 'iv-e2e-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule, LlmModule, QuestionnaireModule],
    }).compile();

    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    evaluationRepo = moduleRef.get(getRepositoryToken(EvaluationEntity));
    consistencyRepo = moduleRef.get(getRepositoryToken(ConsistencyEntity));
    outlineRepo = moduleRef.get(getRepositoryToken(OutlineEntity));
    judgmentRepo = moduleRef.get(getRepositoryToken(InterviewerJudgmentEntity));
    llmCallLogRepo = moduleRef.get(getRepositoryToken(LlmCallLogEntity));
    llmClient = moduleRef.get(LlmClient);

    const contextBuilder = new ContextBuilder(dialogueRepo, questionnaireRepo, assessmentRepo);
    examinerService = new ExaminerService(
      assessmentRepo, dialogueRepo, questionnaireRepo, contextBuilder, llmClient,
    );
    // outline stub 避免 e2e 触发真实 outline LLM 调用
    const outlineStub = { triggerAsync: () => undefined } as unknown as OutlineService;
    initialEvalService = new InitialEvaluationService(
      assessmentRepo, questionnaireRepo, dialogueRepo,
      evaluationRepo, consistencyRepo, llmClient, outlineStub,
    );
    toolService = new ToolService(
      assessmentRepo, dialogueRepo, contextBuilder, llmClient, initialEvalService,
    );
    const questionnaireService = moduleRef.get(QuestionnaireService);
    assessmentService = new AssessmentService(
      assessmentRepo, questionnaireRepo, judgmentRepo, dialogueRepo,
      { triggerAsync: () => undefined } as never,
      examinerService,
      toolService,
      initialEvalService,
      questionnaireService,
    );
    reportService = new ReportService(
      assessmentRepo, questionnaireRepo, dialogueRepo,
      evaluationRepo, judgmentRepo, outlineRepo,
      consistencyRepo, llmCallLogRepo,
    );

    await moduleRef.get(getRepositoryToken(InterviewerEntity)).save({
      id: interviewerId,
      name: 'e2e面试官',
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

  async function cleanup(id: string): Promise<void> {
    await dialogueRepo.delete({ assessmentId: id });
    await judgmentRepo.delete({ assessmentId: id });
    await evaluationRepo.delete({ assessmentId: id });
    await questionnaireRepo.delete({ assessmentId: id });
    await outlineRepo.delete({ assessmentId: id });
    await consistencyRepo.delete({ assessmentId: id });
    await llmCallLogRepo.delete({ assessmentId: id });
    await assessmentRepo.delete({ id });
  }

  it('完整流程：问卷 → S1.1→S1.2→S1.3 → T1→T2 → A 评估 → PENDING_INTERVIEW（A 锁定）', async () => {
    // 1. 创建测评
    const created = await assessmentService.create({
      candidateName: 'e2e候选人',
      position: 'TEST',
      interviewerId,
    });
    const id = created.id;
    expect(created.status).toBe(AssessmentStatus.NOT_STARTED);

    try {
      // 2. 启动测评
      await assessmentService.start(id, 'e2e候选人');
      // 3. 提交问卷 → 生成 S1.1 首问
      let examinerQueue: ExaminerResponse[] = [];
      function setExaminerQueue(responses: ExaminerResponse[]) {
        examinerQueue = responses;
        (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => {
          const r = examinerQueue.shift() ?? examinerResponse('默认AI提问');
          return {
            raw: JSON.stringify(r),
            parsed: r as unknown as never,
            logId: 'mock', model: 'mock', latencyMs: 10,
          };
        }) as typeof llmClient.call;
      }
      setExaminerQueue([examinerResponse('S1.1 首问：今天用AI做了什么？')]);

      const qResult = await assessmentService.submitQuestionnaire(id, {
        q1: 'A', q2: 'A', q3: 'A', q4: 'A', q5: 'A',
      });
      expect(qResult.next.currentStage).toBe('S1.1');
      expect(qResult.next.messages[0]!.content).toContain('S1.1 首问');
      // 不变量 3：响应不含 signals
      expect(JSON.stringify(qResult)).not.toContain('signals');

      // 4. S1.1 → S1.2 推进
      // 设置 progress.turnIndex=5 触发 max_turns
      const a1 = await assessmentRepo.findOne({ where: { id } });
      (a1!.progress as Record<string, unknown>).turnIndex = 5;
      await assessmentRepo.save(a1!);
      setExaminerQueue([examinerResponse('S1.2 首问：你有核对过AI输出的内容吗？')]);

      const r1 = await examinerService.handleCandidateMessage(id, 'S1.1 候选人最终回答');
      expect(r1.currentStage).toBe('S1.2');
      expect(r1.stageAdvanced).toBe(true);
      expect(JSON.stringify(r1)).not.toContain('signals');

      // 5. S1.2 → S1.3 触发（mentioned_process_change=true）
      // 灌一条 S1.1 的 signals 历史，触发 shouldRunS13
      const s11Ai = await dialogueRepo.findOne({ where: { assessmentId: id, stageOrTask: 'S1.1', role: 'ai' } });
      // 修改其 signals 使其包含 mentioned_process_change=true
      if (s11Ai) {
        s11Ai.signals = examinerResponse('', { mentioned_process_change: true }).signals;
        await dialogueRepo.save(s11Ai);
      }

      // 调整 S1.2 turnIndex=1（已完成 1 轮）
      const a2 = await assessmentRepo.findOne({ where: { id } });
      (a2!.progress as Record<string, unknown>).turnIndex = 1;
      await assessmentRepo.save(a2!);
      setExaminerQueue([examinerResponse('S1.3 首问：你提到的流程改造具体怎么做的？')]);

      const r2 = await examinerService.handleCandidateMessage(id, 'S1.2 候选人回答');
      expect(r2.currentStage).toBe('S1.3');
      expect(r2.stageAdvanced).toBe(true);

      // s13Triggered=true
      const a3 = await assessmentRepo.findOne({ where: { id } });
      expect((a3!.progress as Record<string, unknown>).s13Triggered).toBe(true);

      // 6. S1.3 → T1 切换（max_turns=6，调 turnIndex=6）
      const a4 = await assessmentRepo.findOne({ where: { id } });
      (a4!.progress as Record<string, unknown>).turnIndex = 6;
      await assessmentRepo.save(a4!);
      setExaminerQueue([]);

      const r3 = await examinerService.handleCandidateMessage(id, 'S1.3 候选人最终回答');
      expect(r3.step).toBe('tool');
      expect(r3.currentTask).toBe('T1');

      // 7. T1 任务：完成 require_min_turns=5 轮工具对话
      (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
        raw: 'AI 工具模式回复',
        parsed: undefined,
        logId: 'mock', model: 'mock', latencyMs: 10,
      })) as typeof llmClient.call;
      for (let i = 1; i <= 5; i++) {
        await toolService.handleCandidateMessage(id, `T1 候选人输入${i}`);
      }

      // 8. T1 → T2 切换
      const t1Complete = await toolService.completeTask(id);
      expect(t1Complete.currentTask).toBe('T2');

      // 9. T2 任务：完成 5 轮
      for (let i = 1; i <= 5; i++) {
        await toolService.handleCandidateMessage(id, `T2 候选人输入${i}`);
      }

      // 10. T2 完成 → EVALUATING
      const t2Complete = await toolService.completeTask(id);
      expect(t2Complete.step).toBe('finished');
      expect(t2Complete.status).toBe(AssessmentStatus.EVALUATING);

      // 11. A 评估 → PENDING_INTERVIEW（mock 返回 L4_pending + 团队负责人轨道）
      const fakeEval = evalResponseA();
      (llmClient as unknown as { call: typeof llmClient.call }).call = (async () => ({
        raw: JSON.stringify(fakeEval),
        parsed: fakeEval as unknown as never,
        logId: 'mock', model: 'mock', latencyMs: 10,
      })) as typeof llmClient.call;

      const evalResult = await initialEvalService.runInitialEvaluation(id);
      expect(evalResult.status).toBe(AssessmentStatus.PENDING_INTERVIEW);
      expect(evalResult.levelA).toBe('L4_pending');

      // 12. 不变量 2：PENDING_INTERVIEW 期间 GET 报告 A 字段被过滤
      const report = await reportService.getReport(id, interviewerId);
      const reportJson = JSON.stringify(report);
      expect(reportJson).not.toContain('L4_pending');
      expect(reportJson).not.toContain('evaluationA');
      // 状态确认为 PENDING_INTERVIEW（直接读 assessmentRepo）
      const finalA = await assessmentRepo.findOne({ where: { id } });
      expect(finalA!.status).toBe(AssessmentStatus.PENDING_INTERVIEW);

      // 13. 验证 dialogue_log 中无 signals 泄露到 getState
      const state = await assessmentService.getState(id);
      expect(JSON.stringify(state)).not.toContain('signals');
      expect(JSON.stringify(state)).not.toContain('goal_coverage');
      expect(JSON.stringify(state)).not.toContain('mentioned_process_change');
    } finally {
      await cleanup(id);
    }
  });
});
