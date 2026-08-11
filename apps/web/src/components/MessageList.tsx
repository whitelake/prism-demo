import { Alert, Card, Spin, Tag, Typography } from 'antd';
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
export function MessageList({ messages, mode, streamingAiId, streamingText, thinking, thinkingText }: Props) {
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
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 12,
                background: isCandidate ? '#1677ff22' : '#f5f5f5',
                border: isCandidate ? '1px solid #1677ff55' : '1px solid #e8e8e8',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
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
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: '#f5f5f5',
              border: '1px solid #e8e8e8',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <Spin size="small" />
            <span style={{ color: '#999', fontSize: 14 }}>{thinkingText || '正在思考...'}</span>
          </div>
        </div>
      )}
      {/* 流式中尚未落库的 ai 气泡 */}
      {streamingAiId && !messages.some((m) => m.id === streamingAiId) && (
        <div style={{ alignSelf: 'flex-start', maxWidth: '80%' }}>
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 12,
              background: '#f5f5f5',
              border: '1px solid #e8e8e8',
              whiteSpace: 'pre-wrap',
            }}
          >
            {streamingText || ''}
            <span className="cursor">▋</span>
          </div>
        </div>
      )}
      {/* mode 标识条 */}
      <div style={{ textAlign: 'center', marginTop: 8 }}>
        <Tag color={mode === 'tool' ? 'green' : 'blue'}>
          {mode === 'tool' ? '当前为普通AI助手' : '考官对话中'}
        </Tag>
      </div>
    </div>
  );
}

function SystemCardView({ msg }: { msg: DialogueMessage }) {
  if (!msg.card) return null;
  const { variant, title, body, attachment } = msg.card;
  const cardStyle =
    variant === 'mode_switch'
      ? { background: '#fff7e6', borderColor: '#ffd591' }
      : variant === 'task_brief'
      ? { background: '#f6ffed', borderColor: '#b7eb8f' }
      : variant === 'task_done'
      ? { background: '#f0f5ff', borderColor: '#adc6ff' }
      : { background: '#fafafa', borderColor: '#d9d9d9' };
  return (
    <Card size="small" style={{ margin: '8px 0', ...cardStyle }} title={title}>
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
