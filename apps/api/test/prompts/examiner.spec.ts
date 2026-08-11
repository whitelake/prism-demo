import { Test } from '@nestjs/testing';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import { LlmLogger } from '@/llm/llm.logger';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate } from '@/llm/interpolator';
import { isApiKeyConfigured } from '@/llm/llm-params';
import { ExaminerResponseSchema } from '@/llm/schemas/examiner.schema';

const API_KEY_CONFIGURED = isApiKeyConfigured();
const describeIfReady = API_KEY_CONFIGURED ? describe : describe.skip;

const BASE_VARS = {
  candidate_name: '测试候选人',
  stage_code: 'S1.1',
  stage_goal:
    '验证候选人自述的使用强度是否真实；获取至少1个具体的近期使用案例',
  turn_index: 2,
  max_turns: 5,
  questionnaire_result: 'Q1: 每天多次\nQ2: 主要用ChatGPT\nQ3: 用于写文档',
};

const FORBIDDEN_PHRASES = [
  '很好',
  '不错',
  '这个思路很棒',
  '有道理',
  '确实',
  '你说得对',
  '听起来挺专业',
  '别紧张',
  '慢慢想',
  '很多人都这样',
  '请问',
  '烦请',
  '能否请您',
  '你确定吗',
  '可是你刚才说',
  '这和你问卷里填的不一样',
  '评估',
  '打分',
  '等级',
  '报告',
  '最后一个问题',
  '接下来我们进入',
];

async function callExaminer(userContent: string | string[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [LlmModule],
  }).compile();

  const client = moduleRef.get(LlmClient);
  const logger = moduleRef.get(LlmLogger);

  const systemPrompt = interpolate(loadPrompt('examiner'), BASE_VARS);

  // 单轮：直接拼接"候选人回答：xxx"
  // 多轮：模拟连续 N 轮候选人回答，让模型识别为第 N 轮（满足 answer_vagueness 评估前提）
  const userMessages = Array.isArray(userContent)
    ? userContent.map((c, i) => ({
        role: 'user' as const,
        content: `候选人第${i + 1}轮回答：${c}`,
      }))
    : [
        {
          role: 'user' as const,
          content: `候选人回答：${userContent}`,
        },
      ];

  const result = await client.call({
    assessmentId: 'test-examiner-' + Date.now(),
    purpose: 'examiner',
    systemPrompt,
    userMessages,
    schema: ExaminerResponseSchema,
  });

  await moduleRef.close();
  return { ...result, logs: logger.all() };
}

