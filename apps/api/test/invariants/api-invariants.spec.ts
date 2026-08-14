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
import { AssessmentService } from '@/assessment/assessment.service';
import { ReportService } from '@/assessment/report.service';
import { AssessmentStatus } from '@/assessment/assessment.state';
import { AppError } from '@/common/app-error';
import { isApiKeyConfigured } from '@/llm/llm-params';

const API_KEY_CONFIGURED = isApiKeyConfigured();
const describeIfReady = API_KEY_CONFIGURED ? describe : describe.skip;

// PoC 不变量 2：A 结论锁定——API 层（service + controller）接入 ReportFilter
// PoC 不变量 3：signals 不下发——ReportService 输出 rawLog 经 stripSignals 过滤
// PoC 不变量 5：后端控制流程推进——提交 B 触发 PENDING_INTERVIEW → FINAL_EVALUATING
//
// 与 report.filter.spec.ts 的分工：
//   report.filter.spec.ts 测 filterReport 纯函数（19 用例）
//   本测试测 ReportService 端到端：从 DB 拉数据 → 组装 ReportFilterInput → 调 filterReport → 序列化

describeIfReady('API 层不变量：报告/状态机/越权 (e2e, mysql)', () => {
  jest.setTimeout(120000);

  let moduleRef: TestingModule;
  let assessmentRepo: Repository<AssessmentEntity>;
  let interviewerRepo: Repository<InterviewerEntity>;
  let judgmentRepo: Repository<InterviewerJudgmentEntity>;
  let evaluationRepo: Repository<EvaluationEntity>;
  let dialogueRepo: Repository<DialogueLogEntity>;
  let questionnaireRepo: Repository<QuestionnaireResultEntity>;
  let outlineRepo: Repository<OutlineEntity>;
  let consistencyRepo: Repository<ConsistencyEntity>;
  let llmCallLogRepo: Repository<LlmCallLogEntity>;
  let assessments: AssessmentService;
  let reports: ReportService;

  const interviewerId = 'iv-' + crypto.randomBytes(4).toString('hex');
  const otherInterviewerId = 'iv-other-' + crypto.randomBytes(4).toString('hex');

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();

    assessmentRepo = moduleRef.get(getRepositoryToken(AssessmentEntity));
    interviewerRepo = moduleRef.get(getRepositoryToken(InterviewerEntity));
    judgmentRepo = moduleRef.get(getRepositoryToken(InterviewerJudgmentEntity));
    evaluationRepo = moduleRef.get(getRepositoryToken(EvaluationEntity));
    dialogueRepo = moduleRef.get(getRepositoryToken(DialogueLogEntity));
    questionnaireRepo = moduleRef.get(getRepositoryToken(QuestionnaireResultEntity));
    outlineRepo = moduleRef.get(getRepositoryToken(OutlineEntity));
    consistencyRepo = moduleRef.get(getRepositoryToken(ConsistencyEntity));
    llmCallLogRepo = moduleRef.get(getRepositoryToken(LlmCallLogEntity));

    // ReportService / AssessmentService 用 @InjectRepository，
    // 直接 new 时传入 repositories，避免依赖完整 AssessmentModule 的 provider 集合
    assessments = new AssessmentService(
      assessmentRepo,
      questionnaireRepo,
      judgmentRepo,
      dialogueRepo,
      { triggerAsync: () => undefined } as any,
      // ExaminerService / ToolService / InitialEvaluationService 在本 spec 不参与核心断言路径；
      // 由 examiner-first-turn.spec.ts / examiner-advance.spec.ts / tool-service.spec.ts 覆盖
      { handleCandidateMessage: async () => undefined, generateFirstTurn: async () => undefined, forceAdvance: async () => undefined } as any,
      { handleCandidateMessage: async () => undefined, completeTask: async () => undefined, forceComplete: async () => undefined } as any,
      { triggerAsync: () => undefined } as any,
      { submit: async () => undefined } as any,
    );
    reports = new ReportService(
      assessmentRepo,
      questionnaireRepo,
      dialogueRepo,
      evaluationRepo,
      judgmentRepo,
      outlineRepo,
      consistencyRepo,
      llmCallLogRepo,
    );

    await interviewerRepo.save({
      id: interviewerId,
      name: '主面试官',
      account: 'acc-' + interviewerId,
      passwordHash: 'scrypt$16384$8$1$00$00',
    });
    await interviewerRepo.save({
      id: otherInterviewerId,
      name: '另一面试官',
      account: 'acc-' + otherInterviewerId,
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

  async function seedAssessment(
    status: AssessmentStatus,
    ownerId: string,
    over: Partial<AssessmentEntity> = {},
  ): Promise<AssessmentEntity> {
    const id = 'a-' + crypto.randomBytes(8).toString('hex');
    const token = crypto.randomBytes(16).toString('hex');
    const row = assessmentRepo.create({
      id,
      interviewerId: ownerId,
      candidateName: '候选人' + id.slice(-4),
      position: 'TEST',
      token,
      status,
      progress: null,
      createdAt: new Date(),
      startedAt: status === AssessmentStatus.NOT_STARTED ? null : new Date(),
      submittedAt:
        status === AssessmentStatus.EVALUATING ||
        status === AssessmentStatus.PENDING_INTERVIEW ||
        status === AssessmentStatus.FINAL_EVALUATING ||
        status === AssessmentStatus.COMPLETED ||
        status === AssessmentStatus.EVAL_FAILED
          ? new Date()
          : null,
      ...over,
    });
    await assessmentRepo.save(row);
    return row;
  }

  async function seedEvalA(
    assessmentId: string,
    level = 'L4_pending',
    confidence = 0.55,
    resultJson: unknown = { dimensions: [{ code: 'D4', level: 'L3' }] },
  ): Promise<EvaluationEntity> {
    const row = evaluationRepo.create({
      id: crypto.randomUUID(),
      assessmentId,
      type: 'A',
      resultJson: resultJson as Record<string, unknown>,
      level,
      track: '团队负责人轨道',
      confidence: confidence,
      recommendHumanReview: true,
    });
    return evaluationRepo.save(row);
  }

  async function seedEvalC(assessmentId: string): Promise<EvaluationEntity> {
    const row = evaluationRepo.create({
      id: crypto.randomUUID(),
      assessmentId,
      type: 'C',
      resultJson: { final: true } as Record<string, unknown>,
      level: 'L3',
      track: '团队负责人轨道',
      confidence: 0.75,
      recommendHumanReview: false,
    });
    return evaluationRepo.save(row);
  }

  async function seedDialogue(
    assessmentId: string,
    mode: 'examiner' | 'tool',
    stageOrTask: string,
    role: 'ai' | 'candidate',
    signals: unknown = null,
  ): Promise<DialogueLogEntity> {
    const row = dialogueRepo.create({
      assessmentId,
      mode,
      stageOrTask,
      turnIndex: 1,
      role,
      content: mode === 'examiner' ? '考官提问' : '帮我写邮件',
      signals: signals as Record<string, unknown>,
      responseIntervalSec: role === 'candidate' ? 8 : null,
      ts: new Date(),
    });
    return dialogueRepo.save(row);
  }

  describe('创建测评 (POST /assessments)', () => {
    let assessmentId: string;

    afterAll(async () => {
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('新建测评默认 NOT_STARTED（状态机初始态）', async () => {
      const created = await assessments.create({
        candidateName: '测试候选人',
        position: 'TEST',
        interviewerId,
      });
      assessmentId = created.id;
      expect(created.status).toBe(AssessmentStatus.NOT_STARTED);
      const row = await assessmentRepo.findOne({ where: { id: created.id } });
      expect(row?.status).toBe(AssessmentStatus.NOT_STARTED);
      expect(row?.token).toHaveLength(32);
    });

    it('candidateName 超过 20 字符拒绝', async () => {
      await expect(
        assessments.create({
          candidateName: 'x'.repeat(21),
          position: null,
          interviewerId,
        }),
      ).rejects.toThrow();
    });
  });

  describe('越权访问 (api-spec D1)', () => {
    let assessmentId: string;

    beforeAll(async () => {
      const row = await seedAssessment(AssessmentStatus.COMPLETED, interviewerId);
      assessmentId = row.id;
    });

    afterAll(async () => {
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('非创建者访问 report 抛 FORBIDDEN', async () => {
      await expect(
        reports.getReport(assessmentId, otherInterviewerId),
      ).rejects.toBeInstanceOf(AppError);
      try {
        await reports.getReport(assessmentId, otherInterviewerId);
      } catch (e) {
        expect((e as AppError).code).toBe('FORBIDDEN');
      }
    });

    it('非创建者查询状态抛 FORBIDDEN', async () => {
      await expect(
        assessments.getStatus(assessmentId, otherInterviewerId),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('提交 B 触发状态机推进 PENDING_INTERVIEW → FINAL_EVALUATING (PoC 不变量 5)', () => {
    let assessmentId: string;

    beforeAll(async () => {
      const row = await seedAssessment(AssessmentStatus.PENDING_INTERVIEW, interviewerId);
      assessmentId = row.id;
      await seedEvalA(assessmentId);
    });

    afterAll(async () => {
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('提交 B 后状态变为 FINAL_EVALUATING', async () => {
      const result = await assessments.submitJudgment(assessmentId, interviewerId, {
        level: 'L3',
        track: '团队负责人轨道',
        reason:
          '现场追问能说出具体模板的7个字段和两次具体修改内容，' +
          '自述可验证；候选人对工具使用的核验意识表述具体，整体属于主动核验。',
        transcript: '面试官：你说做了一套东西…\n候选人：对，是一个Excel模板…' + 'x'.repeat(180),
        confirm: true,
      });
      // 短记录确认态不会触发，因为传了 confirm:true + transcript ≥ 200
      if ('status' in result) {
        expect(result.status).toBe(AssessmentStatus.FINAL_EVALUATING);
      } else {
        throw new Error('expected status field, got confirm-needed');
      }
      const a = await assessmentRepo.findOne({ where: { id: assessmentId } });
      expect(a?.status).toBe(AssessmentStatus.FINAL_EVALUATING);
    });

    it('重复提交 B 抛 JUDGMENT_ALREADY_SUBMITTED', async () => {
      await expect(
        assessments.submitJudgment(assessmentId, interviewerId, {
          level: 'L3',
          track: '团队负责人轨道',
          reason: '重复提交',
          transcript: 'x'.repeat(200),
          confirm: true,
        }),
      ).rejects.toBeInstanceOf(AppError);
    });
  });

  describe('A 结论锁定：API 层 ReportService 接入 filterReport (PoC 不变量 2)', () => {
    describe('PENDING_INTERVIEW 锁定态', () => {
      let assessmentId: string;

      beforeAll(async () => {
        const row = await seedAssessment(AssessmentStatus.PENDING_INTERVIEW, interviewerId);
        assessmentId = row.id;
        await seedEvalA(assessmentId, 'L4_pending', 0.55);
        await seedDialogue(assessmentId, 'examiner', 'S1.1', 'ai', {
          goal_coverage: 0.6,
          answer_vagueness: 0.4,
        });
        await seedDialogue(assessmentId, 'examiner', 'S1.1', 'candidate');
      });

      afterAll(async () => {
        if (assessmentId) await cleanupAssessment(assessmentId);
      });

      it('A1: report DTO 不含 evaluationA / level / confidence / dimensions 键名', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        expect(dto.locked).toBe(true);
        const text = JSON.stringify(dto);
        expect(text).not.toContain('evaluationA');
        expect(text).not.toContain('evaluationC');
        expect(text).not.toContain('"level"');
        expect(text).not.toContain('"confidence"');
        expect(text).not.toContain('"dimensions"');
      });

      it('A2: report 序列化全文无 /L[0-4]/ 匹配', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        const text = JSON.stringify(dto);
        expect(text).not.toMatch(/L[0-4]/);
      });

      it('C3: report rawLog 不含 signals 键', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        const text = JSON.stringify(dto);
        expect(text).not.toContain('signals');
        expect(text).not.toContain('goal_coverage');
      });
    });

    describe('FINAL_EVALUATING 锁定态', () => {
      let assessmentId: string;

      beforeAll(async () => {
        const row = await seedAssessment(AssessmentStatus.FINAL_EVALUATING, interviewerId);
        assessmentId = row.id;
        await seedEvalA(assessmentId, 'L4_pending', 0.5);
        await judgmentRepo.save({
          assessmentId,
          level: 'L3',
          track: '团队负责人轨道',
          reason: '面试记录…' + 'x'.repeat(50),
          transcript: '面试记录正文…' + 'x'.repeat(200),
          transcriptDraft: null,
          submittedAt: new Date(),
        });
        await seedDialogue(assessmentId, 'examiner', 'S1.2', 'ai', {
          goal_coverage: 0.9,
          answer_vagueness: 0.2,
        });
      });

      afterAll(async () => {
        if (assessmentId) await cleanupAssessment(assessmentId);
      });

      it('A3: final_evaluating 同样过滤——B 已提交也不暴露 A', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        expect(dto.locked).toBe(true);
        const text = JSON.stringify(dto);
        expect(text).not.toContain('evaluationA');
        expect(text).not.toContain('"level"');
        expect(text).not.toMatch(/L[0-4]/);
      });

      it('A5: 提交 B 后立即调 report 仍 locked', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        expect(dto.locked).toBe(true);
      });
    });

    describe('COMPLETED 解锁态', () => {
      let assessmentId: string;

      beforeAll(async () => {
        const row = await seedAssessment(AssessmentStatus.COMPLETED, interviewerId);
        assessmentId = row.id;
        await seedEvalA(assessmentId, 'L4_pending', 0.6);
        await seedEvalC(assessmentId);
        await seedDialogue(assessmentId, 'examiner', 'S1.1', 'ai', {
          goal_coverage: 0.5,
        });
      });

      afterAll(async () => {
        if (assessmentId) await cleanupAssessment(assessmentId);
      });

      it('A6: 终判完成后 evaluationA 与 evaluationC 均返回', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        expect(dto.locked).toBe(false);
        if (dto.locked) throw new Error('unreachable');
        expect(dto.evaluationA).not.toBeNull();
        expect(dto.evaluationC).not.toBeNull();
        expect(dto.evaluationA?.level).toBe('L4_pending');
        expect(dto.evaluationC?.level).toBe('L3');
      });

      it('C3: 完成态 report rawLog 也不含 signals 键（除 export 外一律过滤）', async () => {
        const dto = await reports.getReport(assessmentId, interviewerId);
        const text = JSON.stringify(dto);
        expect(text).not.toContain('signals');
      });
    });

    describe('列表过滤 (api-spec A4)', () => {
      let lockedId: string;
      let completedId: string;
      let evaluatingId: string;

      beforeAll(async () => {
        const locked = await seedAssessment(AssessmentStatus.PENDING_INTERVIEW, interviewerId);
        lockedId = locked.id;
        await seedEvalA(lockedId, 'L4_pending');

        const completed = await seedAssessment(AssessmentStatus.COMPLETED, interviewerId);
        completedId = completed.id;
        await seedEvalA(completedId, 'L2');

        const evaluating = await seedAssessment(AssessmentStatus.EVALUATING, interviewerId);
        evaluatingId = evaluating.id;
      });

      afterAll(async () => {
        await cleanupAssessment(lockedId);
        await cleanupAssessment(completedId);
        await cleanupAssessment(evaluatingId);
      });

      it('pending_interview 列表项 levelDisplay="待验证"', async () => {
        const a = await assessmentRepo.findOne({ where: { id: lockedId } });
        const evalA = await evaluationRepo.findOne({ where: { assessmentId: lockedId, type: 'A' } });
        const item = await reports.getListItem(a!, evalA ?? null);
        expect(item.levelDisplay).toBe('待验证');
        const text = JSON.stringify(item);
        expect(text).not.toContain('"level"');
        expect(text).toContain('"levelDisplay":"待验证"');
      });

      it('completed 列表项 levelDisplay=A.level', async () => {
        const a = await assessmentRepo.findOne({ where: { id: completedId } });
        const evalA = await evaluationRepo.findOne({ where: { assessmentId: completedId, type: 'A' } });
        const item = await reports.getListItem(a!, evalA ?? null);
        expect(item.levelDisplay).toBe('L2');
      });

      it('evaluating 列表项 levelDisplay=null', async () => {
        const a = await assessmentRepo.findOne({ where: { id: evaluatingId } });
        const item = await reports.getListItem(a!, null);
        expect(item.levelDisplay).toBeNull();
      });
    });
  });

  describe('signals 不下发：export 接口是唯一例外 (PoC 不变量 3 + api-spec C4)', () => {
    let assessmentId: string;

    beforeAll(async () => {
      const row = await seedAssessment(AssessmentStatus.PENDING_INTERVIEW, interviewerId);
      assessmentId = row.id;
      await seedEvalA(assessmentId, 'L4_pending', 0.55);
      await seedDialogue(assessmentId, 'examiner', 'S1.1', 'ai', {
        goal_coverage: 0.5,
        answer_vagueness: 0.3,
      });
    });

    afterAll(async () => {
      if (assessmentId) await cleanupAssessment(assessmentId);
    });

    it('export payload 含 signals', async () => {
      const payload = await reports.getExport(assessmentId, interviewerId);
      const text = JSON.stringify(payload.dialogueLog);
      expect(text).toContain('signals');
      expect(text).toContain('goal_coverage');
    });

    it('export 锁定期仍隐藏 evaluationA（export 不绕过 A 锁定）', async () => {
      const payload = await reports.getExport(assessmentId, interviewerId);
      expect(payload.evaluationA).toBeNull();
      expect(payload.evaluationC).toBeNull();
    });
  });
});
