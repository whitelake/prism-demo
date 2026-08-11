import {
  AssessmentStatus,
  isALocked,
  canTransition,
  shouldAdvanceStage,
  onCandidateIdle,
  shouldRunS13,
  shouldTriggerInterview,
  shouldMarkAbandoned,
  type StageContext,
  type StageConfig,
  type ExaminerSignals,
  type ExaminerSignalRecord,
  type S13TriggerInput,
  type InterviewTriggerInput,
} from '@/assessment/assessment.state';
import { getStageConfig } from '@/assessment/stages.config';

// PoC 不变量 5：后端控制流程推进
// 验证模型信号不能直接改变状态；最小/最大轮次、超时、覆盖度规则符合 PRD；
// S1.3 触发符合 Q3/Q4 和 mentioned_* 字段规则。
// 详见 .claude/rules/testing.md "状态机" 一节。

function signals(partial: Partial<ExaminerSignals>): ExaminerSignals {
  return {
    goal_coverage: 0.5,
    answer_vagueness: 0.3,
    ...partial,
  };
}

function stageCtx(partial: Partial<StageContext>): StageContext {
  return {
    stageCode: 'S1.1',
    turnIndex: 3,
    signals: signals({}),
    totalElapsedSec: 300,
    ...partial,
  };
}

