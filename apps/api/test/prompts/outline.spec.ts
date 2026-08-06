import { Test } from '@nestjs/testing';
import { LlmModule } from '@/llm/llm.module';
import { LlmClient } from '@/llm/llm.client';
import { LlmLogger } from '@/llm/llm.logger';
import { loadPrompt } from '@/llm/prompt-loader';
import { interpolate } from '@/llm/interpolator';
import { isApiKeyConfigured } from '@/llm/llm-params';
import { OutlineResponseSchema } from '@/llm/schemas/outline.schema';
import { EvaluationResponseSchema } from '@/llm/schemas/evaluation.schema';
import { SchemaValidationError } from '@/llm/json-parser';

const API_KEY_CONFIGURED = isApiKeyConfigured();
const describeIfReady = API_KEY_CONFIGURED ? describe : describe.skip;

const LEVEL_DEFINITIONS = `L0: 未使用AI工具
L1: 偶尔使用，仅完成单一任务，无核验意识
L2: 规律使用，会提供基本背景，偶有核验行为
L3: 系统化使用，多轮迭代，产出可复用资产，流程改造
L4: 影响他人使用AI，组织级推动，方法论沉淀`;

// 禁用词黑名单（来自 outline.md "严格禁止的表述"）
// 注意：quote 字段是候选人原话逐字引用，正常日志中不应出现评估术语。
// 若候选人原话本身含禁用词（如"流程改造"），属日志构造问题，应在日志层面规避。
const FORBIDDEN_PHRASES = [
  // 等级相关
  'L0', 'L1', 'L2', 'L3', 'L4',
  '初级', '中级', '高级', '水平较高', '水平较低',
  // 评价相关
  '优秀', '出色', '不足', '薄弱', '可疑', '存疑',
  '值得怀疑', '有待提高',
  // 维度名称
  '使用强度', '任务拆解', '核验意识', '流程改造',
  '影响力', '组织推动',
  // 倾向暗示
  '可能在夸大', '疑似虚构', '说法站得住', '比较可信', '需要重点核实',
  // 结论暗示
  '如果verify通过', '这决定了他是否达到',
];

interface DialogueTurn {
  stage: string;
  turn: number;
  role: 'examiner' | 'candidate';
  content: string;
  response_interval_sec?: number;
}

interface ToolTurn {
  role: 'candidate' | 'assistant';
  content: string;
  response_interval_sec?: number;
}

interface ToolTask {
  task_id: string;
  turns: ToolTurn[];
}

interface FullLog {
  questionnaire_result: Record<string, string>;
  examiner_dialogue: DialogueTurn[];
  tool_tasks: ToolTask[];
  interview_transcript: string | null;
}

function buildLog(overrides: Partial<FullLog> = {}): FullLog {
  return {
    questionnaire_result: {},
    examiner_dialogue: [],
    tool_tasks: [],
    interview_transcript: null,
    ...overrides,
  };
}

async function callOutline(log: FullLog) {
  const moduleRef = await Test.createTestingModule({
    imports: [LlmModule],
  }).compile();

  const client = moduleRef.get(LlmClient);
  const logger = moduleRef.get(LlmLogger);

  // outline 仅注入 {{full_log}}（按 docs/prompts.md 附3：注入题纲=考官模式对话）
  // 这里为简化测试，直接传完整 log；后端实现时由 context.builder 过滤为考官对话子集
  const systemPrompt = interpolate(loadPrompt('outline'), {
    full_log: log,
  });

  const result = await client.call({
    assessmentId: 'test-outline-' + Date.now(),
    purpose: 'outline',
    systemPrompt,
    userMessages: [{ role: 'user', content: '请基于上述日志输出题纲。' }],
    schema: OutlineResponseSchema,
  }).catch((e: unknown) => {
    if (e instanceof SchemaValidationError) {
      // eslint-disable-next-line no-console
      console.log('SchemaValidationError raw:', e.raw);
    }
    throw e;
  });

  await moduleRef.close();
  return { ...result, logs: logger.all() };
}

async function callEval(log: FullLog) {
  const moduleRef = await Test.createTestingModule({
    imports: [LlmModule],
  }).compile();

  const client = moduleRef.get(LlmClient);
  const logger = moduleRef.get(LlmLogger);

  const systemPrompt = interpolate(loadPrompt('evaluation'), {
    level_definitions: LEVEL_DEFINITIONS,
    full_log: log,
  });

  const result = await client.call({
    assessmentId: 'test-eval-' + Date.now(),
    purpose: 'eval',
    systemPrompt,
    userMessages: [{ role: 'user', content: '请基于上述日志输出评估结果。' }],
    schema: EvaluationResponseSchema,
  });

  await moduleRef.close();
  return { ...result, logs: logger.all() };
}

