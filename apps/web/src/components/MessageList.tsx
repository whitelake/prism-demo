import { Alert, Card, Spin, Typography } from 'antd';
import type { DialogueMessage, DialogueMode } from '@prism/shared';

const { Text, Paragraph } = Typography;

interface Props {
  messages: DialogueMessage[];
  mode: DialogueMode;
  streamingAiId?: number;
  streamingText?: string;
  thinking?: boolean;
  thinkingText?: string;
}

// 候选人/ai 气泡 + system_card 卡片。系统卡片与普通消息明显区分（frontend.md）。
// 外层 div 的 alignSelf inline style 保留以兼容单测；内层气泡用 class。
export function MessageList({ messages, mode, streamingAiId, streamingText, thinking, thinkingText }: Props) {
  const aiBubbleClass = mode === 'tool' ? 'pd-bubble pd-bubble--tool' : 'pd-bubble pd-bubble--examiner';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {messages.map((m) => {
        if (m.type === 'system_card') {
          return <SystemCardView key={m.id} msg={m} />;
        }
        const isCandidate = m.type === 'candidate';
        const isStreaming = streamingAiId === m.id;
        return (
          <div
            key={m.id}
            style={{
              alignSelf: isCandidate ? 'flex-end' : 'flex-start',
              maxWidth: '80%',
            }}
          >
            <div className={isCandidate ? 'pd-bubble pd-bubble--candidate' : aiBubbleClass}>
              {isStreaming && (streamingText || '')}
              {!isStreaming && m.content}
              {isStreaming && <span className="cursor">▋</span>}
            </div>
          </div>
        );
      })}
      {/* 思考中气泡：examiner 模式提交后等响应、tool 模式 accepted 后等首个 delta */}
      {thinking && !streamingAiId && (
        <div style={{ alignSelf: 'flex-start', maxWidth: '80%' }}>
          <div className="pd-bubble pd-bubble--thinking">
            <Spin size="small" />
            <span>{thinkingText || '正在思考...'}</span>
          </div>
        </div>
      )}
      {/* 流式中尚未落库的 ai 气泡 */}
      {streamingAiId && !messages.some((m) => m.id === streamingAiId) && (
        <div style={{ alignSelf: 'flex-start', maxWidth: '80%' }}>
          <div className={aiBubbleClass}>
            {streamingText || ''}
            <span className="cursor">▋</span>
          </div>
        </div>
      )}
      {/* mode 标识条 */}
      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <div className={`mode-pill ${mode === 'tool' ? 'mode-pill--tool' : 'mode-pill--examiner'}`}>
          <span className="dot" />
          {mode === 'tool' ? '当前为普通AI助手' : '考官对话中'}
        </div>
      </div>
    </div>
  );
}

function SystemCardView({ msg }: { msg: DialogueMessage }) {
  if (!msg.card) return null;
  const { variant, title, body, attachment } = msg.card;
  // 顶部 accent line 颜色按 variant 区分；与 AI 气泡形状明显不同（更大圆角 + 标题栏 + 更宽）
  const accentColor =
    variant === 'mode_switch'
      ? 'var(--pd-warn)'
      : variant === 'task_brief'
      ? 'var(--pd-accent)'
      : variant === 'task_done'
      ? 'var(--pd-success)'
      : 'var(--pd-border-2)';
  const cardStyle: React.CSSProperties = {
    margin: '8px 0',
    background: 'var(--pd-surface)',
    borderColor: 'var(--pd-border)',
    borderRadius: 'var(--pd-radius-lg)',
    boxShadow: 'var(--pd-shadow-card)',
    borderTop: `2px solid ${accentColor}`,
  };
  return (
    <Card size="small" style={cardStyle} title={title}>
      {body && <Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: attachment ? 12 : 0 }}>{body}</Paragraph>}
      {attachment && (
        <Card size="small" type="inner" title={attachment.label} style={{ marginTop: 8 }}>
          <Text style={{ whiteSpace: 'pre-wrap' }}>{attachment.content}</Text>
        </Card>
      )}
      {variant === 'mode_switch' && (
        <Alert
          type="warning"
          message="接下来是不同的对话模式"
          description={undefined}
          showIcon
          style={{ marginTop: 8 }}
        />
      )}
    </Card>
  );
}
