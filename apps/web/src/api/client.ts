import type {
  AppError,
  AssessmentStatus,
  CreateAssessmentResponse,
  EntryInfo,
  Interviewer,
  JudgmentSubmitResponse,
  LoginResponse,
  QuestionnaireAnswers,
  QuestionnaireData,
  ListResponse,
  Report,
  SseEvent,
  StartResponse,
  StatusResponse,
  StepResponse,
  TranscriptSaveResponse,
} from '@prism/shared';

const API_BASE = '/api/v1';
const JWT_KEY = 'prism_jwt';

export class ApiException extends Error {
  code: string;
  detail: unknown;
  status: number;
  constructor(code: string, message: string, status: number, detail?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

async function parseError(resp: Response): Promise<AppError> {
  try {
    const body = (await resp.json()) as { error?: AppError } & AppError;
    // api-spec 1.3：后端返回 { error: { code, message, detail } } 嵌套结构
    const err = body.error ?? body;
    return {
      code: err.code || 'UNKNOWN',
      message: err.message || resp.statusText,
      detail: err.detail,
    };
  } catch {
    return { code: 'UNKNOWN', message: resp.statusText };
  }
}

function authHeaders(): Record<string, string> {
  const token = getJwt();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function getJwt(): string | null {
  return localStorage.getItem(JWT_KEY);
}
export function setJwt(token: string): void {
  localStorage.setItem(JWT_KEY, token);
}
export function clearJwt(): void {
  localStorage.removeItem(JWT_KEY);
}

interface JwtPayload {
  sub: string;
  name: string;
  exp: number;
}

export function getInterviewer(): Interviewer | null {
  const token = getJwt();
  if (!token) return null;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as JwtPayload;
    return { id: payload.sub, name: payload.name };
  } catch {
    return null;
  }
}

export function isJwtExpired(): boolean {
  const token = getJwt();
  if (!token) return true;
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!)) as JwtPayload;
    return Date.now() >= payload.exp * 1000;
  } catch {
    return true;
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers || {}),
    },
  });
  if (!resp.ok) {
    const err = await parseError(resp);
    throw new ApiException(err.code, err.message, resp.status, err.detail);
  }
  return (await resp.json()) as T;
}

// 候选人端
export const candidateApi = {
  getEntry(token: string) {
    return requestJson<EntryInfo>(`/c/${token}`);
  },
  start(token: string, confirmedName: string) {
    return requestJson<StartResponse>(`/c/${token}/start`, {
      method: 'POST',
      body: JSON.stringify({ confirmedName }),
    });
  },
  getQuestionnaire(token: string) {
    return requestJson<QuestionnaireData>(`/c/${token}/questionnaire`);
  },
  submitQuestionnaire(token: string, answers: QuestionnaireAnswers) {
    return requestJson<StepResponse>(`/c/${token}/questionnaire`, {
      method: 'POST',
      body: JSON.stringify({ answers }),
    });
  },
  postMessage(token: string, content: string) {
    return requestJson<StepResponse>(`/c/${token}/message`, {
      method: 'POST',
      body: JSON.stringify({ content, clientTs: new Date().toISOString() }),
    });
  },
  completeTask(token: string) {
    return requestJson<StepResponse>(`/c/${token}/task/complete`, { method: 'POST' });
  },
  skip(token: string, reason: 'idle_timeout' | 'task_timeout') {
    return requestJson<StepResponse>(`/c/${token}/skip`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  getState(token: string) {
    return requestJson<StepResponse & { assessmentId: string; candidateName: string; status: string }>(`/c/${token}/state`);
  },
};

// 面试官端
export const interviewerApi = {
  login(account: string, password: string) {
    return requestJson<LoginResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ account, password }),
    });
  },
  me() {
    return requestJson<Interviewer>('/auth/me');
  },
  list(params: { status?: string; keyword?: string; page?: number; pageSize?: number }) {
    const qs = new URLSearchParams();
    if (params.status) qs.set('status', params.status);
    if (params.keyword) qs.set('keyword', params.keyword);
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    const q = qs.toString();
    return requestJson<ListResponse>(`/assessments${q ? '?' + q : ''}`);
  },
  create(candidateName: string, position?: string) {
    return requestJson<CreateAssessmentResponse>(`/assessments`, {
      method: 'POST',
      body: JSON.stringify({ candidateName, position: position ?? 'TEST' }),
    });
  },
  regenerateLink(id: string) {
    return requestJson<CreateAssessmentResponse>(`/assessments/${id}/regenerate-link`, { method: 'POST' });
  },
  getReport(id: string) {
    return requestJson<Report>(`/assessments/${id}/report`);
  },
  getStatus(id: string) {
    return requestJson<StatusResponse>(`/assessments/${id}/status`);
  },
  saveTranscript(id: string, transcriptDraft: string) {
    return requestJson<TranscriptSaveResponse>(`/assessments/${id}/transcript`, {
      method: 'PUT',
      body: JSON.stringify({ transcriptDraft }),
    });
  },
  submitJudgment(id: string, body: { level: string; track: string; reason: string; transcript: string; confirm?: boolean }) {
    return requestJson<JudgmentSubmitResponse>(`/assessments/${id}/judgment`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  },
  abandon(id: string, reason: string) {
    return requestJson<{ status: AssessmentStatus }>(`/assessments/${id}/abandon`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
  },
  reevaluate(id: string, scope: 'all' | 'evaluation' | 'outline' = 'all') {
    return requestJson<{ status: AssessmentStatus; message: string }>(`/assessments/${id}/reevaluate`, {
      method: 'POST',
      body: JSON.stringify({ scope }),
    });
  },
  getExportUrl(id: string): string {
    return `${API_BASE}/assessments/${id}/export`;
  },
};

// SSE: POST + ReadableStream 解析 event/data 帧。
export async function* postMessageStream(
  token: string,
  content: string,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  const resp = await fetch(`${API_BASE}/c/${token}/message/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ content, clientTs: new Date().toISOString() }),
    signal,
  });
  if (!resp.ok || !resp.body) {
    const err = await parseError(resp);
    throw new ApiException(err.code, err.message, resp.status, err.detail);
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const ev = parseFrame(frame);
      if (ev) yield ev;
    }
  }
  if (buffer.trim()) {
    const ev = parseFrame(buffer);
    if (ev) yield ev;
  }
}

function parseFrame(frame: string): SseEvent | null {
  let event = 'message';
  let dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join('\n'));
    return { event, data } as SseEvent;
  } catch {
    return null;
  }
}

// 导出供单测使用；不作为公开 API
export { parseFrame };

// types 用于上面 import 的 type 推断
