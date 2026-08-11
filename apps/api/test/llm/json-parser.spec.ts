import { z } from 'zod';
import {
  parseJsonResponse,
  unwrapToolCallPayload,
  JsonParseError,
  SchemaValidationError,
} from '@/llm/json-parser';

const Schema = z.object({
  question: z.string().min(1),
  signals: z.object({
    goal_coverage: z.number().min(0).max(1),
    answer_vagueness: z.number().min(0).max(1),
    mentioned_process_change: z.boolean(),
    mentioned_asset: z.boolean(),
    mentioned_others_adoption: z.boolean(),
    mentioned_team_driving: z.boolean(),
  }),
});

describe('parseJsonResponse — 正常对象响应', () => {
  it('标准 {question, signals} 对象直接通过', () => {
    const raw = JSON.stringify({
      question: '最近一次用AI做了什么？',
      signals: {
        goal_coverage: 0.4,
        answer_vagueness: 0.6,
        mentioned_process_change: false,
        mentioned_asset: true,
        mentioned_others_adoption: false,
        mentioned_team_driving: false,
      },
    });
    const result = parseJsonResponse(raw, Schema);
    expect(result.question).toBe('最近一次用AI做了什么？');
    expect(result.signals.goal_coverage).toBe(0.4);
  });

  it('markdown 代码块包裹的 JSON 也能解析', () => {
    const raw = '```json\n' + JSON.stringify({
      question: '问题',
      signals: {
        goal_coverage: 0.1,
        answer_vagueness: 0.2,
        mentioned_process_change: false,
        mentioned_asset: false,
        mentioned_others_adoption: false,
        mentioned_team_driving: false,
      },
    }) + '\n```';
    const result = parseJsonResponse(raw, Schema);
    expect(result.question).toBe('问题');
  });
});

describe('parseJsonResponse — tool_calls 风格响应抢救', () => {
  // 真实失败 raw 形态：候选人说 "Agent"/"skill" 等词后，qwen3.7-flash/plus
  // 把目标对象包成 [{name: "default_api", arguments: {question, signals}}] 输出
  // extractJsonObject 会剥掉外层方括号得到 {name, arguments: {...}} 对象
  const fullPayload = {
    question: '你写的skill具体包含哪些逻辑？',
    signals: {
      goal_coverage: 0.4,
      answer_vagueness: 0.4,
      mentioned_process_change: true,
      mentioned_asset: true,
      mentioned_others_adoption: false,
      mentioned_team_driving: false,
    },
  };

  it('arguments 为对象时从 arguments 抢救出 {question, signals}', () => {
    const raw = JSON.stringify({
      name: 'default_api',
      arguments: fullPayload,
    });
    const result = parseJsonResponse(raw, Schema);
    expect(result.question).toBe(fullPayload.question);
    expect(result.signals.mentioned_asset).toBe(true);
  });

  it('外层带方括号 [{{name, arguments}}] 也能抢救（extractJsonObject 剥掉 []）', () => {
    const raw = JSON.stringify([{
      name: 'default_api',
      arguments: fullPayload,
    }]);
    const result = parseJsonResponse(raw, Schema);
    expect(result.question).toBe(fullPayload.question);
    expect(result.signals.goal_coverage).toBe(0.4);
  });

  it('arguments 为 JSON 字符串时解析后抢救', () => {
    const raw = JSON.stringify({
      name: 'default_api',
      arguments: JSON.stringify(fullPayload),
    });
    const result = parseJsonResponse(raw, Schema);
    expect(result.question).toBe(fullPayload.question);
  });

  it('嵌套 tool_calls (arguments 内有 name+arguments) 递归抢救', () => {
    const raw = JSON.stringify({
      name: 'tool_use',
      arguments: {
        name: 'submit_answer',
        arguments: fullPayload,
      },
    });
    const result = parseJsonResponse(raw, Schema);
    expect(result.question).toBe(fullPayload.question);
  });

  it('arguments 内缺 question 时抢救仍失败，抛 SchemaValidationError 保留原始 zodError', () => {
    const partial = {
      signals: {
        goal_coverage: 0.4,
        answer_vagueness: 0.4,
        mentioned_process_change: false,
        mentioned_asset: true,
        mentioned_others_adoption: false,
        mentioned_team_driving: false,
      },
    };
    const raw = JSON.stringify({
      name: 'default_api',
      arguments: partial,
    });
    expect(() => parseJsonResponse(raw, Schema)).toThrow(SchemaValidationError);
  });
});

describe('parseJsonResponse — 抢救失败仍抛原始错误', () => {
  it('纯字符串响应抛 JsonParseError', () => {
    expect(() => parseJsonResponse('hello', Schema)).toThrow(JsonParseError);
  });

  it('对象缺 signals 字段抛 SchemaValidationError', () => {
    const raw = JSON.stringify({ question: '问题' });
    expect(() => parseJsonResponse(raw, Schema)).toThrow(SchemaValidationError);
  });
});

describe('unwrapToolCallPayload — 单元行为', () => {
  it('非对象直接返回原值', () => {
    expect(unwrapToolCallPayload('hello')).toBe('hello');
    expect(unwrapToolCallPayload(42)).toBe(42);
    expect(unwrapToolCallPayload(null)).toBe(null);
    expect(unwrapToolCallPayload([1, 2])).toEqual([1, 2]);
  });

  it('没有 name+arguments 字段的对象返回原值', () => {
    const obj = { question: '问题', signals: {} };
    expect(unwrapToolCallPayload(obj)).toBe(obj);
  });

  it('{name, arguments: <object>} 返回 arguments', () => {
    const args = { question: '问题', signals: {} };
    expect(unwrapToolCallPayload({ name: 'default_api', arguments: args })).toBe(args);
  });

  it('{name, arguments: <JSON 字符串>} 解析字符串后返回', () => {
    const args = { question: '问题' };
    const result = unwrapToolCallPayload({
      name: 'default_api',
      arguments: JSON.stringify(args),
    });
    expect(result).toEqual(args);
  });

  it('arguments 是非法 JSON 字符串时返回原值（不抛错）', () => {
    const original = { name: 'default_api', arguments: 'not-json' };
    expect(unwrapToolCallPayload(original)).toBe(original);
  });

  it('arguments 是数字/数组时返回原值', () => {
    expect(unwrapToolCallPayload({ name: 'foo', arguments: 42 })).toEqual({
      name: 'foo',
      arguments: 42,
    });
    expect(unwrapToolCallPayload({ name: 'foo', arguments: [1, 2] })).toEqual({
      name: 'foo',
      arguments: [1, 2],
    });
  });
});
