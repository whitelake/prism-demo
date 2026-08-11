import { describe, it, expect } from 'vitest';
import { appendMessages } from './DialoguePage';
import type { DialogueMessage } from '@prism/shared';

const m = (id: number, content: string): DialogueMessage => ({
  id,
  type: 'ai',
  mode: 'examiner',
  content,
  ts: '',
});

describe('appendMessages', () => {
  it('news 为 undefined 直接返回 prev', () => {
    const prev = [m(1, 'a')];
    expect(appendMessages(prev, undefined)).toBe(prev);
  });

  it('news 为空数组直接返回 prev', () => {
    const prev = [m(1, 'a')];
    expect(appendMessages(prev, [])).toBe(prev);
  });

  it('无重复时全量追加', () => {
    const prev = [m(1, 'a')];
    const next = appendMessages(prev, [m(2, 'b'), m(3, 'c')]);
    expect(next.map((x) => x.id)).toEqual([1, 2, 3]);
  });

  it('对 prev 与 news 中重复 id 去重(保留 prev 顺序)', () => {
    const prev = [m(1, 'a'), m(2, 'b')];
    const next = appendMessages(prev, [m(2, 'B-new'), m(3, 'c')]);
    expect(next.map((x) => x.id)).toEqual([1, 2, 3]);
    // id=2 的内容保持 prev 原值(旧消息不会被覆盖)
    expect(next.find((x) => x.id === 2)?.content).toBe('b');
  });

  it('news 内部重复也去重', () => {
    const next = appendMessages([], [m(5, 'x'), m(5, 'x-dup'), m(6, 'y')]);
    expect(next.map((x) => x.id)).toEqual([5, 6]);
  });
});
