import { Alert, Card, Empty, List, Typography } from 'antd';
import type { OutlineSummary } from '@prism/shared';

const { Paragraph, Text } = Typography;

interface OutlineQuestion {
  index?: number;
  quote?: string;
  ask?: string;
  verify?: string;
}

function parseOutlineQuestions(resultJson: unknown): OutlineQuestion[] {
  if (!resultJson || typeof resultJson !== 'object') return [];
  const obj = resultJson as { questions?: OutlineQuestion[] };
  return Array.isArray(obj.questions) ? obj.questions : [];
}

export function OutlineView({ outline }: { outline: OutlineSummary | null }) {
  if (!outline) {
    return (
      <Card size="small" title="追问题纲">
        <Empty description="题纲未生成" />
      </Card>
    );
  }
  const questions = parseOutlineQuestions(outline.resultJson);
  return (
    <Card
      size="small"
      title={`追问题纲（${outline.status === 'success' ? '成功' : '生成失败'}）`}
      extra={<Text type="secondary">{new Date(outline.createdAt).toLocaleString()}</Text>}
    >
      {outline.status !== 'success' && (
        <Alert type="warning" message="题纲生成失败，仅展示原始记录供人工追问" showIcon style={{ marginBottom: 12 }} />
      )}
      <List
        size="small"
        dataSource={questions}
        renderItem={(q, i) => (
          <List.Item style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
            <div>
              <Text strong>问题 {q.index ?? i + 1}</Text>
            </div>
            {q.quote && (
              <Paragraph type="secondary" style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>
                原话：{q.quote}
              </Paragraph>
            )}
            {q.ask && (
              <Paragraph style={{ margin: '4px 0', whiteSpace: 'pre-wrap' }}>
                <Text strong>追问：</Text>
                {q.ask}
              </Paragraph>
            )}
            {q.verify && (
              <Paragraph type="secondary" style={{ margin: '4px 0' }}>
                验证点：{q.verify}
              </Paragraph>
            )}
          </List.Item>
        )}
      />
    </Card>
  );
}
