import {
  AssessmentStatus,
  isALocked,
} from '@/assessment/assessment.state';
import {
  filterReport,
  filterListItem,
  stripSignals,
  buildExportPayload,
  type ReportFilterInput,
  type EvaluationSummary,
  type JudgmentSummary,
  type OutlineSummary,
  type RawLogDto,
  type DialogueLogDtoItem,
  type AssessmentReportMeta,
} from '@/assessment/report.filter';

// PoC 不变量 2：A 结论锁定
// 详见 docs/architecture.md 4.2、.claude/rules/testing.md "结论锁定"
// 对应 api-spec 8.1 锁定验证用例 A1-A6
//
// PoC 不变量 3：signals 不下发
// 对应 api-spec 8.3 用例 C3：GET /report 响应不含 signals 键

function makeAssessment(
  status: AssessmentStatus,
  over: Partial<AssessmentReportMeta> = {},
): AssessmentReportMeta {
  return {
    id: 'A1',
    candidateName: '李明',
    position: '市场经理',
    status,
    submittedAt: new Date('2026-01-01T00:00:00.000+08:00'),
    createdAt: new Date('2026-01-01T00:00:00.000+08:00'),
    ...over,
  };
}

function makeEvalA(level = 'L3_pending'): EvaluationSummary {
  return {
    id: 'evalA1',
    type: 'A',
    level,
    track: '团队负责人轨道',
    confidence: 0.55,
    recommendHumanReview: true,
    resultJson: {
      dimensions: [
        { code: 'D5', level: 'L3', reasoning: '候选人自述中提及流程改造' },
      ],
      claim_reality_gap: { level: '重大' },
      red_lines: [{ code: 'RL1' }],
    },
    createdAt: new Date('2026-01-01T00:00:00.000+08:00'),
  };
}

function makeEvalC(): EvaluationSummary {
  return {
    id: 'evalC1',
    type: 'C',
    level: 'L3',
    track: '团队负责人轨道',
    confidence: 0.75,
    recommendHumanReview: false,
    resultJson: { final: true },
    createdAt: new Date('2026-01-01T00:00:00.000+08:00'),
  };
}

function makeJudgmentB(submitted: boolean): JudgmentSummary {
  return {
    assessmentId: 'A1',
    level: 'L3',
    track: '团队负责人轨道',
    reason: '候选人描述具体且能回答追问',
    transcript: submitted ? '面试记录正文…' : '',
    transcriptDraft: submitted ? null : '草稿内容',
    submittedAt: submitted ? new Date('2026-01-01T00:00:00.000+08:00') : null,
  };
}

function makeOutline(): OutlineSummary {
  return {
    assessmentId: 'A1',
    status: 'success',
    resultJson: { questions: [] },
    createdAt: new Date('2026-01-01T00:00:00.000+08:00'),
  };
}

function makeRawLog(withSignals = true): RawLogDto {
  const examiner: DialogueLogDtoItem[] = [
    {
      mode: 'examiner',
      stageOrTask: 'S1.1',
      turnIndex: 1,
      role: 'ai',
      content: '请描述你最近一次使用AI的具体场景',
      responseIntervalSec: null,
      ts: new Date('2026-01-01T00:00:00.000+08:00'),
      ...(withSignals ? { signals: { goal_coverage: 0.5, answer_vagueness: 0.3 } } : {}),
    },
    {
      mode: 'examiner',
      stageOrTask: 'S1.1',
      turnIndex: 1,
      role: 'candidate',
      content: '上周我用AI写了邮件',
      responseIntervalSec: 8,
      ts: new Date('2026-01-01T00:00:05.000+08:00'),
    },
  ];
  const tool: DialogueLogDtoItem[] = [
    {
      mode: 'tool',
      stageOrTask: 'T1',
      turnIndex: 1,
      role: 'candidate',
      content: '帮我写催收邮件',
      responseIntervalSec: 12,
      ts: new Date('2026-01-01T00:00:10.000+08:00'),
    },
  ];
  return {
    questionnaire: {
      q1: '每天多次',
      q2: { tools: ['ChatGPT'] },
      q3: '给过同事用',
      q4: '经常',
      q5: '数据清洗',
      submittedAt: new Date('2026-01-01T00:00:00.000+08:00'),
    },
    examinerDialogue: examiner,
    toolDialogue: tool,
  };
}

