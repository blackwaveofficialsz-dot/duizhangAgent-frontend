import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ apiFetch }));
const getMyStoreAccess = vi.hoisted(() => vi.fn());
vi.mock('./storeAccess', () => ({ getMyStoreAccess }));

import {
  getLaborEfficiency,
  getLaborEfficiencyDetail,
  getLaborEfficiencyTrend,
  getBusinessReport,
  getMealPeriodTurnover,
  getMealPeriodTrend,
  getOrders,
  getProducts,
  getProductTrend,
  getRevenueTrend,
  getStoreWeather,
  getTradeArea,
  listStoreScopeTree,
  listTradeAreaPois,
  refreshTradeArea,
} from './analytics';
import type { LaborTrendPoint, ProductTrendPoint, ProductsResult, RevenueTrendPoint } from './analytics';

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function trendPoint(period: string, netIncome = 100) {
  return {
    period,
    net_income: netIncome,
    order_count: 10,
    ma7: null,
    ma30: null,
    ma180: null,
    missing: false,
  };
}

function productTrendPoint(period: string, quantity = 10) {
  return {
    period,
    quantity,
    sales_amount: quantity * 10,
    order_count: quantity,
    ma7: null,
    ma30: null,
    ma180: null,
    missing: false,
  };
}

function mealPeriodTrendPoint(date: string, netIncome = 100) {
  const row = (periodKey: string, periodLabel: string, value = 0) => ({
    period_key: periodKey,
    period_label: periodLabel,
    order_count: value ? 10 : 0,
    paid_amount: value,
    income_amount: value,
    refund_amount: 0,
    net_income: value,
    avg_order_value: value ? value / 10 : 0,
    ma7: null,
    ma30: null,
    ma180: null,
  });
  return {
    date,
    breakfast: row('breakfast', '早餐', netIncome),
    lunch: row('lunch', '午餐'),
    afternoon_tea: row('afternoon_tea', '下午茶'),
    dinner: row('dinner', '晚餐'),
    late_night: row('late_night', '夜宵'),
  };
}

function ordersPayload(period: string, orderCount = 3) {
  return {
    granularity: 'day',
    period,
    dim: 'all',
    source_type: 'all',
    rows: [{
      dim_key: 'ALL',
      dim_label: '全部',
      order_count: orderCount,
      paid_amount: 100,
      income_amount: 90,
      refund_amount: 0,
      net_amount: 100,
      net_income: 90,
      avg_order_value: 90 / orderCount,
      refund_rate: 0,
      computed_at: '2026-06-15T09:00:00',
    }],
    excluded: { excluded_orders: 0, excluded_shops: [], confirmed_shops: 11 },
    snapshot_status: 'ready',
    refresh_queued: false,
    backfill_queued: false,
  };
}

function laborTrendPoint(period: string, actualHours = 8) {
  return {
    period,
    net_revenue: 100,
    actual_hours: actualHours,
    planned_hours: 8,
    actual_revenue_per_hour: actualHours ? 100 / actualHours : 0,
    planned_revenue_per_hour: 12.5,
    headcount: 1,
    missing: false,
    actual_hours_ma7: null,
    actual_hours_ma30: null,
    actual_hours_ma180: null,
    planned_hours_ma7: null,
    planned_hours_ma30: null,
    planned_hours_ma180: null,
    actual_revenue_per_hour_ma7: null,
    actual_revenue_per_hour_ma30: null,
    actual_revenue_per_hour_ma180: null,
    planned_revenue_per_hour_ma7: null,
    planned_revenue_per_hour_ma30: null,
    planned_revenue_per_hour_ma180: null,
  };
}

function weatherPayload(period: string, temp = 30) {
  return {
    store_key: '53950',
    granularity: 'day',
    period_key: period,
    rainy_hours: 0,
    heavy_rain_hours: 0,
    avg_temp: temp,
    max_temp: temp + 2,
    min_temp: temp - 2,
    avg_humidity: 70,
    bad_weather_tags: [],
  };
}

function productRow(productKey: string, productName: string, quantity: number, salesAmount = quantity * 10): ProductsResult['top'][number] {
  return {
    product_key: productKey,
    product_name: productName,
    quantity,
    sales_amount: salesAmount,
    order_count: quantity,
    sales_share: 0,
  };
}

function productsPayload(quantity = 3): ProductsResult {
  return {
    top: [productRow('p1', '肉夹馍', quantity)],
    bottom: [],
    total: 1,
    snapshot_status: 'ready',
  };
}

