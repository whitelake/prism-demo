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
  if (!result.success) {
    throw new SchemaValidationError(
      `Schema validation failed: ${result.error.message}`,
      raw,
      result.error,
    );
  }

  return result.data;
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