describe('报告过滤 A 结论锁定 (PoC 不变量 2)', () => {
  describe('A1: pending_interview 调 /report 不返回 evaluationA/level/confidence/dimensions 键名', () => {
    it('锁定态 DTO 不含 evaluationA/evaluationC/judgmentB/failureInfo 键', () => {
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.PENDING_INTERVIEW),
        evaluationA: makeEvalA(),
        evaluationC: null,
        judgmentB: null,
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      };
      const dto = filterReport(input);
      expect(dto.locked).toBe(true);
      // 联合类型在 locked=true 分支下不存在 evaluationA 字段
      expect('evaluationA' in dto).toBe(false);
      expect('evaluationC' in dto).toBe(false);
      expect('judgmentB' in dto).toBe(false);
      expect('failureInfo' in dto).toBe(false);
    });

    it('序列化后不含 evaluationA / level / confidence / dimensions 键名', () => {
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.PENDING_INTERVIEW),
        evaluationA: makeEvalA(),
        evaluationC: null,
        judgmentB: null,
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      };
      const text = JSON.stringify(filterReport(input));
      expect(text).not.toContain('evaluationA');
      expect(text).not.toContain('evaluationC');
      expect(text).not.toContain('"level"');
      expect(text).not.toContain('"confidence"');
      expect(text).not.toContain('"dimensions"');
      expect(text).not.toContain('"track"');
    });
  });

  describe('A2: 全文正则 /L[0-4]/ 无匹配（pending_interview）', () => {
    it('锁定期响应不出现 L0-L4 字符串', () => {
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.PENDING_INTERVIEW),
        evaluationA: makeEvalA('L3_pending'),
        evaluationC: null,
        judgmentB: null,
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      };
      const text = JSON.stringify(filterReport(input));
      expect(text).not.toMatch(/L[0-4]/);
    });
  });

  describe('A3: final_evaluating 同 A1/A2', () => {
    it('锁定期同样过滤 evaluationA/C（即使 B 已提交也不暴露 A）', () => {
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.FINAL_EVALUATING),
        evaluationA: makeEvalA('L4_pending'),
        evaluationC: null,
        judgmentB: makeJudgmentB(true),
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      };
      const dto = filterReport(input);
      expect(dto.locked).toBe(true);
      expect('evaluationA' in dto).toBe(false);
      expect('evaluationC' in dto).toBe(false);
      // 锁定期不返回完整 judgmentB（仅 transcriptDraft），故 judgmentB.level 不暴露
      expect('judgmentB' in dto).toBe(false);
      const text = JSON.stringify(dto);
      expect(text).not.toContain('"level"');
      expect(text).not.toContain('"confidence"');
      expect(text).not.toContain('"dimensions"');
      expect(text).not.toMatch(/L[0-4]/);
    });
  });

  describe('A5: 提交B后立即调 /report 仍为 locked', () => {
    it('状态仍为 final_evaluating 时 locked=true（解锁触发点唯一）', () => {
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.FINAL_EVALUATING),
        evaluationA: makeEvalA(),
        evaluationC: null, // C 尚未产出
        judgmentB: makeJudgmentB(true), // B 已提交
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      };
      const dto = filterReport(input);
      expect(dto.locked).toBe(true);
      expect('evaluationA' in dto).toBe(false);
    });
  });

  describe('A6: 终判完成（completed）调 /report evaluationA 与 evaluationC 均存在', () => {
    it('解锁后返回完整 evaluationA/C', () => {
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.COMPLETED),
        evaluationA: makeEvalA(),
        evaluationC: makeEvalC(),
        judgmentB: makeJudgmentB(true),
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      };
      const dto = filterReport(input);
      expect(dto.locked).toBe(false);
      if (dto.locked) throw new Error('unreachable');
      expect(dto.evaluationA).not.toBeNull();
      expect(dto.evaluationC).not.toBeNull();
      expect(dto.evaluationA?.level).toBe('L3_pending');
      expect(dto.evaluationC?.level).toBe('L3');
    });
  });

  describe('解锁触发点唯一（架构 4.2 强制约束3）', () => {
    it('isALocked 与 filterReport 锁定判定一致', () => {
      // 二者必须保持一致——解锁路径唯一
      for (const s of Object.values(AssessmentStatus)) {
        const stateLocked = isALocked(s);
        const filterLocked =
          s === AssessmentStatus.PENDING_INTERVIEW ||
          s === AssessmentStatus.FINAL_EVALUATING;
        expect(stateLocked).toBe(filterLocked);
      }
    });

    it('PENDING_INTERVIEW 不能仅靠提交B解锁——B 提交后状态先去 final_evaluating', () => {
      // 状态机 canTransition 已经保证此路径
      // 这里再次验证：B 已提交但状态为 final_evaluating 时仍 locked
      const dto = filterReport({
        assessment: makeAssessment(AssessmentStatus.FINAL_EVALUATING),
        evaluationA: makeEvalA(),
        evaluationC: null,
        judgmentB: makeJudgmentB(true),
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: null,
      });
      expect(dto.locked).toBe(true);
    });
  });

  describe('eval_failed 状态', () => {
    it('A 锁定不暴露——eval_failed 也不返回 evaluationA 内容', () => {
      // eval_failed 时 evaluationA 可能为 null（A 失败）或保留之前的 A
      // 但 status=eval_failed 在 PENDING/FINAL 链路上时，架构上未解锁
      const input: ReportFilterInput = {
        assessment: makeAssessment(AssessmentStatus.EVAL_FAILED),
        evaluationA: null,
        evaluationC: null,
        judgmentB: null,
        outline: makeOutline(),
        rawLog: makeRawLog(),
        failureInfo: {
          stage: 'evaluation_a',
          reason: 'JSON parse fail',
          occurredAt: new Date(),
          canRetry: true,
        },
      };
      const dto = filterReport(input);
      expect(dto.locked).toBe(false);
      if (dto.locked) throw new Error('unreachable');
      expect(dto.evaluationA).toBeNull();
      expect(dto.failureInfo).not.toBeNull();
      expect(dto.failureInfo?.stage).toBe('evaluation_a');
    });
  });
});

