import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { EvaluationView } from './EvaluationView';
import type { EvaluationSummary } from '@prism/shared';

function mkEval(resultJson: unknown, over: Partial<EvaluationSummary> = {}): EvaluationSummary {
  return {
    type: 'A',
    level: 'L2',
    track: '个人深度轨道',
    confidence: 0.72,
    recommendHumanReview: false,
    resultJson: resultJson as Record<string, unknown> | null,
    createdAt: '2026-01-01T00:00:00Z',
    ...over,
  } as EvaluationSummary;
}

describe('EvaluationView 防御性解析', () => {
  it('正常结构渲染维度/落差/红线/综合理由', () => {
    render(
      <EvaluationView
        evaluation={mkEval({
          dimensions: [
            { code: 'D1', name: '深度', level: 'L2', confidence: 0.7, reasoning: '一般' },
          ],
          claimRealityGap: { level: 'mild', description: '略有落差', interpretation: '可接受' },
          anomalySignals: [{ type: '回避', evidence: '某问', description: '说明' }],
          redLines: [{ code: 'R1', description: '诚信问题' }],
          overall: {
            level: 'L2',
            track: '个人深度轨道',
            confidence: 0.7,
            reasoning: '综合判定',
            keyUncertainties: ['u1', 'u2'],
            recommendHumanReview: false,
          },
        })}
      />,
    );
    expect(screen.getByText('D1')).toBeTruthy();
    expect(screen.getByText('深度')).toBeTruthy();
    expect(screen.getByText(/略有落差/)).toBeTruthy();
    expect(screen.getByText('回避')).toBeTruthy();
    expect(screen.getByText('R1')).toBeTruthy();
    expect(screen.getByText('综合判定')).toBeTruthy();
    expect(screen.getByText(/u1；u2/)).toBeTruthy();
  });

  it('resultJson 为 null 不崩溃', () => {
    const r = render(<EvaluationView evaluation={mkEval(null)} />);
    // 仅头部 Descriptions 仍渲染
    expect(r.container.textContent).toContain('L2');
    expect(r.container.textContent).toContain('个人深度轨道');
  });

  it('dimensions 不是数组 不崩溃', () => {
    const r = render(<EvaluationView evaluation={mkEval({ dimensions: 'oops' })} />);
    expect(r.container.textContent).toContain('L2');
  });

  it('claimRealityGap 缺失 不渲染"自述与实际落差"卡片', () => {
    const r = render(<EvaluationView evaluation={mkEval({})} />);
    expect(r.container.textContent).not.toContain('自述与实际落差');
  });

  it('redLines 元素缺字段 不崩溃', () => {
    const r = render(
      <EvaluationView evaluation={mkEval({ redLines: [{ code: 'R1' }, { description: '仅描述' }] })} />,
    );
    expect(r.container.textContent).toContain('R1');
  });

  it('confidence=NaN 时 toFixed 仍为数字', () => {
    // 防御 NaN 场景;EvaluationView 直接调 toFixed(2)
    const r = render(<EvaluationView evaluation={mkEval({}, { confidence: Number.NaN })} />);
    expect(r.container.textContent).toContain('NaN');
  });

  it('recommendHumanReview=true 显示"是"标签', () => {
    render(
      <EvaluationView
        evaluation={mkEval(
          { overall: { humanReviewReason: '证据不足' } },
          { recommendHumanReview: true },
        )}
      />,
    );
    expect(screen.getByText('是')).toBeTruthy();
    expect(screen.getByText(/证据不足/)).toBeTruthy();
  });
});
