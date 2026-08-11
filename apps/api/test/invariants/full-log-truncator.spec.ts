import {
  truncateFullLog,
  TRUNCATE_THRESHOLD,
  TRUNCATE_SUFFIX,
  type FullLog,
} from '@/assessment/full-log-truncator';
import { estimateTokens, estimateMessagesTokens } from '@/llm/token-estimator';

// R3（architecture.md 第10章）截断策略不变量
// 优先级1：工具模式 AI 回复（assistant 角色）→ 保留前500字 + "...(已截断)"
// 优先级2：考官模式 AI 提问 → 保留全文（不动）
// 优先级3：候选人输入 + 面试记录 → 绝不截断

function makeFullLog(overrides: Partial<FullLog> = {}): FullLog {
  return {
    candidate: { name: '候选人', position: 'TEST' },
    questionnaire: { Q1: 'A', Q2: ['B'], Q3: 'C', Q4: 'D', Q5: 'E' },
    examiner_dialogue: [
      {
        stage: 'S1.1',
        turn: 1,
        role: 'examiner',
        content: '请描述一次具体的AI使用场景',
        ts: '2026-08-06T00:00:00.000Z',
      },
      {
        stage: 'S1.1',
        turn: 1,
        role: 'candidate',
        content: '上周我用AI写了催收邮件',
        ts: '2026-08-06T00:00:01.000Z',
      },
    ],
    stage_reached: ['S1.1'],
    tool_tasks: [],
    interview_transcript: '面试官：你说做了一套模板…\n候选人：对，是一个Excel模板…',
    ...overrides,
  };
}

