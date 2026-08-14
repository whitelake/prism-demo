// 三方一致性计算（架构 5.1 / PRD 4.9）
//
// 归一化规则（levels.yaml v0.4）：
//   L0=0, L1=1, L2=2, L3=3, L4=4
//   L4_pending=4（pending 视为对应等级参与比较）
//   "是否 pending" 不进入 gap 计算
//
// a_eq_b / b_eq_c / a_eq_c：仅在数值相等时为 true
// pending 与确定等级视为相等：
//   A=L4_pending, C=L4 → a_eq_c=true, gap=0
//
// B 的 level 字段不含 pending（面试官直接给确定等级 L0–L4）
//
// v0.4 变更：L3_pending 已废除。L3 可在阶段 A 直接确定输出。
// 唯一的 pending 等级是 L4_pending。

import { EVALUATION_LEVELS, normalizeLevel } from '@prism/shared';

// level → 数值映射，仅识别 v0.4 合法等级
// 先用字符串版 normalizeLevel 把 L4_pending 折叠为 L4，再查表
const LEVEL_VALUE: Record<string, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
};

// v0.4 合法等级集合——L3_pending 已废除，不应被静默接受
const VALID_EVALUATION_LEVELS = new Set<string>(EVALUATION_LEVELS);

// 数字版归一：合法等级返回 0-4，未知或已废除等级返回 null
// 用于 gap 计算。外部若需字符串归一（L4_pending → 'L4'）请用 @prism/shared 的 normalizeLevel
export function levelValue(level: string): number | null {
  if (!VALID_EVALUATION_LEVELS.has(level)) return null;
  const base = normalizeLevel(level);
  return LEVEL_VALUE[base] ?? null;
}

export interface ConsistencyInput {
  levelA: string | null; // A 可能 null（评估失败）
  levelB: string | null; // B 可能 null（未触发面试官环节）
  levelC: string | null; // C 可能 null（终判未产出）
}

export interface ConsistencyResult {
  levelA: string | null;
  levelB: string | null;
  levelC: string | null;
  aEqB: boolean | null;
  bEqC: boolean | null;
  aEqC: boolean | null;
  maxLevelGap: number | null;
}

export function computeConsistency(input: ConsistencyInput): ConsistencyResult {
  const a = input.levelA ? levelValue(input.levelA) : null;
  const b = input.levelB ? levelValue(input.levelB) : null;
  const c = input.levelC ? levelValue(input.levelC) : null;

  // 仅当两侧都有值时才计算相等与 gap
  const aEqB = a !== null && b !== null ? a === b : null;
  const bEqC = b !== null && c !== null ? b === c : null;
  const aEqC = a !== null && c !== null ? a === c : null;

  const gaps: number[] = [];
  if (a !== null && b !== null) gaps.push(Math.abs(a - b));
  if (b !== null && c !== null) gaps.push(Math.abs(b - c));
  if (a !== null && c !== null) gaps.push(Math.abs(a - c));
  const maxLevelGap = gaps.length > 0 ? Math.max(...gaps) : null;

  return {
    levelA: input.levelA,
    levelB: input.levelB,
    levelC: input.levelC,
    aEqB,
    bEqC,
    aEqC,
    maxLevelGap,
  };
}

// 一致性摘要字符串（架构 4.2 列表项 consistencySummary 字段）
// 三方齐备时返回 "一致" | "差1级" | "差2级+"；否则 null
export function consistencySummary(input: ConsistencyInput): string | null {
  if (input.levelA == null || input.levelB == null || input.levelC == null) {
    return null;
  }
  const r = computeConsistency(input);
  if (r.maxLevelGap == null) return null;
  if (r.maxLevelGap === 0) return '一致';
  if (r.maxLevelGap === 1) return '差1级';
  return '差2级+';
}