describe('assessment.state 状态机不变量 (PoC 不变量 5)', () => {
  describe('AssessmentStatus 转移图 (PRD 4.8)', () => {
    it('合法转移', () => {
      expect(
        canTransition(AssessmentStatus.NOT_STARTED, AssessmentStatus.IN_PROGRESS),
      ).toBe(true);
      expect(
        canTransition(AssessmentStatus.IN_PROGRESS, AssessmentStatus.EVALUATING),
      ).toBe(true);
      expect(
        canTransition(AssessmentStatus.EVALUATING, AssessmentStatus.COMPLETED),
      ).toBe(true);
      expect(
        canTransition(
          AssessmentStatus.EVALUATING,
          AssessmentStatus.PENDING_INTERVIEW,
        ),
      ).toBe(true);
      expect(
        canTransition(
          AssessmentStatus.PENDING_INTERVIEW,
          AssessmentStatus.FINAL_EVALUATING,
        ),
      ).toBe(true);
      expect(
        canTransition(
          AssessmentStatus.FINAL_EVALUATING,
          AssessmentStatus.COMPLETED,
        ),
      ).toBe(true);
      expect(
        canTransition(
          AssessmentStatus.EVAL_FAILED,
          AssessmentStatus.EVALUATING,
        ),
      ).toBe(true);
    });

    it('非法转移被拒绝', () => {
      // 不允许跳过评估直接到完成
      expect(
        canTransition(AssessmentStatus.IN_PROGRESS, AssessmentStatus.COMPLETED),
      ).toBe(false);
      // 不允许从已完成回退
      expect(
        canTransition(AssessmentStatus.COMPLETED, AssessmentStatus.IN_PROGRESS),
      ).toBe(false);
      // 不允许从待现场验证直接跳到已完成（必须经过终判中）
      expect(
        canTransition(
          AssessmentStatus.PENDING_INTERVIEW,
          AssessmentStatus.COMPLETED,
        ),
      ).toBe(false);
      // 不允许从已放弃恢复
      expect(
        canTransition(AssessmentStatus.ABANDONED, AssessmentStatus.IN_PROGRESS),
      ).toBe(false);
    });
  });

  describe('isALocked (PoC 不变量 2：A 锁定)', () => {
    it('pending_interview / final_evaluating 为锁定', () => {
      expect(isALocked(AssessmentStatus.PENDING_INTERVIEW)).toBe(true);
      expect(isALocked(AssessmentStatus.FINAL_EVALUATING)).toBe(true);
    });

    it('其他状态不锁定', () => {
      expect(isALocked(AssessmentStatus.NOT_STARTED)).toBe(false);
      expect(isALocked(AssessmentStatus.IN_PROGRESS)).toBe(false);
      expect(isALocked(AssessmentStatus.EVALUATING)).toBe(false);
      expect(isALocked(AssessmentStatus.COMPLETED)).toBe(false);
      expect(isALocked(AssessmentStatus.ABANDONED)).toBe(false);
      expect(isALocked(AssessmentStatus.EVAL_FAILED)).toBe(false);
    });
  });

  describe('shouldAdvanceStage (PRD 4.2 / 5.1)', () => {
    const cfgS11: StageConfig = getStageConfig('S1.1');
    const cfgS12: StageConfig = getStageConfig('S1.2');
    const cfgS13: StageConfig = getStageConfig('S1.3');

    it('优先级1：第1段总时长 ≥ 900s → 跳过考官剩余阶段 (架构 4.3)', () => {
      const d = shouldAdvanceStage(
        stageCtx({ totalElapsedSec: 900 }),
        cfgS11,
      );
      expect(d.advance).toBe(true);
      expect(d.reason).toBe('total_timeout');
      expect(d.skipRemaining).toBe(true);
    });

    it('优先级1 优于其他条件——即使未达 min_turns 也推进', () => {
      const d = shouldAdvanceStage(
        stageCtx({
          turnIndex: 1,
          totalElapsedSec: 950,
          signals: signals({ goal_coverage: 0.1 }),
        }),
        cfgS11,
      );
      expect(d.advance).toBe(true);
      expect(d.reason).toBe('total_timeout');
      expect(d.skipRemaining).toBe(true);
    });

    it('优先级2：达到 max_turns → 推进', () => {
      const d = shouldAdvanceStage(
        stageCtx({
          turnIndex: 5,
          totalElapsedSec: 100,
          signals: signals({ goal_coverage: 0.1 }),
        }),
        cfgS11,
      );
      expect(d.advance).toBe(true);
      expect(d.reason).toBe('max_turns');
      expect(d.skipRemaining).toBeUndefined();
    });

    it('优先级2：answer_vagueness >= 0.7 时 max_turns +1（不超 absolute_max）', () => {
      // S1.1 max=5, absolute=6
      // vagueness>=0.7 → max=6
      // turnIndex=5 不应推进（5 < 6）
      const d1 = shouldAdvanceStage(
        stageCtx({
          turnIndex: 5,
          signals: signals({ answer_vagueness: 0.7 }),
        }),
        cfgS11,
      );
      expect(d1.advance).toBe(false);
      // turnIndex=6 → 推进（达到 +1 后的上限 6）
      const d2 = shouldAdvanceStage(
        stageCtx({
          turnIndex: 6,
          signals: signals({ answer_vagueness: 0.9 }),
        }),
        cfgS11,
      );
      expect(d2.advance).toBe(true);
      expect(d2.reason).toBe('max_turns');
    });

    it('优先级2：vagueness 触发 +1 但被 absolute_max_turns 框住 (S1.3: max=6, absolute=8)', () => {
      // S1.3 vagueness>=0.7 → max=6+1=7, absolute=8
      // turnIndex=7 推进，8 也推进
      const d7 = shouldAdvanceStage(
        stageCtx({
          stageCode: 'S1.3',
          turnIndex: 7,
          signals: signals({ answer_vagueness: 0.8 }),
        }),
        cfgS13,
      );
      expect(d7.advance).toBe(true);
      expect(d7.reason).toBe('max_turns');
      // absolute_max_turns=8 不应被超过——turnIndex=8 必推进，9 也推进
      const d9 = shouldAdvanceStage(
        stageCtx({
          stageCode: 'S1.3',
          turnIndex: 9,
          signals: signals({ answer_vagueness: 0.9 }),
        }),
        cfgS13,
      );
      expect(d9.advance).toBe(true);
    });

    it('优先级3：goal_coverage >= 0.8 且达 min_turns → 推进', () => {
      // S1.1 min=3
      const d = shouldAdvanceStage(
        stageCtx({
          turnIndex: 3,
          signals: signals({ goal_coverage: 0.8, answer_vagueness: 0.1 }),
        }),
        cfgS11,
      );
      expect(d.advance).toBe(true);
      expect(d.reason).toBe('goal_covered');
    });

    it('未达 min_turns 时即使 goal_coverage=1.0 也不推进', () => {
      // S1.1 min=3, turnIndex=2
      const d = shouldAdvanceStage(
        stageCtx({
          turnIndex: 2,
          signals: signals({ goal_coverage: 1.0 }),
        }),
        cfgS11,
      );
      expect(d.advance).toBe(false);
    });

    it('goal_coverage < 0.8 时即使达 max_turns-1 也不推进', () => {
      // S1.1 max=5, turnIndex=4
      const d = shouldAdvanceStage(
        stageCtx({
          turnIndex: 4,
          signals: signals({ goal_coverage: 0.7 }),
        }),
        cfgS11,
      );
      expect(d.advance).toBe(false);
    });

    it('S1.2 同样适用规则', () => {
      // S1.2 max=5, min=3
      const d = shouldAdvanceStage(
        stageCtx({
          stageCode: 'S1.2',
          turnIndex: 3,
          signals: signals({ goal_coverage: 0.9 }),
        }),
        cfgS12,
      );
      expect(d.advance).toBe(true);
      expect(d.reason).toBe('goal_covered');
    });

    it('模型信号只是输入——同样 signals 在不同 turnIndex/elapsed 决策不同', () => {
      // 不变量 5：模型信号不能直接改变状态，状态机函数以 ctx 为输入做决策
      const s = signals({ goal_coverage: 0.85, answer_vagueness: 0.2 });
      const early = shouldAdvanceStage(
        stageCtx({ turnIndex: 1, signals: s }),
        cfgS11,
      );
      const enough = shouldAdvanceStage(
        stageCtx({ turnIndex: 3, signals: s }),
        cfgS11,
      );
      expect(early.advance).toBe(false);
      expect(enough.advance).toBe(true);
      expect(enough.reason).toBe('goal_covered');
    });
  });

  describe('onCandidateIdle (PRD 4.7)', () => {
    it('5 分钟 → warn_candidate', () => {
      const d = onCandidateIdle(300, 'examiner');
      expect(d.action).toBe('warn_candidate');
      expect(d).toMatchObject({ reason: 'idle_warn' });
    });

    it('10 分钟 + 考官模式 → force_advance_stage', () => {
      const d = onCandidateIdle(600, 'examiner');
      expect(d.action).toBe('force_advance_stage');
      expect(d).toMatchObject({ reason: 'idle_timeout' });
    });

    it('10 分钟 + 工具模式 → force_advance_task', () => {
      const d = onCandidateIdle(601, 'tool');
      expect(d.action).toBe('force_advance_task');
      expect(d).toMatchObject({ reason: 'idle_timeout' });
    });

    it('< 5 分钟 → none', () => {
      expect(onCandidateIdle(60, 'examiner').action).toBe('none');
      expect(onCandidateIdle(299, 'tool').action).toBe('none');
    });
  });

  describe('shouldRunS13 (PRD 4.2)', () => {
    const baseSignals = signals({});

    it('Q3 命中"给过同事用" → 触发', () => {
      const r = shouldRunS13({
        questionnaire: { q3: '给过同事用' },
        examinerSignals: [],
      });
      expect(r).toBe(true);
    });

    it('Q3 命中"有人主动来找我要" → 触发', () => {
      const r = shouldRunS13({
        questionnaire: { q3: '有人主动来找我要' },
        examinerSignals: [],
      });
      expect(r).toBe(true);
    });

    it('Q4 命中"经常" → 触发', () => {
      const r = shouldRunS13({
        questionnaire: { q4: '经常' },
        examinerSignals: [],
      });
      expect(r).toBe(true);
    });

    it('Q4 命中"我是团队里主要的答疑人" → 触发', () => {
      const r = shouldRunS13({
        questionnaire: { q4: '我是团队里主要的答疑人' },
        examinerSignals: [],
      });
      expect(r).toBe(true);
    });

    it('S1.1 出现 mentioned_process_change → 触发', () => {
      const recs: ExaminerSignalRecord[] = [
        { stageOrTask: 'S1.1', signals: { ...baseSignals, mentioned_process_change: true } },
      ];
      const r = shouldRunS13({
        questionnaire: { q3: '没用过', q4: '偶尔' },
        examinerSignals: recs,
      });
      expect(r).toBe(true);
    });

    it('S1.2 出现 mentioned_asset → 触发', () => {
      const recs: ExaminerSignalRecord[] = [
        { stageOrTask: 'S1.2', signals: { ...baseSignals, mentioned_asset: true } },
      ];
      const r = shouldRunS13({
        questionnaire: {},
        examinerSignals: recs,
      });
      expect(r).toBe(true);
    });

    it('S1.2 出现 mentioned_others_adoption → 触发', () => {
      const r = shouldRunS13({
        questionnaire: {},
        examinerSignals: [
          { stageOrTask: 'S1.2', signals: { ...baseSignals, mentioned_others_adoption: true } },
        ],
      });
      expect(r).toBe(true);
    });

    it('S1.2 出现 mentioned_team_driving → 触发', () => {
      const r = shouldRunS13({
        questionnaire: {},
        examinerSignals: [
          { stageOrTask: 'S1.2', signals: { ...baseSignals, mentioned_team_driving: true } },
        ],
      });
      expect(r).toBe(true);
    });

    it('S1.3 内部的 mentioned_* 不参与触发判定', () => {
      const r = shouldRunS13({
        questionnaire: {},
        examinerSignals: [
          { stageOrTask: 'S1.3', signals: { ...baseSignals, mentioned_process_change: true } },
        ],
      });
      expect(r).toBe(false);
    });

    it('Q3/Q4 不命中 + 无 mentioned_* → 不触发', () => {
      const r = shouldRunS13({
        questionnaire: { q3: '偶尔', q4: '偶尔' },
        examinerSignals: [
          { stageOrTask: 'S1.1', signals: baseSignals },
          { stageOrTask: 'S1.2', signals: baseSignals },
        ],
      });
      expect(r).toBe(false);
    });
  });

  describe('shouldTriggerInterview (PRD 4.5)', () => {
    const base: InterviewTriggerInput = {
      level: 'L2',
      track: '个人贡献者轨道',
      confidence: 0.8,
      claimRealityGapLevel: null,
      redLinesCount: 0,
    };

    it('条件1：level=L3_pending → 触发', () => {
      expect(shouldTriggerInterview({ ...base, level: 'L3_pending' })).toBe(true);
    });

    it('条件1：level=L4_pending → 触发', () => {
      expect(shouldTriggerInterview({ ...base, level: 'L4_pending' })).toBe(true);
    });

    it('条件2：track=团队负责人轨道 → 触发', () => {
      expect(
        shouldTriggerInterview({ ...base, track: '团队负责人轨道' }),
      ).toBe(true);
    });

    it('条件3：confidence < 0.6 → 触发', () => {
      expect(shouldTriggerInterview({ ...base, confidence: 0.59 })).toBe(true);
    });

    it('confidence = 0.6 不触发（边界不命中）', () => {
      expect(shouldTriggerInterview({ ...base, confidence: 0.6 })).toBe(false);
    });

    it('条件4：claimRealityGapLevel=重大 → 触发', () => {
      expect(
        shouldTriggerInterview({ ...base, claimRealityGapLevel: '重大' }),
      ).toBe(true);
    });

    it('条件5：redLinesCount > 0 → 触发', () => {
      expect(shouldTriggerInterview({ ...base, redLinesCount: 1 })).toBe(true);
    });

    it('不触发：L2 + confidence ≥ 0.6 + 无落差 + 无红线', () => {
      expect(shouldTriggerInterview(base)).toBe(false);
    });

    it('不触发：L3（确定等级，非 pending） + confidence 高 + 无其他条件', () => {
      expect(
        shouldTriggerInterview({ ...base, level: 'L3' }),
      ).toBe(false);
    });
  });

  describe('shouldMarkAbandoned (PRD 4.7)', () => {
    it('无对话记录 → 不放弃（candidates 未开始答题）', () => {
      expect(shouldMarkAbandoned(null)).toBe(false);
    });

    it('最近记录在 30 分钟内 → 不放弃', () => {
      const last = new Date(Date.now() - 10 * 60 * 1000);
      expect(shouldMarkAbandoned(last)).toBe(false);
    });

    it('最近记录超过 30 分钟 → 放弃', () => {
      const last = new Date(Date.now() - 31 * 60 * 1000);
      expect(shouldMarkAbandoned(last)).toBe(true);
    });
  });
});
