import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageList } from './MessageList';
import type { DialogueMessage, DialogueMode } from '@prism/shared';

function mk(
  messages: DialogueMessage[],
  opts: { mode?: DialogueMode; streamingAiId?: number; streamingText?: string } = {},
) {
  return render(
    <MessageList messages={messages} mode={opts.mode ?? 'examiner'} streamingAiId={opts.streamingAiId} streamingText={opts.streamingText} />,
  );
}

describe('MessageList', () => {
  it('candidate 气泡靠右、ai 气泡靠左', () => {
    mk([
      { id: 1, type: 'candidate', mode: 'examiner', content: '你好', ts: '2026-01-01T00:00:00Z' },
      { id: 2, type: 'ai', mode: 'examiner', content: '请回答', ts: '2026-01-01T00:00:01Z' },
    ]);
    const items = document.querySelectorAll('[style*="flex-end"], [style*="flex-start"]');
    expect(items.length).toBeGreaterThanOrEqual(2);
    // 内容应该都被渲染
    expect(screen.getByText('你好')).toBeTruthy();
    expect(screen.getByText('请回答')).toBeTruthy();
  });

  it('system_card mode_switch 渲染告警', () => {
    mk([
      {
        id: 1,
        type: 'system_card',
        mode: 'examiner',
        content: '',
        ts: '',
        card: { variant: 'mode_switch', title: '切换为工具模式', body: "" },
      },
    ]);
    expect(screen.getByText('切换为工具模式')).toBeTruthy();
    expect(screen.getByText('接下来是不同的对话模式')).toBeTruthy();
  });

  it('system_card task_brief 渲染 attachment', () => {
    mk([
      {
        id: 1,
        type: 'system_card',
        mode: 'tool',
        content: '',
        ts: '',
        card: {
          variant: 'task_brief',
          title: 'T1',
          body: '请催收邮件',
          attachment: { label: '资料', content: '客户名:Zhang' },
        },
      },
    ]);
    expect(screen.getByText('T1')).toBeTruthy();
    expect(screen.getByText('请催收邮件')).toBeTruthy();
    expect(screen.getByText('资料')).toBeTruthy();
    expect(screen.getByText('客户名:Zhang')).toBeTruthy();
  });

  it('system_card task_done 渲染', () => {
    mk([
      {
        id: 1,
        type: 'system_card',
        mode: 'tool',
        content: '',
        ts: '',
        card: { variant: 'task_done', title: 'T1 已完成', body: "" },
      },
    ]);
    expect(screen.getByText('T1 已完成')).toBeTruthy();
  });

  it('streamingAiId 命中已落库消息时显示流式文本', () => {
    mk(
      [{ id: 5, type: 'ai', mode: 'tool', content: '旧内容', ts: '' }],
      { mode: 'tool', streamingAiId: 5, streamingText: '流式中...' },
    );
    expect(screen.getByText('流式中...')).toBeTruthy();
  });

  it('streamingAiId 未落库时显示临时流式气泡', () => {
    mk([], { mode: 'tool', streamingAiId: -1, streamingText: '正在生成' });
    expect(screen.getByText('正在生成')).toBeTruthy();
  });

  it('mode tag 显示考官/工具', () => {
    const r1 = mk([], { mode: 'examiner' });
    expect(r1.container.textContent).toContain('考官对话中');
    const r2 = mk([], { mode: 'tool' });
    expect(r2.container.textContent).toContain('当前为普通AI助手');
  });
});