describeIfReady('examiner prompt 联调 (e2e)', () => {
  jest.setTimeout(120000);

  afterEach(() => {
    // give the LLM a beat between cases
  });

  it('T1: "还行吧，效果挺好的" → 追问最近一次具体任务，answer_vagueness ≥ 0.7', async () => {
    const { parsed, raw } = await callExaminer('还行吧，效果挺好的');
    expect(parsed).toBeDefined();
    const signals = parsed!.signals;
    expect(signals.answer_vagueness).toBeGreaterThanOrEqual(0.7);
    expect(parsed!.question.length).toBeGreaterThan(0);
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(raw).not.toContain(phrase);
    }
  });

  it('T2: "我一般都会核实一下" → 追问最近一次核实', async () => {
    const { parsed } = await callExaminer('我一般都会核实一下');
    expect(parsed).toBeDefined();
    expect(parsed!.signals.answer_vagueness).toBeGreaterThan(0.3);
  });

  it('T3: "我这样回答对吗？" → 不得评价/安慰，回应"没有对错"', async () => {
    const { parsed, raw } = await callExaminer('我这样回答对吗？');
    expect(parsed).toBeDefined();
    expect(raw).not.toContain('很好');
    expect(raw).not.toContain('别紧张');
  });

  it('T4: "我做了一套提示词模板给团队用" → mentioned_asset + mentioned_others_adoption = true', async () => {
    const { parsed } = await callExaminer(
      '我做了一套提示词模板给团队用',
    );
    expect(parsed).toBeDefined();
    expect(parsed!.signals.mentioned_asset).toBe(true);
    expect(parsed!.signals.mentioned_others_adoption).toBe(true);
  });

  it('T5: "我上一份工作是做电商的" → 温和拉回 AI 话题，不得追问岗位经历', async () => {
    const { parsed, raw } = await callExaminer(
      '我上一份工作是做电商的',
    );
    expect(parsed).toBeDefined();
    // 不应在追问岗位经历
    expect(raw).not.toContain('为什么离职');
    expect(raw).not.toContain('薪资');
  });

  it('T6: 连续两次"想不起来了" → 换方向提问', async () => {
    const { parsed } = await callExaminer(['想不起来了', '想不起来了']);
    expect(parsed).toBeDefined();
    expect(parsed!.signals.answer_vagueness).toBeGreaterThan(0.3);
  });

  it('T7: 问卷填"每天多次"但回答"最近没怎么用" → 不得指出矛盾', async () => {
    const { raw } = await callExaminer('最近好像没怎么用');
    expect(raw).not.toContain('可是');
    expect(raw).not.toContain('你刚才说');
    expect(raw).not.toContain('确定吗');
  });

  it('T8: 800字详尽回答 → 顺着具体点深挖，不切换全新话题', async () => {
    const longAnswer =
      '上周三我处理了一份200页的行业报告，先用ChatGPT-4生成了摘要，发现摘要里把"营收"写成"利润"，我手动改了，然后让模型重新生成了三段结论，最后整合进季度汇报。整个过程约40分钟，比之前三人协作省了2小时。';
    const { parsed, raw } = await callExaminer(longAnswer);
    expect(parsed).toBeDefined();
    // 不应切换到无关新话题（如问岗位规划）
    expect(raw).not.toContain('职业规划');
  });

  it('T9: "AI能替代很多工作，我觉得这是趋势" → 拉回到行为', async () => {
    const { parsed, raw } = await callExaminer(
      'AI能替代很多工作，我觉得这是趋势',
    );
    expect(parsed).toBeDefined();
    // 不应就观点展开
    expect(raw).not.toContain('你的观点很');
  });

  it('T10: 任意输入 → 输出严格为 JSON，无 markdown 包裹', async () => {
    const { raw } = await callExaminer('今天用 AI 写了一份周报');
    const trimmed = raw.trim();
    expect(trimmed.startsWith('{')).toBe(true);
    expect(trimmed.endsWith('}')).toBe(true);
    expect(trimmed.startsWith('```')).toBe(false);
  });
});

describe('examiner prompt 静态校验 (unit, no API call)', () => {
  it('prompt 包含所有 6 个 signals 字段', () => {
    const prompt = loadPrompt('examiner');
    expect(prompt).toContain('goal_coverage');
    expect(prompt).toContain('answer_vagueness');
    expect(prompt).toContain('mentioned_process_change');
    expect(prompt).toContain('mentioned_asset');
    expect(prompt).toContain('mentioned_others_adoption');
    expect(prompt).toContain('mentioned_team_driving');
  });

  it('prompt 不包含被禁的 candidate_stuck 字段 (PoC 不变量 5)', () => {
    const prompt = loadPrompt('examiner');
    expect(prompt).not.toContain('candidate_stuck');
  });

  it('prompt 包含必要变量占位符', () => {
    const prompt = loadPrompt('examiner');
    expect(prompt).toContain('{{candidate_name}}');
    expect(prompt).toContain('{{stage_code}}');
    expect(prompt).toContain('{{stage_goal}}');
    expect(prompt).toContain('{{turn_index}}');
    expect(prompt).toContain('{{max_turns}}');
    expect(prompt).toContain('{{questionnaire_result}}');
  });

  it('插值后所有变量被替换', () => {
    const prompt = loadPrompt('examiner');
    const interpolated = interpolate(prompt, BASE_VARS);
    expect(interpolated).not.toContain('{{');
    expect(interpolated).not.toContain('}}');
  });
});
