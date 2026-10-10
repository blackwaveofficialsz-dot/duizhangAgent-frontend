import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricComparison, OperationsOverview } from '../../features/operations-analysis/types/contracts';

const analyticsApi = vi.hoisted(() => ({
  getBusinessReport: vi.fn(),
  getOrders: vi.fn(),
  getOrdersInsight: vi.fn(),
  listPlatformDim: vi.fn(),
  saveOrdersInsightCandidate: vi.fn(),
}));
const operationsApi = vi.hoisted(() => ({ fetchOperationsOverview: vi.fn() }));
const pollingHook = vi.hoisted(() => ({ usePolling: vi.fn() }));
const dailyFactsApi = vi.hoisted(() => ({ getOrderDailyFacts: vi.fn() }));

vi.mock('../../api/analytics', () => analyticsApi);
vi.mock('../../api/analyticsDailyFacts', () => dailyFactsApi);
vi.mock('../../features/operations-analysis/api/client', () => operationsApi);
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/usePolling', () => pollingHook);
vi.mock('./OrderCharts', () => ({ OrderCharts: () => null }));

import { OrdersSection } from './OrdersSection';

function metric(current: number | null, previous: number | null = null): MetricComparison {
  const difference = current == null || previous == null ? null : current - previous;
  return {
    current,
    previous,
    difference,
    change_rate: previous && difference != null ? difference / previous : null,
    status: previous === 0 ? 'zero_previous' : previous == null ? 'missing_previous' : 'ok',
  };
}

function orderMetrics({
  orders = 5,
  paid = 60,
  income = 55,
  refund = 5,
  net = 50,
  previousOrders = 4,
  previousNet = 40,
}: {
  orders?: number;
  paid?: number;
  income?: number;
  refund?: number;
  net?: number;
  previousOrders?: number;
  previousNet?: number;
} = {}): OperationsOverview['metrics'] {
  return {
    order_count: metric(orders, previousOrders),
    paid_amount: metric(paid, paid * (previousNet / Math.max(net, 1))),
    income_amount: metric(income, income * (previousNet / Math.max(net, 1))),
    refund_amount: metric(refund, refund * (previousNet / Math.max(net, 1))),
    net_income: metric(net, previousNet),
    avg_order_value: metric(orders ? net / orders : 0, previousOrders ? previousNet / previousOrders : 0),
    refund_rate: metric(paid ? refund / paid : 0, paid ? (refund * (previousNet / Math.max(net, 1))) / (paid * (previousNet / Math.max(net, 1))) : 0),
  };
}

function overviewResponse({
  status = 'ready',
  metrics = orderMetrics(),
  stores = [],
  channels = [],
  platforms = [],
  storeChannels = [],
  storePlatforms = [],
}: {
  status?: 'ready' | 'partial' | 'missing' | 'stale';
  metrics?: OperationsOverview['metrics'];
  stores?: OperationsOverview['stores'];
  channels?: OperationsOverview['channels'];
  platforms?: OperationsOverview['platforms'];
  storeChannels?: OperationsOverview['store_channels'];
  storePlatforms?: NonNullable<OperationsOverview['store_platforms']>;
} = {}): OperationsOverview {
  return {
    period: { date_from: '2026-07-30', date_to: '2026-07-30' },
    previous_period: { date_from: '2026-07-29', date_to: '2026-07-29' },
    metrics,
    channels,
    platforms,
    stores,
    store_channels: storeChannels,
    store_platforms: storePlatforms,
    sections: { orders: { status } },
    completeness: {
      status,
      complete_dates: status === 'ready' ? 1 : 0,
      expected_dates: 1,
      missing_dates: status === 'ready' ? [] : ['2026-07-30'],
      included_store_keys: stores.map(row => String(row.store_key || row.dim_key || '')),
      excluded_store_keys: [],
      watermark: null,
      cache_source: 'test',
    },
    cache_meta: { status: 'hit', source: 'test' },
    generated_at: '2026-07-30T00:00:00Z',
  };
}

