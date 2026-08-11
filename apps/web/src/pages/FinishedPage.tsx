import { Card, Result } from 'antd';

interface Props {
  message: string;
  submittedAt?: string;
}

export function FinishedPage({ message, submittedAt }: Props) {
  return (
    <div style={{ maxWidth: 720, margin: '80px auto', padding: 24 }}>
      <Card>
        <Result
          status="success"
          title="测评已提交"
          subTitle={message}
          extra={submittedAt ? <div style={{ color: '#999' }}>提交时间：{submittedAt}</div> : undefined}
        />
      </Card>
    </div>
  );
}
