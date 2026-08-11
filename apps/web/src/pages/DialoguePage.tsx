import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Typography, message } from 'antd';
import type { DialogueMessage, DialogueMode, StageCode, TaskCode, TimerInfo, StepResponse } from '@prism/shared';
import { candidateApi, ApiException, postMessageStream } from '../api/client';
import { MessageList } from '../components/MessageList';
import { TimerBar } from '../components/TimerBar';

const { Text } = Typography;

interface Props {
  token: string;
  initial: StepResponse;
  candidateName: string;
  onFinished: (resp: StepResponse) => void;
}

interface LocalState {
  step: 'examiner' | 'tool';
  mode: DialogueMode;
  currentStage?: StageCode | null;
  currentTask?: TaskCode | null;
  turnIndex: number;
  messages: DialogueMessage[];
  timer?: TimerInfo;
  inputEnabled: boolean;
}

export function DialoguePage({ token, initial, onFinished }: Props) {
  const [state, setState] = useState<LocalState>(() => ({
    step: initial.step === 'tool' ? 'tool' : 'examiner',
    mode: initial.step === 'tool' ? 'tool' : 'examiner',
    currentStage: initial.currentStage,
    currentTask: initial.currentTask,
    turnIndex: initial.turnIndex ?? 0,
    messages: initial.messages || [],
    timer: initial.timer,
    inputEnabled: initial.inputEnabled ?? true,
  }));
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [streamingAiId, setStreamingAiId] = useState<number | undefined>();
  const [streamingText, setStreamingText] = useState('');
  const [thinking, setThinking] = useState(false);
  const [thinkingText, setThinkingText] = useState<string | undefined>();
  const [tick, setTick] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const skipGuardRef = useRef(false);
  const sendGuardRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.messages.length, streamingText]);

  // AI 回复完成后自动聚焦输入框：submitting/thinking/streamingAiId 任一为 true 表示进行中，
  // 三者都为 false 时（含首轮首问生成完）触发 focus。submitting 用 ref guard 跟踪避免漏触发
  useEffect(() => {
    if (submitting || thinking || streamingAiId != null) return;
    inputRef.current?.focus();
  }, [submitting, thinking, streamingAiId]);

  // 首问异步生成：进入对话页时若 messages 为空，轮询 GET /state 直到首问落库
  useEffect(() => {
    if (state.messages.length > 0 || state.step !== 'examiner') return;
    setThinking(true);
    setThinkingText('系统初始化，问题准备中...');
    let stopped = false;
    const poll = async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 1200));
        if (stopped) return;
        try {
          const st = await candidateApi.getState(token);
          if (st.messages && st.messages.length > 0) {
            setState((s) => ({
              ...s,
              step: st.step === 'tool' ? 'tool' : 'examiner',
              mode: st.step === 'tool' ? 'tool' : 'examiner',
              currentStage: st.currentStage ?? s.currentStage,
              currentTask: st.currentTask ?? s.currentTask,
              turnIndex: st.turnIndex ?? s.turnIndex,
              messages: st.messages ?? s.messages,
              timer: st.timer ?? s.timer,
              inputEnabled: st.inputEnabled ?? true,
            }));
            setThinking(false);
            return;
          }
        } catch {
          // 单次失败忽略，继续轮询直到成功
        }
      }
    };
    void poll();
    return () => { stopped = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastTs = state.timer?.lastActivityTs ? Date.parse(state.timer.lastActivityTs) : Date.now();
  const idleSkipSec = state.timer?.idleSkipAtSec ?? 600;
  const idleWarningSec = state.timer?.idleWarningAtSec ?? 300;
  const now = Date.now();
  const idleSec = Math.max(0, Math.floor((now - lastTs) / 1000));
  const showIdleWarn = idleSec >= idleWarningSec && idleSec < idleSkipSec;
  void tick;

  useEffect(() => {
    if (idleSec >= idleSkipSec && state.inputEnabled && !submitting && !skipGuardRef.current) {
      skipGuardRef.current = true;
      void handleSkip('idle_timeout').finally(() => {
        skipGuardRef.current = false;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idleSec, idleSkipSec, state.inputEnabled, submitting]);

  async function handleExaminerSubmit(content: string) {
    setSubmitting(true);
    setThinking(true);
    setThinkingText('正在思考...');
    setError(undefined);
    // 乐观插入 candidate 消息（临时负 id，避免与后端真实 id 冲突）
    const tempId = -Date.now();
    setState((s) => ({
      ...s,
      messages: [
        ...s.messages,
        {
          id: tempId,
          type: 'candidate' as const,
          mode: 'examiner' as const,
          content,
          ts: new Date().toISOString(),
        },
      ],
    }));
    try {
      const resp = await candidateApi.postMessage(token, content);
      setState((s) => {
        // 清掉本轮临时 candidate，再 append 后端返回的真实 messages（含 candidate + ai）
        const withoutTemp = s.messages.filter((m) => m.id !== tempId);
        return {
          ...s,
          step: resp.step === 'tool' ? 'tool' : 'examiner',
          mode: resp.step === 'tool' ? 'tool' : 'examiner',
          currentStage: resp.currentStage ?? (resp.step === 'tool' ? null : s.currentStage),
          currentTask: resp.currentTask ?? s.currentTask,
          turnIndex: resp.turnIndex ?? s.turnIndex,
          messages: appendMessages(withoutTemp, resp.newMessages),
          timer: resp.timer ?? s.timer,
        };
      });
      if (resp.step === 'finished') onFinished(resp);
    } catch (e) {
      const err = e as ApiException;
      // 失败：移除临时 candidate（未落库），保留 input 让用户重发
      setState((s) => ({ ...s, messages: s.messages.filter((m) => m.id !== tempId) }));
      if (err.code === 'TURN_IN_PROGRESS') {
        setError('上一轮回复还在生成中，请稍候');
      } else if (err.code === 'LLM_UNAVAILABLE') {
        setError('网络异常，请重试。你的输入已保留');
      } else {
        setError(err.message || '发送失败');
      }
      setInput(content);
    } finally {
      setSubmitting(false);
      setThinking(false);
    }
  }

  async function handleToolSubmit(content: string) {
    setError(undefined);
    setSubmitting(true);
    setStreamingText('');
    setThinking(true);
    setThinkingText('正在思考...');
    let candidateId = 0;
    let aiId = 0;
    let accumulated = '';
    let turnIndex = state.turnIndex;
    let taskRemainingSec: number | undefined;
    // 流式期间用临时 id 标识流式气泡（后端 accepted 不返回 aiMessageId）
    const STREAMING_TEMP_ID = -1;
    try {
      for await (const ev of postMessageStream(token, content)) {
        if (ev.event === 'accepted') {
          candidateId = ev.data.candidateMessageId;
          aiId = ev.data.aiMessageId ?? 0;
          setStreamingAiId(STREAMING_TEMP_ID);
          // accepted 后到首个 delta 之前仍处于 thinking 状态
          setState((s) => ({
            ...s,
            messages: [
              ...s.messages,
              {
                id: candidateId,
                type: 'candidate' as const,
                mode: 'tool' as const,
                content,
                ts: new Date().toISOString(),
              },
            ],
          }));
          setInput('');
        } else if (ev.event === 'delta') {
          setThinking(false);
          accumulated += ev.data.text;
          setStreamingText(accumulated);
        } else if (ev.event === 'done') {
          aiId = ev.data.aiMessageId;
          turnIndex = ev.data.turnIndex;
          taskRemainingSec = ev.data.taskRemainingSec;
          setState((s) => ({
            ...s,
            turnIndex,
            messages: [
              ...s.messages,
              {
                id: aiId,
                type: 'ai' as const,
                mode: 'tool' as const,
                content: accumulated,
                ts: new Date().toISOString(),
              },
            ],
            timer: s.timer
              ? {
                  ...s.timer,
                  taskRemainingSec: taskRemainingSec ?? s.timer.taskRemainingSec,
                  lastActivityTs: new Date().toISOString(),
                }
              : s.timer,
          }));
          setStreamingText('');
          setStreamingAiId(undefined);
        } else if (ev.event === 'error') {
          setError(ev.data.message || '生成失败');
          setStreamingText('');
          setStreamingAiId(undefined);
        }
      }
    } catch (e) {
      const err = e as ApiException;
      if (err.code === 'TURN_IN_PROGRESS') {
        setError('上一轮回复还在生成中，请稍候');
      } else if (err.code === 'LLM_UNAVAILABLE') {
        setError('网络异常，请重试。你的输入已保留');
      } else {
        setError(err.message || '连接中断，请重试');
      }
    } finally {
      setSubmitting(false);
      setThinking(false);
    }
  }

  async function handleCompleteTask() {
    setSubmitting(true);
    setError(undefined);
    try {
      const resp = await candidateApi.completeTask(token);
      if (resp.step === 'finished') {
        onFinished(resp);
        return;
      }
      setState((s) => ({
        ...s,
        currentTask: resp.currentTask ?? s.currentTask,
        turnIndex: resp.turnIndex ?? 0,
        messages: appendMessages(s.messages, resp.newMessages),
        timer: resp.timer ?? s.timer,
      }));
    } catch (e) {
      const err = e as ApiException;
      if (err.code === 'SKIP_NOT_ALLOWED') {
        setError('请至少与AI交流一次再完成任务');
      } else {
        setError(err.message || '完成失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSkip(reason: 'idle_timeout' | 'task_timeout') {
    setSubmitting(true);
    setError(undefined);
    try {
      const resp = await candidateApi.skip(token, reason);
      if (resp.step === 'finished') {
        onFinished(resp);
        return;
      }
      setState((s) => ({
        ...s,
        step: resp.step === 'tool' ? 'tool' : 'examiner',
        mode: resp.step === 'tool' ? 'tool' : 'examiner',
        currentStage: resp.currentStage ?? s.currentStage,
        currentTask: resp.currentTask ?? s.currentTask,
        turnIndex: resp.turnIndex ?? s.turnIndex,
        messages: appendMessages(s.messages, resp.newMessages),
        timer: resp.timer ?? s.timer,
      }));
    } catch (e) {
      const err = e as ApiException;
      if (err.code === 'SKIP_NOT_ALLOWED') {
        // 服务端二次校验未通过，静默
      } else {
        setError(err.message || '跳过失败');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const taskRemaining = state.timer?.taskRemainingSec ?? null;
  useEffect(() => {
    if (state.step === 'tool' && taskRemaining !== null && taskRemaining <= 0 && state.inputEnabled && !submitting) {
      void handleSkip('task_timeout');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskRemaining, state.step, state.inputEnabled, submitting]);

  async function handleSend() {
    // 防并发：React state 是异步的，submitting 还未变 true 时连续回车/点击会重复触发
    // sendGuardRef 是同步 ref，立即生效；return 后 ref 已被设回 false 由 finally 保证
    if (sendGuardRef.current) return;
    const content = input.trim();
    if (!content) return;
    sendGuardRef.current = true;
    try {
      if (state.step === 'examiner') {
        setInput('');
        await handleExaminerSubmit(content);
      } else {
        await handleToolSubmit(content);
      }
    } finally {
      sendGuardRef.current = false;
    }
  }

  const inputDisabled = submitting || !state.inputEnabled;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: 'var(--pd-bg)' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <MessageList
            messages={state.messages}
            mode={state.mode}
            streamingAiId={streamingAiId}
            streamingText={streamingText}
            thinking={thinking}
            thinkingText={thinkingText}
          />
          <div ref={messagesEndRef} />
        </div>
      </div>
      <div style={{ padding: 12, background: 'var(--pd-surface)', borderTop: '1px solid var(--pd-border)' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          {state.timer && (
            <TimerBar timer={state.timer} step={state.step} idleSec={idleSec} showIdleWarn={showIdleWarn} />
          )}
          {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 8 }} />}
          <Input.TextArea
            ref={inputRef as any}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={state.step === 'tool' ? '像平时使用AI一样输入你的需求' : '请输入你的回答'}
            autoSize={{ minRows: 5, maxRows: 12 }}
            disabled={inputDisabled}
            onPressEnter={(e) => {
              if (!e.shiftKey) {
                e.preventDefault();
                void handleSend();
              }
            }}
            style={{ marginBottom: 8 }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button
              type="primary"
              onClick={handleSend}
              loading={submitting}
              disabled={inputDisabled}
              style={{ flex: 1 }}
            >
              发送
            </Button>
            {state.step === 'tool' && (
              <Button onClick={handleCompleteTask} disabled={submitting} style={{ flex: 1 }}>
                已完成当前任务，提交
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// 导出供单测使用；不作为公开 API
export { appendMessages };

function appendMessages(prev: DialogueMessage[], news?: DialogueMessage[]): DialogueMessage[] {
  if (!news || news.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.id));
  const next = [...prev];
  for (const m of news) {
    if (!seen.has(m.id)) {
      next.push(m);
      seen.add(m.id);
    }
  }
  return next;
}
