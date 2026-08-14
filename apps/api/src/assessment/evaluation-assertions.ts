// 评估响应的跨字段语义断言。
// Zod schema 校验单字段格式，但无法表达跨字段约束；
// 本模块在 schema 通过后做后处理断言，失败即抛 EvaluationAssertionError →
// 上层 catch → EVAL_FAILED。
//
// 规则来源：config/prompts/evaluation.md（R1–R9 与第十章字段取值约束）。
// 每条断言标注对应规则编号，便于排查。

import { EVALUATION_LEVELS } from '@prism/shared';
import type { EvaluationResponse } from '@/llm/schemas/evaluation.schema';

export class EvaluationAssertionError extends Error {
  constructor(
    public readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'EvaluationAssertionError';
  }
}

// R3 三条禁止：阶段与 overall.level 取值约束
function assertStageLevelRules(response: EvaluationResponse): void {
  const stage = response.meta.evaluation_stage;
  const level = response.overall.level;

  if (!EVALUATION_LEVELS.includes(level as never)) {
    throw new EvaluationAssertionError(
      'R3.3',
      `overall.level "${level}" 不在合法等级集合 ${EVALUATION_LEVELS.join('/')} 中；唯一 pending 是 L4_pending`,
    );
  }

  if (stage === 'A' && level === 'L4') {
    throw new EvaluationAssertionError(
      'R3.1',
      `阶段 A 禁止输出 overall.level="L4"；判到 L4 一律输出 "L4_pending"（evaluation.md R3.1）`,
    );
  }

  if (stage === 'C' && level === 'L4_pending') {
    throw new EvaluationAssertionError(
      'R3.2',
      `阶段 C 禁止输出 overall.level="L4_pending"；有了面试记录必须给出确定结论 "L4" 或更低（evaluation.md R3.2）`,
    );
  }
}

// 10.1 dimensions：evidence_source / evidence_grade / insufficient_evidence 三者一致性
// + 阶段 A 不得出现 interview 印证 + D4 在阶段 A 不得 E3
function assertDimensionConsistency(response: EvaluationResponse): void {
  const stage = response.meta.evaluation_stage;
  for (const d of response.dimensions) {
    // E3 时 evidence_source 必须非 null；非 E3 时必须为 null
    if (d.evidence_grade === 'E3' && d.evidence_source == null) {
      throw new EvaluationAssertionError(
        '10.1',
        `维度 ${d.code} evidence_grade="E3" 但 evidence_source 为 null；E3 必须注明来源（task/interview）`,
      );
    }
    if (d.evidence_grade !== 'E3' && d.evidence_source != null) {
      throw new EvaluationAssertionError(
        '10.1',
        `维度 ${d.code} evidence_grade="${d.evidence_grade}" 但 evidence_source=${d.evidence_source}；仅 E3 允许非 null`,
      );
    }
    // 阶段 A 不得出现 interview 印证（interview 印证只在终判 C 出现）
    if (stage === 'A' && d.evidence_source === 'interview') {
      throw new EvaluationAssertionError(
        '10.1',
        `阶段 A 维度 ${d.code} evidence_source="interview" 禁止；阶段 A 的 E3 只能来自 task`,
      );
    }
    // D4 在阶段 A 不得 E3（D4 无对应实操任务）
    if (stage === 'A' && d.code === 'D4' && d.evidence_grade === 'E3') {
      throw new EvaluationAssertionError(
        '10.1',
        `阶段 A 维度 D4 不得输出 evidence_grade="E3"；D4 无对应实操任务，最高 E2`,
      );
    }
    // insufficient_evidence=true 时：level=null、evidence_grade=E0、evidence=[]
    if (d.insufficient_evidence) {
      if (d.level !== null) {
        throw new EvaluationAssertionError(
          '10.1',
          `维度 ${d.code} insufficient_evidence=true 但 level=${d.level}；应同时为 null`,
        );
      }
      if (d.evidence_grade !== 'E0') {
        throw new EvaluationAssertionError(
          '10.1',
          `维度 ${d.code} insufficient_evidence=true 但 evidence_grade=${d.evidence_grade}；应为 E0`,
        );
      }
      if (d.evidence.length > 0) {
        throw new EvaluationAssertionError(
          '10.1',
          `维度 ${d.code} insufficient_evidence=true 但 evidence 非空；应为 []`,
        );
      }
    }
  }
}

// 10.2 gate_checks：spillover_form 与 d4_spillover 一致性
function assertGateChecks(response: EvaluationResponse): void {
  const l4 = response.gate_checks.l4_gate;
  if (!l4.d4_spillover && l4.spillover_form != null) {
    throw new EvaluationAssertionError(
      '10.2',
      `gate_checks.l4_gate.d4_spillover=false 时 spillover_form 必须为 null，实际为 ${l4.spillover_form}`,
    );
  }
}

