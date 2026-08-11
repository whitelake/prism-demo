import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import type { ListItem } from '@prism/shared';
import { interviewerApi, ApiException, clearJwt, getInterviewer } from '../../api/client';

const { Title, Paragraph, Text } = Typography;

const STATUS_OPTIONS = [
  { value: '', label: '全部' },
  { value: 'not_started', label: '未开始' },
  { value: 'in_progress', label: '进行中' },
  { value: 'evaluating', label: '评估中' },
  { value: 'pending_interview', label: '待现场验证' },
  { value: 'final_evaluating', label: '终判中' },
  { value: 'completed', label: '已完成' },
  { value: 'eval_failed', label: '评估失败' },
  { value: 'abandoned', label: '已放弃' },
];

const STATUS_COLOR: Record<string, string> = {
  not_started: 'default',
  in_progress: 'processing',
  evaluating: 'processing',
  pending_interview: 'warning',
  final_evaluating: 'warning',
  completed: 'success',
  eval_failed: 'error',
  abandoned: 'default',
};

export function AssessmentListPage() {
  const navigate = useNavigate();
  const interviewer = getInterviewer();
  const [items, setItems] = useState<ListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const resp = await interviewerApi.list({
        status: status || undefined,
        keyword: keyword || undefined,
        page,
        pageSize,
      });
      setItems(resp.items);
      setTotal(resp.total);
    } catch (e) {
      const err = e as ApiException;
      if (err.status === 401) {
        clearJwt();
        navigate('/login');
        return;
      }
      setError(err.message || '加载失败');
    } finally {
      setLoading(false);
    }
  }, [status, keyword, page, pageSize, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  const columns: ColumnsType<ListItem> = [
    {
      title: '候选人',
      dataIndex: 'candidateName',
      key: 'candidateName',
      render: (v: string, r) => (
        <a onClick={() => navigate(`/interviewer/assessments/${r.id}`)}>{v}</a>
      ),
    },
    { title: '岗位', dataIndex: 'position', key: 'position' },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      render: (v: string, r) => <Tag color={STATUS_COLOR[v] || 'default'}>{r.statusLabel}</Tag>,
    },
    {
      title: 'A 等级',
      dataIndex: 'levelDisplay',
      key: 'levelDisplay',
      render: (v: string | null) => v ?? <Text type="secondary">—</Text>,
    },
    {
      title: '提交时间',
      dataIndex: 'submittedAt',
      key: 'submittedAt',
      render: (v: string | null) => (v ? new Date(v).toLocaleString() : '—'),
    },
    {
      title: '创建时间',
      dataIndex: 'createdAt',
      key: 'createdAt',
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  async function handleCreate() {
    const values = await createForm.validateFields();
    setCreating(true);
    try {
      const resp = await interviewerApi.create(values.candidateName, values.position);
      message.success('测评已创建');
      setCreateOpen(false);
      createForm.resetFields();
      // 复制链接
      await navigator.clipboard.writeText(resp.link).catch(() => undefined);
      message.info('候选人链接已复制到剪贴板');
      await load();
    } catch (e) {
      const err = e as ApiException;
      message.error(err.message || '创建失败');
    } finally {
      setCreating(false);
    }
  }

  return (
    <div style={{ maxWidth: 1200, margin: '24px auto', padding: 24 }}>
      <Card>
        <Space style={{ justifyContent: 'space-between', width: '100%', marginBottom: 16 }}>
          <div>
            <Title level={3} style={{ margin: 0 }}>
              测评管理
            </Title>
            <Paragraph type="secondary" style={{ margin: 0 }}>
              {interviewer ? `欢迎，${interviewer.name}` : ''}
            </Paragraph>
          </div>
          <Space>
            <Button onClick={() => { clearJwt(); navigate('/login'); }}>退出登录</Button>
            <Button type="primary" onClick={() => setCreateOpen(true)}>
              创建测评
            </Button>
          </Space>
        </Space>

        <Space style={{ marginBottom: 16 }} wrap>
          <Select
            value={status}
            onChange={(v) => { setStatus(v); setPage(1); }}
            options={STATUS_OPTIONS}
            style={{ width: 180 }}
          />
          <Input.Search
            placeholder="按候选人/岗位搜索"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onSearch={() => { setPage(1); void load(); }}
            style={{ width: 240 }}
            allowClear
          />
          <Button onClick={() => { setPage(1); void load(); }}>刷新</Button>
        </Space>

        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}

        <Table<ListItem>
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={loading}
          pagination={{
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            onChange: (p, s) => { setPage(p); setPageSize(s); },
          }}
        />
      </Card>

      <Modal
        open={createOpen}
        title="创建测评"
        onCancel={() => setCreateOpen(false)}
        confirmLoading={creating}
        onOk={handleCreate}
        okText="创建并复制链接"
      >
        <Form form={createForm} layout="vertical">
          <Form.Item
            label="候选人姓名"
            name="candidateName"
            rules={[{ required: true, message: '请输入姓名' }, { max: 20 }]}
          >
            <Input placeholder="1-20 字符" />
          </Form.Item>
          <Form.Item label="岗位" name="position" rules={[{ max: 100 }]}>
            <Input placeholder="可选；PoC 阶段约定填 TEST" />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
