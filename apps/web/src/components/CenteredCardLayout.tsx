import { ReactNode } from 'react';
import { Card } from 'antd';

interface Props {
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  maxWidth?: number;
  extra?: ReactNode;
}

export function CenteredCardLayout({ title, subtitle, children, maxWidth = 720, extra }: Props) {
  return (
    <div className="page-canvas" style={{ display: 'flex', justifyContent: 'center' }}>
      <Card
        className="pd-card-enter"
        style={{ maxWidth: maxWidth, width: '100%', margin: '0 auto', boxShadow: 'var(--pd-shadow-card)' }}
      >
        {extra && <div style={{ marginBottom: 16 }}>{extra}</div>}
        {title}
        {subtitle}
        {children}
      </Card>
    </div>
  );
}
