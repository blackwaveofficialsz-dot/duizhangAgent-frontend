/**
 * 平台后台 API 客户端（独立于租户 apiFetch）。
 *
 * 物理隔离：
 * - 自带 platformToken 存取（localStorage key = 'platform_admin_token'）
 * - 401 → 仅清理 platformToken，不动租户 token
 * - 所有路径前缀 /api/v1/platform/*
 */
import { apiUrl } from '../api/url';
import type { AdminTenant, AdminUser } from '../types';

const TOKEN_KEY = 'platform_admin_token';

export function getPlatformToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setPlatformToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearPlatformToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class PlatformApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function platformFetch(path: string, init: RequestInit = {}, skipAuth = false): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!skipAuth) {
    const token = getPlatformToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (res.status === 401) {
    clearPlatformToken();
    throw new PlatformApiError(401, '登录已过期，请重新登录');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new PlatformApiError(res.status, data.detail ?? `请求失败 (${res.status})`);
  }
  return res;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface PlatformAdmin {
  id: string;
  username: string;
  display_name?: string | null;
}

export async function platformLogin(username: string, password: string): Promise<{ token: string; admin: PlatformAdmin }> {
  const res = await platformFetch('/api/v1/platform/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  }, /* skipAuth */ true);
  const data = await res.json();
  return {
    token: data.token,
    admin: { id: '', username: data.username, display_name: data.display_name },
  };
}

export async function platformMe(): Promise<PlatformAdmin> {
  const res = await platformFetch('/api/v1/platform/auth/me');
  return res.json();
}

export interface PlatformHealth {
  status: string;
  services: Record<string, string>;
}

export async function getPlatformHealth(): Promise<PlatformHealth> {
  const res = await platformFetch('/health/ready');
  return res.json();
}

// ── Billing rules ───────────────────────────────────────────────────────────

export interface BillingRule {
  id: string;
  model_pattern: string;
  cache_hit_rate_per_m_yuan: string;
  cache_write_rate_per_m_yuan: string;
  cache_miss_rate_per_m_yuan: string;
  output_rate_per_m_yuan: string;
  effective_from: string;
  effective_to?: string | null;
  created_by?: string | null;
  created_at: string;
}

export async function listActiveRules(): Promise<BillingRule[]> {
  const res = await platformFetch('/api/v1/platform/billing/rules');
  return res.json();
}

export async function listRulesHistory(modelPattern?: string): Promise<BillingRule[]> {
  const q = modelPattern ? `?model_pattern=${encodeURIComponent(modelPattern)}` : '';
  const res = await platformFetch(`/api/v1/platform/billing/rules/history${q}`);
  return res.json();
}

export interface UpsertRuleBody {
  model_pattern: string;
  cache_hit_rate_per_m_yuan: string | number;
  cache_write_rate_per_m_yuan: string | number;
  cache_miss_rate_per_m_yuan: string | number;
  output_rate_per_m_yuan: string | number;
}

export async function upsertRule(body: UpsertRuleBody): Promise<BillingRule> {
  const res = await platformFetch('/api/v1/platform/billing/rules', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

// ── Usage detail ────────────────────────────────────────────────────────────

export interface UsageRecord {
  id: number;
  tenant_id: string;
  user_id?: string | null;
  username?: string | null;
  session_id?: string | null;
  agent?: string | null;
  provider: string;
  model: string;
  cache_read_input_tokens: number;
  cache_write_input_tokens: number;
  uncached_input_tokens: number;
  output_tokens: number;
  estimated: boolean;
  request_id?: string | null;
  created_at: string;
}

export interface UsageListResponse {
  total: number;
  items: UsageRecord[];
}

export interface UsageQuery {
  period?: string;
  tenant_id?: string;
  username?: string;
  model?: string;
  limit?: number;
  offset?: number;
}

export async function listUsage(q: UsageQuery = {}): Promise<UsageListResponse> {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const qs = params.toString();
  const res = await platformFetch(`/api/v1/platform/billing/usage${qs ? `?${qs}` : ''}`);
  return res.json();
}

export async function listUsageTenants(): Promise<string[]> {
  const res = await platformFetch('/api/v1/platform/billing/usage/tenants');
  return res.json();
}

// ── Summaries ───────────────────────────────────────────────────────────────

export interface BillingSummary {
  id: string;
  tenant_id: string;
  user_id?: string | null;
  username?: string | null;
  period: string;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_miss_tokens: number;
  output_tokens: number;
  amount_yuan: string;
  computed_at: string;
}

export async function listSummaries(q: { period?: string; tenant_id?: string; user_id?: string; limit?: number; offset?: number } = {}): Promise<BillingSummary[]> {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const qs = params.toString();
  const res = await platformFetch(`/api/v1/platform/billing/summaries${qs ? `?${qs}` : ''}`);
  return res.json();
}

export interface DailyPoint {
  date: string;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cache_miss_tokens: number;
  output_tokens: number;
  amount_yuan: string;
}

export async function listDaily(period: string): Promise<DailyPoint[]> {
  const res = await platformFetch(`/api/v1/platform/billing/daily?period=${encodeURIComponent(period)}`);
  return res.json();
}

export async function recomputePeriod(period: string): Promise<{ period: string; rows: number }> {
  const res = await platformFetch(`/api/v1/platform/billing/recompute?period=${encodeURIComponent(period)}`, {
    method: 'POST',
  });
  return res.json();
}

// ── Platform operations ────────────────────────────────────────────────────

export async function listPlatformUsers(q: {
  tenant_id?: string;
  role?: string;
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ users: AdminUser[]; total: number }> {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const qs = params.toString();
  const res = await platformFetch(`/api/v1/platform/users${qs ? `?${qs}` : ''}`);
  return res.json();
}

export async function createPlatformUser(body: {
  username: string;
  password: string;
  tenant_id: string;
  role: string;
}): Promise<AdminUser> {
  const res = await platformFetch('/api/v1/platform/users', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function updatePlatformUserRole(id: string, role: string): Promise<AdminUser> {
  const res = await platformFetch(`/api/v1/platform/users/${encodeURIComponent(id)}/role`, {
    method: 'PATCH',
    body: JSON.stringify({ role }),
  });
  return res.json();
}

export async function deletePlatformUser(id: string): Promise<void> {
  await platformFetch(`/api/v1/platform/users/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export async function listPlatformTenants(q: {
  search?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ tenants: AdminTenant[]; total: number }> {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const qs = params.toString();
  const res = await platformFetch(`/api/v1/platform/tenants${qs ? `?${qs}` : ''}`);
  return res.json();
}

export async function createPlatformTenant(body: {
  brand_name: string;
  store_count: number;
  model_provider: string;
  model_name: string;
}): Promise<AdminTenant> {
  const res = await platformFetch('/api/v1/platform/tenants', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function updatePlatformTenant(id: string, body: {
  brand_name?: string;
  store_count?: number;
  model_provider?: string;
  model_name?: string;
}): Promise<AdminTenant> {
  const res = await platformFetch(`/api/v1/platform/tenants/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  return res.json();
}

export async function regeneratePlatformTenantCode(id: string): Promise<AdminTenant> {
  const res = await platformFetch(`/api/v1/platform/tenants/${encodeURIComponent(id)}/tenant-code/regenerate`, {
    method: 'POST',
  });
  return res.json();
}

export async function deletePlatformTenant(id: string): Promise<void> {
  await platformFetch(`/api/v1/platform/tenants/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface PlatformTaskItem {
  id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  task_type: string;
  status: string;
  task_id: string | null;
  celery_task_id: string | null;
  meta: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export async function listPlatformTasks(q: {
  tenant_id?: string;
  status?: string;
  task_type?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<{ tasks: PlatformTaskItem[]; total: number }> {
  const params = new URLSearchParams();
  Object.entries(q).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  });
  const qs = params.toString();
  const res = await platformFetch(`/api/v1/platform/tasks${qs ? `?${qs}` : ''}`);
  return res.json();
}