const storeOverview = () => overviewResponse({
  stores: [{
    store_key: '851784429',
    store_label: '凤八店',
    metrics: orderMetrics(),
  }],
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  operationsApi.fetchOperationsOverview.mockResolvedValue(storeOverview());
  analyticsApi.getOrders.mockResolvedValue({
    rows: [],
    excluded: null,
    snapshot_status: 'ready',
    refresh_queued: false,
    backfill_queued: false,
  });
  dailyFactsApi.getOrderDailyFacts.mockResolvedValue([]);
  analyticsApi.listPlatformDim.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('OrdersSection timer lifecycle', () => {
  it('clears the tracked 700ms repair reset timer on unmount', async () => {
    let resolveOverview!: (value: OperationsOverview) => void;
    operationsApi.fetchOperationsOverview.mockReturnValue(new Promise((resolve) => { resolveOverview = resolve; }));
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const { unmount } = render(<OrdersSection show={vi.fn()} canManage={false} />);

    await act(async () => {
      resolveOverview(storeOverview());
      await Promise.resolve();
    });

    const timerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 700);
    expect(timerCallIndex).toBeGreaterThanOrEqual(0);
    const timerId = setTimeoutSpy.mock.results[timerCallIndex]?.value;

    unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(timerId);
  });

  it('polls queued repairs through usePolling and forwards its AbortSignal', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    analyticsApi.getOrders.mockResolvedValueOnce({
      rows: [],
      excluded: null,
      snapshot_status: 'partial',
      refresh_queued: true,
      backfill_queued: false,
    });
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const activeCall = [...pollingHook.usePolling.mock.calls]
      .reverse()
      .find(([, interval]) => interval === 30000);
    expect(activeCall).toBeDefined();
    const poll = activeCall?.[0] as (signal: AbortSignal) => Promise<void>;
    const controller = new AbortController();
    operationsApi.fetchOperationsOverview.mockResolvedValueOnce(storeOverview());

    await act(async () => poll(controller.signal));

    expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({
      signal: controller.signal,
      refresh: false,
      filters: expect.objectContaining({
        granularity: 'day',
        compare: 'previous',
        orderBreakdown: 'none',
      }),
    }));
  });

  it('defaults to one row per store, adds a total row, and exposes table actions', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByText('凤八店')).toBeTruthy();
    const totalRow = screen.getByText('总数据').closest('tr');
    expect(totalRow).toBeTruthy();
    expect(screen.getAllByText('+25.0%').length).toBeGreaterThan(0);
    expect(screen.getByText('不附加维度')).toBeTruthy();
    expect(screen.getByLabelText('订单统计对比展示')).toBeTruthy();
    expect(screen.getByTitle('全屏展示')).toBeTruthy();
    expect(screen.getByTitle('下载表格')).toBeTruthy();
    expect(document.querySelector('.ant-table-bordered')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '凤八店' }));
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('凤八店订单趋势')).toBeTruthy();
  });

  it('shows platform or channel as mutually exclusive secondary headers without splitting store rows', async () => {
    analyticsApi.listPlatformDim.mockResolvedValueOnce([
      { platform_code: 4, platform_name: '美团外卖', confirmed: true },
    ]);
    operationsApi.fetchOperationsOverview.mockResolvedValue(overviewResponse({
      stores: [{ store_key: '851784429', store_label: '凤八店', metrics: orderMetrics() }],
      storePlatforms: [{ dim_key: '851784429|4', store_label: '凤八店', metrics: orderMetrics({ orders: 2, paid: 20, income: 19, refund: 1, net: 18, previousOrders: 1, previousNet: 9 }) }],
      platforms: [{ dim_key: '4', dim_label: '美团外卖', metrics: orderMetrics({ orders: 2, paid: 20, income: 19, refund: 1, net: 18, previousOrders: 1, previousNet: 9 }) }],
      storeChannels: [
        { dim_key: '851784429|shop', store_label: '凤八店', metrics: orderMetrics({ orders: 3, paid: 40, income: 36, refund: 4, net: 32, previousOrders: 2, previousNet: 24 }) },
        { dim_key: '851784429|takeout', store_label: '凤八店', metrics: orderMetrics({ orders: 2, paid: 20, income: 19, refund: 1, net: 18, previousOrders: 1, previousNet: 9 }) },
      ],
      channels: [
        { dim_key: 'shop', dim_label: '堂食', metrics: orderMetrics({ orders: 3, paid: 40, income: 36, refund: 4, net: 32, previousOrders: 2, previousNet: 24 }) },
        { dim_key: 'takeout', dim_label: '外卖', metrics: orderMetrics({ orders: 2, paid: 20, income: 19, refund: 1, net: 18, previousOrders: 1, previousNet: 9 }) },
      ],
    }));

    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    fireEvent.mouseDown(screen.getByLabelText('订单统计维度'));
    fireEvent.click(screen.getByText('平台'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const platformTable = document.querySelector('.ant-table') as HTMLElement;
    expect(within(platformTable).getAllByText('美团外卖').length).toBeGreaterThan(0);
    expect(within(platformTable).getAllByText('凤八店')).toHaveLength(1);

    fireEvent.mouseDown(screen.getByLabelText('订单统计维度'));
    fireEvent.click(screen.getByText('堂食/外卖'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const channelTable = document.querySelector('.ant-table') as HTMLElement;
    expect(within(channelTable).getAllByText('堂食').length).toBeGreaterThan(0);
    expect(within(channelTable).getAllByText('外卖').length).toBeGreaterThan(0);
    expect(within(channelTable).queryByText('美团外卖')).toBeNull();
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(1);
  });

  it('reloads only the operations overview when changing dimensions after daily facts load', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(1);
    expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByLabelText('订单统计维度'));
    fireEvent.click(screen.getByText('堂食/外卖'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(1);
    expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(2);
    expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ orderBreakdown: 'channel' }),
    }));
    expect(screen.getByText('凤八店')).toBeTruthy();
  });


  it('shows missing backend metrics as unavailable instead of zero', async () => {
    operationsApi.fetchOperationsOverview.mockResolvedValue(overviewResponse({
      stores: [{
        store_key: '851784429',
        store_label: '凤八店',
        metrics: {
          ...orderMetrics(),
          net_income: metric(null, 40),
          avg_order_value: metric(null, 10),
        },
      }],
    }));

    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const row = screen.getByRole('row', { name: /凤八店/ });
    expect(within(row).getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(within(row).queryByText('¥0.00')).toBeNull();
  });

  it('shows canonical partial completeness from operations overview', async () => {
    operationsApi.fetchOperationsOverview.mockResolvedValue(overviewResponse({
      status: 'partial',
      stores: [],
    }));

    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByText('已发现快照不完整，等待后台修复')).toBeTruthy();
    expect(screen.getByText('12%')).toBeTruthy();
    expect(pollingHook.usePolling.mock.calls.some(([, interval]) => interval === 30000)).toBe(true);
  });

  it('uses force refresh only for the explicit refresh request', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: true }));
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(2);
    expect(dailyFactsApi.getOrderDailyFacts.mock.calls[1][3]).toEqual(expect.objectContaining({ forceRefresh: true }));

    fireEvent.click(screen.getByRole('button', { name: '◀' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({ refresh: false }));
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(3);
    expect(dailyFactsApi.getOrderDailyFacts.mock.calls[2][3]).toEqual(expect.objectContaining({ forceRefresh: false }));
  });
});


