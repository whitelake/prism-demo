import { z } from 'zod';
import { JsonParseError, SchemaValidationError, parseJsonResponse } from '../json-parser';
import {
  DIMENSION_CODES,
  DIMENSION_COUNT,
  EVIDENCE_GRADES,
  EVALUATION_LEVELS,
  LEVEL_CAP_CODES,
  LEVELS,
  RED_LINE_CODES,
  SPILLOVER_FORMS,
  TRACKS,
} from '@prism/shared';

// 与 config/levels.yaml v0.4、config/dimensions.yaml v0.1、
// config/prompts/evaluation.md 输出契约对齐。
// PoC 不变量 4：模型结构化输出必须经过 JSON 解析与 Schema 校验。
// 详见 docs/architecture.md 4.4、docs/prd.md 4.6。

// 维度级 level 不带 _pending（dimensions[].level）
const DimensionLevel = z.enum(LEVELS).nullable();

// overall.level：阶段 A 允许 L4_pending；阶段 C 允许 L4
// R3：阶段 A 禁止 L4；阶段 C 禁止 L4_pending；不存在 L0..L3_pending
const OverallLevel = z.enum(EVALUATION_LEVELS);

// overall.track：L4/L4_pending 时为前三者之一；其他等级固定"无"
const Track = z.enum(TRACKS);

const GapLevel = z.enum(['无', '轻微', '重大']);
const GapInterpretation = z.enum([
  '无',
  '倾向夸大',
  '缺乏自我认知',
  '紧张导致表现失真',
  '难以判断',
]);

// E3 证据的印证来源类型；仅 evidence_grade = E3 时非 null
// 与 EvidenceLocation（单条引用出自日志哪部分）是不同字段
const DimensionEvidenceSource = z.enum(['task', 'interview']).nullable();

// 单条原文引用出自日志的哪个部分
const EvidenceLocation = z.enum([
  'questionnaire_result',
  'examiner_dialogue',
  'tool_tasks',
  'interview_transcript',
]);

const EvidenceGrade = z.enum(EVIDENCE_GRADES);

const Evidence = z.object({
  source: EvidenceLocation,
  location: z.string(),
  quote: z.string().min(1),
  note: z.string().default(''),
});

const Dimension = z.object({
  code: z.enum(DIMENSION_CODES),
  name: z.string(),
  level: DimensionLevel,
  evidence_grade: EvidenceGrade,
  evidence_source: DimensionEvidenceSource,
  insufficient_evidence: z.boolean(),
  evidence: z.array(Evidence),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
});

const GateChecks = z.object({
  l3_gates: z.object({
    d2_decomposition: z.boolean(),
    d3_verification: z.boolean(),
    d4_personal_asset: z.boolean(),
    task_corroboration: z.boolean(),
  }),
  l4_gate: z.object({
    d4_spillover: z.boolean(),
    spillover_form: z.enum(SPILLOVER_FORMS).nullable(),
  }),
  notes: z.array(z.string()),
});

const ClaimRealityGap = z.object({
  level: GapLevel,
  description: z.string(),
  interpretation: GapInterpretation,
});

const LevelCap = z.object({
  code: z.enum(LEVEL_CAP_CODES),
  cap_level: z.enum(['L1', 'L2', '下调一级']),
  quote: z.string(),
  description: z.string(),
});

const AnomalySignal = z.object({
  type: z.string(),
  evidence: z.string(),
  description: z.string().default(''),
});

const RedLine = z.object({
  code: z.enum(RED_LINE_CODES),
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
  verification_targets: z.array(z.string()),
  recommend_human_review: z.boolean(),
  human_review_reason: z.string().default(''),
});

const Meta = z.object({
  evaluation_stage: z.enum(['A', 'C']),
  levels_version: z.string(),
  dimensions_version: z.string(),
});

export const EvaluationResponseSchema = z.object({
  meta: Meta,
  dimensions: z.array(Dimension).length(DIMENSION_COUNT, {
    message: 'dimensions must contain exactly 4 entries (D1–D4)',
  }),
  gate_checks: GateChecks,
  claim_reality_gap: ClaimRealityGap,
  level_caps: z.array(LevelCap),
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
