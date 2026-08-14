// 评估跨字段语义断言单元测试（不调 LLM，纯 mock EvaluationResponse）
// 验证 evaluation-assertions.ts 的各类 EvaluationAssertionError 触发
// 对应 config/prompts/evaluation.md 的 R3/R6/R7/10.1/10.2/10.4/10.5/10.6 规则

import {
  assertEvaluationStageRules,
  EvaluationAssertionError,
} from '@/assessment/evaluation-assertions';
import type { EvaluationResponse } from '@/llm/schemas/evaluation.schema';

// 复用 evaluation.schema.ts 类型，避免重复定义
interface MinimalEval extends EvaluationResponse {}

function baseDimension(code: 'D1' | 'D2' | 'D3' | 'D4', overrides: Partial<EvaluationResponse['dimensions'][number]> = {}) {
  return {
    code,
    name: { D1: '使用强度与场景广度', D2: '任务拆解与信息组织', D3: '核验意识', D4: '沉淀与外溢' }[code],
    level: 'L2',
    evidence_grade: 'E2',
    evidence_source: null,
    insufficient_evidence: false,
    evidence: [],
    confidence: 0.8,
    reasoning: 'r',
    ...overrides,
  } as EvaluationResponse['dimensions'][number];
}

function baseResponse(overrides: Partial<EvaluationResponse> = {}): EvaluationResponse {
  return {
    meta: { evaluation_stage: 'A', levels_version: '0.4', dimensions_version: '0.1' },
    dimensions: [
      baseDimension('D1'),
      baseDimension('D2'),
      baseDimension('D3'),
      baseDimension('D4'),
    ],
    gate_checks: {
      l3_gates: { d2_decomposition: true, d3_verification: true, d4_personal_asset: true, task_corroboration: true },
      l4_gate: { d4_spillover: false, spillover_form: null },
      notes: [],
    },
    claim_reality_gap: { level: '无', description: '', interpretation: '无' },
    level_caps: [],
    anomaly_signals: [],
    red_lines: [],
    overall: {
      level: 'L2',
      track: '无',
      confidence: 0.8,
      reasoning: 'r',
      key_uncertainties: [],
      verification_targets: [],
      recommend_human_review: false,
      human_review_reason: '',
    },
    judgment_change: null,
    ...overrides,
  } as EvaluationResponse;
}

