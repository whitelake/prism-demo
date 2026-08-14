import {
  computeConsistency,
  consistencySummary,
  levelValue,
} from '@/assessment/consistency';
import { normalizeLevel } from '@prism/shared';

// PRD 4.9 / 架构 5.1 三方一致性计算
// 归一化（levels.yaml v0.4）：L0=0, L1=1, L2=2, L3=3, L4=4
//         L4_pending=4（pending 视为对应等级）
// v0.4 变更：L3_pending 已废除——L3 可在阶段 A 直接确定输出。
// B 不含 pending（面试官给确定等级 L0–L4）

describe('consistency 纯函数 (PoC 不变量 2 / PRD 4.9)', () => {
  describe('normalizeLevel (字符串版，@prism/shared)', () => {
    it('L4_pending → L4', () => {
      expect(normalizeLevel('L4_pending')).toBe('L4');
    });

    it('非 pending 等级原样返回', () => {
      expect(normalizeLevel('L0')).toBe('L0');
      expect(normalizeLevel('L4')).toBe('L4');
    });

    it('不校验合法性，未知字符串原样返回', () => {
      expect(normalizeLevel('L5')).toBe('L5');
      expect(normalizeLevel('L3_pending')).toBe('L3');
    });
  });

  describe('levelValue (数字版，consistency)', () => {
    it('L0-L4 → 0-4', () => {
      expect(levelValue('L0')).toBe(0);
      expect(levelValue('L1')).toBe(1);
      expect(levelValue('L2')).toBe(2);
      expect(levelValue('L3')).toBe(3);
      expect(levelValue('L4')).toBe(4);
    });

    it('L4_pending 视为 L4', () => {
      expect(levelValue('L4_pending')).toBe(4);
    });

    it('v0.4 已废除的 L3_pending 不再可识别', () => {
      expect(levelValue('L3_pending')).toBeNull();
    });

    it('未知字符串返回 null', () => {
      expect(levelValue('L5')).toBeNull();
      expect(levelValue('')).toBeNull();
    });
  });

  describe('computeConsistency', () => {
    it('三方齐备 + 全相等 → aEqB/bEqC/aEqC=true, gap=0', () => {
      const r = computeConsistency({
        levelA: 'L3',
        levelB: 'L3',
        levelC: 'L3',
      });
      expect(r.aEqB).toBe(true);
      expect(r.bEqC).toBe(true);
      expect(r.aEqC).toBe(true);
      expect(r.maxLevelGap).toBe(0);
    });

    it('A=L4_pending, C=L4 → pending 与确定等级视为相等', () => {
      const r = computeConsistency({
        levelA: 'L4_pending',
        levelB: 'L4',
        levelC: 'L4',
      });
      expect(r.aEqC).toBe(true);
      expect(r.aEqB).toBe(true); // L4_pending 与 L4 都归一为 4
      expect(r.maxLevelGap).toBe(0);
    });

    it('A=L4_pending, B=L3, C=L4 → gap=1', () => {
      const r = computeConsistency({
        levelA: 'L4_pending',
        levelB: 'L3',
        levelC: 'L4',
      });
      expect(r.aEqB).toBe(false); // 4 vs 3
      expect(r.bEqC).toBe(false); // 3 vs 4
      expect(r.aEqC).toBe(true); // 4 vs 4
      expect(r.maxLevelGap).toBe(1);
    });

    it('差 2 级 → gap=2', () => {
      const r = computeConsistency({
        levelA: 'L2',
        levelB: 'L4',
        levelC: 'L2',
      });
      expect(r.aEqB).toBe(false);
      expect(r.bEqC).toBe(false);
      expect(r.aEqC).toBe(true);
      expect(r.maxLevelGap).toBe(2);
    });

    it('B 未提交 → aEqB/bEqC=null, 仅算 aEqC', () => {
      const r = computeConsistency({
        levelA: 'L4_pending',
        levelB: null,
        levelC: 'L4',
      });
      expect(r.aEqB).toBeNull();
      expect(r.bEqC).toBeNull();
      expect(r.aEqC).toBe(true);
      expect(r.maxLevelGap).toBe(0);
    });

    it('C 未产出 → 仅算 aEqB', () => {
      const r = computeConsistency({
        levelA: 'L2',
        levelB: 'L2',
        levelC: null,
      });
      expect(r.aEqB).toBe(true);
      expect(r.bEqC).toBeNull();
      expect(r.aEqC).toBeNull();
      expect(r.maxLevelGap).toBe(0);
    });

    it('A 缺失 → 仅算 bEqC', () => {
      const r = computeConsistency({
        levelA: null,
        levelB: 'L2',
        levelC: 'L3',
      });
      expect(r.aEqB).toBeNull();
      expect(r.bEqC).toBe(false);
      expect(r.aEqC).toBeNull();
      expect(r.maxLevelGap).toBe(1);
    });

    it('三方均缺失 → gap=null', () => {
      const r = computeConsistency({
        levelA: null,
        levelB: null,
        levelC: null,
      });
      expect(r.aEqB).toBeNull();
      expect(r.bEqC).toBeNull();
      expect(r.aEqC).toBeNull();
      expect(r.maxLevelGap).toBeNull();
    });
  });

  describe('consistencySummary', () => {
    it('三方齐备 + gap=0 → "一致"', () => {
      expect(
        consistencySummary({
          levelA: 'L4_pending',
          levelB: 'L4',
          levelC: 'L4',
        }),
      ).toBe('一致');
    });

    it('三方齐备 + gap=1 → "差1级"', () => {
      expect(
        consistencySummary({
          levelA: 'L4_pending',
          levelB: 'L3',
          levelC: 'L4',
        }),
      ).toBe('差1级');
    });

    it('三方齐备 + gap=2 → "差2级+"', () => {
      expect(
        consistencySummary({
          levelA: 'L2',
          levelB: 'L4',
          levelC: 'L2',
        }),
      ).toBe('差2级+');
    });

    it('三方未齐备 → null', () => {
      expect(
        consistencySummary({
          levelA: 'L3',
          levelB: null,
          levelC: 'L3',
        }),
      ).toBeNull();
    });
  });
});
