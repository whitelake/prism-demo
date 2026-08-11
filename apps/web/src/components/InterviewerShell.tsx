import { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Space } from 'antd';
import { clearJwt, getInterviewer } from '../api/client';

interface Props {
  children: ReactNode;
  maxWidth?: number;
  showBack?: boolean;
}

export function InterviewerShell({ children, maxWidth = 1200, showBack }: Props) {
  const navigate = useNavigate();
  const interviewer = getInterviewer();

  return (
    <div style={{ minHeight: '100vh' }}>
      <header className="glass-surface" style={{ position: 'sticky', top: 0, zIndex: 10 }}>
        <div
          style={{
            maxWidth,
            margin: '0 auto',
            padding: '12px 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 18, color: 'var(--pd-accent)' }}>◐</span>
            <span style={{ fontSize: 16, fontWeight: 500, letterSpacing: '0.04em' }}>PRISM</span>
          </div>
          <Space>
            {interviewer && (
              <span style={{ color: 'var(--pd-text-2)', fontSize: 13 }}>{interviewer.name}</span>
            )}
            {showBack && <Button size="small" onClick={() => navigate('/interviewer')}>返回列表</Button>}
            <Button size="small" onClick={() => { clearJwt(); navigate('/login'); }}>退出</Button>
          </Space>
        </div>
      </header>
      <main style={{ maxWidth, margin: '0 auto', padding: 24 }}>{children}</main>
    </div>
  );
}
