import { Result } from 'antd';
import { CenteredCardLayout } from '../components/CenteredCardLayout';

interface Props {
  message: string;
  submittedAt?: string;
}

export function FinishedPage({ message, submittedAt }: Props) {
  return (
    <CenteredCardLayout>
      <Result
        status="success"
        title="测评已提交"
        subTitle={message}
        extra={submittedAt ? <div style={{ color: 'var(--pd-text-3)' }}>提交时间：{submittedAt}</div> : undefined}
      />
    </CenteredCardLayout>
  );
}
