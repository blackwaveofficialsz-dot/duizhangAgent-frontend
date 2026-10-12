import { create } from 'zustand';
import { logoutWebSession, refreshWebSession } from '../api/authSession';
import {
  clearSessionState,
  invalidateSessionRequests,
  registerSessionUnauthorizedHandler,
} from '../api/sessionLifecycle';
import { apiUrl } from '../api/url';
import {
  acceptWorkspaceInvite as requestAcceptWorkspaceInvite,
  getAccountState,
  getWorkspaces,
  loginWithCode as requestCodeLogin,
  loginWithPassword as requestPasswordLogin,
  registerAccount,
  registerPersonalAccount,
  resetAccountPassword,
  setInitialAccountPassword,
  switchActiveWorkspace,
  type AuthResponse,
  type IdentifierType,
  type Role,
  type Workspace,
  type WorkspaceType,
} from '../api/auth';

interface AuthState {
  token: string | null;
  username: string;
  userId: string;
  role: Role;
  tenantId: string | null;
  hasPassword: boolean;
  workspaceType: WorkspaceType;
  activeWorkspaceId: string;
  workspaces: Workspace[];
  workspaceLoading: boolean;
  switchingWorkspaceId: string | null;
  isLoggedIn: boolean;
  hydrating: boolean;
  login: (username: string, password: string) => Promise<void>;
  loginWithPassword: (identifierType: IdentifierType, identifier: string, password: string) => Promise<void>;
  loginWithCode: (verificationToken: string) => Promise<void>;
  register: (username: string, password: string, inviteToken: string, verificationToken?: string) => Promise<void>;
  registerPersonal: (verificationToken: string) => Promise<void>;
  resetPassword: (verificationToken: string, newPassword: string) => Promise<void>;
  setInitialPassword: (newPassword: string) => Promise<void>;
  acceptWorkspaceInvite: (inviteToken: string) => Promise<string>;
  refreshAuth: (response: AuthResponse) => void;
  joinTenant: (tenantCode: string) => Promise<string>;
  loadWorkspaceState: () => Promise<void>;
  switchWorkspace: (workspaceId: string) => Promise<void>;
  restoreSession: () => Promise<void>;
  refreshSession: () => Promise<boolean>;
  logout: (options?: { remote?: boolean }) => Promise<void>;
}

const _storedUsername = localStorage.getItem('auth_username') ?? '';
const _storedUserId = localStorage.getItem('auth_user_id') ?? '';
const _legacyToken = localStorage.getItem('auth_token');
let _authGeneration = 0;

function _persistAuth(username: string, userId: string) {
  localStorage.removeItem('auth_token');
  localStorage.setItem('auth_username', username);
  localStorage.setItem('auth_user_id', userId);
  localStorage.removeItem('auth_role');
  localStorage.removeItem('auth_tenant_id');
}

function _clearPersistedAuth() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_role');
  localStorage.removeItem('auth_username');
  localStorage.removeItem('auth_user_id');
  localStorage.removeItem('auth_tenant_id');
}

function _loggedOutState(hydrating = false) {
  return {
    token: null,
    username: '',
    userId: '',
    role: 'personal' as Role,
    tenantId: null,
    hasPassword: false,
    workspaceType: 'personal' as WorkspaceType,
    activeWorkspaceId: 'personal',
    workspaces: [],
    workspaceLoading: false,
    switchingWorkspaceId: null,
    isLoggedIn: false,
    hydrating,
  };
}

function _commitAuth(
  set: (state: Partial<AuthState>) => void,
  response: AuthResponse,
  fallbackUsername = '',
) {
  const username = response.username || fallbackUsername;
  _persistAuth(username, response.user_id);
  set({
    token: response.token,
    username,
    userId: response.user_id,
    role: response.role,
    tenantId: response.tenant_id,
    hasPassword: response.has_password,
    workspaceType: response.workspace_type,
    activeWorkspaceId: response.active_workspace_id,
    isLoggedIn: true,
    hydrating: false,
  });
}

