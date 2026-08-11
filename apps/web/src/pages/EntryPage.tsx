import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import type { EntryInfo } from '@prism/shared';
import { candidateApi, ApiException } from '../api/client';

const { Title, Paragraph, Text } = Typography;

interface Props {
  token: string;
  entry: EntryInfo;
  onStarted: () => void;
}

export function EntryPage({ token, entry, onStarted }: Props) {
  const [name, setName] = useState(entry.candidateName || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  async function handleStart() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('请输入你的姓名');
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      await candidateApi.start(token, trimmed);
      onStarted();
    } catch (e) {
      const err = e as ApiException;
      if (err.code === 'ALREADY_STARTED') {
        onStarted();
        return;
      }
      setError(err.message || '启动失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 24 }}>
      <Card>
        <Title level={3}>{entry.position} 测评</Title>
        <Paragraph type="secondary">预计 {entry.estimatedMinutes} 分钟</Paragraph>
        <Paragraph style={{ whiteSpace: 'pre-wrap' }}>{entry.notice}</Paragraph>
        <Form layout="vertical" onFinish={handleStart}>
          <Form.Item label="确认你的姓名" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={20} placeholder="如面试官录入有误可修改" />
          </Form.Item>
          {error && (
            <Form.Item>
              <Alert type="error" message={error} showIcon />
            </Form.Item>
          )}
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={loading} block>
              开始测评
            </Button>
          </Form.Item>
        </Form>
        <Text type="secondary">开始后即视为同意按实际情况作答。</Text>
      </Card>
    </div>
  );
}