function installFakeIndexedDB() {
  const entries = new Map<IDBValidKey, unknown>();

  function request<T>(value: T): IDBRequest<T> {
    const req = {
      result: undefined as T,
      error: null,
      onsuccess: null as ((event: Event) => void) | null,
      onerror: null as ((event: Event) => void) | null,
    };
    queueMicrotask(() => {
      req.result = value;
      req.onsuccess?.(new Event('success'));
    });
    return req as IDBRequest<T>;
  }

  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: vi.fn(),
    transaction: () => {
      const tx = {
        error: null,
        oncomplete: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onabort: null as ((event: Event) => void) | null,
        objectStore: () => ({
          get: (key: IDBValidKey) => request(entries.get(key)),
          put: (value: unknown, key: IDBValidKey) => {
            entries.set(key, value);
            queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
            return request(key);
          },
          delete: (key: IDBValidKey) => {
            entries.delete(key);
            queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
            return request(undefined);
          },
          openCursor: () => {
            const keys = Array.from(entries.keys());
            let index = 0;
            const req = {
              result: null as IDBCursorWithValue | null,
              error: null,
              onsuccess: null as ((event: Event) => void) | null,
              onerror: null as ((event: Event) => void) | null,
            };
            const fire = () => {
              const key = keys[index];
              if (key === undefined) {
                req.result = null;
                req.onsuccess?.(new Event('success'));
                queueMicrotask(() => tx.oncomplete?.(new Event('complete')));
                return;
              }
              req.result = {
                key,
                value: entries.get(key),
                continue: () => {
                  index += 1;
                  queueMicrotask(fire);
                },
                delete: () => {
                  entries.delete(key);
                  return request(undefined);
                },
              } as IDBCursorWithValue;
              req.onsuccess?.(new Event('success'));
            };
            queueMicrotask(fire);
            return req as IDBRequest<IDBCursorWithValue | null>;
          },
        }),
      };
      return tx as unknown as IDBTransaction;
    },
  };

  vi.stubGlobal('indexedDB', {
    open: () => {
      const req = {
        result: db,
        error: null,
        onupgradeneeded: null as ((event: Event) => void) | null,
        onsuccess: null as ((event: Event) => void) | null,
        onerror: null as ((event: Event) => void) | null,
        onblocked: null as ((event: Event) => void) | null,
      };
      queueMicrotask(() => req.onsuccess?.(new Event('success')));
      return req as unknown as IDBOpenDBRequest;
    },
  });

  return entries;
}

function forceAnalyticsCacheIntoIndexedDB() {
  let storageMethodOwner: object | null = localStorage;
  while (storageMethodOwner && !Object.prototype.hasOwnProperty.call(storageMethodOwner, 'setItem')) {
    storageMethodOwner = Object.getPrototypeOf(storageMethodOwner);
  }
  if (!storageMethodOwner) throw new Error('localStorage.setItem is unavailable');
  const owner = storageMethodOwner as Record<'setItem', Storage['setItem']>;
  const originalSetItem = owner.setItem;
  return vi.spyOn(owner, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith('analytics-api-cache-v2:') && key !== 'analytics-api-cache-v2:cache-bust') {
      throw new Error('quota exceeded');
    }
    return originalSetItem.call(this, key, value);
  });
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dispatchAnalyticsCacheBust(namespace: string, cacheKey?: string): void {
  window.dispatchEvent(new StorageEvent('storage', {
    key: 'analytics-api-cache-v2:cache-bust',
    newValue: JSON.stringify({
      tenantId: localStorage.getItem('auth_tenant_id') || 'anonymous',
      day: todayKey(),
      namespace,
      cacheKey,
      nonce: 'test',
    }),
  }));
}

