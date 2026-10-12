import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAuthStore } from './authStore';
import { useChatStore } from './chatStore';
import { useTaskStore } from './taskStore';

const apiMocks = vi.hoisted(() => ({
  acceptWorkspaceInvite: vi.fn(),
  loginWithPassword: vi.fn(),
  loginWithCode: vi.fn(),
  registerAccount: vi.fn(),
  registerPersonalAccount: vi.fn(),
  resetAccountPassword: vi.fn(),
  setInitialAccountPassword: vi.fn(),
  getAccountState: vi.fn(),
  getWorkspaces: vi.fn(),
  switchActiveWorkspace: vi.fn(),
}));
const authSessionMocks = vi.hoisted(() => ({
  refreshWebSession: vi.fn(),
  logoutWebSession: vi.fn(),
}));

vi.mock('../api/auth', () => apiMocks);
vi.mock('../api/authSession', () => authSessionMocks);

describe('authStore new authentication actions', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    authSessionMocks.refreshWebSession.mockResolvedValue(null);
    authSessionMocks.logoutWebSession.mockResolvedValue(undefined);
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
      workspaceLoading: false,
      switchingWorkspaceId: null,
      isLoggedIn: false,
      hydrating: false,
    });
  });

  it('persists the canonical username returned by email login', async () => {
    apiMocks.loginWithPassword.mockResolvedValue({
      token: 'token-1', username: 'operator', user_id: 'user-1', tenant_id: 'tenant-1', role: 'member',
      has_password: true, workspace_type: 'tenant', active_workspace_id: 'tenant-1',
    });

    await useAuthStore.getState().loginWithPassword('email', 'ops@example.com', 'secret-password');

    expect(useAuthStore.getState().username).toBe('operator');
    expect(localStorage.getItem('auth_username')).toBe('operator');
  });

  it('does not persist the one-time verification token during code login', async () => {
    apiMocks.loginWithCode.mockResolvedValue({
      token: 'token-2', username: 'operator', user_id: 'user-1', tenant_id: 'tenant-1', role: 'member',
      has_password: true, workspace_type: 'tenant', active_workspace_id: 'tenant-1',
    });

    await useAuthStore.getState().loginWithCode('one-time-token');

    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('verification_token')).toBeNull();
    expect(Object.values(localStorage)).not.toContain('one-time-token');
  });

  it('commits the rotated contact-update session to state without persisting the access token', () => {
    localStorage.setItem('auth_token', 'stale-token');
    useAuthStore.setState({
      token: 'stale-token',
      username: 'former-operator',
      userId: 'former-user',
      role: 'member',
      tenantId: 'former-tenant',
      isLoggedIn: true,
    });

    useAuthStore.getState().refreshAuth({
      token: 'rotated-token',
      username: 'contact-user',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      role: 'admin',
      has_password: true,
      workspace_type: 'tenant',
      active_workspace_id: 'tenant-1',
    });

    expect(useAuthStore.getState()).toMatchObject({
      token: 'rotated-token',
      username: 'contact-user',
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'admin',
      isLoggedIn: true,
    });
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('restores a web session from the refresh cookie', async () => {
    authSessionMocks.refreshWebSession.mockResolvedValue({
      token: 'access-new',
      username: 'operator',
      user_id: 'user-1',
      tenant_id: 'tenant-1',
      role: 'admin',
      has_password: true,
      workspace_type: 'tenant',
      active_workspace_id: 'tenant-1',
      refresh_token: null,
    });

    await useAuthStore.getState().restoreSession();

    expect(useAuthStore.getState()).toMatchObject({
      token: 'access-new',
      username: 'operator',
      userId: 'user-1',
      tenantId: 'tenant-1',
      role: 'admin',
      isLoggedIn: true,
      hydrating: false,
    });
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('restores a personal workspace without inventing a tenant', async () => {
    authSessionMocks.refreshWebSession.mockResolvedValue({
      token: 'personal-token',
      username: '13800138000',
      user_id: 'personal-user',
      tenant_id: null,
      role: 'personal',
      has_password: false,
      workspace_type: 'personal',
      active_workspace_id: 'personal',
      refresh_token: null,
    });

    await useAuthStore.getState().restoreSession();

    expect(useAuthStore.getState()).toMatchObject({
      token: 'personal-token',
      tenantId: null,
      role: 'personal',
      hasPassword: false,
      workspaceType: 'personal',
      activeWorkspaceId: 'personal',
    });
  });

  it('clears tenant-scoped state after switching workspaces', async () => {
    useAuthStore.setState({
      token: 'tenant-a-token',
      username: 'operator',
      userId: 'user-1',
      tenantId: 'tenant-a',
      role: 'member',
      hasPassword: true,
      workspaceType: 'tenant',
      activeWorkspaceId: 'tenant-a',
      workspaces: [
        { workspace_id: 'tenant-a', workspace_type: 'tenant', name: '租户 A', tenant_id: 'tenant-a', role: 'member', is_active: true },
        { workspace_id: 'tenant-b', workspace_type: 'tenant', name: '租户 B', tenant_id: 'tenant-b', role: 'member', is_active: false },
      ],
      isLoggedIn: true,
    });
    useChatStore.setState({
      sessions: [{ id: 'session-a', title: '租户 A 对话', messages: [], createdAt: 1 }],
      activeSessionId: 'session-a',
    });
    useTaskStore.setState({ tasks: [{ task_id: 'task-a' } as never], selectedTaskId: 'task-a' });
    localStorage.setItem('activeSessionId', 'session-a');
    apiMocks.switchActiveWorkspace.mockResolvedValue({
      token: 'tenant-b-token', username: 'operator', user_id: 'user-1', tenant_id: 'tenant-b', role: 'member',
      has_password: true, workspace_type: 'tenant', active_workspace_id: 'tenant-b',
    });
    apiMocks.getAccountState.mockResolvedValue({
      user_id: 'user-1', username: 'operator', has_password: true, workspace_type: 'tenant',
      active_workspace_id: 'tenant-b', active_workspace_available: true, tenant_id: 'tenant-b', role: 'member',
    });
    apiMocks.getWorkspaces.mockResolvedValue({
      active_workspace_id: 'tenant-b',
      items: [
        { workspace_id: 'tenant-a', workspace_type: 'tenant', name: '租户 A', tenant_id: 'tenant-a', role: 'member', is_active: false },
        { workspace_id: 'tenant-b', workspace_type: 'tenant', name: '租户 B', tenant_id: 'tenant-b', role: 'member', is_active: true },
      ],
    });

    await useAuthStore.getState().switchWorkspace('tenant-b');

    expect(apiMocks.switchActiveWorkspace).toHaveBeenCalledWith('tenant-b', 'tenant-a-token');
    expect(useAuthStore.getState()).toMatchObject({
      token: 'tenant-b-token', tenantId: 'tenant-b', activeWorkspaceId: 'tenant-b', switchingWorkspaceId: null,
    });
    expect(useChatStore.getState()).toMatchObject({ sessions: [], activeSessionId: null });
    expect(useTaskStore.getState()).toMatchObject({ tasks: [], selectedTaskId: null });
    expect(localStorage.getItem('activeSessionId')).toBeNull();
  });

  it('keeps the current workspace when switching is rejected', async () => {
    useAuthStore.setState({
      token: 'tenant-a-token', tenantId: 'tenant-a', workspaceType: 'tenant', activeWorkspaceId: 'tenant-a',
      workspaces: [{ workspace_id: 'tenant-a', workspace_type: 'tenant', name: '租户 A', tenant_id: 'tenant-a', role: 'member', is_active: true }],
      isLoggedIn: true,
    });
    useChatStore.setState({
      sessions: [{ id: 'session-a', title: '租户 A 对话', messages: [], createdAt: 1 }],
      activeSessionId: 'session-a',
    });
    apiMocks.switchActiveWorkspace.mockRejectedValue(new Error('没有该工作空间的访问权限'));

    await expect(useAuthStore.getState().switchWorkspace('tenant-b')).rejects.toThrow('没有该工作空间的访问权限');

    expect(useAuthStore.getState()).toMatchObject({
      token: 'tenant-a-token', tenantId: 'tenant-a', activeWorkspaceId: 'tenant-a', switchingWorkspaceId: null,
    });
    expect(useChatStore.getState()).toMatchObject({ activeSessionId: 'session-a' });
  });

  it('adds an accepted invitation to the workspace list without switching the current workspace', async () => {
    useAuthStore.setState({
      token: 'personal-token', tenantId: null, workspaceType: 'personal', activeWorkspaceId: 'personal',
      workspaces: [{
        workspace_id: 'personal', workspace_type: 'personal', name: '个人空间',
        tenant_id: null, role: 'personal', is_active: true,
      }],
      isLoggedIn: true,
    });
    apiMocks.acceptWorkspaceInvite.mockResolvedValue({
      workspace: {
        workspace_id: 'tenant-b', workspace_type: 'tenant', name: '租户 B',
        tenant_id: 'tenant-b', role: 'member', is_active: false,
      },
      message: '已加入租户 B，可在工作空间列表中切换',
    });

    const message = await useAuthStore.getState().acceptWorkspaceInvite('Ab12Mixed');

    expect(apiMocks.acceptWorkspaceInvite).toHaveBeenCalledWith('Ab12Mixed', 'personal-token');
    expect(message).toBe('已加入租户 B，可在工作空间列表中切换');
    expect(useAuthStore.getState()).toMatchObject({
      activeWorkspaceId: 'personal',
      workspaces: [
        expect.objectContaining({ workspace_id: 'personal', is_active: true }),
        expect.objectContaining({ workspace_id: 'tenant-b', is_active: false }),
      ],
    });
  });
});