export const useAuthStore = create<AuthState>((set, get) => ({
  token: _legacyToken,
  username: _storedUsername,
  userId: _storedUserId,
  role: 'personal',
  tenantId: null,
  hasPassword: false,
  workspaceType: 'personal',
  activeWorkspaceId: 'personal',
  workspaces: [],
  workspaceLoading: false,
  switchingWorkspaceId: null,
  isLoggedIn: !!_legacyToken,
  hydrating: true,

  login: async (username, password) => {
    const generation = ++_authGeneration;
    const response = await requestPasswordLogin('username', username, password);
    if (generation !== _authGeneration) return;
    _commitAuth(set, response, username);
  },

  loginWithPassword: async (identifierType, identifier, password) => {
    const generation = ++_authGeneration;
    const response = await requestPasswordLogin(identifierType, identifier, password);
    if (generation !== _authGeneration) return;
    _commitAuth(set, response, identifierType === 'username' ? identifier : '');
  },

  loginWithCode: async (verificationToken) => {
    const generation = ++_authGeneration;
    const response = await requestCodeLogin(verificationToken);
    if (generation !== _authGeneration) return;
    _commitAuth(set, response);
  },

  register: async (username, password, inviteToken, verificationToken = '') => {
    const generation = ++_authGeneration;
    const response = await registerAccount(username, password, inviteToken, verificationToken);
    if (generation !== _authGeneration) return;
    _commitAuth(set, response, username);
  },

  registerPersonal: async (verificationToken) => {
    const generation = ++_authGeneration;
    const response = await registerPersonalAccount(verificationToken);
    if (generation !== _authGeneration) return;
    _commitAuth(set, response);
  },

  resetPassword: async (verificationToken, newPassword) => {
    await resetAccountPassword(verificationToken, newPassword);
  },

  setInitialPassword: async (newPassword) => {
    const token = get().token;
    if (!token) throw new Error('登录已过期，请重新登录');
    const result = await setInitialAccountPassword(newPassword, token);
    set({ hasPassword: result.has_password });
  },

  acceptWorkspaceInvite: async (inviteToken) => {
    const token = get().token;
    if (!token) throw new Error('登录已过期，请重新登录');
    const result = await requestAcceptWorkspaceInvite(inviteToken, token);
    set((state) => {
      const exists = state.workspaces.some(
        (workspace) => workspace.workspace_id === result.workspace.workspace_id,
      );
      return {
        workspaces: exists
          ? state.workspaces.map((workspace) => (
            workspace.workspace_id === result.workspace.workspace_id
              ? result.workspace
              : workspace
          ))
          : [...state.workspaces, result.workspace],
      };
    });
    return result.message;
  },

  refreshAuth: (response) => {
    _authGeneration += 1;
    invalidateSessionRequests();
    _commitAuth(set, response);
  },

  joinTenant: async (tenantCode) => {
    const token = get().token;
    const res = await fetch(apiUrl('/api/v1/auth/join-tenant'), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ tenant_code: tenantCode }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail ?? '加入租户失败');
    }
    // 申请制：不再即时切换租户，返回待审批提示文案。
    const data = await res.json();
    return (data.message as string) ?? '申请已提交，等待管理员审批';
  },

  loadWorkspaceState: async () => {
    const token = get().token;
    if (!token) return;
    const generation = _authGeneration;
    set({ workspaceLoading: true });
    try {
      const [account, workspaceList] = await Promise.all([
        getAccountState(token),
        getWorkspaces(token),
      ]);
      if (generation !== _authGeneration || get().token !== token) return;
      set({
        username: account.username,
        userId: account.user_id,
        role: account.role ?? 'personal',
        tenantId: account.tenant_id,
        hasPassword: account.has_password,
        workspaceType: account.workspace_type,
        activeWorkspaceId: account.active_workspace_id,
        workspaces: workspaceList.items,
      });
      _persistAuth(account.username, account.user_id);
    } finally {
      if (generation === _authGeneration) set({ workspaceLoading: false });
    }
  },

  switchWorkspace: async (workspaceId) => {
    const state = get();
    if (!state.token || workspaceId === state.activeWorkspaceId || state.switchingWorkspaceId) return;
    const generation = _authGeneration;
    set({ switchingWorkspaceId: workspaceId });
    try {
      const response = await switchActiveWorkspace(workspaceId, state.token);
      if (generation !== _authGeneration) return;
      _authGeneration += 1;
      clearSessionState();
      _commitAuth(set, response);
      set({
        workspaces: state.workspaces.map((workspace) => ({
          ...workspace,
          is_active: workspace.workspace_id === response.active_workspace_id,
        })),
      });
      await get().loadWorkspaceState().catch(() => undefined);
    } finally {
      if (get().switchingWorkspaceId === workspaceId) set({ switchingWorkspaceId: null });
    }
  },

  restoreSession: async () => {
    const generation = ++_authGeneration;
    set({ hydrating: true });
    const refreshed = await refreshWebSession();
    if (generation !== _authGeneration) return;
    if (refreshed) {
      const username = refreshed.username || localStorage.getItem('auth_username') || get().username;
      _commitAuth(set, refreshed, username);
      return;
    }
    if (get().token) {
      set({ hydrating: false });
      return;
    }
    _clearPersistedAuth();
    set(_loggedOutState(false));
  },

  refreshSession: async () => {
    const generation = _authGeneration;
    const refreshed = await refreshWebSession();
    if (generation !== _authGeneration) return false;
    if (!refreshed) {
      _clearPersistedAuth();
      set(_loggedOutState(false));
      return false;
    }
    const username = refreshed.username || localStorage.getItem('auth_username') || get().username;
    if (get().activeWorkspaceId !== refreshed.active_workspace_id) clearSessionState();
    _commitAuth(set, refreshed, username);
    return true;
  },

  logout: async (options) => {
    _authGeneration += 1;
    clearSessionState();
    _clearPersistedAuth();
    set(_loggedOutState(false));
    if (options?.remote === false) return;
    await logoutWebSession();
  },
}));

registerSessionUnauthorizedHandler((token) => {
  const state = useAuthStore.getState();
  if (state.token === token) void state.logout({ remote: false });
});
