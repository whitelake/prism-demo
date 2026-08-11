import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TimerBar } from './TimerBar';
import type { TimerInfo } from '@prism/shared';

function baseTimer(over: Partial<TimerInfo> = {}): TimerInfo {
  return {
    examinerTotalRemainingSec: 800,
    taskRemainingSec: 600,
    idleWarningAtSec: 300,
    idleSkipAtSec: 600,
    lastActivityTs: '2026-01-01T00:00:00Z',
    ...over,
  } as TimerInfo;
}

describe('TimerBar', () => {
  it('tool 步骤显示 taskRemainingSec 格式 mm:ss', () => {
    render(<TimerBar timer={baseTimer({ taskRemainingSec: 125 })} step="tool" idleSec={0} showIdleWarn={false} />);
    // 125s = 2:05
    expect(screen.getByText(/2:05/)).toBeTruthy();
  });

  it('examiner 步骤显示 examinerTotalRemainingSec', () => {
    render(<TimerBar timer={baseTimer({ examinerTotalRemainingSec: 65 })} step="examiner" idleSec={0} showIdleWarn={false} />);
    expect(screen.getByText(/1:05/)).toBeTruthy();
  });

  it('remaining 为 null 显示 --:--', () => {
    render(<TimerBar timer={baseTimer({ taskRemainingSec: null, examinerTotalRemainingSec: null })} step="tool" idleSec={0} showIdleWarn={false} />);
    expect(screen.getByText(/--:--/)).toBeTruthy();
  });

  it('showIdleWarn=true 显示空闲告警', () => {
    render(<TimerBar timer={baseTimer({ idleSkipAtSec: 600 })} step="tool" idleSec={310} showIdleWarn={true} />);
    expect(screen.getByText(/已空闲 310 秒/)).toBeTruthy();
    expect(screen.getByText(/超过 600 秒将自动跳过本环节/)).toBeTruthy();
  });

  it('showIdleWarn=false 不显示空闲告警', () => {
    const r = render(<TimerBar timer={baseTimer()} step="tool" idleSec={0} showIdleWarn={false} />);
    expect(r.container.textContent).not.toContain('已空闲');
  });

  it('tool 步骤文案为"任务剩余"', () => {
    render(<TimerBar timer={baseTimer()} step="tool" idleSec={0} showIdleWarn={false} />);
    expect(screen.getByText(/任务剩余/)).toBeTruthy();
  });

  it('examiner 步骤文案为"考官对话剩余"', () => {
    render(<TimerBar timer={baseTimer()} step="examiner" idleSec={0} showIdleWarn={false} />);
    expect(screen.getByText(/考官对话剩余/)).toBeTruthy();
  });
});
