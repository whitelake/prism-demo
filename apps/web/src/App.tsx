import { Typography } from 'antd';

const { Title, Paragraph } = Typography;

export function App() {
  return (
    <div style={{ padding: 24 }}>
      <Title level={2}>prism-demo</Title>
      <Paragraph>AI素质测评PoC前端脚手架。</Paragraph>
    </div>
  );
}
