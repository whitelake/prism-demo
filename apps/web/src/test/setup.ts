import { vi } from 'vitest';

// @ant-design/plots 用 Canvas 渲染，jsdom 无真实 canvas 上下文会崩溃
// 全局 mock 成占位 div；测试断言走文本内容，不依赖图表渲染
vi.mock('@ant-design/plots', () => ({
  Radar: () => null,
}));

// jsdom 缺失 polyfill
Object.defineProperty(globalThis, 'matchMedia', {
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
  configurable: true,
});

// localStorage（jsdom 默认不注入）
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
