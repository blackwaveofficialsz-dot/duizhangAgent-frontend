import { apiFetch } from './client';

export type AccessKind = 'group' | 'role';
export type AccessPrincipal = {
  id: string; kind: AccessKind; name: string; version: number;
  members: { id: string; username: string }[]; store_keys: string[];
};
export type AccessDraft = {
  kind: AccessKind; name: string; member_ids: string[]; store_keys: string[]; version?: number;
};
export type StoreOption = { key: string; name: string };
export type EffectiveStoreAccess = { all_stores: boolean; store_keys: string[] };
const base = '/api/v1/admin/store-access';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(url, init);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `操作失败 (${response.status})`);
  }
  return response.status === 204 ? undefined as T : response.json();
}
export const listStoreAccess = (kind: AccessKind, signal?: AbortSignal) =>
  request<{ items: AccessPrincipal[] }>(`${base}?kind=${kind}`, { signal });
export const listAccessStores = (signal?: AbortSignal) =>
  request<{ items: StoreOption[] }>(`${base}/stores`, { signal });
export const getMemberStoreAccess = (id: string, signal?: AbortSignal) =>
  request<EffectiveStoreAccess>(`${base}/members/${encodeURIComponent(id)}`, { signal });
export const getMyStoreAccess = (signal?: AbortSignal) =>
  request<EffectiveStoreAccess>('/api/v1/store-access/me', { signal });
export const saveStoreAccess = (id: string | undefined, body: AccessDraft, signal?: AbortSignal) =>
  request<AccessPrincipal>(id ? `${base}/${encodeURIComponent(id)}` : base, {
    method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
  });
export const deleteStoreAccess = (row: AccessPrincipal, signal?: AbortSignal) =>
  request<void>(`${base}/${encodeURIComponent(row.id)}?version=${row.version}`, { method: 'DELETE', signal });
