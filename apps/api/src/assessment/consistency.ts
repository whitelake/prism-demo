// 三方一致性计算（架构 5.1 / PRD 4.9）
//
// 归一化规则：
//   L0=0, L1=1, L2=2, L3=3, L4=4
//   L3_pending=3, L4_pending=4（pending 视为对应等级参与比较）
//   "是否 pending" 不进入 gap 计算
//
// a_eq_b / b_eq_c / a_eq_c：仅在数值相等时为 true
// pending 与确定等级视为相等：
//   A=L3_pending, C=L3 → a_eq_c=true, gap=0
//
// B 的 level 字段不含 pending（面试官直接给确定等级 L0–L4）

export type LevelString =
  | 'L0'
  | 'L1'
  | 'L2'
  | 'L3'
  | 'L4'
  | 'L3_pending'
  | 'L4_pending';

const LEVEL_VALUE: Record<LevelString, number> = {
  L0: 0,
  L1: 1,
  L2: 2,
  L3: 3,
  L4: 4,
  L3_pending: 3,
  L4_pending: 4,
};

export function normalizeLevel(level: string): number | null {
  if (level in LEVEL_VALUE) {
    return LEVEL_VALUE[level as LevelString];
  }
  return null;
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
  const a = input.levelA ? normalizeLevel(input.levelA) : null;
  const b = input.levelB ? normalizeLevel(input.levelB) : null;
  const c = input.levelC ? normalizeLevel(input.levelC) : null;

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
