import { apiFetch } from './client';
import type { AdminUser, AdminTenant } from '../types';

const ADMIN_USERS = '/api/v1/admin/users';
const ADMIN_TENANTS = '/api/v1/admin/tenants';
const ADMIN_JOIN_REQUESTS = '/api/v1/admin/join-requests';

function asArray<T>(data: unknown, key: string): T[] {
  if (Array.isArray(data)) return data as T[];
  const value = (data as Record<string, unknown> | null)?.[key];
  return Array.isArray(value) ? value as T[] : [];
}

async function requireSuccess(res: Response): Promise<void> {
  if (res.ok) return;
  const data = await res.json().catch(() => ({}));
  throw new Error(typeof data.detail === 'string' ? data.detail : `操作失败 (${res.status})`);
}

export interface JoinRequest {
  id: string;
  user_id: string;
  username: string;
  from_tenant_id: string | null;
  from_brand: string;
  created_at: string;
}

export type RegistrationInviteStatus = 'active' | 'used' | 'expired' | 'revoked';

export interface RegistrationInvite {
  id: string;
  tenant_id: string;
  invite_token: string | null;
  invite_email: string | null;
  role: string;
  created_by: string;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  revoked_at: string | null;
  status: RegistrationInviteStatus;
}

export interface RegistrationInviteCreated {
  invite_token: string;
  email_sent: boolean;
}

export async function listJoinRequests(signal?: AbortSignal): Promise<JoinRequest[]> {
  const res = await apiFetch(ADMIN_JOIN_REQUESTS, signal ? { signal } : undefined);
  if (!res.ok) throw new Error('加载加入申请失败');
  return asArray<JoinRequest>(await res.json(), 'items');
}

export async function approveJoinRequest(id: string): Promise<void> {
  const res = await apiFetch(`${ADMIN_JOIN_REQUESTS}/${id}/approve`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? '审批失败');
  }
}

export async function rejectJoinRequest(id: string): Promise<void> {
  const res = await apiFetch(`${ADMIN_JOIN_REQUESTS}/${id}/reject`, { method: 'POST' });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? '驳回失败');
  }
}

export async function listUsers(params: {
  tenant_id?: string;
  role?: string;
  search?: string;
  limit?: number;
  offset?: number;
}, signal?: AbortSignal): Promise<{ users: AdminUser[]; total: number }> {
  const qs = new URLSearchParams();
  if (params.tenant_id) qs.set('tenant_id', params.tenant_id);
  if (params.role) qs.set('role', params.role);
  if (params.search) qs.set('search', params.search);
  if (params.limit) qs.set('limit', String(params.limit));
  if (params.offset) qs.set('offset', String(params.offset));
  const res = await apiFetch(`${ADMIN_USERS}?${qs}`, { signal });
  await requireSuccess(res);
  const data = await res.json();
  return { users: asArray<AdminUser>(data, 'users'), total: Number(data?.total ?? 0) };
}

export async function createUser(body: {
  username: string;
  password: string;
  tenant_id: string;
  role: string;
}): Promise<AdminUser> {
  const res = await apiFetch(ADMIN_USERS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  await requireSuccess(res);
  return res.json();
}

export async function updateUserRole(id: string, role: string): Promise<AdminUser> {
  const res = await apiFetch(`${ADMIN_USERS}/${id}/role`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  await requireSuccess(res);
  return res.json();
}

export async function deleteUser(id: string): Promise<void> {
  const res = await apiFetch(`${ADMIN_USERS}/${id}`, { method: 'DELETE' });
  await requireSuccess(res);
}

export async function listRegistrationInvites(): Promise<RegistrationInvite[]> {
  const res = await apiFetch(`${ADMIN_USERS}/invitations`);
  if (!res.ok) throw new Error('加载注册邀请码失败');
  return asArray<RegistrationInvite>(await res.json(), 'items');
}

export async function createRegistrationInvite(
  expiresMinutes = 1440,
  email = '',
): Promise<RegistrationInviteCreated> {
  const res = await apiFetch(`${ADMIN_USERS}/invitations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      expires_minutes: expiresMinutes,
      ...(email ? { email } : {}),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.detail ?? data.message ?? '生成注册邀请码失败');
  }
  return res.json();
}

export async function listTenants(params?: {
  search?: string;
  limit?: number;
  offset?: number;
}, signal?: AbortSignal): Promise<{ tenants: AdminTenant[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.search) qs.set('search', params.search);
  if (params?.limit) qs.set('limit', String(params.limit));
  if (params?.offset) qs.set('offset', String(params.offset));
  const res = await apiFetch(`${ADMIN_TENANTS}?${qs}`, { signal });
  await requireSuccess(res);
  const data = await res.json();
  return { tenants: asArray<AdminTenant>(data, 'tenants'), total: Number(data?.total ?? 0) };
}

export async function createTenant(body: {
  brand_name: string;
  store_count: number;
  model_provider: string;
  model_name: string;
}): Promise<AdminTenant> {
  const res = await apiFetch(ADMIN_TENANTS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function updateTenant(id: string, body: {
  brand_name?: string;
  store_count?: number;
  model_provider?: string;
  model_name?: string;
}): Promise<AdminTenant> {
  const res = await apiFetch(`${ADMIN_TENANTS}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function regenerateTenantCode(id: string): Promise<AdminTenant> {
  const res = await apiFetch(`${ADMIN_TENANTS}/${id}/tenant-code/regenerate`, { method: 'POST' });
  return res.json();
}

export async function deleteTenant(id: string): Promise<void> {
  await apiFetch(`${ADMIN_TENANTS}/${id}`, { method: 'DELETE' });
}
