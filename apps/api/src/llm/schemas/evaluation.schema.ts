import { z } from 'zod';
import { JsonParseError, SchemaValidationError, parseJsonResponse } from '../json-parser';

const DimensionLevel = z.enum(['L0', 'L1', 'L2', 'L3', 'L4']).nullable();

const OverallLevel = z.enum([
  'L0',
  'L1',
  'L2',
  'L3_pending',
  'L4_pending',
  'L3',
  'L4',
]);

const Track = z.enum(['个人深度轨道', '团队负责人轨道', '无法判断']);

const GapLevel = z.enum(['无', '轻微', '重大']);
const GapInterpretation = z.enum([
  '无',
  '倾向夸大',
  '缺乏自我认知',
  '紧张导致表现失真',
  '难以判断',
]);

const EvidenceSource = z.enum([
  'questionnaire',
  'examiner_dialogue',
  'tool_task',
  'interview_transcript',
]);

const Evidence = z.object({
  source: EvidenceSource,
  location: z.string(),
  quote: z.string().min(1),
  note: z.string().default(''),
});

const Dimension = z.object({
  code: z.enum(['D1', 'D2', 'D3', 'D4', 'D5', 'D6']),
  name: z.string(),
  level: DimensionLevel,
  insufficient_evidence: z.boolean(),
  evidence: z.array(Evidence),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const ClaimRealityGap = z.object({
  level: GapLevel,
  description: z.string(),
  interpretation: GapInterpretation,
});

const AnomalySignal = z.object({
  type: z.string(),
  evidence: z.string(),
  description: z.string().default(''),
});

const RedLine = z.object({
  code: z.enum(['RL1', 'RL2', 'RL3', 'RL4']),
  quote: z.string(),
  description: z.string(),
});

const JudgmentChange = z
  .object({
    changed: z.boolean(),
    from_level: z.string().default(''),
    to_level: z.string().default(''),
    reason: z.string(),
    key_new_evidence: z.array(z.string()).default([]),
  })
  .nullable();

const Overall = z.object({
  level: OverallLevel,
  track: Track,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  key_uncertainties: z.array(z.string()),
  recommend_human_review: z.boolean(),
  human_review_reason: z.string().default(''),
});

export const EvaluationResponseSchema = z.object({
  dimensions: z.array(Dimension).length(6, { message: 'dimensions must contain exactly 6 entries (D1–D6)' }),
  claim_reality_gap: ClaimRealityGap,
  anomaly_signals: z.array(AnomalySignal),
  red_lines: z.array(RedLine),
  overall: Overall,
  judgment_change: JudgmentChange,
});

export type EvaluationResponse = z.infer<typeof EvaluationResponseSchema>;

export function parseEvaluationResponse(raw: string): EvaluationResponse {
  return parseJsonResponse(raw, EvaluationResponseSchema);
}

export { JsonParseError, SchemaValidationError };