describe('live order snapshots', () => {
  it('includes Beijing today and polls snapshots without requesting a rebuild', async () => {
    vi.setSystemTime(new Date('2026-10-10T00:30:00+08:00'));
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledWith(expect.objectContaining({
      filters: expect.objectContaining({ dateFrom: '2026-10-10', dateTo: '2026-10-10' }),
    }));
    const call = [...pollingHook.usePolling.mock.calls].reverse().find(([, interval]) => interval === 30000);
    expect(call).toBeDefined();
    operationsApi.fetchOperationsOverview.mockResolvedValueOnce(overviewResponse({ metrics: orderMetrics({ net: 75 }) }));
    const controller = new AbortController();
    await act(async () => { await call![0](controller.signal); });
    expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({
      signal: controller.signal, refresh: false,
    }));
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenLastCalledWith('2026-10-10', '2026-10-10', {}, expect.objectContaining({
      signal: controller.signal, forceRefresh: false,
    }));
    expect(analyticsApi.getOrders).not.toHaveBeenCalled();
    expect(screen.getAllByText('¥75.00').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: '昨天' }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { vi.advanceTimersByTime(750); });
    expect(pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1]?.[1]).toBeNull();
  });
  it('keeps the last good overview when polling fails and ignores an aborted response', async () => {
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const poll = pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1][0];
    operationsApi.fetchOperationsOverview.mockRejectedValueOnce(new Error('temporary outage'));
    await act(async () => { await poll(new AbortController().signal); });
    expect(screen.getByText(/读取暂时失败，保留上次结果/)).toBeTruthy();
    expect(screen.getAllByText('¥50.00').length).toBeGreaterThan(0);
    const controller = new AbortController();
    controller.abort();
    operationsApi.fetchOperationsOverview.mockResolvedValueOnce(overviewResponse({ metrics: orderMetrics({ net: 75 }) }));
    await act(async () => { await poll(controller.signal); });
    expect(screen.queryByText('¥75.00')).toBeNull();
    expect(screen.getAllByText('¥50.00').length).toBeGreaterThan(0);
  });

});
