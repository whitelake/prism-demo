import { Alert, Progress, Space, Typography } from 'antd';
import type { DialogueMode, TimerInfo } from '@prism/shared';

const { Text } = Typography;

interface Props {
  timer: TimerInfo;
  step: 'examiner' | 'tool';
  idleSec: number;
  showIdleWarn: boolean;
}

export function TimerBar({ timer, step, idleSec, showIdleWarn }: Props) {
  const examinerSec = timer.examinerTotalRemainingSec;
  const taskSec = timer.taskRemainingSec;
  const examinerTotal = 900;
  const taskTotal = 720;
  const remaining = step === 'tool' ? taskSec : examinerSec;
  const total = step === 'tool' ? taskTotal : examinerTotal;
  const percent = remaining != null && total > 0 ? Math.max(0, Math.min(100, (remaining / total) * 100)) : 0;
  const minutes = remaining != null ? Math.floor(remaining / 60) : 0;
  const seconds = remaining != null ? remaining % 60 : 0;
  const timeStr = remaining != null ? `${minutes}:${seconds.toString().padStart(2, '0')}` : '--:--';

  return (
    <div style={{ marginBottom: 8 }}>
      <Space size="middle" style={{ width: '100%', justifyContent: 'space-between' }}>
        <Text type="secondary">
          {step === 'tool' ? '任务剩余' : '考官对话剩余'}：{timeStr}
        </Text>
        {showIdleWarn && (
          <Text type="warning" style={{ fontSize: 12 }}>
            长时间未操作，即将自动跳过
          </Text>
        )}
      </Space>
      {remaining != null && (
        <Progress
          percent={percent}
          showInfo={false}
          size="small"
          status={percent < 20 ? 'exception' : 'active'}
          strokeColor={percent < 20 ? 'var(--pd-error)' : 'var(--pd-accent)'}
        />
      )}
      {showIdleWarn && (
        <Alert
          type="warning"
          message={`已空闲 ${idleSec} 秒，超过 ${timer.idleSkipAtSec} 秒将自动跳过本环节`}
          showIcon
          style={{ marginTop: 4, borderRadius: 'var(--pd-radius)' }}
        />
      )}
    </div>
  );
}

void 0 as unknown as DialogueMode;
