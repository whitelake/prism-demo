import { Card, Descriptions, Empty, List, Tag, Typography } from 'antd';
import type { RawLog } from '@prism/shared';

const { Text, Paragraph } = Typography;

const STAGE_NAMES: Record<string, string> = {
  'S1.1': '开场校验',
  'S1.2': '使用深度',
  'S1.3': '流程改造',
  T1: '任务一：催货邮件',
  T2: '任务二：信息核查',
};

export function RawLogView({ rawLog }: { rawLog: RawLog }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title="问卷">
        {rawLog.questionnaire ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="Q1 频率">{rawLog.questionnaire.q1 ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Q2 付费工具">
              {Array.isArray(rawLog.questionnaire.q2) ? rawLog.questionnaire.q2.join('、') : String(rawLog.questionnaire.q2 ?? '—')}
            </Descriptions.Item>
            <Descriptions.Item label="Q3">{rawLog.questionnaire.q3 ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Q4">{rawLog.questionnaire.q4 ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="Q5">{rawLog.questionnaire.q5 ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="提交时间">
              {new Date(rawLog.questionnaire.submittedAt).toLocaleString()}
            </Descriptions.Item>
          </Descriptions>
        ) : (
          <Empty description="问卷未提交" />
        )}
      </Card>

      <Card size="small" title="考官对话">
        <DialogueList items={rawLog.examinerDialogue} />
      </Card>

      <Card size="small" title="工具任务">
        <DialogueList items={rawLog.toolDialogue} />
      </Card>
    </div>
  );
}

function DialogueList({ items }: { items: RawLog['examinerDialogue'] }) {
  if (items.length === 0) return <Empty description="无对话记录" />;
  // 按 stageOrTask 分组
  const groups: Record<string, typeof items> = {};
  for (const it of items) {
    const key = it.stageOrTask;
    (groups[key] ??= []).push(it);
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {Object.entries(groups).map(([stage, turns]) => (
        <div key={stage}>
          <Tag color="blue">
            {stage} · {STAGE_NAMES[stage] ?? stage}
          </Tag>
          <List
            size="small"
            dataSource={turns}
            renderItem={(t) => (
              <List.Item style={{ alignItems: 'flex-start', flexDirection: 'column' }}>
                <div>
                  <Text type="secondary">
                    [{t.role === 'ai' ? 'AI' : '候选人'}] turn {t.turnIndex}
                    {t.responseIntervalSec != null ? ` · 响应 ${t.responseIntervalSec}s` : ''}
                    {' · '}{new Date(t.ts).toLocaleTimeString()}
                  </Text>
                </div>
                <Paragraph style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{t.content}</Paragraph>
              </List.Item>
            )}
          />
        </div>
      ))}
    </div>
  );
}
