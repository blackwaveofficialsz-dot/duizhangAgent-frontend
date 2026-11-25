// @vitest-environment jsdom

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from './client';
import { useAuthStore } from '../store/authStore';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('apiFetch refresh retry', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    useAuthStore.setState({
      token: 'access-old',
      username: 'admin1',
      userId: 'user-a',
      role: 'admin',
      tenantId: 'tenant-a',
      hasPassword: true,
      workspaceType: 'tenant',
      activeWorkspaceId: 'tenant-a',
      workspaces: [],
      isLoggedIn: true,
      hydrating: false,
    });
  });

  it('refreshes once and retries after a 401', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/protected') {
        const auth = new Headers(init?.headers).get('Authorization');
        if (auth === 'Bearer access-new') return Promise.resolve(jsonResponse({ ok: true }));
        return Promise.resolve(jsonResponse({ detail: 'expired' }, 401));
      }
      if (url === '/api/v1/auth/refresh') {
        return Promise.resolve(jsonResponse({
          token: 'access-new',
          user_id: 'user-a',
          tenant_id: 'tenant-a',
          role: 'admin',
          has_password: true,
          workspace_type: 'tenant',
          active_workspace_id: 'tenant-a',
          refresh_token: null,
        }));
      }
      return Promise.resolve(jsonResponse({ detail: 'unexpected' }, 500));
    }));

    const res = await apiFetch('/api/v1/protected');

    expect(res.ok).toBe(true);
    expect(useAuthStore.getState().token).toBe('access-new');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('shares one refresh request across concurrent api calls', async () => {
    let refreshCalls = 0;
    let resolveRefresh!: (value: Response) => void;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/v1/auth/refresh') {
        refreshCalls += 1;
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      const auth = new Headers(init?.headers).get('Authorization');
      if (auth === 'Bearer access-new') return Promise.resolve(jsonResponse({ ok: true }));
      return Promise.resolve(jsonResponse({ detail: 'expired' }, 401));
    }));

    const first = apiFetch('/api/v1/a');
    const second = apiFetch('/api/v1/b');
    await waitFor(() => expect(refreshCalls).toBe(1));

    resolveRefresh(jsonResponse({
      token: 'access-new',
      user_id: 'user-a',
      tenant_id: 'tenant-a',
      role: 'admin',
      has_password: true,
      workspace_type: 'tenant',
      active_workspace_id: 'tenant-a',
      refresh_token: null,
    }));

    await Promise.all([first, second]);

    expect(refreshCalls).toBe(1);
  });

  it('logs out when refresh fails', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/v1/auth/refresh') return Promise.resolve(jsonResponse({ detail: 'expired' }, 401));
      return Promise.resolve(jsonResponse({ detail: 'expired' }, 401));
    }));

    await expect(apiFetch('/api/v1/protected')).rejects.toMatchObject({ message: '登录已过期，请重新登录', status: 401 });

    expect(useAuthStore.getState()).toMatchObject({
      token: null,
      isLoggedIn: false,
    });
  });
});