describe('R3 截断策略 (architecture.md 第10章)', () => {
  describe('truncateFullLog 优先级1：工具模式 AI 回复', () => {
    it('assistant 回复 ≤ 500 字 → 不截断，返回原对象引用', () => {
      const log = makeFullLog({
        tool_tasks: [
          {
            task_id: 'T1',
            turns: [
              { turn: 1, role: 'candidate', content: '帮我写邮件', ts: '2026-08-06T00:00:00.000Z' },
              { turn: 2, role: 'assistant', content: 'a'.repeat(500), ts: '2026-08-06T00:00:01.000Z' },
            ],
            total_turns: 2,
            duration_sec: null,
            ended_by: null,
          },
        ],
      });
      const result = truncateFullLog(log);
      // 未触发截断 → 返回原引用（调用方依此判断是否需重试）
      expect(result).toBe(log);
      expect(result.tool_tasks[0]!.turns[1]!.content).toBe('a'.repeat(500));
    });

    it('assistant 回复 > 500 字 → 截断为前500字 + "...(已截断)"', () => {
      const longReply = 'a'.repeat(TRUNCATE_THRESHOLD + 1000);
      const log = makeFullLog({
        tool_tasks: [
          {
            task_id: 'T1',
            turns: [
              { turn: 1, role: 'candidate', content: '帮我写邮件', ts: '2026-08-06T00:00:00.000Z' },
              { turn: 2, role: 'assistant', content: longReply, ts: '2026-08-06T00:00:01.000Z' },
            ],
            total_turns: 2,
            duration_sec: null,
            ended_by: null,
          },
        ],
      });
      const result = truncateFullLog(log);
      expect(result).not.toBe(log); // 已截断 → 新对象
      const assistantContent = result.tool_tasks[0]!.turns[1]!.content;
      expect(assistantContent).toBe('a'.repeat(TRUNCATE_THRESHOLD) + TRUNCATE_SUFFIX);
      expect(assistantContent.length).toBe(TRUNCATE_THRESHOLD + TRUNCATE_SUFFIX.length);
    });

    it('同一任务多个 assistant 回复全部超长 → 全部截断', () => {
      const log = makeFullLog({
        tool_tasks: [
          {
            task_id: 'T1',
            turns: [
              { turn: 1, role: 'candidate', content: '帮我写邮件', ts: '2026-08-06T00:00:00.000Z' },
              { turn: 2, role: 'assistant', content: 'a'.repeat(600), ts: '2026-08-06T00:00:01.000Z' },
              { turn: 3, role: 'candidate', content: '改一下', ts: '2026-08-06T00:00:02.000Z' },
              { turn: 4, role: 'assistant', content: 'b'.repeat(800), ts: '2026-08-06T00:00:03.000Z' },
            ],
            total_turns: 4,
            duration_sec: null,
            ended_by: null,
          },
        ],
      });
      const result = truncateFullLog(log);
      const turns = result.tool_tasks[0]!.turns;
      expect(turns[1]!.content).toBe('a'.repeat(500) + TRUNCATE_SUFFIX);
      expect(turns[3]!.content).toBe('b'.repeat(500) + TRUNCATE_SUFFIX);
    });

    it('多个工具任务 → 跨任务全部截断', () => {
      const log = makeFullLog({
        tool_tasks: [
          {
            task_id: 'T1',
            turns: [
              { turn: 1, role: 'assistant', content: 'a'.repeat(700), ts: '2026-08-06T00:00:00.000Z' },
            ],
            total_turns: 1,
            duration_sec: null,
            ended_by: null,
          },
          {
            task_id: 'T2',
            turns: [
              { turn: 1, role: 'assistant', content: 'b'.repeat(900), ts: '2026-08-06T00:00:01.000Z' },
            ],
            total_turns: 1,
            duration_sec: null,
            ended_by: null,
          },
        ],
      });
      const result = truncateFullLog(log);
      expect(result.tool_tasks[0]!.turns[0]!.content).toBe('a'.repeat(500) + TRUNCATE_SUFFIX);
      expect(result.tool_tasks[1]!.turns[0]!.content).toBe('b'.repeat(500) + TRUNCATE_SUFFIX);
    });
  });

  describe('truncateFullLog 优先级2：考官模式 AI 提问', () => {
    it('examiner 回复（即使超长）保留全文', () => {
      const longExaminer = '请问'.repeat(300); // 600 字
      const log = makeFullLog({
        examiner_dialogue: [
          {
            stage: 'S1.1',
            turn: 1,
            role: 'examiner',
            content: longExaminer,
            ts: '2026-08-06T00:00:00.000Z',
          },
        ],
      });
      const result = truncateFullLog(log);
      // examiner 不截断
      expect(result.examiner_dialogue[0]!.content).toBe(longExaminer);
    });
  });

  describe('truncateFullLog 优先级3：候选人输入与面试记录', () => {
    it('候选人 tool 输入（即使超长）保留全文', () => {
      const longCandidate = '我'.repeat(800);
      const log = makeFullLog({
        tool_tasks: [
          {
            task_id: 'T1',
            turns: [
              { turn: 1, role: 'candidate', content: longCandidate, ts: '2026-08-06T00:00:00.000Z' },
              { turn: 2, role: 'assistant', content: 'a'.repeat(700), ts: '2026-08-06T00:00:01.000Z' },
            ],
            total_turns: 2,
            duration_sec: null,
            ended_by: null,
          },
        ],
      });
      const result = truncateFullLog(log);
      expect(result.tool_tasks[0]!.turns[0]!.content).toBe(longCandidate);
      // assistant 仍被截断
      expect(result.tool_tasks[0]!.turns[1]!.content).toBe('a'.repeat(500) + TRUNCATE_SUFFIX);
    });

    it('候选人 examiner 对话输入（即使超长）保留全文', () => {
      const longCandidate = '我'.repeat(800);
      const log = makeFullLog({
        examiner_dialogue: [
          { stage: 'S1.1', turn: 1, role: 'examiner', content: '问题', ts: '2026-08-06T00:00:00.000Z' },
          { stage: 'S1.1', turn: 1, role: 'candidate', content: longCandidate, ts: '2026-08-06T00:00:01.000Z' },
        ],
      });
      const result = truncateFullLog(log);
      expect(result.examiner_dialogue[1]!.content).toBe(longCandidate);
    });

    it('interview_transcript 保留全文（绝不截断）', () => {
      const transcript = '面'.repeat(1000);
      const log = makeFullLog({ interview_transcript: transcript });
      const result = truncateFullLog(log);
      expect(result.interview_transcript).toBe(transcript);
    });
  });

  describe('truncateFullLog 不修改原对象（不可变性）', () => {
    it('截断后原 fullLog 引用对象不变', () => {
      const originalAssistant = 'a'.repeat(700);
      const log = makeFullLog({
        tool_tasks: [
          {
            task_id: 'T1',
            turns: [
              { turn: 1, role: 'assistant', content: originalAssistant, ts: '2026-08-06T00:00:00.000Z' },
            ],
            total_turns: 1,
            duration_sec: null,
            ended_by: null,
          },
        ],
      });
      const result = truncateFullLog(log);
      expect(result).not.toBe(log);
      // 原 log 的 content 仍是 700 字未截断
      expect(log.tool_tasks[0]!.turns[0]!.content).toBe(originalAssistant);
      expect(result.tool_tasks[0]!.turns[0]!.content).not.toBe(originalAssistant);
    });
  });
});

describe('token-estimator 启发式（R3 输入预检）', () => {
  it('纯中文 → 1 token/字符', () => {
    expect(estimateTokens('我')).toBe(1);
    expect(estimateTokens('我使用大模型')).toBe(6);
  });

  it('纯 ASCII → 约 4 字符/token', () => {
    expect(estimateTokens('hello')).toBe(2); // ceil(5/4)=2
    expect(estimateTokens('abcd')).toBe(1);
  });

  it('中英混合 → 分别计算', () => {
    expect(estimateTokens('hello 我')).toBe(3); // 2 (ascii) + 1 (cjk)
  });

  it('空字符串 → 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimateMessagesTokens 累加 + 每条 4 token 结构开销', () => {
    const tokens = estimateMessagesTokens([
      { role: 'system', content: '系统' },     // 4 + 2 = 6
      { role: 'user', content: 'hello world' }, // 4 + 3 = 7 (11 ascii → ceil(11/4)=3)
    ]);
    expect(tokens).toBe(13);
  });
});
