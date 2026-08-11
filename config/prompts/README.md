# Prompts 目录

本目录下所有 prompt 文件由**产品团队维护**，工程侧不得自行改写内容（见 `.claude/CLAUDE.md`）。

## 文件清单

| 文件 | 用途 | Schema | 插值变量 | 调用点 |
|------|------|--------|----------|--------|
| `examiner.md` | 考官模式对话（S1.1/S1.2/S1.3） | `ExaminerResponseSchema` | `candidate_name` / `position` / `stage_code` / `stage_goal` / `max_turns` / `turn_index` / `questionnaire_result` | `context.builder.ts#buildExaminerContext` |
| `tool.md` | 工具模式 AI 助手（静态） | 无（自由文本） | **无**（`assertNoVariables` 强制） | `context.builder.ts#getToolPrompt` |
| `outline.md` | 面试官追问题纲生成 | `OutlineResponseSchema` | `full_log` | `outline.service.ts#runOutline` |
| `evaluation.md` | A 评估 + C 终判（共用，差异在 `interview_transcript` 是否为 null） | `EvaluationResponseSchema` | `level_definitions` / `full_log` | `initial-evaluation.service.ts#runInitialEvaluation`、`final-evaluation.service.ts#runFinalEvaluation` |

## 一致性核对状态

工程侧已核对全部 4 个 prompt 与对应 schema 字段一致（2026-08-06）：

- `examiner.md` 输出 JSON 字段 = `ExaminerResponseSchema`（`question` + 6 个 signals）
- `tool.md` 无插值变量（不变量 1：工具模式静态 prompt）
- `outline.md` 输出 JSON 字段 = `OutlineResponseSchema`（`questions[]` + `note`）
- `evaluation.md` 输出 JSON 字段 = `EvaluationResponseSchema`（`dimensions[6]` / `claim_reality_gap` / `anomaly_signals` / `red_lines` / `overall` / `judgment_change`），含 R1–R7 硬规则、字段取值约束、有/无面试记录的差异化要求

## 变更流程

1. 产品团队修改 prompt 内容 → 提交 PR
2. 工程侧核对 schema 一致性 → 必要时更新 `*.schema.ts`
3. 跑 `test/invariants/` + `test/e2e/` 回归
4. 上线前完整回归

如发现 prompt 与 schema 不一致，**报告问题，不静默兼容**（见 `.claude/CLAUDE.md`）。