function localStorageKeys(): string[] {
  return Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index)).filter(Boolean) as string[];
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('analytics api', () => {
  beforeEach(() => {
    apiFetch.mockReset();
    getMyStoreAccess.mockReset().mockResolvedValue({ all_stores: true, store_keys: [] });
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves order refresh metadata from backend', async () => {
    apiFetch.mockResolvedValue(ok({
      rows: [],
      excluded: { excluded_orders: 0, excluded_shops: [], confirmed_shops: 11 },
      snapshot_status: 'missing',
      refresh_queued: true,
    }));

    const result = await getOrders('day', '2026-06-18', 'shop', true);

    expect(result.refresh_queued).toBe(true);
    expect(result.snapshot_status).toBe('missing');
  });

  it('loads the shared store scope tree', async () => {
    const response = { nodes: [], store_count: 0, source: 'flat' };
    apiFetch.mockResolvedValue(ok(response));

    await expect(listStoreScopeTree()).resolves.toEqual(response);
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/analytics/store-scope-tree');
  });

  it('uses cached GET endpoints for week and month trends', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ metric: 'net_income', points: [] }))
      .mockResolvedValueOnce(ok({ granularity: 'month', points: [] }))
      .mockResolvedValueOnce(ok({ metric: 'quantity', points: [] }));

    await getRevenueTrend('2026-06-15', '2026-07-19', 'ALL', 'all', {
      granularity: 'week',
      includeCurrent: true,
    });
    await getLaborEfficiencyTrend('2026-02-01', '2026-06-30', 'ALL', 30, {
      granularity: 'month',
      includeCurrent: false,
    });
    await getProductTrend('sku-1', '2026-06-15', '2026-07-19', 'ALL', 'all', {
      granularity: 'week',
      includeCurrent: true,
    });

    const urls = apiFetch.mock.calls.map(([url]) => new URL(String(url), 'http://localhost'));
    expect(urls.map(url => url.pathname)).toEqual([
      '/api/v1/analytics/trends/revenue',
      '/api/v1/analytics/labor-efficiency/trend',
      '/api/v1/analytics/products/trend',
    ]);
    expect(urls.map(url => [url.searchParams.get('granularity'), url.searchParams.get('include_current')])).toEqual([
      ['week', 'true'],
      ['month', 'false'],
      ['week', 'true'],
    ]);
  });

  it('accepts period trend points without daily moving-average fields', async () => {
    const revenuePoint: RevenueTrendPoint = {
      period: '2026-W29', net_income: 100, order_count: 10, missing: false, ma4: null,
    };
    const productPoint: ProductTrendPoint = {
      period: '2026-06', quantity: 10, sales_amount: 100, order_count: 5, missing: false, ma3: null,
    };
    const laborPoint: LaborTrendPoint = {
      period: '2026-W29', net_revenue: 100, actual_hours: 8, planned_hours: 8,
      actual_revenue_per_hour: 12.5, planned_revenue_per_hour: 12.5, headcount: 1,
      missing: false, actual_hours_ma4: null,
    };
    apiFetch
      .mockResolvedValueOnce(ok({ metric: 'net_income', points: [revenuePoint] }))
      .mockResolvedValueOnce(ok({ metric: 'quantity', points: [productPoint] }))
      .mockResolvedValueOnce(ok({ granularity: 'week', points: [laborPoint] }));

    const revenue = await getRevenueTrend('2026-07-13', '2026-07-19', 'ALL', 'all', { granularity: 'week' });
    const product = await getProductTrend('sku-1', '2026-06-01', '2026-06-30', 'ALL', 'all', { granularity: 'month' });
    const labor = await getLaborEfficiencyTrend('2026-07-13', '2026-07-19', 'ALL', 30, { granularity: 'week' });

    expect(revenue.points[0].ma4).toBeNull();
    expect(product.points[0].ma3).toBeNull();
    expect(labor.points[0].actual_hours_ma4).toBeNull();
  });

  it('isolates complete trend cache entries by period options', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ metric: 'net_income', points: [{ period: 'week' }] }))
      .mockResolvedValueOnce(ok({ metric: 'net_income', points: [{ period: 'month' }] }))
      .mockResolvedValueOnce(ok({ metric: 'net_income', points: [{ period: 'current' }] }));

    await getRevenueTrend('2026-06-01', '2026-06-30', 'ALL', 'all', { granularity: 'week' });
    await getRevenueTrend('2026-06-01', '2026-06-30', 'ALL', 'all', { granularity: 'month' });
    await getRevenueTrend('2026-06-01', '2026-06-30', 'ALL', 'all', { granularity: 'week', includeCurrent: true });

    expect(apiFetch).toHaveBeenCalledTimes(3);
  });

  it('versions complete trend caches after shared period semantics change', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ metric: 'net_income', points: [] }))
      .mockResolvedValueOnce(ok({ metric: 'quantity', points: [] }))
      .mockResolvedValueOnce(ok({ granularity: 'week', points: [] }));

    await getRevenueTrend('2026-06-01', '2026-06-30', 'ALL', 'all', { granularity: 'week' });
    await getProductTrend('sku-1', '2026-06-01', '2026-06-30', 'ALL', 'all', { granularity: 'month' });
    await getLaborEfficiencyTrend('2026-06-01', '2026-06-30', 'ALL', 30, { granularity: 'week' });

    const keys = localStorageKeys();
    expect(keys.some(key => key.includes(':analytics.revenue_trend.v2:'))).toBe(true);
    expect(keys.some(key => key.includes(':analytics.product_trend.v2:'))).toBe(true);
    expect(keys.some(key => key.includes(':analytics.labor_trend.v2:'))).toBe(true);
  });

  it('reuses daily revenue trend cache after backend version check', async () => {
    const movingAverages = [
      { field: 'ma7', label: 'MA7', window: 7, available: true, available_periods: 2 },
      { field: 'ma30', label: 'MA30', window: 30, available: true, available_periods: 2 },
      { field: 'ma180', label: 'MA180', window: 180, available: false, available_periods: 2 },
    ];
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [
          { date: '2026-06-01', version: 'v1', payload: trendPoint('2026-06-01', 10) },
          { date: '2026-06-02', version: 'v2', payload: trendPoint('2026-06-02', 20) },
        ],
        unchanged_days: [],
        moving_averages: movingAverages,
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-06-01', '2026-06-02'],
      }));

    const first = await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'takeout');
    const second = await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'takeout');

    expect(first.points.map((point) => point.net_income)).toEqual([10, 20]);
    expect(first.granularity).toBe('day');
    expect(first.moving_averages).toEqual(movingAverages);
    expect(second.points.map((point) => point.net_income)).toEqual([10, 20]);
    expect(second.moving_averages).toEqual(movingAverages);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/trends/revenue/delta');
    expect(apiFetch.mock.calls[1][0]).toBe('/api/v1/analytics/trends/revenue/delta');
    const firstBody = JSON.parse(String(apiFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(firstBody.params.source_type).toBe('takeout');
    expect(firstBody.client_days).toEqual([]);
    expect(secondBody.client_days).toEqual([
      { date: '2026-06-01', version: 'v1' },
      { date: '2026-06-02', version: 'v2' },
    ]);
  });

  it('stores revenue trend daily shards in one bucket key per parameter set', async () => {
    apiFetch.mockResolvedValueOnce(ok({
      changed_days: [
        { date: '2026-06-01', version: 'v1', payload: trendPoint('2026-06-01', 10) },
        { date: '2026-06-02', version: 'v2', payload: trendPoint('2026-06-02', 20) },
      ],
      unchanged_days: [],
    }));

    await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'takeout');

    const dailyKeys = localStorageKeys().filter((key) => key.includes(':analytics.revenue_trend.daily.v2:'));
    expect(dailyKeys).toHaveLength(1);
    expect(dailyKeys[0]).toContain(':analytics.revenue_trend.daily.v2:ALL:takeout');
    const entry = JSON.parse(localStorage.getItem(dailyKeys[0]) || '{}');
    expect(Object.keys(entry.payload.days).sort()).toEqual(['2026-06-01', '2026-06-02']);
  });

  it('coalesces inflight analytics requests with the same cache key', async () => {
    let resolveFetch: (value: Response) => void = () => {};
    apiFetch.mockReturnValue(new Promise<Response>((resolve) => { resolveFetch = resolve; }));

    const first = getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'takeout');
    const second = getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'takeout');
    await flushPromises();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    resolveFetch(ok({
      changed_days: [
        { date: '2026-06-01', version: 'v1', payload: trendPoint('2026-06-01') },
        { date: '2026-06-02', version: 'v2', payload: trendPoint('2026-06-02') },
      ],
      unchanged_days: [],
    }));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });

  it('falls back to legacy revenue trend endpoint when delta is unavailable', async () => {
    apiFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(ok({
        metric: 'net_income',
        date_from: '2026-06-01',
        date_to: '2026-06-02',
        store_key: 'ALL',
        source_type: 'takeout',
        points: [trendPoint('2026-06-01'), trendPoint('2026-06-02')],
      }));

    const result = await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'takeout');

    expect(result.points).toHaveLength(2);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[1][0]).toContain('/api/v1/analytics/trends/revenue?');
    expect(apiFetch.mock.calls[1][0]).toContain('source_type=takeout');
  });

  it('uses sorted repeated store keys for multi-store revenue trends', async () => {
    apiFetch.mockResolvedValueOnce(ok({
      metric: 'net_income',
      date_from: '2026-06-01',
      date_to: '2026-06-02',
      store_key: 'MULTI',
      store_keys: ['101', '102'],
      source_type: 'all',
      points: [],
      store_trends: {},
    }));

    await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'all', {
      storeKeys: ['102', '101', '102'],
    });

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch.mock.calls[0][0]).toBe(
      '/api/v1/analytics/trends/revenue?date_from=2026-06-01&date_to=2026-06-02&store_key=ALL&source_type=all&store_keys=101&store_keys=102&granularity=day&include_current=false&refresh=false',
    );
  });

  it('uses complete endpoints when store trend bundles are required', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        metric: 'net_income',
        date_from: '2026-06-01',
        date_to: '2026-06-02',
        store_key: 'ALL',
        points: [],
        store_trends: { '101': [] },
      }))
      .mockResolvedValueOnce(ok({
        store_key: 'ALL',
        date_from: '2026-06-01',
        date_to: '2026-06-02',
        points: [],
        store_trends: { '101': [] },
      }))
      .mockResolvedValueOnce(ok({
        metric: 'quantity',
        date_from: '2026-06-01',
        date_to: '2026-06-02',
        dim_type: 'all',
        dim_key: 'ALL',
        product_key: 'sku-1',
        points: [],
        store_trends: { '101': [] },
      }));

    await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'all', {
      includeStoreTrends: true,
    });
    await getMealPeriodTrend('ALL', '2026-06-01', '2026-06-02', {
      includeStoreTrends: true,
    });
    await getProductTrend('sku-1', '2026-06-01', '2026-06-02', 'ALL', 'all', {
      includeStoreTrends: true,
    });

    expect(apiFetch.mock.calls.map(call => call[0])).toEqual([
      '/api/v1/analytics/trends/revenue?date_from=2026-06-01&date_to=2026-06-02&store_key=ALL&source_type=all&granularity=day&include_current=false&refresh=false',
      '/api/v1/analytics/stores/ALL/meal-periods/trend?date_from=2026-06-01&date_to=2026-06-02&refresh=false',
      '/api/v1/analytics/products/trend?product_key=sku-1&date_from=2026-06-01&date_to=2026-06-02&dim_key=ALL&dim_type=all&granularity=day&include_current=false&refresh=false',
    ]);
  });

  it('revalidates complete trend data without forcing a backend snapshot rebuild', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        metric: 'net_income',
        date_from: '2026-06-01',
        date_to: '2026-06-02',
        store_key: 'ALL',
        points: [],
        store_trends: {},
      }))
      .mockResolvedValueOnce(ok({
        metric: 'net_income',
        date_from: '2026-06-01',
        date_to: '2026-06-02',
        store_key: 'ALL',
        points: [],
        store_trends: { '101': [] },
      }));

    await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'all', {
      includeStoreTrends: true,
    });
    await getRevenueTrend('2026-06-01', '2026-06-02', 'ALL', 'all', {
      includeStoreTrends: true,
      revalidate: true,
    });

    expect(apiFetch.mock.calls.map(call => call[0])).toEqual([
      '/api/v1/analytics/trends/revenue?date_from=2026-06-01&date_to=2026-06-02&store_key=ALL&source_type=all&granularity=day&include_current=false&refresh=false',
      '/api/v1/analytics/trends/revenue?date_from=2026-06-01&date_to=2026-06-02&store_key=ALL&source_type=all&granularity=day&include_current=false&refresh=false',
    ]);
  });

  it('builds range product ranking from complete daily delta shards', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [
          {
            date: '2026-06-01',
            version: 'p1',
            payload: {
              top: [productRow('burger', '肉夹馍', 8, 80), productRow('noodle', '凉皮', 3, 30)],
              bottom: [],
              total: 2,
              snapshot_status: 'ready',
            },
          },
          {
            date: '2026-06-02',
            version: 'p2',
            payload: {
              top: [productRow('noodle', '凉皮', 9, 90), productRow('drink', '冰峰', 2, 20)],
              bottom: [],
              total: 2,
              snapshot_status: 'ready',
            },
          },
        ],
        unchanged_days: [],
        cache_meta: { status: 'miss', returned_days: 2, server_checked_days: 2 },
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-06-01', '2026-06-02'],
        cache_meta: { status: 'hit', returned_days: 0, server_checked_days: 2 },
      }));

    const first = await getProducts('day', '2026-06-02', 'ALL', false, 1, 'all', false, {
      dateFrom: '2026-06-01',
      dateTo: '2026-06-02',
    });
    const second = await getProducts('day', '2026-06-02', 'ALL', false, 1, 'all', false, {
      dateFrom: '2026-06-01',
      dateTo: '2026-06-02',
    });

    expect(first.top.map(row => [row.product_key, row.sales_amount])).toEqual([['noodle', 120]]);
    expect(second.top.map(row => [row.product_key, row.sales_amount])).toEqual([['noodle', 120]]);
    expect(first.total).toBe(3);
    expect(first.cache_meta?.status).toBe('miss');
    expect(second.cache_meta?.status).toBe('hit');
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/products/delta');
    const firstBody = JSON.parse(String(apiFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(firstBody.params.full_rows).toBe(true);
    expect(firstBody.params.limit).toBe(1);
    expect(secondBody.client_days).toEqual([
      { date: '2026-06-01', version: 'p1' },
      { date: '2026-06-02', version: 'p2' },
    ]);
  });

  it('caches product ranking fallback requests through the shared analytics cache', async () => {
    apiFetch.mockImplementation(() => Promise.resolve(ok({
      top: [],
      bottom: [],
      total: 0,
      snapshot_status: 'ready',
    })));

    await getProducts('hour', '2026-06-01T10', 'ALL', false, 20);
    await getProducts('hour', '2026-06-01T10', 'ALL', false, 20);

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('clears same-tenant cache when another tab broadcasts a cache bust', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ top: [{ product_key: 'old', product_name: '旧', quantity: 1, sales_amount: 10, order_count: 1, sales_share: 1 }], bottom: [], total: 1, snapshot_status: 'ready' }))
      .mockResolvedValueOnce(ok({ top: [{ product_key: 'fresh', product_name: '新', quantity: 2, sales_amount: 20, order_count: 2, sales_share: 1 }], bottom: [], total: 1, snapshot_status: 'ready' }));

    const first = await getProducts('hour', '2026-06-01T10', 'ALL', false, 20);
    dispatchAnalyticsCacheBust('analytics.products');
    const second = await getProducts('hour', '2026-06-01T10', 'ALL', false, 20);

    expect(first.top[0]?.product_key).toBe('old');
    expect(second.top[0]?.product_key).toBe('fresh');
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('reuses daily product trend cache after backend version check', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        product_name: '肉夹馍',
        changed_days: [
          { date: '2026-06-01', version: 'p1', payload: productTrendPoint('2026-06-01', 3) },
          { date: '2026-06-02', version: 'p2', payload: productTrendPoint('2026-06-02', 5) },
        ],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        product_name: '肉夹馍',
        changed_days: [],
        unchanged_days: ['2026-06-01', '2026-06-02'],
      }));

    const first = await getProductTrend('sku-1', '2026-06-01', '2026-06-02', 'ALL', 'all');
    const second = await getProductTrend('sku-1', '2026-06-01', '2026-06-02', 'ALL', 'all');

    expect(first.points.map((point) => point.quantity)).toEqual([3, 5]);
    expect(first.granularity).toBe('day');
    expect(second.points.map((point) => point.quantity)).toEqual([3, 5]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/products/trend/delta');
    expect(apiFetch.mock.calls[1][0]).toBe('/api/v1/analytics/products/trend/delta');
    const firstBody = JSON.parse(String(apiFetch.mock.calls[0][1]?.body));
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(firstBody.schema_version).toBe('product-daily-fact-v2');
    expect(secondBody.client_days).toEqual([
      { date: '2026-06-01', version: 'p1' },
      { date: '2026-06-02', version: 'p2' },
    ]);
    expect(localStorageKeys().some(key => key.includes(':analytics.product_trend.daily.v2:'))).toBe(true);
  });

  it('reuses daily meal period trend cache after backend version check', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [
          { date: '2026-06-01', version: 'm1', payload: mealPeriodTrendPoint('2026-06-01', 10) },
          { date: '2026-06-02', version: 'm2', payload: mealPeriodTrendPoint('2026-06-02', 20) },
        ],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-06-01', '2026-06-02'],
      }));

    const first = await getMealPeriodTrend('ALL', '2026-06-01', '2026-06-02');
    const second = await getMealPeriodTrend('ALL', '2026-06-01', '2026-06-02');

    expect(first.points.map((point) => point.breakfast.net_income)).toEqual([10, 20]);
    expect(second.points.map((point) => point.breakfast.net_income)).toEqual([10, 20]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/stores/ALL/meal-periods/trend/delta');
    expect(apiFetch.mock.calls[1][0]).toBe('/api/v1/analytics/stores/ALL/meal-periods/trend/delta');
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(secondBody.client_days).toEqual([
      { date: '2026-06-01', version: 'm1' },
      { date: '2026-06-02', version: 'm2' },
    ]);
  });

  it('loads meal period turnover by store and date range', async () => {
    apiFetch.mockResolvedValueOnce(ok({
      data_status: 'ok',
      date_from: '2026-06-29',
      date_to: '2026-07-05',
      day_count: 7,
      eligible_store_count: 1,
      table_count: 27,
      excluded_stores: [],
      summary: [],
      points: [],
      store_summaries: [],
    }));

    const result = await getMealPeriodTurnover(
      '53961',
      '2026-06-29',
      '2026-07-05',
    );

    expect(result.table_count).toBe(27);
    expect(apiFetch.mock.calls[0]?.[0]).toBe(
      '/api/v1/analytics/stores/53961/meal-periods/turnover?date_from=2026-06-29&date_to=2026-07-05&refresh=false',
    );
  });

  it('reuses cached meal period turnover for the same store and date range', async () => {
    apiFetch.mockResolvedValueOnce(ok({
      data_status: 'ok',
      date_from: '2026-06-29',
      date_to: '2026-07-05',
      day_count: 7,
      eligible_store_count: 1,
      table_count: 27,
      excluded_stores: [],
      summary: [],
      points: [],
      store_summaries: [],
    }));

    const first = await getMealPeriodTurnover('53961', '2026-06-29', '2026-07-05');
    const second = await getMealPeriodTurnover('53961', '2026-06-29', '2026-07-05');

    expect(first.table_count).toBe(27);
    expect(second.table_count).toBe(27);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('reuses daily order statistics cache after backend version check', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [
          { date: '2026-06-15', version: 'o1', payload: ordersPayload('2026-06-15', 3) },
        ],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-06-15'],
      }));

    const first = await getOrders('day', '2026-06-15', 'all');
    const second = await getOrders('day', '2026-06-15', 'all');

    expect(first.rows[0]?.order_count).toBe(3);
    expect(second.rows[0]?.order_count).toBe(3);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/orders/delta');
    expect(apiFetch.mock.calls[1][0]).toBe('/api/v1/analytics/orders/delta');
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(secondBody.client_days).toEqual([{ date: '2026-06-15', version: 'o1' }]);
  });

  it('builds week order statistics from daily delta shards', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [
          { date: '2026-06-01', version: 'o1', payload: ordersPayload('2026-06-01', 3) },
          { date: '2026-06-02', version: 'o2', payload: ordersPayload('2026-06-02', 5) },
        ],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-06-01', '2026-06-02'],
      }));

    const first = await getOrders('week', '2026-06-01~2026-06-02', 'all');
    const second = await getOrders('week', '2026-06-01~2026-06-02', 'all');

    expect(first.rows[0]?.order_count).toBe(8);
    expect(first.rows[0]?.avg_order_value).toBe(22.5);
    expect(second.rows[0]?.order_count).toBe(8);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/orders/delta');
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(secondBody.client_days).toEqual([
      { date: '2026-06-01', version: 'o1' },
      { date: '2026-06-02', version: 'o2' },
    ]);
  });

  it('aggregates order money in integer cents', async () => {
    const firstDay = ordersPayload('2026-06-01', 1);
    const secondDay = ordersPayload('2026-06-02', 2);
    Object.assign(firstDay.rows[0], {
      paid_amount: 0.1,
      income_amount: 0.1,
      refund_amount: 0.2,
      net_amount: -0.1,
      net_income: -0.1,
    });
    Object.assign(secondDay.rows[0], {
      paid_amount: 0.2,
      income_amount: 0.2,
      refund_amount: 0.1,
      net_amount: -0.2,
      net_income: -0.2,
    });
    apiFetch.mockResolvedValueOnce(ok({
      changed_days: [
        { date: '2026-06-01', version: 'o1', payload: firstDay },
        { date: '2026-06-02', version: 'o2', payload: secondDay },
      ],
      unchanged_days: [],
    }));

    const result = await getOrders('week', '2026-06-01~2026-06-02', 'all');

    expect(result.rows[0]).toMatchObject({
      order_count: 3,
      paid_amount: 0.3,
      income_amount: 0.3,
      refund_amount: 0.3,
      net_amount: -0.3,
      net_income: -0.3,
    });
  });

  it('reuses daily labor trend cache after backend version check', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [
          { date: '2026-06-01', version: 'l1', payload: laborTrendPoint('2026-06-01', 8) },
          { date: '2026-06-02', version: 'l2', payload: laborTrendPoint('2026-06-02', 9) },
        ],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-06-01', '2026-06-02'],
      }));

    const first = await getLaborEfficiencyTrend('2026-06-01', '2026-06-02', 'ALL', 30);
    const second = await getLaborEfficiencyTrend('2026-06-01', '2026-06-02', 'ALL', 30);

    expect(first.points.map((point) => point.actual_hours)).toEqual([8, 9]);
    expect(first.granularity).toBe('day');
    expect(second.points.map((point) => point.actual_hours)).toEqual([8, 9]);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/labor-efficiency/trend/delta');
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(secondBody.client_days).toEqual([
      { date: '2026-06-01', version: 'l1' },
      { date: '2026-06-02', version: 'l2' },
    ]);
    expect(localStorageKeys().some(key => key.includes(':analytics.labor_trend.daily.v2:'))).toBe(true);
  });

  it('reuses daily weather cache after backend version check', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [{ date: '2026-07-09', version: 'w1', payload: weatherPayload('2026-07-09', 31) }],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-07-09'],
      }));

    const first = await getStoreWeather('53950', 'day', '2026-07-09');
    const second = await getStoreWeather('53950', 'day', '2026-07-09');

    expect(first.avg_temp).toBe(31);
    expect(second.avg_temp).toBe(31);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/stores/53950/weather/delta');
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(secondBody.client_days).toEqual([{ date: '2026-07-09', version: 'w1' }]);
  });

  it('reuses daily product ranking cache after backend version check', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({
        changed_days: [{ date: '2026-07-09', version: 'r1', payload: productsPayload(7) }],
        unchanged_days: [],
      }))
      .mockResolvedValueOnce(ok({
        changed_days: [],
        unchanged_days: ['2026-07-09'],
      }));

    const first = await getProducts('day', '2026-07-09', 'ALL', false, 20);
    const second = await getProducts('day', '2026-07-09', 'ALL', false, 20);

    expect(first.top[0]?.quantity).toBe(7);
    expect(second.top[0]?.quantity).toBe(7);
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/products/delta');
    const secondBody = JSON.parse(String(apiFetch.mock.calls[1][1]?.body));
    expect(secondBody.client_days).toEqual([{ date: '2026-07-09', version: 'r1' }]);
  });

  it('caches lightweight analytics detail requests through the shared cache', async () => {
    apiFetch.mockImplementation(() => Promise.resolve(ok({
      store_key: '53950',
      period: { date_from: '2026-06-29', date_to: '2026-07-05', granularity: 'week' },
      employees: [],
      revenue: { paid_amount: 0, income_amount: 0, refund_amount: 0, net_income: 0, order_count: 0, daily: [], shops: [] },
    })));

    await getLaborEfficiencyDetail('2026-06-29', '2026-07-05', '53950');
    await getLaborEfficiencyDetail('2026-06-29', '2026-07-05', '53950');

    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('revalidates labor summaries without forcing a backend rebuild', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ rows: [], snapshot_status: 'stale' }))
      .mockResolvedValueOnce(ok({ rows: [], snapshot_status: 'ready' }));

    await getLaborEfficiency('2026-09-13', '2026-09-13');
    const result = await getLaborEfficiency('2026-09-13', '2026-09-13');

    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch.mock.calls.map(call => call[0])).toEqual([
      '/api/v1/analytics/labor-efficiency?granularity=week&date_from=2026-09-13&date_to=2026-09-13&refresh=false',
      '/api/v1/analytics/labor-efficiency?granularity=week&date_from=2026-09-13&date_to=2026-09-13&refresh=false',
    ]);
    expect(result.snapshot_status).toBe('ready');
  });

  it('requests business reports with refresh=false by default', async () => {
    apiFetch.mockResolvedValue(ok({
      content_md: '经营稳定',
      output_json: {},
      cached: true,
      model: null,
      trace_id: 'trace-1',
      data_sources: [],
      missing_context: [],
      knowledge_candidate_count: 0,
    }));

    await getBusinessReport('month', '2026-06');

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/analytics/business-report?granularity=month&period=2026-06&refresh=false', { method: 'POST' });
  });

  it('caches weather and trade area requests separately', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ store_key: '53950', granularity: 'week', period_key: '2026-W28', rainy_hours: 0, heavy_rain_hours: 0, avg_temp: 30, max_temp: 34, min_temp: 25, avg_humidity: 70, bad_weather_tags: [] }))
      .mockResolvedValueOnce(ok({ store_key: '53950', snapshot_month: '2026-07', poi_counts: {}, density_metrics: {}, scores: {}, tags: [], top_competitors: [], total_pois: 0, fetch_summary: {} }));

    await getStoreWeather('53950', 'week', '2026-W28');
    await getStoreWeather('53950', 'week', '2026-W28');
    await getTradeArea('53950', '2026-07');
    await getTradeArea('53950', '2026-07');

    expect(apiFetch).toHaveBeenCalledTimes(2);
  });

  it('clears cached trade area data before refresh', async () => {
    apiFetch
      .mockResolvedValueOnce(ok({ store_key: '53950', snapshot_month: '2026-07', poi_counts: { old: 1 }, density_metrics: {}, scores: {}, tags: [], top_competitors: [], total_pois: 1, fetch_summary: {} }))
      .mockResolvedValueOnce(ok({ pois: [{ id: 'old-poi', name: '旧 POI' }] }))
      .mockResolvedValueOnce(ok({ status: 'queued', refresh_queued: true }))
      .mockResolvedValueOnce(ok({ store_key: '53950', snapshot_month: '2026-07', poi_counts: { fresh: 1 }, density_metrics: {}, scores: {}, tags: [], top_competitors: [], total_pois: 1, fetch_summary: {} }))
      .mockResolvedValueOnce(ok({ pois: [{ id: 'fresh-poi', name: '新 POI' }] }));

    await getTradeArea('53950', '2026-07');
    await listTradeAreaPois('53950', 'competitor', '2026-07');
    await listTradeAreaPois('53950', 'competitor', '2026-07');
    await refreshTradeArea('53950');
    const fresh = await getTradeArea('53950', '2026-07');
    const freshPois = await listTradeAreaPois('53950', 'competitor', '2026-07');

    expect(apiFetch).toHaveBeenCalledTimes(5);
    expect(fresh.poi_counts).toEqual({ fresh: 1 });
    expect(freshPois).toEqual([{ id: 'fresh-poi', name: '新 POI' }]);
  });

  it('stores large shared cache payloads in indexedDB instead of localStorage', async () => {
    installFakeIndexedDB();
    apiFetch.mockResolvedValue(ok({
      top: [],
      bottom: [],
      total: 0,
      snapshot_status: 'ready',
      large_note: 'x'.repeat(250_000),
    }));

    const first = await getProducts('hour', '2026-06-01T10', 'ALL', false, 20) as ProductsResult & { large_note: string };
    const second = await getProducts('hour', '2026-06-01T10', 'ALL', false, 20) as ProductsResult & { large_note: string };

    expect(first.large_note).toHaveLength(250_000);
    expect(second.large_note).toHaveLength(250_000);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(localStorage.length).toBe(0);
  });

  it('prunes old indexedDB analytics cache entries', async () => {
    installFakeIndexedDB();
    const setItemSpy = forceAnalyticsCacheIntoIndexedDB();
    try {
      apiFetch.mockImplementation(() => Promise.resolve(ok({
        top: [{ product_key: `p-${apiFetch.mock.calls.length}`, product_name: '产品', quantity: 1, sales_amount: 10, order_count: 1, sales_share: 1 }],
        bottom: [],
        total: 1,
        snapshot_status: 'ready',
        large_note: 'x'.repeat(250_000),
      })));

      for (let index = 0; index < 301; index += 1) {
        await getProducts('hour', `2026-06-01T${String(index).padStart(2, '0')}`, 'ALL', false, 20);
      }
      const firstAgain = await getProducts('hour', '2026-06-01T00', 'ALL', false, 20);

      expect(firstAgain.top[0]?.product_key).toBe('p-302');
      expect(apiFetch).toHaveBeenCalledTimes(302);
    } finally {
      setItemSpy.mockRestore();
    }
  });

  it('keeps recently read indexedDB entries when pruning cache overflow', async () => {
    const indexedEntries = installFakeIndexedDB();
    const setItemSpy = forceAnalyticsCacheIntoIndexedDB();
    try {
      apiFetch.mockImplementation(() => Promise.resolve(ok({
        store_key: 's',
        snapshot_month: '2026-07',
        poi_counts: {},
        density_metrics: {},
        scores: {},
        tags: [],
        top_competitors: [],
        total_pois: 0,
        fetch_summary: {},
      })));

      for (let index = 0; index < 300; index += 1) {
        await getTradeArea(`s${index}`, '2026-07');
      }
      await getTradeArea('s0', '2026-07');
      await getTradeArea('s300', '2026-07');

      const cachedStoreKeys = new Set(Array.from(indexedEntries.keys(), (key) => {
        const match = String(key).match(/\/analytics\/stores\/(s\d+)\/trade-area/);
        return match?.[1];
      }).filter(Boolean));
      const missingStoreKeys = Array.from({ length: 301 }, (_, index) => `s${index}`)
        .filter((key) => !cachedStoreKeys.has(key));
      expect(missingStoreKeys).toEqual(['s1']);

      apiFetch.mockClear();
      await getTradeArea('s0', '2026-07');
      await getTradeArea('s1', '2026-07');

      expect(apiFetch).toHaveBeenCalledTimes(1);
      expect(String(apiFetch.mock.calls[0][0])).toContain('/analytics/stores/s1/trade-area');
    } finally {
      setItemSpy.mockRestore();
    }
  });
});