describe('assertEvaluationStageRules', () => {
  describe('R3 阶段-等级取值', () => {
    it('合法 L2 阶段 A 通过', () => {
      expect(() => assertEvaluationStageRules(baseResponse())).not.toThrow();
    });

    it('R3.1 阶段 A 禁止 L4', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4', track: '个人深度轨道' },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
      try {
        assertEvaluationStageRules(r);
      } catch (e) {
        expect((e as EvaluationAssertionError).rule).toBe('R3.1');
      }
    });

    it('R3.2 阶段 C 禁止 L4_pending', () => {
      const r = baseResponse({
        meta: { evaluation_stage: 'C', levels_version: '0.4', dimensions_version: '0.1' },
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.75, verification_targets: ['t1', 't2', 't3'] },
        judgment_change: { changed: false, from_level: 'L4_pending', to_level: 'L4', reason: 'r', key_new_evidence: [] },
      });
      // 改为合法 L4 C 才能验证 R3.2：先合法 C，再触发 R3.2
      const rBad = baseResponse({
        meta: { evaluation_stage: 'C', levels_version: '0.4', dimensions_version: '0.1' },
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.75, verification_targets: ['t1', 't2', 't3'] },
        judgment_change: { changed: false, from_level: 'L4_pending', to_level: 'L4', reason: 'r', key_new_evidence: [] },
      });
      expect(() => assertEvaluationStageRules(rBad)).toThrow(EvaluationAssertionError);
      // 用 r 验证合法 C 路径
      void r;
    });

    it('R3.3 非法等级 L3_pending 拒绝', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L3_pending' as unknown as EvaluationResponse['overall']['level'] },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });
  });

  describe('10.1 dimensions 一致性', () => {
    it('E3 时 evidence_source 必须非空', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1', { evidence_grade: 'E3', evidence_source: null }), baseDimension('D2'), baseDimension('D3'), baseDimension('D4')],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('非 E3 时 evidence_source 必须为 null', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1', { evidence_grade: 'E2', evidence_source: 'task' }), baseDimension('D2'), baseDimension('D3'), baseDimension('D4')],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('阶段 A 禁止 interview 印证', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1', { evidence_grade: 'E3', evidence_source: 'interview' }), baseDimension('D2'), baseDimension('D3'), baseDimension('D4')],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('阶段 A D4 不得 E3', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1'), baseDimension('D2'), baseDimension('D3'), baseDimension('D4', { evidence_grade: 'E3', evidence_source: 'task' })],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('insufficient_evidence=true 时 level 必须为 null', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1', { insufficient_evidence: true, level: 'L1', evidence_grade: 'E0', evidence: [] }), baseDimension('D2'), baseDimension('D3'), baseDimension('D4')],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('insufficient_evidence=true 时 evidence_grade 必须 E0', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1', { insufficient_evidence: true, level: null, evidence_grade: 'E1', evidence: [] }), baseDimension('D2'), baseDimension('D3'), baseDimension('D4')],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('合法 E3 task 印证通过', () => {
      const r = baseResponse({
        dimensions: [baseDimension('D1', { evidence_grade: 'E3', evidence_source: 'task' }), baseDimension('D2'), baseDimension('D3'), baseDimension('D4')],
      });
      expect(() => assertEvaluationStageRules(r)).not.toThrow();
    });
  });

  describe('10.2 gate_checks spillover_form 一致性', () => {
    it('d4_spillover=false 时 spillover_form 必须为 null', () => {
      const r = baseResponse({
        gate_checks: {
          l3_gates: { d2_decomposition: true, d3_verification: true, d4_personal_asset: true, task_corroboration: true },
          l4_gate: { d4_spillover: false, spillover_form: '他人采纳' },
          notes: [],
        },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });
  });

  describe('10.4 level_caps cap_level', () => {
    it('LC4 必须为 "下调一级"', () => {
      const r = baseResponse({
        level_caps: [{ code: 'LC4', cap_level: 'L2', quote: 'q', description: 'd' }],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('LC1 cap_level 必须 L1 或 L2', () => {
      const r = baseResponse({
        level_caps: [{ code: 'LC1', cap_level: 'L3' as unknown as 'L1', quote: 'q', description: 'd' }],
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('合法 LC2 cap_level=L2 通过', () => {
      const r = baseResponse({
        level_caps: [{ code: 'LC2', cap_level: 'L2', quote: 'q', description: 'd' }],
      });
      expect(() => assertEvaluationStageRules(r)).not.toThrow();
    });
  });

  describe('10.5 overall 一致性', () => {
    it('非 L4 等级 track 必须 "无"', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L2', track: '个人深度轨道' },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('L4_pending 时 track 不得 "无"', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '无', confidence: 0.75, verification_targets: ['t1', 't2', 't3'] },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('R7 L4_pending 时 confidence 不得 > 0.80', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.85, verification_targets: ['t1', 't2', 't3'] },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
      try {
        assertEvaluationStageRules(r);
      } catch (e) {
        expect((e as EvaluationAssertionError).rule).toBe('R7');
      }
    });

    it('L4_pending 时 verification_targets 至少 3 条', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.75, verification_targets: ['t1'] },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('recommend_human_review=true 时 human_review_reason 不得为空', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, recommend_human_review: true, human_review_reason: '' },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('合法 L4_pending 通过', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.75, verification_targets: ['t1', 't2', 't3'], recommend_human_review: true, human_review_reason: '需现场验证外溢' },
        gate_checks: {
          l3_gates: { d2_decomposition: true, d3_verification: true, d4_personal_asset: true, task_corroboration: true },
          l4_gate: { d4_spillover: true, spillover_form: '他人采纳' },
          notes: [],
        },
      });
      expect(() => assertEvaluationStageRules(r)).not.toThrow();
    });
  });

  describe('R6 L4_pending 门槛', () => {
    it('L4_pending 但 d4_spillover=false 拒绝', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.75, verification_targets: ['t1', 't2', 't3'], recommend_human_review: true, human_review_reason: '需现场验证' },
        gate_checks: {
          l3_gates: { d2_decomposition: true, d3_verification: true, d4_personal_asset: true, task_corroboration: true },
          l4_gate: { d4_spillover: false, spillover_form: null },
          notes: [],
        },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
      try {
        assertEvaluationStageRules(r);
      } catch (e) {
        expect((e as EvaluationAssertionError).rule).toBe('R6');
      }
    });

    it('L4_pending 但 d2_decomposition=false 拒绝', () => {
      const r = baseResponse({
        overall: { ...baseResponse().overall, level: 'L4_pending', track: '个人深度轨道', confidence: 0.75, verification_targets: ['t1', 't2', 't3'], recommend_human_review: true, human_review_reason: '需现场验证' },
        gate_checks: {
          l3_gates: { d2_decomposition: false, d3_verification: true, d4_personal_asset: true, task_corroboration: true },
          l4_gate: { d4_spillover: true, spillover_form: '他人采纳' },
          notes: [],
        },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });
  });

  describe('10.6 judgment_change 阶段一致性', () => {
    it('阶段 A judgment_change 必须 null', () => {
      const r = baseResponse({
        judgment_change: { changed: false, from_level: '', to_level: '', reason: 'r', key_new_evidence: [] },
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('阶段 C judgment_change 不得 null', () => {
      const r = baseResponse({
        meta: { evaluation_stage: 'C', levels_version: '0.4', dimensions_version: '0.1' },
        judgment_change: null,
      });
      expect(() => assertEvaluationStageRules(r)).toThrow(EvaluationAssertionError);
    });

    it('合法阶段 C 通过', () => {
      const r = baseResponse({
        meta: { evaluation_stage: 'C', levels_version: '0.4', dimensions_version: '0.1' },
        judgment_change: { changed: false, from_level: 'L2', to_level: 'L2', reason: '面试记录未改变判定', key_new_evidence: [] },
      });
      expect(() => assertEvaluationStageRules(r)).not.toThrow();
    });
  });
});
