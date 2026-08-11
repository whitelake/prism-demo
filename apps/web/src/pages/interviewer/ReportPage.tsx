import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import type { Report, LockedReport, UnlockedReport } from '@prism/shared';
import { interviewerApi, ApiException } from '../../api/client';
import { RawLogView } from './RawLogView';
import { OutlineView } from './OutlineView';
import { EvaluationView } from './EvaluationView';

const { Title, Paragraph, Text } = Typography;

const LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'];
const TRACKS = ['个人深度轨道', '团队负责人轨道', '无法判断'];

export function ReportPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  // 轮询状态（提交 B 后 / 加载 final_evaluating）
  const [polling, setPolling] = useState(false);
  const [pollCount, setPollCount] = useState(0);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const r = await interviewerApi.getReport(id);
      setReport(r);
    } catch (e) {
      const err = e as ApiException;
      if (err.status === 401) {
        navigate('/login');
        return;
      }
      if (err.code === 'FORBIDDEN') {
        setError('无权访问该测评');
      } else {
        setError(err.message || '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, [id, navigate]);

  useEffect(() => {
    void load();
  }, [load]);

  // 轮询：每 3s 拉一次 status，locked=false 后停止并 reload report
  useEffect(() => {
    if (!polling || !report) return;
    if (pollCount >= 40) {
      message.warning('生成时间较长，请手动刷新');
      setPolling(false);
      return;
    }
    pollTimerRef.current = setTimeout(async () => {
      try {
        const st = await interviewerApi.getStatus(id);
        setPollCount((c) => c + 1);
        if (!st.locked) {
          setPolling(false);
          await load();
        }
      } catch {
        setPolling(false);
      }
    }, 3000);
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [polling, pollCount, id, report, load]);

  if (loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: 960, margin: '24px auto', padding: 24 }}>
        <Alert type="error" message={error} showIcon />
        <Button style={{ marginTop: 16 }} onClick={() => navigate('/interviewer')}>
          返回列表
        </Button>
      </div>
    );
  }

  if (!report) return null;

  return (
    <div style={{ maxWidth: 960, margin: '24px auto', padding: 24 }}>
      <Card>
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <Space direction="vertical" size={0}>
            <Title level={3} style={{ margin: 0 }}>
              {report.assessment.candidateName} · {report.assessment.position || '—'}
            </Title>
            <Space>
              <Tag color={report.locked ? 'orange' : 'green'}>{report.statusLabel}</Tag>
              <Text type="secondary">ID: {report.assessment.id}</Text>
              {report.assessment.submittedAt && (
                <Text type="secondary">提交于 {new Date(report.assessment.submittedAt).toLocaleString()}</Text>
              )}
            </Space>
          </Space>
          <Button onClick={() => navigate('/interviewer')}>返回列表</Button>
        </Space>
      </Card>

      {polling && (
        <Card style={{ marginTop: 16 }}>
          <Alert
            type="info"
            message={`正在生成终判结论（${pollCount}/40）...`}
            description="已提交独立判断 B，正在生成 C。完成后将自动展示。"
            showIcon
          />
        </Card>
      )}

      <div style={{ marginTop: 16 }}>
        {report.locked ? (
          <LockedView
            report={report}
            onSubmitJudgment={async () => {
              setPolling(true);
              setPollCount(0);
              // 立即调一次 load，让状态从 final_evaluating 进入；report 仍 locked（final_evaluating）
              await load();
            }}
          />
        ) : (
          <UnlockedView report={report} onPollingDone={load} onPolling={setPolling} />
        )}
      </div>
    </div>
  );
}

function LockedView({ report, onSubmitJudgment }: { report: LockedReport; onSubmitJudgment: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small">
        <Alert type="warning" message={report.lockNotice} showIcon />
      </Card>
      <OutlineView outline={report.outline} />
      <RawLogView rawLog={report.rawLog} />
      <TranscriptEditor assessmentId={report.assessment.id} initialDraft={report.transcriptDraft ?? ''} />
      <JudgmentForm assessmentId={report.assessment.id} transcriptSeed={report.transcriptDraft ?? ''} onSubmitted={onSubmitJudgment} />
    </div>
  );
}

