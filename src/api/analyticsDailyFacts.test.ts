import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
const cache = vi.hoisted(() => ({
  readDailyManifest: vi.fn(),
  readDailyFacts: vi.fn(),
  buildClientDays: vi.fn(),
  applyDailyDelta: vi.fn(),
  pruneDailyFacts: vi.fn(),
}));

vi.mock('./client', () => ({ apiFetch }));
vi.mock('./analyticsDailyCache', () => cache);

import { DailyFactUnsupportedError, fetchDailyFacts, getOrderDailyFacts, stableParamsHash } from './analyticsDailyFacts';
import type { DailyFactRecord } from './analyticsDailyTypes';
import { useAuthStore } from '../store/authStore';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function record(date: string, version: string): DailyFactRecord<{ value: number }> {
  return {
    tenantId: 'tenant-a',
    userId: 'admin-a',
    accessScopeHash: 'scope-current',
    namespace: 'orders',
    schemaVersion: 'orders-daily-fact-v4',
    paramsHash: 'hash-orders',
    date,
    version,
    payload: { value: 1 },
    savedAt: '2026-08-01T00:00:00.000Z',
    lastAccessedAt: '2026-08-01T00:00:00.000Z',
  };
}

describe('analyticsDailyFacts', () => {
  it('takes the authenticated principal from the session instead of stale legacy storage', async () => {
    useAuthStore.setState({ tenantId: 'active-tenant', userId: 'active-user' });
    apiFetch.mockResolvedValue(ok({
      namespace: 'orders', schema_version: 'orders-daily-fact-v4', date_from: '2026-08-01', date_to: '2026-08-01',
      params_hash: 'hash-orders', access_scope_hash: 'scope-current', reset_required: false,
      unchanged_days: ['2026-08-01'], changed_days: [], deleted_days: [],
      cache_meta: { status: 'hit', server_checked_days: 1, returned_days: 0, deleted_days: 0 },
    }));
    try {
      await getOrderDailyFacts('2026-08-01', '2026-08-01');
      expect(cache.readDailyManifest).toHaveBeenLastCalledWith(expect.objectContaining({ tenantId: 'active-tenant', userId: 'active-user' }));
    } finally {
      useAuthStore.setState({ tenantId: null, userId: '' });
    }
  });
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubEnv('VITE_ANALYTICS_DAILY_FACT_V2', 'true');
    localStorage.setItem('auth_tenant_id', 'tenant-a');
    localStorage.setItem('auth_user_id', 'admin-a');
    cache.readDailyManifest.mockResolvedValue({
      tenantId: 'tenant-a',
      userId: 'admin-a',
      accessScopeHash: 'scope-current',
      namespace: 'orders',
      schemaVersion: 'orders-daily-fact-v4',
      paramsHash: 'hash-orders',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-01',
      updatedAt: '2026-08-01T00:00:00.000Z',
    });
    cache.readDailyFacts.mockResolvedValue([record('2026-08-01', 'v1')]);
    cache.buildClientDays.mockReturnValue([{ date: '2026-08-01', version: 'v1' }]);
    cache.pruneDailyFacts.mockResolvedValue(0);
  });

  it('sends cached versions and does not rewrite unchanged days', async () => {
    apiFetch.mockResolvedValue(ok({
      namespace: 'orders',
      schema_version: 'orders-daily-fact-v4',
      date_from: '2026-08-01',
      date_to: '2026-08-01',
      params_hash: 'hash-orders',
      access_scope_hash: 'scope-current',
      reset_required: false,
      unchanged_days: ['2026-08-01'],
      changed_days: [],
      deleted_days: [],
      cache_meta: { status: 'hit', server_checked_days: 1, returned_days: 0, deleted_days: 0 },
    }));

    await getOrderDailyFacts('2026-08-01', '2026-08-01', { dim: 'ALL' }, { paramsHash: 'hash-orders' });

    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.client_days).toEqual([{ date: '2026-08-01', version: 'v1' }]);
    expect(body.client_access_scope_hash).toBe('scope-current');
    expect(cache.applyDailyDelta).not.toHaveBeenCalled();
  });

  it('force refresh sends no client days but keeps old cache until success', async () => {
    apiFetch.mockResolvedValue(ok({
      namespace: 'orders',
      schema_version: 'orders-daily-fact-v4',
      date_from: '2026-08-01',
      date_to: '2026-08-01',
      params_hash: 'hash-orders',
      access_scope_hash: 'scope-current',
      reset_required: false,
      unchanged_days: [],
      changed_days: [{ date: '2026-08-01', version: 'v2', payload: { value: 2 } }],
      deleted_days: [],
      cache_meta: { status: 'partial', server_checked_days: 1, returned_days: 1, deleted_days: 0 },
    }));

    await fetchDailyFacts<{ value: number }>({
      endpoint: '/api/v1/analytics/orders/delta',
      namespace: 'orders',
      schemaVersion: 'orders-daily-fact-v4',
      paramsHash: 'hash-orders',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-01',
      params: {},
      forceRefresh: true,
    });

    const body = JSON.parse(apiFetch.mock.calls[0][1].body);
    expect(body.client_days).toEqual([]);
    expect(cache.applyDailyDelta).toHaveBeenCalledTimes(1);
    expect(cache.pruneDailyFacts).toHaveBeenCalledTimes(1);
  });

  it('splits a monthly moving-average history range at the server day limit', async () => {
    cache.readDailyManifest.mockResolvedValue(null);
    cache.readDailyFacts.mockResolvedValue([]);
    cache.buildClientDays.mockReturnValue([]);
    apiFetch.mockImplementation(async (_endpoint, init) => {
      const body = JSON.parse(init.body);
      return ok({
        namespace: 'orders',
        schema_version: 'orders-daily-fact-v4',
        date_from: body.date_from,
        date_to: body.date_to,
        params_hash: 'hash-orders',
        access_scope_hash: 'scope-current',
        reset_required: false,
        unchanged_days: [],
        changed_days: [],
        deleted_days: [],
        cache_meta: { status: 'hit', server_checked_days: 0, returned_days: 0, deleted_days: 0 },
      });
    });

    await getOrderDailyFacts('2025-04-01', '2026-07-31', {}, { paramsHash: 'hash-orders' });

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toMatchObject({
      date_from: '2025-04-01',
      date_to: '2026-04-01',
    });
    expect(JSON.parse(apiFetch.mock.calls[1][1].body)).toMatchObject({
      date_from: '2026-04-02',
      date_to: '2026-07-31',
    });
  });

  it('splits force refresh ranges into at most 31 days', async () => {
    cache.readDailyManifest.mockResolvedValue(null);
    cache.readDailyFacts.mockResolvedValue([]);
    cache.buildClientDays.mockReturnValue([]);
    apiFetch.mockImplementation(async (_endpoint, init) => {
      const body = JSON.parse(init.body);
      return ok({
        namespace: 'orders',
        schema_version: 'orders-daily-fact-v4',
        date_from: body.date_from,
        date_to: body.date_to,
        params_hash: 'hash-orders',
        access_scope_hash: 'scope-current',
        reset_required: false,
        unchanged_days: [],
        changed_days: [],
        deleted_days: [],
        cache_meta: { status: 'hit', server_checked_days: 0, returned_days: 0, deleted_days: 0 },
      });
    });

    await getOrderDailyFacts('2026-01-01', '2026-03-05', {}, {
      paramsHash: 'hash-orders',
      forceRefresh: true,
    });

    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(apiFetch.mock.calls.map(call => {
      const body = JSON.parse(call[1].body);
      return [body.date_from, body.date_to];
    })).toEqual([
      ['2026-01-01', '2026-01-31'],
      ['2026-02-01', '2026-03-03'],
      ['2026-03-04', '2026-03-05'],
    ]);
  });

  it('switches to server access scope after reset response', async () => {
    apiFetch.mockResolvedValue(ok({
      namespace: 'orders',
      schema_version: 'orders-daily-fact-v4',
      date_from: '2026-08-01',
      date_to: '2026-08-01',
      params_hash: 'hash-orders',
      access_scope_hash: 'scope-store-b',
      reset_required: true,
      unchanged_days: [],
      changed_days: [{ date: '2026-08-01', version: 'v2', payload: { value: 2 } }],
      deleted_days: [],
      cache_meta: { status: 'partial', server_checked_days: 1, returned_days: 1, deleted_days: 0 },
    }));

    await getOrderDailyFacts('2026-08-01', '2026-08-01', {}, { paramsHash: 'hash-orders' });

    expect(cache.readDailyFacts).toHaveBeenLastCalledWith(
      expect.objectContaining({ accessScopeHash: 'scope-store-b' }),
      ['2026-08-01'],
    );
    expect(cache.applyDailyDelta).toHaveBeenCalledWith(
      expect.objectContaining({ accessScopeHash: 'scope-current' }),
      expect.objectContaining({ access_scope_hash: 'scope-store-b', reset_required: true }),
      expect.objectContaining({ accessScopeHash: 'pending' }),
    );
  });

  it('reuses the base manifest alias to read effective IndexedDB records on the next request', async () => {
    cache.readDailyManifest.mockResolvedValue({
      tenantId: 'tenant-a', userId: 'admin-a', accessScopeHash: 'scope-real', namespace: 'analytics.orders.daily',
      schemaVersion: 'orders-daily-fact-v4', paramsHash: 'server-sha16', dateFrom: '2026-08-01', dateTo: '2026-08-01', updatedAt: 'now',
    });
    cache.readDailyFacts.mockResolvedValue([record('2026-08-01', 'first-version')]);
    cache.buildClientDays.mockReturnValue([{ date: '2026-08-01', version: 'first-version' }]);
    apiFetch.mockResolvedValue(ok({
      namespace: 'analytics.orders.daily', schema_version: 'orders-daily-fact-v4', date_from: '2026-08-01', date_to: '2026-08-01',
      params_hash: 'server-sha16', access_scope_hash: 'scope-real', reset_required: false, unchanged_days: ['2026-08-01'], changed_days: [], deleted_days: [],
      cache_meta: { status: 'hit', server_checked_days: 1, returned_days: 0, deleted_days: 0 },
    }));

    await getOrderDailyFacts('2026-08-01', '2026-08-01', { dim: 'ALL' });

    expect(cache.readDailyFacts).toHaveBeenCalledWith(expect.objectContaining({
      accessScopeHash: 'scope-real', paramsHash: 'server-sha16', namespace: 'analytics.orders.daily',
    }), ['2026-08-01']);
    expect(JSON.parse(apiFetch.mock.calls[0][1].body)).toMatchObject({
      client_access_scope_hash: 'scope-real', client_days: [{ date: '2026-08-01', version: 'first-version' }],
    });
  });

  it('builds a stable params hash independent of object key order', () => {
    expect(stableParamsHash({ b: 2, a: 1 })).toBe(stableParamsHash({ a: 1, b: 2 }));
  });

  it('uses the V1 delta contract when the V2 build flag is disabled', async () => {
    vi.stubEnv('VITE_ANALYTICS_DAILY_FACT_V2', 'false');

    await expect(getOrderDailyFacts('2026-08-01', '2026-08-01', { dim: 'all' }))
      .rejects.toBeInstanceOf(DailyFactUnsupportedError);

    expect(apiFetch).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('rejects a successful response that does not satisfy the V2 contract', async () => {
    apiFetch.mockResolvedValue(ok({ rows: [], total: 0 }));

    await expect(getOrderDailyFacts('2026-08-01', '2026-08-01'))
      .rejects.toBeInstanceOf(DailyFactUnsupportedError);

    expect(cache.applyDailyDelta).not.toHaveBeenCalled();
  });
});
