// 等级 / 维度 / 轨道 / 证据等级 常量。
// 与 config/levels.yaml v0.4、config/dimensions.yaml v0.1 对齐。
// 修改后需同步更新 api-types.ts 的类型别名与 apps/api 的 Zod schema。

export const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export const PENDING_LEVELS = ['L4_pending'] as const;
export const EVALUATION_LEVELS = [...LEVELS, ...PENDING_LEVELS] as const;
export const EVIDENCE_GRADES = ['E0', 'E1', 'E2', 'E3'] as const;
export const DIMENSION_CODES = ['D1', 'D2', 'D3', 'D4'] as const;
export const DIMENSION_COUNT = DIMENSION_CODES.length;
export const TRACKS = ['个人深度轨道', '团队负责人轨道', '无法判断', '无'] as const;

// 等级上限代号（levels.yaml 第四章 level_caps，evaluation.md 第六章 LC1–LC5）
export const LEVEL_CAP_CODES = ['LC1', 'LC2', 'LC3', 'LC4', 'LC5'] as const;

// 安全红线代号（evaluation.md 第七章 RL1–RL4，独立于等级）
export const RED_LINE_CODES = ['RL1', 'RL2', 'RL3', 'RL4'] as const;

// D4 外溢形式（gate_checks.l4_gate.spillover_form）
export const SPILLOVER_FORMS = ['他人采纳', '流程改造', '组织机制'] as const;

// 阶段 A 允许的 overall.level 取值——不含 'L4'，L4 必须输出 L4_pending
export const EVALUATION_A_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4_pending'] as const;

// 一致性对比：L4_pending 视为等于 L4
// 仅做字符串归一，不做合法性校验；未知字符串原样返回
export const normalizeLevel = (l: string): string => l.replace(/_pending$/, '');
