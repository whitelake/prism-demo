import { Test } from '@nestjs/testing';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import { LlmLogger } from '@/llm/llm.logger';
import { loadPrompt } from '@/llm/prompt-loader';
import { assertNoVariables } from '@/llm/interpolator';
import { isApiKeyConfigured } from '@/llm/llm-params';

const API_KEY_CONFIGURED = isApiKeyConfigured();
const describeIfReady = API_KEY_CONFIGURED ? describe : describe.skip;

const FORBIDDEN_PHRASES = [
  '测评',
  '考察',
  '评估',
  '面试',
  '打分',
  '练习',
  '题目',
  '为了更好地帮助你',
  '建议你提供',
  '如果你能说明',
  '补充以下信息',
  '这是个很好的需求',
  '你的描述很清晰',
  '你的要求有些笼统',
  '建议你根据实际情况',
  '发送前请再确认',
  '你可以进一步',
  '希望对您有帮助',
  '以下是为您准备的',
];

async function callTool(userMessages: { role: 'user' | 'assistant'; content: string }[]) {
  const moduleRef = await Test.createTestingModule({
    imports: [LlmModule],
  }).compile();

  const client = moduleRef.get(LlmClient);
  const logger = moduleRef.get(LlmLogger);

  const systemPrompt = loadPrompt('tool');

  // PoC 不变量 1：工具模式 System Prompt 必须静态，不插值
  assertNoVariables(systemPrompt);

  // 工具模式上下文隔离：userMessages 只含当前任务内的对话，不注入问卷/考官历史
  const result = await client.call({
    assessmentId: 'test-tool-' + Date.now(),
    purpose: 'tool',
    systemPrompt,
    userMessages,
    // 工具模式输出自然语言，不强制 JSON，不传 schema
  });

  await moduleRef.close();
  return { ...result, logs: logger.all() };
}

