import { beginSessionRequest, reportSessionUnauthorized } from './sessionLifecycle';
import { apiUrl } from './url';

export type IdentifierType = 'username' | 'email' | 'phone';
export type VerificationChannel = 'email' | 'sms';
export type VerificationPurpose = 'register' | 'personal_register' | 'login' | 'reset_password' | 'bind_contact' | 'change_contact';
export type Role = 'admin' | 'member' | 'personal';
export type WorkspaceType = 'personal' | 'tenant';

export interface AuthCapabilities {
  verification_enabled: boolean;
  code_login_enabled: boolean;
  password_reset_enabled: boolean;
  contact_management_enabled: boolean;
  register_verification_required: boolean;
  code_login_reveal_unknown_contact: boolean;
  personal_registration_enabled: boolean;
}

export interface AuthResponse {
  token: string;
  username: string;
  user_id: string;
  tenant_id: string | null;
  role: Role;
  has_password: boolean;
  workspace_type: WorkspaceType;
  active_workspace_id: string;
  refresh_token?: string | null;
}

export interface AccountState {
  user_id: string;
  username: string;
  has_password: boolean;
  workspace_type: WorkspaceType;
  active_workspace_id: string;
  active_workspace_available: boolean;
  tenant_id: string | null;
  role: Role | null;
}

export interface Workspace {
  workspace_id: string;
  workspace_type: WorkspaceType;
  name: string;
  tenant_id: string | null;
  role: Role;
  is_active: boolean;
}

export interface WorkspaceList {
  active_workspace_id: string;
  items: Workspace[];
}

export interface AcceptInviteResponse {
  workspace: Workspace;
  message: string;
}

export interface PhoneStatus {
  is_registered: boolean;
  has_password: boolean;
  next_step: 'password' | 'verification' | 'personal_registration';
}

export interface VerificationRequest {
  channel: VerificationChannel;
  purpose: VerificationPurpose;
  target: string;
  invite_token?: string;
}

export interface VerificationChallenge {
  challenge_id: string;
  message?: string;
  expires_in?: number;
  resend_after: number;
}

export interface VerificationConfirmation {
  verification_token: string;
  expires_in?: number;
}

export interface ContactChannelStatus {
  bound: boolean;
  verified: boolean;
  masked: string;
}

export interface ContactStatus {
  email: ContactChannelStatus;
  phone: ContactChannelStatus;
}

export interface ContactUpdateResponse extends AuthResponse {
  message: string;
  contact: ContactStatus;
}

interface AuthErrorPayload {
  detail?: unknown;
  message?: string;
  error_code?: string;
  retry_after?: number;
}

function errorMessage(payload: AuthErrorPayload): string {
  if (payload.message) return payload.message;
  if (typeof payload.detail === 'string') return payload.detail;
  if (Array.isArray(payload.detail)) {
    const first = payload.detail[0] as { msg?: unknown } | undefined;
    if (typeof first?.msg === 'string') return first.msg;
  }
  return '请求失败，请稍后重试';
}

function retryAfter(payload: AuthErrorPayload, response: Response): number | undefined {
  if (payload.retry_after !== undefined) {
    return Number.isInteger(payload.retry_after) && payload.retry_after > 0
      ? payload.retry_after
      : undefined;
  }
  const value = response.headers.get('Retry-After');
  return value && /^[1-9]\d*$/.test(value) ? Number(value) : undefined;
}

export class AuthApiError extends Error {
  code?: string;
  retryAfter?: number;

