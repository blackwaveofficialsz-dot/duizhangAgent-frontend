import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MetricComparison, OperationsOverview } from '../../features/operations-analysis/types/contracts';

const analyticsApi = vi.hoisted(() => ({ getBusinessReport: vi.fn(), getOrders: vi.fn(), getOrdersInsight: vi.fn(), listPlatformDim: vi.fn(), saveOrdersInsightCandidate: vi.fn() }));
const operationsApi = vi.hoisted(() => ({ fetchOperationsOverview: vi.fn() }));
const dailyFactsApi = vi.hoisted(() => ({ getOrderDailyFacts: vi.fn() }));
const pollingHook = vi.hoisted(() => ({ usePolling: vi.fn() }));
vi.mock('../../api/analytics', () => analyticsApi);
vi.mock('../../api/analyticsDailyFacts', () => dailyFactsApi);
vi.mock('../../features/operations-analysis/api/client', () => operationsApi);
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../../hooks/usePolling', () => pollingHook);

import { OrdersSection } from './OrdersSection';

function overview(current: number | null, withStore = true): OperationsOverview {
  const metric: MetricComparison = { current, previous: null, difference: null, change_rate: null, status: 'missing_previous' };
  const metrics = Object.fromEntries(['order_count', 'paid_amount', 'income_amount', 'refund_amount', 'net_income', 'avg_order_value', 'refund_rate'].map(key => [key, metric]));
  return {
    period: { date_from: '2026-11-25', date_to: '2026-11-25' }, previous_period: null,
    metrics, channels: [], platforms: [], stores: withStore ? [{ store_key: '801', store_label: '测试门店', metrics }] : [], store_channels: [],
    sections: { orders: { status: current === null ? 'missing' : 'ready' } },
    completeness: { status: current === null ? 'missing' : 'ready' }, generated_at: '2026-11-25T12:00:00+08:00',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  dailyFactsApi.getOrderDailyFacts.mockResolvedValue([]);
  analyticsApi.listPlatformDim.mockResolvedValue([]);
});
afterEach(cleanup);

describe('OrdersSection published chart data', () => {
  it.each([true, false])('shows an unpublished empty state instead of a zero ring (store rows: %s)', async withStore => {
    operationsApi.fetchOperationsOverview.mockResolvedValue(overview(null, withStore));
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    expect(await screen.findByText('暂无已发布数据')).toBeTruthy();
    expect(screen.queryByRole('img', { name: '分店铺净实收占比环形图' })).toBeNull();
    expect(screen.queryByText('¥0.00')).toBeNull();
    expect(screen.queryByText(/0 单/)).toBeNull();
  });

  it('keeps a genuinely published zero and removes its ring when a refresh becomes unavailable, including fullscreen', async () => {
    operationsApi.fetchOperationsOverview.mockResolvedValue(overview(0));
    render(<OrdersSection show={vi.fn()} canManage={false} />);
    expect(await screen.findByRole('img', { name: '分店铺净实收占比环形图' })).toBeTruthy();
    expect(screen.getByText('0 单 · 1 项')).toBeTruthy();
    expect(screen.getAllByText('¥0.00').length).toBeGreaterThan(0);
    expect(screen.queryByText('暂无已发布数据')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '全屏横屏查看图表' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('img', { name: '分店铺净实收占比环形图' })).toBeTruthy();

    operationsApi.fetchOperationsOverview.mockResolvedValue(overview(null));
    const poll = [...pollingHook.usePolling.mock.calls].reverse().find(([, interval]) => interval === 300000)?.[0] as (signal: AbortSignal) => Promise<void>;
    expect(poll).toBeTypeOf('function');
    await act(async () => { await poll(new AbortController().signal); });
    expect(within(dialog).getByText('暂无已发布数据')).toBeTruthy();
    expect(within(dialog).queryByRole('img', { name: '分店铺净实收占比环形图' })).toBeNull();
    expect(within(dialog).queryByText('¥0.00')).toBeNull();
  });
});
