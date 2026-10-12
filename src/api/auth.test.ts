import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  acceptWorkspaceInvite,
  getAuthCapabilities,
  getAccountState,
  getContactStatus,
  getPhoneStatus,
  getWorkspaces,
  loginWithPassword,
  registerPersonalAccount,
  requestVerification,
  setInitialAccountPassword,
  switchActiveWorkspace,
  updateContact,
  type AuthCapabilities,
} from './auth';
import { useAuthStore } from '../store/authStore';

describe('auth api', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useAuthStore.setState({
      token: null,
      username: '',
      userId: '',
      role: 'member',
      tenantId: null,
      hasPassword: false,
      workspaceType: 'personal',
      activeWorkspaceId: 'personal',
      workspaces: [],
      isLoggedIn: false,
    });
  });

  it('sends the explicit identifier login shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      token: 'token-1',
      username: 'account-1',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      role: 'member',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await loginWithPassword('email', 'OPS@EXAMPLE.COM', 'secret-password');

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      identifier_type: 'email',
      identifier: 'OPS@EXAMPLE.COM',
      password: 'secret-password',
      client_type: 'web',
    });
  });

  it('maps stable backend errors and retry time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error_code: 'verification_rate_limited',
      message: '操作过于频繁',
      retry_after: 42,
    }), { status: 429, headers: { 'Content-Type': 'application/json' } })));

    await expect(requestVerification({
      channel: 'sms',
      purpose: 'login',
      target: '13800138000',
    })).rejects.toMatchObject({
      message: '操作过于频繁',
      code: 'verification_rate_limited',
      retryAfter: 42,
    });
  });

  it('uses a positive Retry-After header when a rate-limited response omits retry_after', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: '登录尝试次数过多',
    }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '37',
      },
    })));

    await expect(loginWithPassword('username', 'operator', 'wrong-password')).rejects.toMatchObject({
      retryAfter: 37,
    });
  });

  it('clears the current session when an authenticated contact request is unauthorized', async () => {
    localStorage.setItem('auth_token', 'token-current');
    useAuthStore.setState({
      token: 'token-current',
      username: 'operator',
      userId: 'user-1',
      role: 'member',
      tenantId: 'tenant-1',
      isLoggedIn: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: '登录已过期',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    await expect(getContactStatus('token-current')).rejects.toMatchObject({
      message: '登录已过期',
    });

    expect(useAuthStore.getState()).toMatchObject({ token: null, isLoggedIn: false });
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('clears the current session when an authenticated contact update is unauthorized', async () => {
    localStorage.setItem('auth_token', 'token-current');
    useAuthStore.setState({
      token: 'token-current',
      username: 'operator',
      userId: 'user-1',
      role: 'member',
      tenantId: 'tenant-1',
      isLoggedIn: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: '登录已过期',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    await expect(updateContact(
      'bind',
      'current-password',
      'verification-token',
      'token-current',
    )).rejects.toMatchObject({ message: '登录已过期' });

    expect(useAuthStore.getState()).toMatchObject({ token: null, isLoggedIn: false });
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('does not clear an existing session for an unauthenticated login rejection', async () => {
    localStorage.setItem('auth_token', 'token-current');
    useAuthStore.setState({
      token: 'token-current',
      username: 'operator',
      userId: 'user-1',
      role: 'member',
      tenantId: 'tenant-1',
      isLoggedIn: true,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      message: '账号或密码错误',
    }), { status: 401, headers: { 'Content-Type': 'application/json' } })));

    await expect(loginWithPassword('email', 'ops@example.com', 'wrong-password')).rejects.toMatchObject({
      message: '账号或密码错误',
    });

    expect(useAuthStore.getState()).toMatchObject({ token: 'token-current', isLoggedIn: true });
    expect(localStorage.getItem('auth_token')).toBe('token-current');
  });

  it('exposes the complete authentication capability contract', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      verification_enabled: true,
      code_login_enabled: true,
      password_reset_enabled: true,
      contact_management_enabled: true,
      register_verification_required: true,
      code_login_reveal_unknown_contact: false,
      personal_registration_enabled: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })));

    const capabilities: AuthCapabilities = await getAuthCapabilities();

    expect(capabilities.code_login_reveal_unknown_contact).toBe(false);
    expect(capabilities.personal_registration_enabled).toBe(true);
  });

  it('uses the public personal registration contract', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        is_registered: false, has_password: false, next_step: 'personal_registration',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({}), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    await getPhoneStatus('13800138000');
    await registerPersonalAccount('verification-token');

    expect(fetchMock.mock.calls[0][0]).toContain('/api/v1/auth/phone-status');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      phone: '13800138000', country_code: '+86', client_type: 'web',
    });
    expect(fetchMock.mock.calls[1][0]).toContain('/api/v1/auth/personal-register');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      verification_token: 'verification-token', client_type: 'web',
    });
  });

  it('uses authenticated workspace and initial-password contracts', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({}), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    vi.stubGlobal('fetch', fetchMock);

    await getAccountState('access-token');
    await getWorkspaces('access-token');
    await switchActiveWorkspace('tenant-2', 'access-token');
    await setInitialAccountPassword('secret123', 'access-token');

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      expect.stringContaining('/api/v1/auth/me'),
      expect.stringContaining('/api/v1/auth/workspaces'),
      expect.stringContaining('/api/v1/auth/workspaces/switch'),
      expect.stringContaining('/api/v1/auth/password/initial'),
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body)).toEqual({
      workspace_id: 'tenant-2', client_type: 'web',
    });
    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ new_password: 'secret123' });
    for (const call of fetchMock.mock.calls) {
      expect(new Headers(call[1].headers).get('Authorization')).toBe('Bearer access-token');
    }
  });

  it('accepts a mixed-case workspace invitation without changing the code', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      workspace: {
        workspace_id: 'tenant-2', workspace_type: 'tenant', name: '租户 B',
        tenant_id: 'tenant-2', role: 'member', is_active: false,
      },
      message: '已加入租户 B，可在工作空间列表中切换',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await acceptWorkspaceInvite('Ab12Mixed', 'access-token');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/v1/auth/accept-invite'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ invite_token: 'Ab12Mixed' }),
      }),
    );
    expect(new Headers(fetchMock.mock.calls[0][1].headers).get('Authorization')).toBe('Bearer access-token');
  });
});
