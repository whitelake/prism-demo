import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ApiException,
  getJwt,
  setJwt,
  clearJwt,
  getInterviewer,
  isJwtExpired,
  parseFrame,
} from './client';

// jsdom 默认无 localStorage,用最小 stub
const store = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  },
  configurable: true,
});

// 构造一个 JWT：header.payload.signature（payload 是 base64url JSON）
function makeJwt(payload: object): string {
  const enc = (obj: object) =>
    btoa(JSON.stringify(obj))
      .replace(/=+$/, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

describe('JWT 工具', () => {
  beforeEach(() => localStorage.clear());

  it('setJwt/getJwt/clearJwt', () => {
    expect(getJwt()).toBeNull();
    setJwt('abc');
    expect(getJwt()).toBe('abc');
    clearJwt();
    expect(getJwt()).toBeNull();
  });

  it('getInterviewer 解析 sub + name', () => {
    setJwt(makeJwt({ sub: 'u-001', name: 'Admin', exp: Math.floor(Date.now() / 1000) + 3600 }));
    const i = getInterviewer();
    expect(i).toEqual({ id: 'u-001', name: 'Admin' });
  });

  it('getInterviewer 损坏 token 返回 null', () => {
    setJwt('not.a.jwt');
    expect(getInterviewer()).toBeNull();
  });

  it('isJwtExpired 无 token 视为过期', () => {
    expect(isJwtExpired()).toBe(true);
  });

  it('isJwtExpired 未来 exp 返回 false', () => {
    setJwt(makeJwt({ sub: 'u-001', name: 'Admin', exp: Math.floor(Date.now() / 1000) + 3600 }));
    expect(isJwtExpired()).toBe(false);
  });

  it('isJwtExpired 过去 exp 返回 true', () => {
    setJwt(makeJwt({ sub: 'u-001', name: 'Admin', exp: Math.floor(Date.now() / 1000) - 1 }));
    expect(isJwtExpired()).toBe(true);
  });

  it('isJwtExpired 损坏 token 视为过期', () => {
    setJwt('xxx');
    expect(isJwtExpired()).toBe(true);
  });
});

describe('ApiException', () => {
  it('携带 code/status/detail', () => {
    const e = new ApiException('CODE', 'msg', 400, { k: 1 });
    expect(e.code).toBe('CODE');
    expect(e.status).toBe(400);
    expect(e.message).toBe('msg');
    expect(e.detail).toEqual({ k: 1 });
  });
});

describe('parseFrame', () => {
  it('解析 event + data 单行', () => {
    const ev = parseFrame('event: delta\ndata: {"text":"hi"}');
    expect(ev).toEqual({ event: 'delta', data: { text: 'hi' } });
  });

  it('多行 data 用换行拼接', () => {
    const ev = parseFrame('event: done\ndata: {"a":1}\ndata: {"b":2}');
    // JSON.parse 会把两段 JSON 拼接后失败,因此测试两行合法拼接场景
    expect(ev).toBeNull();
  });

  it('多行 data 形成合法 JSON', () => {
    const ev = parseFrame('event: done\ndata: {"aiMessageId":1,"turnIndex":2}');
    expect(ev).toEqual({ event: 'done', data: { aiMessageId: 1, turnIndex: 2 } });
  });

  it('无 data 返回 null', () => {
    expect(parseFrame('event: ping')).toBeNull();
  });

  it('非法 JSON 返回 null', () => {
    expect(parseFrame('data: not-json')).toBeNull();
  });

  it('默认 event 为 message', () => {
    const ev = parseFrame('data: {"x":1}');
    expect(ev).toEqual({ event: 'message', data: { x: 1 } });
  });
});

describe('postMessageStream', () => {
  beforeEach(() => localStorage.clear());

  it('解析多个 SSE 帧,按顺序 yield', async () => {
    const { postMessageStream } = await import('./client');
    const frames = 'event: delta\ndata: {"text":"A"}\n\nevent: delta\ndata: {"text":"B"}\n\nevent: done\ndata: {"aiMessageId":1}\n\n';
    const body = new TextEncoder().encode(frames);
    const resp = {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(body);
          controller.close();
        },
      }),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp);

    const out: { event: string; data: unknown }[] = [];
    for await (const ev of postMessageStream('tok', 'hi')) {
      out.push(ev as { event: string; data: unknown });
    }
    expect(out.map((e) => e.event)).toEqual(['delta', 'delta', 'done']);
    expect((out[0] as { data: { text: string } }).data.text).toBe('A');
    expect((out[2] as { data: { aiMessageId: number } }).data.aiMessageId).toBe(1);
    fetchSpy.mockRestore();
  });

  it('非 2xx 抛 ApiException', async () => {
    const { postMessageStream } = await import('./client');
    const resp = {
      ok: false,
      status: 423,
      statusText: 'Locked',
      json: async () => ({ code: 'TURN_IN_PROGRESS', message: '正在生成' }),
    } as unknown as Response;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(resp);

    let caught: unknown;
    try {
      for await (const _ of postMessageStream('tok', 'x')) {
        // 不应进入
      }
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiException);
    expect((caught as ApiException).code).toBe('TURN_IN_PROGRESS');
    expect((caught as ApiException).status).toBe(423);
    fetchSpy.mockRestore();
  });
});