function UnlockedView({
  report,
  onPollingDone,
  onPolling,
}: {
  report: UnlockedReport;
  onPollingDone: () => void;
  onPolling: (v: boolean) => void;
}) {
  const { id } = useParams();
  const [reevaluating, setReevaluating] = useState(false);
  const [abandonModalOpen, setAbandonModalOpen] = useState(false);
  const [abandonReason, setAbandonReason] = useState('');

  async function handleReevaluate() {
    setReevaluating(true);
    try {
      await interviewerApi.reevaluate(id!, 'all');
      onPolling(true);
      message.success('已重新触发评估');
    } catch (e) {
      const err = e as ApiException;
      message.error(err.message || '重新评估失败');
    } finally {
      setReevaluating(false);
    }
  }

  async function handleAbandon() {
    try {
      await interviewerApi.abandon(id!, abandonReason || '候选人主动退出');
      setAbandonModalOpen(false);
      message.success('已标记放弃');
      await onPollingDone();
    } catch (e) {
      const err = e as ApiException;
      message.error(err.message || '放弃失败');
    }
  }

  // 失败情形
  if (report.status === 'eval_failed' || report.failureInfo) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Card size="small">
          <Alert
            type="error"
            message="评估失败"
            description={report.failureInfo?.reason || '模型评估过程出错'}
            showIcon
          />
          {report.failureInfo && (
            <Paragraph type="secondary" style={{ marginTop: 8 }}>
              失败阶段：{report.failureInfo.stage} · 时间：{new Date(report.failureInfo.occurredAt).toLocaleString()}
            </Paragraph>
          )}
          <Space style={{ marginTop: 12 }}>
            <Button type="primary" loading={reevaluating} onClick={handleReevaluate}>
              重新评估
            </Button>
            <Button onClick={() => setAbandonModalOpen(true)}>标记放弃</Button>
          </Space>
        </Card>
        <RawLogView rawLog={report.rawLog} />
        <Modal
          open={abandonModalOpen}
          title="标记放弃"
          onCancel={() => setAbandonModalOpen(false)}
          onOk={handleAbandon}
          okText="确认"
        >
          <Input.TextArea
            value={abandonReason}
            onChange={(e) => setAbandonReason(e.target.value)}
            placeholder="放弃原因（可选）"
            autoSize={{ minRows: 2 }}
          />
        </Modal>
      </div>
    );
  }

  // 解锁态
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Card size="small" title="三方对比">
        <Descriptions column={3} size="small" bordered>
          <Descriptions.Item label="A 大模型初判">{report.evaluationA?.level ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="B 面试官判断">{report.judgmentB?.level ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="C 大模型终判">{report.evaluationC?.level ?? '—'}</Descriptions.Item>
        </Descriptions>
      </Card>

      {report.evaluationA && <EvaluationView evaluation={report.evaluationA} title="A · 大模型初判" />}

      {report.judgmentB && (
        <Card
          size="small"
          title="B · 面试官独立判断"
          extra={<Text type="secondary">{new Date(report.judgmentB.submittedAt ?? Date.now()).toLocaleString()}</Text>}
        >
          <Descriptions column={2} size="small" bordered>
            <Descriptions.Item label="等级">{report.judgmentB.level}</Descriptions.Item>
            <Descriptions.Item label="轨道">{report.judgmentB.track}</Descriptions.Item>
          </Descriptions>
          <Paragraph style={{ margin: '12px 0 0', whiteSpace: 'pre-wrap' }}>{report.judgmentB.reason}</Paragraph>
          {report.judgmentB.transcript && (
            <Card type="inner" title="面试记录" size="small" style={{ marginTop: 12 }}>
              <Paragraph style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{report.judgmentB.transcript}</Paragraph>
            </Card>
          )}
        </Card>
      )}

      {report.evaluationC && <EvaluationView evaluation={report.evaluationC} title="C · 大模型终判" />}

      <RawLogView rawLog={report.rawLog} />

      <Space>
        <Button onClick={() => setAbandonModalOpen(true)}>标记放弃</Button>
        <Button onClick={() => window.open(interviewerApi.getExportUrl(id!), '_blank')}>导出原始数据</Button>
      </Space>
      <Modal
        open={abandonModalOpen}
        title="标记放弃"
        onCancel={() => setAbandonModalOpen(false)}
        onOk={handleAbandon}
        okText="确认"
      >
        <Input.TextArea
          value={abandonReason}
          onChange={(e) => setAbandonReason(e.target.value)}
          placeholder="放弃原因（可选）"
          autoSize={{ minRows: 2 }}
        />
      </Modal>
    </div>
  );
}