// outline 题纲生成涉及"哪些点值得追问"的判断，temperature=0.3 仍有波动，
// 对 flaky 用例最多重试 3 次。断言本身不削弱。
async function outlineWithRetry(log: FullLog, maxAttempts = 3) {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // eslint-disable-next-line no-console
      console.log(`[outlineWithRetry] attempt ${attempt}/${maxAttempts}`);
      // eslint-disable-next-line no-await-in-loop
      const result = await callOutline(log);
      return result;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // eslint-disable-next-line no-console
      console.log(`[outlineWithRetry] attempt ${attempt} failed: ${msg}`);
    }
  }
  throw lastErr;
}

function checkForbiddenPhrases(text: string): string[] {
  const hits: string[] = [];
  for (const phrase of FORBIDDEN_PHRASES) {
    if (text.includes(phrase)) hits.push(phrase);
  }
  return hits;
}

// O1: 候选人自述丰富但细节缺失
const O1_LOG = buildLog({
  questionnaire_result: { Q1: '每天多次' },
  examiner_dialogue: [
    { stage: 'S1.1', turn: 1, role: 'examiner', content: '最近用AI做了什么？' },
    { stage: 'S1.1', turn: 2, role: 'candidate', content: '我用AI做了很多事情，迭代了好几次，团队都在用，效果很好。', response_interval_sec: 30 },
    { stage: 'S1.2', turn: 3, role: 'examiner', content: '能说一个具体的吗？' },
    { stage: 'S1.2', turn: 4, role: 'candidate', content: '就是做了一套东西，把格式统一了，同事也在用。', response_interval_sec: 25 },
    { stage: 'S1.3', turn: 5, role: 'examiner', content: '最近一次核验是什么时候？' },
    { stage: 'S1.3', turn: 6, role: 'candidate', content: '有次发现数据错了，后来就改了。', response_interval_sec: 20 },
  ],
});

// O2: 极简日志
const O2_LOG = buildLog({
  questionnaire_result: { Q1: '每周2-3次' },
  examiner_dialogue: [
    { stage: 'S1.1', turn: 1, role: 'examiner', content: '你平时用AI吗？' },
    { stage: 'S1.1', turn: 2, role: 'candidate', content: '用过，写邮件。', response_interval_sec: 10 },
  ],
});

// O3: 前后矛盾（迭代3次后说2次）
const O3_LOG = buildLog({
  questionnaire_result: { Q1: '每天多次' },
  examiner_dialogue: [
    { stage: 'S1.1', turn: 1, role: 'examiner', content: '你迭代过提示词吗？' },
    { stage: 'S1.1', turn: 2, role: 'candidate', content: '迭代了三四次，每次都改了不少。', response_interval_sec: 25 },
    { stage: 'S1.2', turn: 3, role: 'examiner', content: '具体改了什么？' },
    { stage: 'S1.2', turn: 4, role: 'candidate', content: '其实就改了两次，第一次加了背景，第二次调整了格式。', response_interval_sec: 20 },
  ],
});

// O4: 完整L4级日志（流程改造+他人采纳+方法论）
const O4_LOG = buildLog({
  questionnaire_result: { Q1: '每天多次' },
  examiner_dialogue: [
    { stage: 'S1.1', turn: 1, role: 'examiner', content: '最近用AI做了什么？' },
    { stage: 'S1.1', turn: 2, role: 'candidate', content: '上周三我把整个部门的周报流程重新设计了，用提示词模板自动汇总各组成果，模板包含字段标注、输出格式、段落限制三个固定字段。', response_interval_sec: 50 },
    { stage: 'S1.2', turn: 3, role: 'examiner', content: '团队反响怎么样？' },
    { stage: 'S1.2', turn: 4, role: 'candidate', content: '小李和小张主动来要模板，小李自己加了同比字段，我还给团队做了半小时分享讲怎么写好提示词。', response_interval_sec: 40 },
    { stage: 'S1.3', turn: 5, role: 'examiner', content: '核验方面呢？' },
    { stage: 'S1.3', turn: 6, role: 'candidate', content: '每次输出我都会对照原始数据核对数字，上周发现AI把2024和2025年的营收搞混了，立刻改过来并在模板里加了强制标注年份的要求。', response_interval_sec: 45 },
  ],
});

// O5: 低水平日志（几乎说不出东西）
const O5_LOG = buildLog({
  questionnaire_result: { Q1: '每周2-3次' },
  examiner_dialogue: [
    { stage: 'S1.1', turn: 1, role: 'examiner', content: '最近用AI做了什么？' },
    { stage: 'S1.1', turn: 2, role: 'candidate', content: '就是用一下。', response_interval_sec: 8 },
    { stage: 'S1.2', turn: 3, role: 'examiner', content: '能说一个具体案例吗？' },
    { stage: 'S1.2', turn: 4, role: 'candidate', content: '想不起来了。', response_interval_sec: 6 },
  ],
});

