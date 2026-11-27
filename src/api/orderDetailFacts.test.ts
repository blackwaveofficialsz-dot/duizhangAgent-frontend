import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getOrderDetailFacts } from './orderDetailFacts';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('./client', () => ({ apiFetch: network.fetch }));
const row = { dim_key: 'A', dim_label: '测试店', source_type: 'all', order_count: 2, paid_amount: 100,
  income_amount: 60, refund_amount: 5, net_amount: 95, net_income: 55, avg_order_value: 27.5, refund_rate: 0.05, computed_at: null };
const ok = (rows: unknown[]) => new Response(JSON.stringify({ changed_days: [{ date: '2026-11-26', version: 'v1',
  payload: { rows, snapshot_status: 'ready' } }], unchanged_days: [] }), { status: 200 });
beforeEach(() => { vi.stubEnv('VITE_ANALYTICS_DAILY_FACT_V2', 'false'); network.fetch.mockReset(); });
afterEach(() => vi.unstubAllEnvs());

it('requests only the selected store through the V2 detail contract', async () => {
  vi.stubEnv('VITE_ANALYTICS_DAILY_FACT_V2', 'true');
  network.fetch.mockImplementation(async () => new Response(JSON.stringify({
    namespace: 'analytics.orders.daily', schema_version: 'orders-daily-fact-v4', date_from: '2026-11-26', date_to: '2026-11-26',
    params_hash: 'selected-store', access_scope_hash: 'selected-store', reset_required: false,
    changed_days: [], unchanged_days: [], deleted_days: [],
    cache_meta: { status: 'hit', server_checked_days: 1, returned_days: 0, deleted_days: 0 },
  }), { status: 200 }));
  const signal = new AbortController().signal;
  await getOrderDetailFacts('2026-11-26', '2026-11-26', 'A', 'none', signal);
  await getOrderDetailFacts('2026-11-26', '2026-11-26', 'B', 'none', signal);
  expect(network.fetch.mock.calls.map(([, options]) => JSON.parse(options.body).params)).toEqual([
    { store_keys: ['A'] }, { store_keys: ['B'] },
  ]);
  expect(network.fetch.mock.calls.every(([, options]) => JSON.parse(options.body).schema_version === 'orders-daily-fact-v4')).toBe(true);
});

it.each([
  ['channel', 'shop_channel', 'takeout', 'source_totals'],
  ['platform', 'shop_platform', '44', 'platform_totals'],
] as const)('preserves backend %s totals without recalculating financial amounts', async (dimension, dim, key, field) => {
  network.fetch.mockResolvedValueOnce(ok([row])).mockResolvedValueOnce(ok([
    { ...row, dim_key: `A|${key}`, net_income: 12.34 },
    { ...row, dim_key: `B|${key}`, net_income: 999 },
  ]));
  const result = await getOrderDetailFacts('2026-11-26', '2026-11-26', 'A', dimension, new AbortController().signal);
  expect(result[0].stores.A.net_income_cent).toBe(5500);
  expect(result[0].stores.A[field]).toEqual({ [key]: {
    order_count: 2, paid_amount_cent: 10000, income_amount_cent: 6000, refund_amount_cent: 500, net_amount_cent: 9500, net_income_cent: 1234,
  } });
  expect(JSON.parse(network.fetch.mock.calls[1][1].body)).toMatchObject({ params: { dim, store_keys: ['A'] }, force_refresh: false, auto_refresh: false });
});

it('bounds long-history legacy reads to at most 366 days per request', async () => {
  network.fetch.mockImplementation(async () => ok([]));
  expect(await getOrderDetailFacts('2025-01-01', '2026-01-02', 'A', 'none', new AbortController().signal)).toEqual([]);
  const requests = network.fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
  expect(requests.map(({ date_from, date_to }) => [date_from, date_to])).toEqual([
    ['2025-01-01', '2026-01-01'], ['2026-01-02', '2026-01-02'],
  ]);
});
