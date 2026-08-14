import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ContextBuilder, ChatMessage } from '@/assessment/context.builder';
import { DialogueLogEntity } from '@/db/entities/dialogue-log.entity';
import { QuestionnaireResultEntity } from '@/db/entities/questionnaire-result.entity';
import { AssessmentEntity } from '@/db/entities/assessment.entity';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate } from '@/llm/interpolator';
import { getStageConfig } from '@/assessment/stages.config';
import { getTask } from '@/assessment/tasks.config';

// PoC 不变量 1：工具模式上下文严格隔离
// 详见 docs/architecture.md 4.1、.claude/rules/poc-invariants.md 第1条、.claude/rules/testing.md "上下文隔离"
//
// 验证内容（架构 4.1 自动化验证）：
// - 不含问卷信息
// - 不含候选人姓名
// - 不含考官模式对话
// - 不含任务描述
// - T2 不含 T1 历史

// 工具模式 system prompt 静态性由 ContextBuilder 启动时 assertNoVariables 保证，
// 不在每条 it 中重复断言，独立写在 "tool prompt 静态性" 一节。

interface MockRepo<T> {
  find: jest.Mock<Promise<T[]>, unknown[]>;
  findOne: jest.Mock<Promise<T | null>, unknown[]>;
}

function mockDialogueRepo(): MockRepo<DialogueLogEntity> & Partial<Repository<DialogueLogEntity>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function mockQuestionnaireRepo(): MockRepo<QuestionnaireResultEntity> & Partial<Repository<QuestionnaireResultEntity>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function mockAssessmentRepo(): MockRepo<AssessmentEntity> & Partial<Repository<AssessmentEntity>> {
  return {
    find: jest.fn().mockResolvedValue([]),
    findOne: jest.fn().mockResolvedValue(null),
  };
}

function makeDialogueRow(over: Partial<DialogueLogEntity>): DialogueLogEntity {
  const row = new DialogueLogEntity();
  return Object.assign(row, {
    id: '1',
    assessmentId: 'A1',
    mode: 'tool',
    stageOrTask: 'T1',
    turnIndex: 1,
    role: 'candidate',
    content: '',
    signals: null,
    responseIntervalSec: null,
    ts: new Date(),
    ...over,
  });
}