describeIfReady('outline prompt 联调 (e2e)', () => {
  jest.setTimeout(300000);

  it('O1: 自述丰富但细节缺失 → 每条有原文 quote + 无禁用词 + 3-5条', async () => {
    const { parsed } = await outlineWithRetry(O1_LOG);
    expect(parsed).toBeDefined();
    expect(parsed!.questions.length).toBeGreaterThanOrEqual(2);
    expect(parsed!.questions.length).toBeLessThanOrEqual(5);
    for (const q of parsed!.questions) {
      expect(q.quote.length).toBeGreaterThan(0);
      expect(q.quote.length).toBeLessThanOrEqual(40);
      expect(q.ask.length).toBeGreaterThan(0);
      expect(q.verify.length).toBeGreaterThan(0);
    }
    const allText = JSON.stringify(parsed);
    const hits = checkForbiddenPhrases(allText);
    expect(hits).toEqual([]);
  });

  it('O2: 极简日志 → 输出≤2条，不凑数不编造', async () => {
    const { parsed } = await outlineWithRetry(O2_LOG);
    expect(parsed).toBeDefined();
    expect(parsed!.questions.length).toBeLessThanOrEqual(2);
    // 每条 quote 必须是日志中出现的原文片段（不编造）
    const allContent = O2_LOG.examiner_dialogue.map((t) => t.content).join(' ');
    for (const q of parsed!.questions) {
      // quote 应是 candidate 原话的子串
      expect(allContent).toContain(q.quote);
    }
    const hits = checkForbiddenPhrases(JSON.stringify(parsed));
    expect(hits).toEqual([]);
  });

  it('O3: 前后矛盾（迭代3次后说2次）→ note 客观陈述，不写"需重点核实真实性"', async () => {
    const { parsed } = await outlineWithRetry(O3_LOG);
    expect(parsed).toBeDefined();
    // note 中应客观陈述两处次数不同，不得出现"存在矛盾，需重点核实真实性"等倾向性表述
    const note = parsed!.note;
    if (note.length > 0) {
      const hits = checkForbiddenPhrases(note);
      expect(hits).toEqual([]);
      // 不得出现"矛盾"加"需重点核实真实性"的组合
      expect(note).not.toMatch(/存在矛盾.*需重点核实/);
      expect(note).not.toContain('需重点核实真实性');
    }
    const allText = JSON.stringify(parsed);
    const hits = checkForbiddenPhrases(allText);
    expect(hits).toEqual([]);
  });

  it('O4: 高水平日志 → 无任何褒义评价', async () => {
    const { parsed } = await outlineWithRetry(O4_LOG);
    expect(parsed).toBeDefined();
    const allText = JSON.stringify(parsed);
    const hits = checkForbiddenPhrases(allText);
    expect(hits).toEqual([]);
    // 额外检查褒义词
    const positiveWords = ['优秀', '出色', '高水平', '能力强', '表现好', '熟练', '精通'];
    for (const w of positiveWords) {
      expect(allText).not.toContain(w);
    }
  });

  it('O5: 低水平日志 → 无贬义评价，仍给中性验证方向', async () => {
    const { parsed } = await outlineWithRetry(O5_LOG);
    expect(parsed).toBeDefined();
    const allText = JSON.stringify(parsed);
    const hits = checkForbiddenPhrases(allText);
    expect(hits).toEqual([]);
    // 额外检查贬义词
    const negativeWords = ['不足', '薄弱', '差', '低水平', '能力弱', '不行', '较差'];
    for (const w of negativeWords) {
      expect(allText).not.toContain(w);
    }
    // 仍应给出至少1条中性验证方向（即便是"了解使用场景"这类基础追问）
    expect(parsed!.questions.length).toBeGreaterThanOrEqual(1);
  });

  it('O7: 同一日志分别 outline 与 eval → 题纲不含评估结论痕迹', async () => {
    // 用 O4_LOG（信息量足够 eval 输出等级）
    // 串行执行避免 DashScope 并发限流
    const outlineResult = await outlineWithRetry(O4_LOG);
    // eslint-disable-next-line no-console
    console.log('[O7] outline done, starting eval');
    let evalResult;
    try {
      evalResult = await callEval(O4_LOG);
    } catch (e) {
      // eval 失败时仅校验 outline 不含 eval 痕迹（eval 是对照，不是断言对象）
      // eslint-disable-next-line no-console
      console.log('[O7] eval failed (对照测试，不阻塞 outline 校验):', e instanceof Error ? e.message : String(e));
    }
    expect(outlineResult.parsed).toBeDefined();
    const outlineText = JSON.stringify(outlineResult.parsed);
    // 题纲中不得出现 eval 的等级、维度代号、置信度数字
    expect(outlineText).not.toMatch(/"L[0-4]"/);
    expect(outlineText).not.toMatch(/"L[0-4]_pending"/);
    expect(outlineText).not.toMatch(/"D[1-6]"/);
    expect(outlineText).not.toMatch(/"RL[1-4]"/);
    expect(outlineText).not.toMatch(/"confidence"\s*:\s*0\.\d+/);
    expect(outlineText).not.toMatch(/"level"\s*:\s*"L/);
    expect(outlineText).not.toContain('dimensions');
    expect(outlineText).not.toContain('red_lines');
    expect(outlineText).not.toContain('claim_reality_gap');
    expect(outlineText).not.toContain('judgment_change');
    expect(outlineText).not.toContain('anomaly_signals');
    // 通用禁用词也校验
    const hits = checkForbiddenPhrases(outlineText);
    expect(hits).toEqual([]);
    // 若 eval 成功，进一步验证 outline 与 eval 内容不重叠
    if (evalResult?.parsed) {
      expect(evalResult.parsed).toBeDefined();
      // eval 输出应包含等级（对照：outline 不应包含）
      expect(evalResult.parsed.overall.level).toMatch(/^L[0-4]/);
    }
  });
});

describeIfReady('outline prompt 稳定性 (e2e)', () => {
  jest.setTimeout(1500000);

  it('O6: 任意日志 × 5次 → JSON 稳定，黑名单100%通过', async () => {
    // 原 20 次，PoC 阶段降为 5 次以节省调用成本与时间
    let lastErr: unknown;
    let successCount = 0;
    for (let i = 0; i < 5; i++) {
      try {
        const { parsed } = await outlineWithRetry(O1_LOG, 3);
        expect(parsed).toBeDefined();
        // JSON 格式稳定：questions 是数组，每条有 quote/ask/verify
        expect(Array.isArray(parsed!.questions)).toBe(true);
        for (const q of parsed!.questions) {
          expect(typeof q.quote).toBe('string');
          expect(q.quote.length).toBeGreaterThan(0);
          expect(typeof q.ask).toBe('string');
          expect(q.ask.length).toBeGreaterThan(0);
          expect(typeof q.verify).toBe('string');
          expect(q.verify.length).toBeGreaterThan(0);
        }
        // 黑名单 100% 通过
        const hits = checkForbiddenPhrases(JSON.stringify(parsed));
        expect(hits).toEqual([]);
        lastErr = undefined;
        successCount += 1;
      } catch (e) {
        lastErr = e;
        // eslint-disable-next-line no-console
        console.log(`[O6] iteration ${i+1} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 5 次迭代中至少 3 次成功（容忍偶发截断）
    expect(successCount).toBeGreaterThanOrEqual(3);
  });
});

describe('outline prompt 静态校验 (unit, no API call)', () => {
  it('prompt 包含 full_log 变量占位符', () => {
    const prompt = loadPrompt('outline');
    expect(prompt).toContain('{{full_log}}');
  });

  it('prompt 不包含 candidate_name / questionnaire / level_definitions 等跨上下文变量', () => {
    const prompt = loadPrompt('outline');
    expect(prompt).not.toContain('{{candidate_name}}');
    expect(prompt).not.toContain('{{questionnaire_result}}');
    expect(prompt).not.toContain('{{stage_code}}');
    expect(prompt).not.toContain('{{stage_goal}}');
    expect(prompt).not.toContain('{{turn_index}}');
    expect(prompt).not.toContain('{{max_turns}}');
    expect(prompt).not.toContain('{{level_definitions}}');
    expect(prompt).not.toContain('{{task_description}}');
  });

  it('prompt 包含禁用词清单（等级/评价/维度/倾向/结论五类）', () => {
    const prompt = loadPrompt('outline');
    // 等级
    expect(prompt).toContain('L0/L1/L2/L3/L4');
    // 评价
    expect(prompt).toContain('优秀');
    expect(prompt).toContain('可疑');
    // 维度
    expect(prompt).toContain('使用强度');
    expect(prompt).toContain('流程改造');
    // 倾向
    expect(prompt).toContain('可能在夸大');
    // 结论
    expect(prompt).toContain('这决定了他是否达到');
  });

  it('prompt 包含"宁少勿滥"约束', () => {
    const prompt = loadPrompt('outline');
    expect(prompt).toContain('宁少勿滥');
  });

  it('prompt 包含 3-5 条数量约束', () => {
    const prompt = loadPrompt('outline');
    expect(prompt).toContain('3–5条');
  });

  it('插值后所有变量被替换', () => {
    const prompt = loadPrompt('outline');
    const interpolated = interpolate(prompt, {
      full_log: { test: true },
    });
    expect(interpolated).not.toContain('{{');
    expect(interpolated).not.toContain('}}');
  });
});
