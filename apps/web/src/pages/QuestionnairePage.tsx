import { useEffect, useState } from 'react';
import { Alert, Button, Card, Checkbox, Form, Radio, Typography, message } from 'antd';
import type { QuestionItem, QuestionnaireAnswers, StepResponse } from '@prism/shared';
import { candidateApi, ApiException } from '../api/client';

const { Title, Paragraph } = Typography;

interface Props {
  token: string;
  onSubmitted: (resp: StepResponse) => void;
}

export function QuestionnairePage({ token, onSubmitted }: Props) {
  const [questions, setQuestions] = useState<QuestionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [answers, setAnswers] = useState<QuestionnaireAnswers>({});

  useEffect(() => {
    candidateApi
      .getQuestionnaire(token)
      .then((data) => {
        setQuestions(data.questions || []);
        setLoading(false);
      })
      .catch((e: ApiException) => {
        setError(e.message);
        setLoading(false);
      });
  }, [token]);

  function setSingle(code: string, value: string) {
    setAnswers((s) => ({ ...s, [code]: value }));
  }
  function setMultiple(code: string, values: string[]) {
    setAnswers((s) => ({ ...s, [code]: values }));
  }

  function handleSubmit() {
    // 校验必答
    for (const q of questions) {
      if (!q.required) continue;
      const v = answers[q.code];
      if (v == null || (Array.isArray(v) && v.length === 0) || (typeof v === 'string' && !v.trim())) {
        setError(`请完成题号 ${q.code}`);
        return;
      }
      if (q.type === 'multiple' && q.minSelect && Array.isArray(v) && v.length < q.minSelect) {
        setError(`${q.code} 至少选 ${q.minSelect} 项`);
        return;
      }
    }
    setSubmitting(true);
    candidateApi
      .submitQuestionnaire(token, answers)
      .then((resp) => {
        onSubmitted(resp);
      })
      .catch((e: ApiException) => {
        if (e.code === 'QUESTIONNAIRE_INVALID') {
          message.error(e.detail ? String(e.detail) : '校验失败');
        } else {
          message.error(e.message || '提交失败');
        }
        setSubmitting(false);
      });
  }

  if (loading) return <Card loading style={{ maxWidth: 720, margin: '40px auto' }} />;

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: 24 }}>
      <Card>
        <Title level={3}>基本信息问卷</Title>
        <Paragraph type="secondary">请根据实际情况作答，没有标准答案。</Paragraph>
        <Form layout="vertical">
          {questions.map((q) => (
            <Form.Item
              key={q.code}
              label={`${q.code}. ${q.title}${q.required ? ' *' : ''}`}
              required={q.required}
            >
              {q.type === 'single' && (
                <Radio.Group value={answers[q.code] as string} onChange={(e) => setSingle(q.code, e.target.value)}>
                  {(q.options || []).map((opt) => (
                    <Radio key={opt.value} value={opt.value} style={{ display: 'block', margin: '8px 0' }}>
                      {opt.label}
                    </Radio>
                  ))}
                </Radio.Group>
              )}
              {q.type === 'multiple' && (
                <Checkbox.Group
                  value={(answers[q.code] as string[]) || []}
                  onChange={(values) => setMultiple(q.code, values as string[])}
                >
                  {(q.options || []).map((opt) => (
                    <Checkbox key={opt.value} value={opt.value} style={{ display: 'block', margin: '8px 0' }}>
                      {opt.label}
                    </Checkbox>
                  ))}
                </Checkbox.Group>
              )}
            </Form.Item>
          ))}
        </Form>
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}
        <Button type="primary" onClick={handleSubmit} loading={submitting} block size="large">
          提交并开始对话
        </Button>
      </Card>
    </div>
  );
}