function TranscriptEditor({ assessmentId, initialDraft }: { assessmentId: string; initialDraft: string }) {
  const [text, setText] = useState(initialDraft);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const dirtyRef = useRef(false);

  useEffect(() => {
    setText(initialDraft);
    dirtyRef.current = false;
  }, [initialDraft]);

  // 30s 自动保存
  useEffect(() => {
    const t = setInterval(() => {
      if (dirtyRef.current) void save();
    }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function save() {
    if (!dirtyRef.current) return;
    setSaving(true);
    try {
      await interviewerApi.saveTranscript(assessmentId, text);
      dirtyRef.current = false;
      setLastSavedAt(new Date());
    } catch (e) {
      const err = e as ApiException;
      if (err.code === 'JUDGMENT_SUBMITTED') {
        message.info('已提交判断，记录已锁定');
      } else {
        message.error(err.message || '保存失败');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card
      size="small"
      title="面试记录"
      extra={
        <Space>
          <Text type="secondary">
            {saving ? '保存中...' : lastSavedAt ? `已保存 ${lastSavedAt.toLocaleTimeString()}` : ''}
          </Text>
          <Button size="small" onClick={() => void save()}>
            保存草稿
          </Button>
        </Space>
      }
    >
      <Input.TextArea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          dirtyRef.current = true;
        }}
        placeholder="录入面试官与候选人的对话记录"
        autoSize={{ minRows: 8, maxRows: 24 }}
        maxLength={100000}
      />
    </Card>
  );
}

function JudgmentForm({
  assessmentId,
  transcriptSeed,
  onSubmitted,
}: {
  assessmentId: string;
  transcriptSeed: string;
  onSubmitted: () => void;
}) {
  const [form] = Form.useForm();
  const [submitting, setSubmitting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingBody, setPendingBody] = useState<{ level: string; track: string; reason: string; transcript: string } | null>(null);

  async function submit(body: { level: string; track: string; reason: string; transcript: string; confirm?: boolean }) {
    setSubmitting(true);
    try {
      const resp = await interviewerApi.submitJudgment(assessmentId, body);
      if (resp.needConfirm) {
        setPendingBody(body);
        setConfirmOpen(true);
      } else {
        message.success(resp.message || '已提交');
        onSubmitted();
      }
    } catch (e) {
      const err = e as ApiException;
      if (err.code === 'JUDGMENT_ALREADY_SUBMITTED') {
        message.info('已提交过判断');
        onSubmitted();
      } else {
        message.error(err.message || '提交失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOk() {
    const values = await form.validateFields();
    // 确认对话框（不可逆提示）
    Modal.confirm({
      title: '提交后将不可修改',
      content: '提交后会展示AI的评估结论（C 终判约需 30 秒）。确认提交？',
      okText: '确认提交',
      cancelText: '取消',
      onOk: () =>
        submit({
          level: values.level,
          track: values.track,
          reason: values.reason,
          transcript: values.transcript ?? transcriptSeed,
        }),
    });
  }

  async function handleConfirmOk() {
    setConfirmOpen(false);
    if (pendingBody) {
      await submit({ ...pendingBody, confirm: true });
      setPendingBody(null);
    }
  }

  return (
    <Card size="small" title="独立判断 B">
      <Form form={form} layout="vertical">
        <Form.Item label="等级" name="level" rules={[{ required: true, message: '请选择等级' }]}>
          <Select options={LEVELS.map((l) => ({ value: l, label: l }))} placeholder="选择 L0-L4" />
        </Form.Item>
        <Form.Item label="轨道" name="track" rules={[{ required: true, message: '请选择轨道' }]}>
          <Select options={TRACKS.map((t) => ({ value: t, label: t }))} />
        </Form.Item>
        <Form.Item
          label="判断理由"
          name="reason"
          rules={[{ required: true, message: '请填写理由' }, { min: 30, message: '至少 30 字' }, { max: 2000 }]}
        >
          <Input.TextArea placeholder="30-2000 字符" autoSize={{ minRows: 3, maxRows: 8 }} />
        </Form.Item>
        <Form.Item
          label="面试记录（提交后即锁定）"
          name="transcript"
          rules={[{ required: true, message: '请录入面试记录' }]}
          initialValue={transcriptSeed}
        >
          <Input.TextArea autoSize={{ minRows: 6, maxRows: 16 }} maxLength={100000} />
        </Form.Item>
        <Button type="primary" loading={submitting} onClick={handleOk} block>
          提交独立判断 B
        </Button>
      </Form>
      <Modal
        open={confirmOpen}
        title="面试记录较短"
        okText="确认提交"
        cancelText="返回补充"
        onCancel={() => setConfirmOpen(false)}
        onOk={handleConfirmOk}
      >
        <Paragraph>
          面试记录较短（{pendingBody?.transcript.length ?? 0}字），可能影响终判质量。是否确认提交？
        </Paragraph>
      </Modal>
    </Card>
  );
}