describe('列表过滤 (PoC 不变量 2 + api-spec 8.1 A4)', () => {
  it('pending_interview 状态 levelDisplay="待验证"，无 level 键', () => {
    const item = filterListItem(
      makeAssessment(AssessmentStatus.PENDING_INTERVIEW),
      makeEvalA(),
    );
    expect(item.levelDisplay).toBe('待验证');
    const text = JSON.stringify(item);
    expect(text).not.toContain('"level"');
    expect(text).not.toContain('"confidence"');
  });

  it('final_evaluating 状态 levelDisplay="待验证"', () => {
    const item = filterListItem(
      makeAssessment(AssessmentStatus.FINAL_EVALUATING),
      makeEvalA(),
    );
    expect(item.levelDisplay).toBe('待验证');
  });

  it('eval_failed 状态 levelDisplay="待验证"', () => {
    const item = filterListItem(
      makeAssessment(AssessmentStatus.EVAL_FAILED),
      null,
    );
    expect(item.levelDisplay).toBe('待验证');
  });

  it('evaluating 状态且 A 未产出 levelDisplay=null', () => {
    const item = filterListItem(
      makeAssessment(AssessmentStatus.EVALUATING),
      null,
    );
    expect(item.levelDisplay).toBeNull();
  });

  it('completed 状态返回 A 的真实等级', () => {
    const item = filterListItem(
      makeAssessment(AssessmentStatus.COMPLETED),
      makeEvalA('L2'),
    );
    expect(item.levelDisplay).toBe('L2');
  });

  it('列表项不含 level/confidence 原始字段名（levelDisplay 是字符串包装）', () => {
    const item = filterListItem(
      makeAssessment(AssessmentStatus.COMPLETED),
      makeEvalA('L2'),
    );
    const text = JSON.stringify(item);
    expect(text).not.toContain('"level"');
    expect(text).not.toContain('"confidence"');
    expect(text).toContain('"levelDisplay":"L2"');
  });
});

describe('signals 不下发 (PoC 不变量 3 + api-spec 8.3 C3)', () => {
  it('filterReport 输出 rawLog 不含 signals 键', () => {
    const input: ReportFilterInput = {
      assessment: makeAssessment(AssessmentStatus.COMPLETED),
      evaluationA: makeEvalA(),
      evaluationC: makeEvalC(),
      judgmentB: makeJudgmentB(true),
      outline: makeOutline(),
      rawLog: makeRawLog(true), // 输入 rawLog 含 signals
      failureInfo: null,
    };
    const dto = filterReport(input);
    const text = JSON.stringify(dto.rawLog);
    expect(text).not.toContain('signals');
    expect(text).not.toContain('goal_coverage');
    expect(text).not.toContain('answer_vagueness');
  });

  it('stripSignals 不修改入参', () => {
    const raw = makeRawLog(true);
    const before = JSON.stringify(raw);
    stripSignals(raw);
    const after = JSON.stringify(raw);
    expect(before).toBe(after);
    // 原对象仍含 signals 字段
    expect(raw.examinerDialogue[0]?.signals).toBeDefined();
  });

  it('export 接口（buildExportPayload）保留 signals（C4 例外）', () => {
    const input: ReportFilterInput = {
      assessment: makeAssessment(AssessmentStatus.COMPLETED),
      evaluationA: makeEvalA(),
      evaluationC: makeEvalC(),
      judgmentB: makeJudgmentB(true),
      outline: makeOutline(),
      rawLog: makeRawLog(true),
      failureInfo: null,
    };
    const payload = buildExportPayload(input, null, []);
    const text = JSON.stringify(payload.dialogueLog);
    expect(text).toContain('signals');
    expect(text).toContain('goal_coverage');
  });

  it('export 接口锁定期仍隐藏 evaluationA（export 不绕过 A 锁定）', () => {
    const input: ReportFilterInput = {
      assessment: makeAssessment(AssessmentStatus.PENDING_INTERVIEW),
      evaluationA: makeEvalA(),
      evaluationC: null,
      judgmentB: null,
      outline: makeOutline(),
      rawLog: makeRawLog(true),
      failureInfo: null,
    };
    const payload = buildExportPayload(input, null, []);
    expect(payload.evaluationA).toBeNull();
    expect(payload.evaluationC).toBeNull();
    // 但 signals 字段仍保留（export 唯一例外）
    const text = JSON.stringify(payload.dialogueLog);
    expect(text).toContain('signals');
  });
});