// 10.4 level_caps：LC4 cap_level="下调一级"，其他 LC cap_level ∈ {L1, L2}
function assertLevelCaps(response: EvaluationResponse): void {
  for (const cap of response.level_caps) {
    if (cap.code === 'LC4') {
      if (cap.cap_level !== '下调一级') {
        throw new EvaluationAssertionError(
          '10.4',
          `level_caps LC4 的 cap_level 必须为 "下调一级"，实际为 ${cap.cap_level}`,
        );
      }
    } else {
      if (!['L1', 'L2'].includes(cap.cap_level)) {
        throw new EvaluationAssertionError(
          '10.4',
          `level_caps ${cap.code} 的 cap_level 必须为 L1 或 L2，实际为 ${cap.cap_level}`,
        );
      }
    }
  }
}

// 10.5 overall：track 与 level 一致性 + L4_pending 时 confidence ≤ 0.80 + verification_targets ≥ 3
function assertOverallConsistency(response: EvaluationResponse): void {
  const { level, track, confidence, verification_targets, recommend_human_review, human_review_reason } =
    response.overall;

  // track 与 level 一致性
  const isL4 = level === 'L4' || level === 'L4_pending';
  if (isL4) {
    if (track === '无') {
      throw new EvaluationAssertionError(
        '10.5',
        `overall.level=${level} 时 track 不得为 "无"；必须为 个人深度轨道/团队负责人轨道/无法判断 之一`,
      );
    }
  } else {
    if (track !== '无') {
      throw new EvaluationAssertionError(
        '10.5',
        `overall.level=${level}（非 L4/L4_pending）时 track 必须为 "无"，实际为 ${track}`,
      );
    }
  }

  // L4_pending 时 confidence ≤ 0.80
  if (level === 'L4_pending' && confidence > 0.8) {
    throw new EvaluationAssertionError(
      'R7',
      `overall.level="L4_pending" 时 confidence 不得超过 0.80，实际为 ${confidence}`,
    );
  }

  // L4_pending 时 verification_targets 至少 3 条
  if (level === 'L4_pending' && verification_targets.length < 3) {
    throw new EvaluationAssertionError(
      '10.5',
      `overall.level="L4_pending" 时 verification_targets 至少 3 条，实际 ${verification_targets.length} 条`,
    );
  }

  // recommend_human_review=true 时 human_review_reason 不得为空
  if (recommend_human_review && human_review_reason.trim() === '') {
    throw new EvaluationAssertionError(
      '10.5',
      `overall.recommend_human_review=true 时 human_review_reason 不得为空字符串`,
    );
  }
}

// R6 管理者拦截：D4 达到 L4 但 L3 个人门槛任一不成立时不得判 L4_pending
// 简化为：level=L4_pending 时 l3_gates 三个个人门槛必须全部 true
// （task_corroboration 是 additional_gate，单独看；R6 关注的是 d2/d3/d4_personal_asset）
function assertL4PendingGates(response: EvaluationResponse): void {
  if (response.overall.level !== 'L4_pending') return;
  const g = response.gate_checks.l3_gates;
  const missing: string[] = [];
  if (!g.d2_decomposition) missing.push('d2_decomposition');
  if (!g.d3_verification) missing.push('d3_verification');
  if (!g.d4_personal_asset) missing.push('d4_personal_asset');
  if (missing.length > 0) {
    throw new EvaluationAssertionError(
      'R6',
      `overall.level="L4_pending" 但 L3 个人门槛未全部成立：${missing.join('、')}；按 R6 应判 L2 或 L3，不得判 L4_pending`,
    );
  }
  // L4_pending 时 d4_spillover 必须为 true（否则不算 L4 候选）
  if (!response.gate_checks.l4_gate.d4_spillover) {
    throw new EvaluationAssertionError(
      'R6',
      `overall.level="L4_pending" 但 gate_checks.l4_gate.d4_spillover=false；外溢事实不成立时不得判 L4_pending`,
    );
  }
}

// 10.6 judgment_change：阶段 A 必须为 null、阶段 C 不得为 null
function assertJudgmentChange(response: EvaluationResponse): void {
  const stage = response.meta.evaluation_stage;
  if (stage === 'A' && response.judgment_change !== null) {
    throw new EvaluationAssertionError(
      '10.6',
      `阶段 A 时 judgment_change 必须为 null`,
    );
  }
  if (stage === 'C' && response.judgment_change === null) {
    throw new EvaluationAssertionError(
      '10.6',
      `阶段 C 时 judgment_change 不得为 null，必须为完整对象`,
    );
  }
}

export function assertEvaluationStageRules(response: EvaluationResponse): void {
  assertStageLevelRules(response);
  assertDimensionConsistency(response);
  assertGateChecks(response);
  assertLevelCaps(response);
  assertOverallConsistency(response);
  assertL4PendingGates(response);
  assertJudgmentChange(response);
}
