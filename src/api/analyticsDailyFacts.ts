import { apiFetch } from './client';
import { useAuthStore } from '../store/authStore';
import {
  applyDailyDelta,
  buildClientDays,
  readDailyFacts,
  readDailyManifest,
  pruneDailyFacts,
  type DailyFactIdentity,
} from './analyticsDailyCache';

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_REQUEST_DAYS = 366;
const MAX_FORCE_REFRESH_DAYS = 31;
let lastPruneAt = 0;

function pruneDailyFactsEventually(): void {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_INTERVAL_MS) return;
  lastPruneAt = now;
  void pruneDailyFacts().catch(() => undefined);
}
import type { DailyFactDeltaResponse, DailyFactRecord } from './analyticsDailyTypes';

export type DailyFactFetchRequest = {
  endpoint: string;
  namespace: string;
  schemaVersion: string;
  paramsHash?: string;
  accessScopeHash?: string;
  dateFrom: string;
  dateTo: string;
  params?: Record<string, unknown>;
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

export class DailyFactUnsupportedError extends Error {
  constructor(message = 'daily fact endpoint is unsupported') {
    super(message);
    this.name = 'DailyFactUnsupportedError';
  }
}

export function analyticsDailyFactV2Enabled(): boolean {
  return String(import.meta.env.VITE_ANALYTICS_DAILY_FACT_V2 || '').toLowerCase() === 'true';
}

function currentTenantId(): string {
  const tenantId = useAuthStore.getState().tenantId;
  if (tenantId) return tenantId;
  try {
    return localStorage.getItem('auth_tenant_id') || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function currentUserId(): string {
  const userId = useAuthStore.getState().userId;
  if (userId) return userId;
  try {
    return localStorage.getItem('auth_user_id') || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function stableParamsHash(params: Record<string, unknown> = {}): string {
  let hash = 0x811c9dc5;
  const raw = stableStringify(params);
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `p${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function eachDate(dateFrom: string, dateTo: string): string[] {
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return [];
  const dates: string[] = [];
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)) {
    dates.push(cursor.toISOString().slice(0, 10));
  }
  return dates;
}

function splitDateRange(dateFrom: string, dateTo: string, maxDays: number): Array<[string, string]> {
  const dates = eachDate(dateFrom, dateTo);
  const ranges: Array<[string, string]> = [];
  for (let index = 0; index < dates.length; index += maxDays) {
    const chunk = dates.slice(index, index + maxDays);
    ranges.push([chunk[0], chunk[chunk.length - 1]]);
  }
  return ranges;
}

function principalIdentity(request: DailyFactFetchRequest): DailyFactIdentity {
  return {
    tenantId: currentTenantId(),
    userId: currentUserId(),
    accessScopeHash: request.accessScopeHash || 'pending',
    namespace: request.namespace,
    schemaVersion: request.schemaVersion,
    paramsHash: request.paramsHash || stableParamsHash(request.params),
  };
}

async function parseDeltaResponse<T>(response: Response): Promise<DailyFactDeltaResponse<T>> {
  if (response.status === 404 || response.status === 409) throw new DailyFactUnsupportedError();
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`;
    try {
      const body = await response.json();
      detail = body.detail || detail;
      if (body.code === 'unsupported_schema' || body.detail === 'unsupported_schema') throw new DailyFactUnsupportedError();
    } catch (err) {
      if (err instanceof DailyFactUnsupportedError) throw err;
    }
    throw Object.assign(new Error(detail), { status: response.status });
  }
  const body = await response.json();
  if (body?.code === 'unsupported_schema') throw new DailyFactUnsupportedError();
  if (!isDeltaResponse<T>(body)) {
    throw new DailyFactUnsupportedError('invalid daily fact V2 response');
  }
  return {
    ...body,
    changed_days: body.changed_days.map((day) => ({
      ...day,
      completeness: day.completeness || {},
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isDeltaResponse<T>(value: unknown): value is DailyFactDeltaResponse<T> {
  if (!isRecord(value)) return false;
  const cacheMeta = value.cache_meta;
  const changedDays = value.changed_days;
  const validStatus = new Set(['hit', 'miss', 'partial', 'bypass', 'error']);
  return typeof value.namespace === 'string' && value.namespace.length > 0
    && typeof value.schema_version === 'string' && value.schema_version.length > 0
    && typeof value.date_from === 'string'
    && typeof value.date_to === 'string'
    && typeof value.params_hash === 'string' && value.params_hash.length > 0
    && typeof value.access_scope_hash === 'string' && value.access_scope_hash.length > 0
    && typeof value.reset_required === 'boolean'
    && isStringArray(value.unchanged_days)
    && isStringArray(value.deleted_days)
    && Array.isArray(changedDays)
    && changedDays.every((item) => (
      isRecord(item)
      && typeof item.date === 'string'
      && typeof item.version === 'string'
      && isRecord(item.payload)
      && (item.completeness === undefined || isRecord(item.completeness))
    ))
    && isRecord(cacheMeta)
    && typeof cacheMeta.status === 'string'
    && validStatus.has(cacheMeta.status)
    && typeof cacheMeta.server_checked_days === 'number'
    && typeof cacheMeta.returned_days === 'number'
    && typeof cacheMeta.deleted_days === 'number';
}

async function fetchDailyFactChunk<T>(
  request: DailyFactFetchRequest,
): Promise<DailyFactRecord<T>[]> {
  const baseIdentity = principalIdentity(request);
  const manifest = await readDailyManifest(baseIdentity);
  const effectiveIdentity: DailyFactIdentity = manifest ? {
    ...baseIdentity,
    namespace: manifest.namespace,
    schemaVersion: manifest.schemaVersion,
    paramsHash: manifest.paramsHash,
    accessScopeHash: manifest.accessScopeHash,
  } : baseIdentity;
  const dates = eachDate(request.dateFrom, request.dateTo);
  const cachedRecords = request.forceRefresh ? [] : await readDailyFacts<T>(effectiveIdentity, dates);
  const clientDays = request.forceRefresh ? [] : buildClientDays(cachedRecords);
  const response = await apiFetch(request.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: request.signal,
    body: JSON.stringify({
      schema_version: request.schemaVersion,
      date_from: request.dateFrom,
      date_to: request.dateTo,
      params: request.params || {},
      client_access_scope_hash: effectiveIdentity.accessScopeHash,
      client_days: clientDays,
      force_refresh: !!request.forceRefresh,
    }),
  });
  const delta = await parseDeltaResponse<T>(response);
  const scopedIdentity: DailyFactIdentity = {
    ...baseIdentity,
    namespace: delta.namespace || baseIdentity.namespace,
    schemaVersion: delta.schema_version || baseIdentity.schemaVersion,
    paramsHash: delta.params_hash || baseIdentity.paramsHash,
    accessScopeHash: delta.access_scope_hash || baseIdentity.accessScopeHash,
  };
  if (delta.reset_required || delta.changed_days.length || delta.deleted_days.length) {
    await applyDailyDelta(effectiveIdentity, delta, baseIdentity);
    pruneDailyFactsEventually();
  }
  return readDailyFacts<T>(scopedIdentity, dates);
}

export async function fetchDailyFacts<T>(
  request: DailyFactFetchRequest,
): Promise<DailyFactRecord<T>[]> {
  if (!analyticsDailyFactV2Enabled()) throw new DailyFactUnsupportedError('daily fact V2 is disabled');
  const ranges = splitDateRange(
    request.dateFrom,
    request.dateTo,
    request.forceRefresh ? MAX_FORCE_REFRESH_DAYS : MAX_REQUEST_DAYS,
  );
  const records: DailyFactRecord<T>[] = [];
  for (const [dateFrom, dateTo] of ranges) {
    records.push(...await fetchDailyFactChunk<T>({ ...request, dateFrom, dateTo }));
  }
  return records;
}

export function getOrderDailyFacts<T = Record<string, unknown>>(
  dateFrom: string,
  dateTo: string,
  params: Record<string, unknown> = {},
  options: Omit<DailyFactFetchRequest, 'endpoint' | 'namespace' | 'schemaVersion' | 'dateFrom' | 'dateTo' | 'params'> = {},
): Promise<DailyFactRecord<T>[]> {
  return fetchDailyFacts<T>({
    ...options,
    endpoint: '/api/v1/analytics/orders/delta',
    namespace: 'analytics.orders.daily',
    schemaVersion: 'orders-daily-fact-v4',
    dateFrom,
    dateTo,
    params,
  });
}

export function getMealDailyFacts<T = Record<string, unknown>>(dateFrom: string, dateTo: string, params: Record<string, unknown> = {}, options: Partial<DailyFactFetchRequest> = {}) {
  return fetchDailyFacts<T>({ ...options, endpoint: '/api/v1/analytics/meal-periods/delta', namespace: 'analytics.meal_period_trend.daily', schemaVersion: 'meal-period-daily-fact-v4', dateFrom, dateTo, params });
}

export function getLaborDailyFacts<T = Record<string, unknown>>(dateFrom: string, dateTo: string, params: Record<string, unknown> = {}, options: Partial<DailyFactFetchRequest> = {}) {
  return fetchDailyFacts<T>({ ...options, endpoint: '/api/v1/analytics/labor-efficiency/delta', namespace: 'analytics.labor_trend.daily', schemaVersion: 'labor-daily-fact-v3', dateFrom, dateTo, params });
}

export function getWeatherDailyFacts<T = Record<string, unknown>>(dateFrom: string, dateTo: string, params: Record<string, unknown> = {}, options: Partial<DailyFactFetchRequest> = {}) {
  return fetchDailyFacts<T>({ ...options, endpoint: '/api/v1/analytics/weather/delta', namespace: 'analytics.weather.daily', schemaVersion: 'weather-daily-fact-v2', dateFrom, dateTo, params });
}

export function getProductDailyFacts<T = Record<string, unknown>>(dateFrom: string, dateTo: string, params: Record<string, unknown> = {}, options: Partial<DailyFactFetchRequest> = {}) {
  return fetchDailyFacts<T>({ ...options, endpoint: '/api/v1/analytics/products/delta', namespace: 'analytics.products.daily', schemaVersion: 'product-daily-fact-v2', dateFrom, dateTo, params });
}