describe('live store access and analytics caching', () => {
  beforeEach(() => { apiFetch.mockReset(); getMyStoreAccess.mockReset(); localStorage.clear(); });
  it('does not reuse an administrator cache after demotion and checks grants on every read', async () => {
    getMyStoreAccess.mockResolvedValueOnce({ all_stores: true, store_keys: [] })
      .mockResolvedValue({ all_stores: false, store_keys: ['s1'] });
    apiFetch.mockResolvedValueOnce(ok({ store_key: 's1', employees: ['all-workspace'] }))
      .mockResolvedValueOnce(ok({ store_key: 's1', employees: ['scoped'] }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ detail: '尚未分配店铺查看权限' }), { status: 403 }));
    await getLaborEfficiencyDetail('2026-10-01', '2026-10-02', 's1');
    expect(await getLaborEfficiencyDetail('2026-10-01', '2026-10-02', 's1')).toMatchObject({ employees: ['scoped'] });
    await expect(getLaborEfficiencyDetail('2026-10-01', '2026-10-02', 's1')).rejects.toThrow();
    expect(apiFetch).toHaveBeenCalledTimes(3);
    expect(getMyStoreAccess).toHaveBeenCalledTimes(3);
  });
  it('partitions cached results between accounts in the same workspace', async () => {
    getMyStoreAccess.mockResolvedValue({ all_stores: true, store_keys: [] });
    apiFetch.mockResolvedValueOnce(ok({ account: 'a' })).mockResolvedValueOnce(ok({ account: 'b' }));
    localStorage.setItem('auth_user_id', 'a');
    await getLaborEfficiencyDetail('2026-10-01', '2026-10-02', 's1');
    localStorage.setItem('auth_user_id', 'b');
    expect(await getLaborEfficiencyDetail('2026-10-01', '2026-10-02', 's1')).toMatchObject({ account: 'b' });
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