  constructor(message: string, code?: string, retryAfter?: number) {
    super(message);
    this.name = 'AuthApiError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

async function authRequest<T>(
  path: string,
  init: RequestInit = {},
  token?: string | null,
): Promise<T> {
  const request = beginSessionRequest(init.signal);
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', `Bearer ${token}`);

  try {
    const response = await fetch(apiUrl(path), {
      ...init,
      credentials: init.credentials ?? 'include',
      headers,
      signal: request.signal,
    });
    if (!request.isCurrent()) throw new DOMException('Aborted', 'AbortError');
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as AuthErrorPayload;
      if (response.status === 401 && token) reportSessionUnauthorized(token);
      throw new AuthApiError(
        errorMessage(payload),
        payload.error_code,
        retryAfter(payload, response),
      );
    }
    return await response.json() as T;
  } finally {
    request.release();
  }
}

export function getAuthCapabilities(): Promise<AuthCapabilities> {
  return authRequest<AuthCapabilities>('/api/v1/auth/capabilities');
}

export function loginWithPassword(
  identifierType: IdentifierType,
  identifier: string,
  password: string,
): Promise<AuthResponse> {
  return authRequest<AuthResponse>('/api/v1/auth/login', {
    method: 'POST',
    body: JSON.stringify({
      identifier_type: identifierType,
      identifier,
      password,
      client_type: 'web',
    }),
  });
}

export function loginWithCode(verificationToken: string): Promise<AuthResponse> {
  return authRequest<AuthResponse>('/api/v1/auth/login/code', {
    method: 'POST',
    body: JSON.stringify({ verification_token: verificationToken, client_type: 'web' }),
  });
}

export function registerAccount(
  username: string,
  password: string,
  inviteToken: string,
  verificationToken = '',
): Promise<AuthResponse> {
  return authRequest<AuthResponse>('/api/v1/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      username,
      password,
      invite_token: inviteToken,
      verification_token: verificationToken,
      client_type: 'web',
    }),
  });
}

export function getPhoneStatus(phone: string): Promise<PhoneStatus> {
  return authRequest<PhoneStatus>('/api/v1/auth/phone-status', {
    method: 'POST',
    body: JSON.stringify({ phone, country_code: '+86', client_type: 'web' }),
  });
}

export function registerPersonalAccount(verificationToken: string): Promise<AuthResponse> {
  return authRequest<AuthResponse>('/api/v1/auth/personal-register', {
    method: 'POST',
    body: JSON.stringify({ verification_token: verificationToken, client_type: 'web' }),
  });
}

export function getAccountState(token: string): Promise<AccountState> {
  return authRequest<AccountState>('/api/v1/auth/me', {}, token);
}

export function getWorkspaces(token: string): Promise<WorkspaceList> {
  return authRequest<WorkspaceList>('/api/v1/auth/workspaces', {}, token);
}

export function acceptWorkspaceInvite(
  inviteToken: string,
  token: string,
): Promise<AcceptInviteResponse> {
  return authRequest<AcceptInviteResponse>('/api/v1/auth/accept-invite', {
    method: 'POST',
    body: JSON.stringify({ invite_token: inviteToken }),
  }, token);
}

export function switchActiveWorkspace(workspaceId: string, token: string): Promise<AuthResponse> {
  return authRequest<AuthResponse>('/api/v1/auth/workspaces/switch', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId, client_type: 'web' }),
  }, token);
}

export function setInitialAccountPassword(newPassword: string, token: string): Promise<{ message: string; has_password: boolean }> {
  return authRequest('/api/v1/auth/password/initial', {
    method: 'POST',
    body: JSON.stringify({ new_password: newPassword }),
  }, token);
}

export function requestVerification(
  body: VerificationRequest,
  token?: string | null,
): Promise<VerificationChallenge> {
  return authRequest<VerificationChallenge>('/api/v1/auth/verifications', {
    method: 'POST',
    body: JSON.stringify(body),
  }, token);
}

export function confirmVerification(
  challengeId: string,
  code: string,
): Promise<VerificationConfirmation> {
  return authRequest<VerificationConfirmation>(`/api/v1/auth/verifications/${encodeURIComponent(challengeId)}/confirm`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

export function resetAccountPassword(verificationToken: string, newPassword: string): Promise<{ message: string }> {
  return authRequest('/api/v1/auth/reset-password', {
    method: 'POST',
    body: JSON.stringify({ verification_token: verificationToken, new_password: newPassword }),
  });
}

export function getContactStatus(token: string): Promise<ContactStatus> {
  return authRequest<ContactStatus>('/api/v1/auth/contact', {}, token);
}

export function updateContact(
  mode: 'bind' | 'change',
  password: string,
  verificationToken: string,
  token: string,
): Promise<ContactUpdateResponse> {
  return authRequest<ContactUpdateResponse>(`/api/v1/auth/contact/${mode}`, {
    method: 'POST',
    body: JSON.stringify({ password, verification_token: verificationToken }),
  }, token);
}
