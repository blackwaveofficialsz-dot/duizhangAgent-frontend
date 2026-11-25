import { beforeEach, describe, expect, it, vi } from 'vitest';
const apiFetch = vi.hoisted(() => vi.fn());
vi.mock('./client', () => ({ apiFetch }));
import { fetchLiveOrdersSummary } from './liveOrders';

beforeEach(() => apiFetch.mockReset());
describe('received orders summary API', () => {
  it('reads one selected day and normalized store scope without reusing a stale response', async () => {
    apiFetch.mockImplementation(async () => new Response(JSON.stringify({ data: { sale_order_count: 2 } })));
    const controller = new AbortController();
    await fetchLiveOrdersSummary({ date: '2026-11-25', storeKeys: ['B', 'A', 'A'], signal: controller.signal });
    await fetchLiveOrdersSummary({ date: '2026-11-25', storeKeys: ['A', 'B'], signal: controller.signal });
    expect(apiFetch).toHaveBeenCalledTimes(2);
    expect(apiFetch).toHaveBeenLastCalledWith('/api/v1/analytics/orders/live/summary?date_from=2026-11-25&date_to=2026-11-25&store_keys=A&store_keys=B', { signal: controller.signal, cache: 'no-store' });
  });
  it('omits store parameters for the server-authorized whole scope', async () => {
    apiFetch.mockResolvedValue(new Response('{}'));
    await fetchLiveOrdersSummary({ date: '2026-11-25', storeKeys: [] });
    expect(apiFetch.mock.calls[0][0]).toBe('/api/v1/analytics/orders/live/summary?date_from=2026-11-25&date_to=2026-11-25');
  });
  it('preserves permission status and server error text', async () => {
    apiFetch.mockResolvedValue(new Response(JSON.stringify({ detail: 'analytics_scope_denied' }), { status: 403 }));
    await expect(fetchLiveOrdersSummary({ date: '2026-11-25' })).rejects.toMatchObject({ status: 403, message: 'analytics_scope_denied' });
  });
});