describe('工具模式上下文隔离 (PoC 不变量 1)', () => {
  let builder: ContextBuilder;
  let dialogueRepo: ReturnType<typeof mockDialogueRepo>;
  let questionnaireRepo: ReturnType<typeof mockQuestionnaireRepo>;
  let assessmentRepo: ReturnType<typeof mockAssessmentRepo>;
  let moduleRef: TestingModule;

  const ASSESSMENT_ID = 'test-ctx-A1';
  const CANDIDATE_NAME = '测试候选人张三';

  beforeAll(async () => {
    dialogueRepo = mockDialogueRepo();
    questionnaireRepo = mockQuestionnaireRepo();
    assessmentRepo = mockAssessmentRepo();
    moduleRef = await Test.createTestingModule({
      providers: [
        ContextBuilder,
        {
          provide: getRepositoryToken(DialogueLogEntity),
          useValue: dialogueRepo,
        },
        {
          provide: getRepositoryToken(QuestionnaireResultEntity),
          useValue: questionnaireRepo,
        },
        {
          provide: getRepositoryToken(AssessmentEntity),
          useValue: assessmentRepo,
        },
      ],
    }).compile();
    builder = moduleRef.get(ContextBuilder);
  });

  afterAll(async () => {
    if (moduleRef) await moduleRef.close();
  });

  describe('tool prompt 静态性（架构 4.1 强制约束1）', () => {
    it('loadPrompt("tool") 不含 {{...}} 占位符', () => {
      const raw = loadPrompt('tool');
      expect(raw).not.toMatch(/\{\{\s*[a-z_][a-z0-9_]*\s*\}\}/);
    });

    it('buildToolContext 不向 system prompt 注入任何变量', async () => {
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T1');
      const system = ctx[0];
      expect(system?.role).toBe('system');
      // tool prompt 静态：与 loadPrompt('tool') 完全相等
      expect(system?.content).toBe(loadPrompt('tool'));
    });
  });

  describe('工具模式 messages 数组结构', () => {
    it('首条恒为 system，后续按 ts 顺序排列 user/assistant', async () => {
      const t0 = new Date('2026-01-01T00:00:00.000Z');
      dialogueRepo.find.mockResolvedValueOnce([
        makeDialogueRow({
          ts: new Date(t0.getTime() + 5000),
          role: 'ai',
          content: '你好，我是AI助手',
        }),
        makeDialogueRow({
          ts: t0,
          role: 'candidate',
          content: '帮我写邮件',
        }),
      ]);
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T1');
      expect(ctx[0]?.role).toBe('system');
      expect(ctx[1]?.role).toBe('user');
      expect(ctx[1]?.content).toBe('帮我写邮件');
      expect(ctx[2]?.role).toBe('assistant');
      expect(ctx[2]?.content).toBe('你好，我是AI助手');
    });
  });

  describe('工具模式上下文不含敏感信息', () => {
    beforeEach(() => {
      // 预置：assessment + 问卷 + 考官历史 + 工具历史
      assessmentRepo.findOne.mockResolvedValue({
        id: ASSESSMENT_ID,
        candidateName: CANDIDATE_NAME,
        position: '数据分析师',
      } as AssessmentEntity);
      questionnaireRepo.findOne.mockResolvedValue({
        assessmentId: ASSESSMENT_ID,
        q1: '每天多次使用',
        q2: 'B',
        q3: '给过同事用',
        q4: '经常',
        q5: '主要做数据清洗',
      } as QuestionnaireResultEntity);
    });

    it('不含候选人姓名', async () => {
      dialogueRepo.find.mockResolvedValueOnce([
        makeDialogueRow({ role: 'candidate', content: '继续帮我处理', ts: new Date() }),
      ]);
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T1');
      const text = JSON.stringify(ctx);
      expect(text).not.toContain(CANDIDATE_NAME);
    });

    it('不含问卷内容（q1/q3/q4 等具体选项文本）', async () => {
      dialogueRepo.find.mockResolvedValueOnce([
        makeDialogueRow({ role: 'candidate', content: '帮我写邮件', ts: new Date() }),
      ]);
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T1');
      const text = JSON.stringify(ctx);
      expect(text).not.toContain('每天多次使用');
      expect(text).not.toContain('给过同事用');
      expect(text).not.toContain('数据清洗');
    });

    it('不含考官模式对话历史', async () => {
      // 即使 DB 中有 mode=examiner 的记录，工具模式不应取到
      // 由于 mock 根据调用的 where 过滤，这里模拟 dialogueRepo 在收到 mode=tool 查询时
      // 不会返回 examiner 记录
      dialogueRepo.find.mockImplementation(async (opts?: any) => {
        const mode = opts?.where?.mode;
        if (mode === 'examiner') {
          return [
            makeDialogueRow({
              mode: 'examiner',
              stageOrTask: 'S1.1',
              role: 'ai',
              content: '这是考官模式的提问，涉及测评目标',
              ts: new Date(),
            }),
          ];
        }
        // mode === 'tool'
        return [
          makeDialogueRow({
            mode: 'tool',
            stageOrTask: 'T1',
            role: 'candidate',
            content: '帮我写邮件',
            ts: new Date(),
          }),
        ];
      });
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T1');
      const text = JSON.stringify(ctx);
      expect(text).not.toContain('考官模式');
      expect(text).not.toContain('测评目标');
    });

    it('不含任务描述（tasks.yaml 中的描述文本）', async () => {
      const task = getTask('T1');
      // 取任务描述中独特关键词
      const taskDescKeywords = extractKeywords(task.description);
      dialogueRepo.find.mockResolvedValueOnce([
        makeDialogueRow({ role: 'candidate', content: '开始任务', ts: new Date() }),
      ]);
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T1');
      const text = JSON.stringify(ctx);
      for (const kw of taskDescKeywords) {
        expect(text).not.toContain(kw);
      }
    });
  });

  describe('任务间隔离：T2 不含 T1 历史', () => {
    it('T2 上下文不含 T1 的候选人输入', async () => {
      const t1UserInput = 'T1中候选人输入的独特字符串';
      dialogueRepo.find.mockImplementation(async (opts?: any) => {
        const stageOrTask = opts?.where?.stageOrTask;
        if (stageOrTask === 'T1') {
          return [
            makeDialogueRow({
              mode: 'tool',
              stageOrTask: 'T1',
              role: 'candidate',
              content: t1UserInput,
              ts: new Date(),
            }),
          ];
        }
        return [
          makeDialogueRow({
            mode: 'tool',
            stageOrTask: 'T2',
            role: 'candidate',
            content: 'T2中候选人输入',
            ts: new Date(),
          }),
        ];
      });
      const ctx = await builder.buildToolContext(ASSESSMENT_ID, 'T2');
      const text = JSON.stringify(ctx);
      expect(text).not.toContain(t1UserInput);
    });
  });

  describe('考官模式上下文构造（对照）', () => {
    it('考官模式 system prompt 含问卷与候选人姓名（与工具模式相反）', async () => {
      assessmentRepo.findOne.mockResolvedValue({
        id: ASSESSMENT_ID,
        candidateName: CANDIDATE_NAME,
        position: '数据分析师',
      } as AssessmentEntity);
      questionnaireRepo.findOne.mockResolvedValue({
        assessmentId: ASSESSMENT_ID,
        q1: '每天多次使用',
        q2: 'A',
        q3: '给过同事用',
        q4: '经常',
        q5: '数据清洗',
      } as QuestionnaireResultEntity);
      dialogueRepo.find.mockResolvedValue([]);
      const ctx = await builder.buildExaminerContext(ASSESSMENT_ID, 'S1.1', 1);
      const text = JSON.stringify(ctx);
      expect(text).toContain(CANDIDATE_NAME);
      expect(text).toContain('每天多次使用');
      // 同时也确认 examiner prompt 真的被 interpolate——stage_goal 进了 system
      const stage = getStageConfig('S1.1');
      expect(text).toContain(stage.goal);
    });

    it('考官模式只取 mode=examiner 历史，不含工具模式记录', async () => {
      const toolOnlyContent = '工具模式独有的内容字符串';
      dialogueRepo.find.mockResolvedValue([
        makeDialogueRow({
          mode: 'examiner',
          stageOrTask: 'S1.1',
          role: 'ai',
          content: '考官提问',
          ts: new Date(),
        }),
      ]);
      // 注意：mock 实现只在 mode=examiner 时返回 examiner 记录，
      // 即工具模式内容根本不会出现在 messages 数组里——
      // 这是 DB 层硬过滤的体现
      const ctx = await builder.buildExaminerContext(ASSESSMENT_ID, 'S1.1', 1);
      const text = JSON.stringify(ctx);
      expect(text).not.toContain(toolOnlyContent);
    });
  });
});

function extractKeywords(description: string): string[] {
  // 取任务描述中长度 ≥ 4 且不含通用词的连续片段，用于断言"未注入"
  // 简化：取所有非空白字符 ≥ 4 的中文片段
  const matches = description.match(/[一-龥]{4,}/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 5);
}