describeIfReady('tool prompt 联调 (e2e)', () => {
  jest.setTimeout(120000);

  it('U1: "帮我写封催货的邮件" → 直接输出完整邮件，无反问/补充提示/多版本', async () => {
    const { raw } = await callTool([{ role: 'user', content: '帮我写封催货的邮件' }]);
    // 应该有邮件正文结构（含主题/称呼/正文/落款之一）
    expect(raw.length).toBeGreaterThan(50);
    for (const phrase of FORBIDDEN_PHRASES) {
      expect(raw).not.toContain(phrase);
    }
    // 不应出现反问
    expect(raw).not.toMatch(/请问|请告知|你希望|能否|是否/);
    // 只有一个版本，不应出现"版本二""备选"
    expect(raw).not.toMatch(/版本[二三四]|备选[一二三]/);
  });

  it('U2: "帮我写封催货的邮件，语气强硬点" → 结尾无"发送前请确认"类提醒', async () => {
    const { raw } = await callTool([
      { role: 'user', content: '帮我写封催货的邮件，语气强硬点' },
    ]);
    expect(raw.length).toBeGreaterThan(50);
    expect(raw).not.toContain('发送前请再确认');
    expect(raw).not.toContain('建议你根据实际情况');
    expect(raw).not.toContain('希望对您有帮助');
  });

  it('U3: "改一下" → 直接输出改后版本，不问"改哪里"', async () => {
    const { raw } = await callTool([
      { role: 'user', content: '帮我写一封会议邀请邮件' },
      { role: 'assistant', content: '尊敬的各位：兹定于下周三召开项目评审会，敬请参加。' },
      { role: 'user', content: '改一下' },
    ]);
    // 应直接输出新版本，不应反问"改哪里"
    expect(raw).not.toContain('请问');
    expect(raw).not.toContain('你指的');
    expect(raw).not.toContain('改哪里');
    expect(raw.length).toBeGreaterThan(20);
  });

  it('U4: "你觉得我这个要求写得清楚吗？" → 回应"我只是一个AI助手"', async () => {
    const { raw } = await callTool([
      { role: 'user', content: '你觉得我这个要求写得清楚吗？' },
    ]);
    expect(raw).toContain('我只是一个AI助手');
    // 不应展开评价
    expect(raw).not.toContain('你的要求');
    expect(raw).not.toContain('写得');
    expect(raw).not.toContain('清楚');
  });

  it('U5: "这是不是在测试我？" → 不承认/否认/展开', async () => {
    const { raw } = await callTool([
      { role: 'user', content: '这是不是在测试我？' },
    ]);
    expect(raw).toContain('我只是一个AI助手');
    expect(raw).not.toContain('测试');
    expect(raw).not.toContain('考察');
    expect(raw).not.toContain('测评');
  });

  it('U6: "应该怎么写提示词才能得到更好结果？" → 不得给提示词教学', async () => {
    const { raw } = await callTool([
      { role: 'user', content: '我应该怎么写提示词才能得到更好的结果？' },
    ]);
    // 不应给出"提示词写作技巧清单"式教学（如列出 1.明确目标 2.提供背景 等）
    expect(raw).not.toMatch(/提示词的?技巧是|提示词的?原则是|写好提示词要|提示词写作的?[一几]个/);
    expect(raw).not.toContain('建议你提供');
    expect(raw).not.toContain('如果你能说明');
  });

  it('U7: 600字详细提示词 → 正常完成，不夸奖提示词写得好', async () => {
    const longPrompt = '请帮我写一份季度业务复盘报告，要求：\n' +
      '1. 涵盖Q3（7-9月）三个核心业务线的进展\n' +
      '2. 包含关键指标对比（同比、环比）\n' +
      '3. 列出三个最大挑战及应对措施\n' +
      '4. Q4 重点计划，至少4项\n' +
      '5. 语言简洁专业，不超过800字\n' +
      '6. 末尾附一页执行摘要\n' +
      '7. 使用markdown格式，含标题层级';
    const { raw } = await callTool([{ role: 'user', content: longPrompt }]);
    expect(raw.length).toBeGreaterThan(100);
    expect(raw).not.toContain('你的信息很完整');
    expect(raw).not.toContain('这是个很好的需求');
    expect(raw).not.toContain('你的描述很清晰');
  });

  it('U8: "我是XX公司的运营" → 正常完成，不追问公司/岗位细节', async () => {
    const { raw } = await callTool([
      { role: 'user', content: '我是某互联网公司的运营，负责用户增长，帮我写一份周报模板' },
    ]);
    expect(raw.length).toBeGreaterThan(50);
    // 不应追问公司或岗位信息
    expect(raw).not.toMatch(/请问.*公司|你.*公司是|你的岗位|你的角色/);
  });

  it('U9: 连续5轮修改要求 → 每轮直接输出完整新版本，不总结"已经改了5版"', async () => {
    const turns = [
      { role: 'user' as const, content: '帮我写一段产品介绍' },
      { role: 'assistant' as const, content: '我们的产品X是一款智能工具，帮助团队高效协作。' },
      { role: 'user' as const, content: '更简短' },
      { role: 'assistant' as const, content: '产品X：让团队协作更高效。' },
      { role: 'user' as const, content: '加一句客户案例' },
      { role: 'assistant' as const, content: '产品X：让团队协作更高效。某客户使用后效率提升40%。' },
      { role: 'user' as const, content: '案例改成金融行业' },
      { role: 'assistant' as const, content: '产品X：让团队协作更高效。某银行使用后效率提升40%。' },
      { role: 'user' as const, content: '再正式一点' },
    ];
    const { raw } = await callTool(turns);
    expect(raw.length).toBeGreaterThan(10);
    // 不应表现出不耐烦或总结改了几版
    expect(raw).not.toMatch(/已经改了|改了.*版|第.*版|我们已经/);
  });

  it('U10: 空输入或"？" → 简短回应"你需要我帮你做什么？"（唯一允许的反问）', async () => {
    const { raw } = await callTool([{ role: 'user', content: '？' }]);
    // U10 是 prompt 明确允许的唯一反问情形：模型应简短反问需要做什么
    expect(raw).toMatch(/你需要|您需要|告诉我.*帮助|需要什么帮助|帮你做什么|帮你做什么/);
    // 必须简短
    expect(raw.length).toBeLessThan(100);
    // 仍然不得提及测评类概念
    for (const phrase of ['测评', '考察', '评估', '面试', '打分', '题目']) {
      expect(raw).not.toContain(phrase);
    }
  });
});

describe('tool prompt 静态校验 (unit, no API call)', () => {
  it('prompt 必须为纯静态，不含 {{...}} 占位符 (PoC 不变量 1)', () => {
    const prompt = loadPrompt('tool');
    expect(() => assertNoVariables(prompt)).not.toThrow();
  });

  it('prompt 不包含 candidate_name / questionnaire / stage_goal 等跨上下文变量', () => {
    const prompt = loadPrompt('tool');
    expect(prompt).not.toContain('candidate_name');
    expect(prompt).not.toContain('questionnaire');
    expect(prompt).not.toContain('stage_goal');
    expect(prompt).not.toContain('stage_code');
    expect(prompt).not.toContain('full_log');
    expect(prompt).not.toContain('level_definitions');
    expect(prompt).not.toContain('task_description');
  });

  it('prompt 包含"不得提及测评/考察/评估/面试"约束', () => {
    const prompt = loadPrompt('tool');
    expect(prompt).toContain('测评');
    expect(prompt).toContain('考察');
    expect(prompt).toContain('评估');
    expect(prompt).toContain('面试');
  });

  it('prompt 包含"不反问"的核心约束', () => {
    const prompt = loadPrompt('tool');
    expect(prompt).toContain('不要反问');
    expect(prompt).toContain('不要把问题抛回给用户');
  });
});
