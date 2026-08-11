import { useEffect, useState } from 'react';
import { Routes, Route, useParams, Navigate } from 'react-router-dom';
import { Alert, Spin } from 'antd';
import { candidateApi, ApiException } from './api/client';
import type { EntryInfo, StepResponse } from '@prism/shared';
import { EntryPage } from './pages/EntryPage';
import { QuestionnairePage } from './pages/QuestionnairePage';
import { DialoguePage } from './pages/DialoguePage';
import { FinishedPage } from './pages/FinishedPage';
import { LoginPage } from './pages/interviewer/LoginPage';
import { AuthGuard } from './pages/interviewer/AuthGuard';
import { AssessmentListPage } from './pages/interviewer/AssessmentListPage';
import { ReportPage } from './pages/interviewer/ReportPage';

export function App() {
  return (
    <Routes>
      <Route path="/c/:token" element={<AssessmentRouter />} />
      <Route path="/login" element={<LoginPage />} />
      <Route element={<AuthGuard />}>
        <Route path="/interviewer" element={<AssessmentListPage />} />
        <Route path="/interviewer/assessments/:id" element={<ReportPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

interface RouterState {
  loading: boolean;
  entry?: EntryInfo;
  stepInfo?: StepResponse & { assessmentId?: string; candidateName?: string };
  error?: string;
  skipReasonHint?: string;
}

function AssessmentRouter() {
  const { token = '' } = useParams();
  const [state, setState] = useState<RouterState>({ loading: true });
  const [resumeNonce, setResumeNonce] = useState(0);

  async function loadEntry() {
    setState((s) => ({ ...s, loading: true, error: undefined }));
    try {
      const entry = await candidateApi.getEntry(token);
      // 非 entry/questionnaire 步骤需要全量 state 恢复现场
      if (entry.step !== 'entry' && entry.step !== 'questionnaire') {
        const st = await candidateApi.getState(token);
        setState({ loading: false, entry, stepInfo: st });
        return;
      }
      setState({ loading: false, entry });
    } catch (e) {
      const err = e as ApiException;
      setState({ loading: false, error: err.message || '加载失败' });
    }
  }

  useEffect(() => {
    void loadEntry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, resumeNonce]);

  if (state.loading) {
    return (
      <div style={{ padding: 48, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (state.error) {
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
        <Alert type="error" message={state.error} showIcon />
      </div>
    );
  }

  const entry = state.entry!;
  const step = state.stepInfo?.step || entry.step;

  // step=finished 或后端返回 finishMessage
  if (step === 'finished' || state.stepInfo?.finishMessage) {
    return <FinishedPage message={state.stepInfo?.finishMessage || '测评已提交，感谢你的参与。'} submittedAt={state.stepInfo?.submittedAt} />;
  }

  if (step === 'entry') {
    return (
      <EntryPage
        token={token}
        entry={entry}
        onStarted={async () => {
          // start 成功后拉取真实状态（后端可能直接进 examiner 或先 questionnaire）
          try {
            const st = await candidateApi.getState(token);
            setState({ loading: false, entry: { ...entry, status: 'in_progress', step: st.step }, stepInfo: st });
          } catch {
            setState({ loading: false, entry: { ...entry, status: 'in_progress', step: 'questionnaire' }, stepInfo: undefined });
          }
        }}
      />
    );
  }

  if (step === 'questionnaire') {
    return (
      <QuestionnairePage
        token={token}
        onSubmitted={(resp) => {
          setState({ loading: false, entry, stepInfo: resp });
        }}
      />
    );
  }

  if (step === 'examiner' || step === 'tool') {
    return (
      <DialoguePage
        token={token}
        initial={state.stepInfo!}
        candidateName={entry.candidateName}
        onFinished={(resp) => {
          if (resp.step === 'finished') {
            setState({ loading: false, entry, stepInfo: resp });
          }
        }}
      />
    );
  }

  return (
    <div style={{ padding: 24, maxWidth: 720, margin: '0 auto' }}>
      <Alert type="warning" message={`未知步骤：${step}`} showIcon />
    </div>
  );
}
