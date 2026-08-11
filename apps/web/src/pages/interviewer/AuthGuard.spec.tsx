import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { AuthGuard } from './AuthGuard';

// jsdom 无 localStorage
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

vi.mock('../../api/client', () => ({
  clearJwt: vi.fn(),
  getInterviewer: vi.fn(() => null),
  isJwtExpired: vi.fn(() => true),
}));

import { clearJwt, getInterviewer, isJwtExpired } from '../../api/client';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<AuthGuard />}>
          <Route path="/interviewer" element={<div>protected-content</div>} />
        </Route>
        <Route path="/login" element={<div>login-page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('AuthGuard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it('JWT 过期 → 清理并重定向到 /login', () => {
    vi.mocked(isJwtExpired).mockReturnValue(true);
    renderAt('/interviewer');
    expect(clearJwt).toHaveBeenCalled();
    expect(screen.getByText('login-page')).toBeTruthy();
  });

  it('JWT 未过期但无 interviewer → 重定向到 /login(不调 clearJwt)', () => {
    vi.mocked(isJwtExpired).mockReturnValue(false);
    vi.mocked(getInterviewer).mockReturnValue(null);
    renderAt('/interviewer');
    expect(clearJwt).not.toHaveBeenCalled();
    expect(screen.getByText('login-page')).toBeTruthy();
  });

  it('JWT 有效且有 interviewer → 渲染受保护 Outlet', () => {
    vi.mocked(isJwtExpired).mockReturnValue(false);
    vi.mocked(getInterviewer).mockReturnValue({ id: 'u-001', name: 'Admin' });
    renderAt('/interviewer');
    expect(screen.getByText('protected-content')).toBeTruthy();
    expect(clearJwt).not.toHaveBeenCalled();
  });
});

void Outlet;
