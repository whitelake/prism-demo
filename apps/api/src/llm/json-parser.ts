import { ZodSchema, ZodError } from 'zod';

export class JsonParseError extends Error {
  constructor(
    message: string,
    readonly raw: string,
  ) {
    super(message);
    this.name = 'JsonParseError';
  }
}

export class SchemaValidationError extends Error {
  constructor(
    message: string,
    readonly raw: string,
    readonly zodError: ZodError,
  ) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export function parseJsonResponse<T>(raw: string, schema: ZodSchema<T>): T {
  const stripped = stripMarkdownFence(raw);
  const extracted = extractJsonObject(stripped);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (e) {
    throw new JsonParseError(
      `JSON.parse failed: ${(e as Error).message}`,
      raw,
    );
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return result.data;
  }

  // 兼容 LLM 偶发把 JSON 包成 tool_calls 风格的偏置：
  //   候选人对话中含 "Agent"/"skill"/"工具调用" 等词时，
  //   qwen3.7-flash/plus 会误进 tool_calls 输出模式，把目标对象包成
  //   [{name: "default_api", arguments: {question, signals}}] 输出。
  //   extractJsonObject 已剥掉外层方括号得到 {name, arguments: {...}} 对象，
  //   这里从 arguments 字段提取真实 payload，再走一次 schema 校验。
  // 抢救失败仍抛原始 SchemaValidationError，保留原始 zodError 用于诊断。
  const unwrapped = unwrapToolCallPayload(parsed);
  if (unwrapped !== parsed) {
    const retry = schema.safeParse(unwrapped);
    if (retry.success) {
      return retry.data;
    }
  }

  throw new SchemaValidationError(
    `Schema validation failed: ${result.error.message}`,
    raw,
    result.error,
  );
}

// 从 tool_calls 风格响应中提取真实 payload。
// 支持两种形态：
//   1. arguments 是对象 → 直接返回 arguments
//   2. arguments 是 JSON 字符串 → 解析后递归 unwrap（应对嵌套 tool_calls）
// 不匹配时返回原值，由调用方继续走原 schema 校验流程。
export function unwrapToolCallPayload(parsed: unknown): unknown {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return parsed;
  }
  const obj = parsed as Record<string, unknown>;
  const hasName = 'name' in obj && typeof obj.name === 'string';
  const hasArguments = 'arguments' in obj;
  if (!hasName || !hasArguments) {
    return parsed;
  }

  const args = obj.arguments;
  if (args !== null && typeof args === 'object' && !Array.isArray(args)) {
    // arguments 是对象：递归检查它本身是否也是 tool_calls 风格（应对嵌套）
    return unwrapToolCallPayload(args);
  }
  if (typeof args === 'string') {
    try {
      const inner = JSON.parse(args);
      if (inner !== null && typeof inner === 'object') {
        return unwrapToolCallPayload(inner);
      }
    } catch {
      return parsed;
    }
  }
  return parsed;
}

function stripMarkdownFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
}

function extractJsonObject(s: string): string {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return s.slice(start, end + 1);
  }
  return s;
}
