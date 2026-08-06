import { z } from 'zod';
import { JsonParseError, SchemaValidationError, parseJsonResponse } from '../json-parser';

export const ExaminerSignalsSchema = z.object({
  goal_coverage: z.number().min(0).max(1),
  answer_vagueness: z.number().min(0).max(1),
  mentioned_process_change: z.boolean(),
  mentioned_asset: z.boolean(),
  mentioned_others_adoption: z.boolean(),
  mentioned_team_driving: z.boolean(),
});

export type ExaminerSignals = z.infer<typeof ExaminerSignalsSchema>;

export const ExaminerResponseSchema = z.object({
  question: z.string().min(1),
  signals: ExaminerSignalsSchema,
});

export type ExaminerResponse = z.infer<typeof ExaminerResponseSchema>;

export function parseExaminerResponse(raw: string): ExaminerResponse {
  return parseJsonResponse(raw, ExaminerResponseSchema);
}

export { JsonParseError, SchemaValidationError };
