import { useState } from 'react';
import { Alert, Button, Card, Form, Input, Typography } from 'antd';
import { useNavigate, useLocation } from 'react-router-dom';
import { interviewerApi, setJwt, ApiException } from '../../api/client';

const { Title, Paragraph } = Typography;

interface LocationState {
  from?: string;
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');

  async function handleSubmit() {
    if (!account || !password) {
      setError('请输入账号和密码');
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const resp = await interviewerApi.login(account, password);
      setJwt(resp.token);
      const from = (location.state as LocationState | null)?.from || '/interviewer';
      navigate(from, { replace: true });
    } catch (e) {
      const err = e as ApiException;
      setError(err.code === 'CREDENTIAL_INVALID' ? '账号或密码错误' : err.message || '登录失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 480, margin: '80px auto', padding: 24 }}>
      <Card>
        <Title level={3}>面试官登录</Title>
        <Paragraph type="secondary">prism-demo 测评管理后台</Paragraph>
        <Form layout="vertical" onFinish={handleSubmit}>
          <Form.Item label="账号" required>
            <Input value={account} onChange={(e) => setAccount(e.target.value)} placeholder="面试官账号" />
          </Form.Item>
          <Form.Item label="密码" required>
            <Input.Password value={password} onChange={(e) => setPassword(e.target.value)} placeholder="密码" />
          </Form.Item>
          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
          <Button type="primary" htmlType="submit" loading={loading} block>
            登录
          </Button>
        </Form>
      </Card>
    </div>
  );
}
