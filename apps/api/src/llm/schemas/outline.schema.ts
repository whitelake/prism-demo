import { z } from 'zod';
import { JsonParseError, SchemaValidationError, parseJsonResponse } from '../json-parser';

const OutlineQuestion = z.object({
  index: z.number().int().min(1),
  quote: z.string().min(1),
  ask: z.string().min(1),
  verify: z.string().min(1),
  follow_up: z.array(z.string()).default([]),
});

export const OutlineResponseSchema = z.object({
  questions: z.array(OutlineQuestion).max(5),
  note: z.string().default(''),
});

export type OutlineResponse = z.infer<typeof OutlineResponseSchema>;

export function parseOutlineResponse(raw: string): OutlineResponse {
  return parseJsonResponse(raw, OutlineResponseSchema);
}

export { JsonParseError, SchemaValidationError };
