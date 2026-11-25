import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ getBusinessReport: vi.fn(), getOrders: vi.fn(), getOrdersInsight: vi.fn(), listPlatformDim: vi.fn(), saveOrdersInsightCandidate: vi.fn() }));
const overviewApi = vi.hoisted(() => ({ fetchOperationsOverview: vi.fn() }));
const facts = vi.hoisted(() => ({ getOrderDailyFacts: vi.fn() }));
const liveApi = vi.hoisted(() => ({ fetchLiveOrdersSummary: vi.fn() }));
vi.mock('../../api/liveOrders', () => liveApi);
vi.mock('../../api/analytics', () => api);
vi.mock('../../api/analyticsDailyFacts', () => facts);
vi.mock('../../features/operations-analysis/api/client', () => overviewApi);
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('./OrderCharts', () => ({ OrderCharts: () => null }));
import { OrdersSection } from './OrdersSection';

function overview(net = 50) {
  const metric = (current: number) => ({ current, previous: null, difference: null, change_rate: null, status: 'missing_previous' });
  const metrics = { order_count: metric(5), paid_amount: metric(60), income_amount: metric(55), refund_amount: metric(5), net_income: metric(net), avg_order_value: metric(10), refund_rate: metric(0.1) };
  return { period: { date_from: '2026-08-12', date_to: '2026-08-12' }, metrics, stores: [{ store_key: '801', store_label: '实时测试店', metrics }], channels: [], platforms: [], sections: { orders: { status: 'ready' } }, completeness: { status: 'ready' }, generated_at: '2026-08-12T12:00:00+08:00' };
}

async function flush() {
  await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-12T04:00:00Z'));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.clearAllMocks();
  overviewApi.fetchOperationsOverview.mockResolvedValue(overview());
  facts.getOrderDailyFacts.mockResolvedValue([]);
  api.listPlatformDim.mockResolvedValue([]);
  liveApi.fetchLiveOrdersSummary.mockResolvedValue({ data: { sale_order_count: 7, received_verified_paid_net: '88.1200' }, received_amount_availability: { status: 'available', basis: 'verified_received_push_events' }, freshness: {}, coverage: { status: 'partial' } });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('OrdersSection realtime orders', () => {
  it('consumes received orders while the published summary is missing', async () => {
    const missing = overview();
    Object.values(missing.metrics).forEach(metric => { Object.assign(metric, { current: null }); });
    missing.sections.orders.status = 'missing'; missing.completeness.status = 'missing';
    overviewApi.fetchOperationsOverview.mockResolvedValue(missing);
    render(<OrdersSection show={vi.fn()} canManage={false} />); await flush();
    expect(screen.getByText('¥88.1200')).toBeTruthy();
    expect(liveApi.fetchLiveOrdersSummary).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-08-12', storeKeys: [] }));
  });
  it('does not wait for a slow formal summary before showing received orders', async () => {
    overviewApi.fetchOperationsOverview.mockReturnValue(new Promise(() => {}));
    render(<OrdersSection show={vi.fn()} canManage={false} />); await flush();
    expect(screen.getByText('¥88.1200')).toBeTruthy();
  });
  it('opens today and explicitly includes current orders', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    expect(overviewApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ filters: expect.objectContaining({ dateFrom: '2026-08-12', dateTo: '2026-08-12', includeCurrent: true }), refresh: false }));
    expect(screen.getAllByText('实时测试店').length).toBeGreaterThan(0);
  });

  it('silently revalidates every five minutes without queueing a snapshot rebuild', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    let finish!: (value: ReturnType<typeof overview>) => void;
    overviewApi.fetchOperationsOverview.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(2);
    expect(screen.getAllByText('实时测试店').length).toBeGreaterThan(0);
    expect(api.getOrders).not.toHaveBeenCalled();
    await act(async () => { finish(overview(80)); });
    expect(screen.getAllByText('¥80.00').length).toBeGreaterThan(0);
    expect(overviewApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: false }));
  });

  it('pauses in the background and revalidates immediately on return', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    fireEvent(document, new Event('visibilitychange'));
    await flush();
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(2);
  });

  it('aborts a pending refresh on unmount', async () => {
    const view = render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    overviewApi.fetchOperationsOverview.mockReturnValueOnce(new Promise(() => {}));
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(2);
    const signal = overviewApi.fetchOperationsOverview.mock.calls[1][0].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it('revokes visible data and stops polling after permission is withdrawn', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    overviewApi.fetchOperationsOverview.mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(screen.queryByText('实时测试店')).toBeNull();
    expect(screen.getByText('暂无权限查看经营数据')).toBeTruthy();
    const calls = overviewApi.fetchOperationsOverview.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(calls);
  });

  it('follows the Beijing calendar after midnight for the default date', async () => {
    vi.setSystemTime(new Date('2026-08-12T15:59:00Z'));
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    await flush();
    expect(overviewApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ filters: expect.objectContaining({ dateFrom: '2026-08-13', dateTo: '2026-08-13', includeCurrent: true }) }));
  });

  it('does not poll a fixed historical date', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '◀' }));
    await flush();
    expect(overviewApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ filters: expect.objectContaining({ dateTo: '2026-08-11', includeCurrent: false }) }));
    const calls = overviewApi.fetchOperationsOverview.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(calls);
  });

  it('does not turn today partial coverage into a five-second repair loop', async () => {
    const partial = overview();
    partial.sections.orders.status = 'partial';
    partial.completeness.status = 'partial';
    overviewApi.fetchOperationsOverview.mockResolvedValue(partial);
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(290000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(2);
  });

  it('returns to the five-minute cadence after a historical partial period is left', async () => {
    const partial = overview();
    partial.sections.orders.status = 'partial';
    partial.completeness.status = 'partial';
    overviewApi.fetchOperationsOverview.mockResolvedValue(partial);
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '◀' }));
    await flush();
    expect(screen.getByText('已发现快照不完整，等待后台修复')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '▶' }));
    await flush();
    const calls = overviewApi.fetchOperationsOverview.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(calls);
    expect(screen.queryByText('已发现快照不完整，等待后台修复')).toBeNull();
  });

  it('bounds an explicitly queued current-day repair recheck when only natural partial coverage remains', async () => {
    const partial = overview();
    partial.sections.orders.status = 'partial';
    partial.completeness.status = 'partial';
    overviewApi.fetchOperationsOverview.mockResolvedValue(partial);
    api.getOrders.mockResolvedValueOnce({ refresh_queued: true });
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(overviewApi.fetchOperationsOverview).toHaveBeenCalledTimes(3);
  });

  it('uses the new Beijing day when returning from a historical date after midnight', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: '◀' }));
    await flush();
    vi.setSystemTime(new Date('2026-08-12T16:01:00Z'));
    fireEvent.click(screen.getByRole('button', { name: '今天' }));
    await flush();
    expect(overviewApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ filters: expect.objectContaining({ dateFrom: '2026-08-13', dateTo: '2026-08-13', includeCurrent: true }) }));
  });
});
