import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DashboardPage } from './DashboardPage';
import { useAuthStore } from '../../store/authStore';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
const charts = vi.hoisted(() => new Map<HTMLElement, { series: Array<{ data: Array<number | null> }> }>());
vi.mock('../../api/client', () => ({ apiFetch: network.fetch }));
vi.mock('../../api/analyticsDailyFacts', () => ({ getOrderDailyFacts: vi.fn().mockRejectedValue(new Error('unsupported')), getMealDailyFacts: vi.fn().mockRejectedValue(new Error('unsupported')) }));
vi.mock('./ReceivedOrdersOverview', () => ({ ReceivedOrdersOverview: () => null }));
vi.mock('./TrendPeriodControls', () => ({ TrendPeriodControls: ({ onRangeChange }: { onRangeChange: (from: string, to: string) => void }) => <button onClick={() => onRangeChange('2026-11-25', '2026-11-25')}>查看25日</button> }));
vi.mock('./StoreScopePicker', () => ({ StoreScopePicker: ({ onChange }: { onChange: (keys: string[]) => void }) => <button onClick={() => onChange(['shop:801'])}>选择门店801</button> }));
vi.mock('../../features/operations-analysis/api/client', () => ({ fetchOperationsOverview: vi.fn().mockResolvedValue({ period: { date_from: '2026-11-25', date_to: '2026-11-25' }, metrics: {}, channels: [], stores: [], completeness: { status: 'missing' } }) }));
vi.mock('echarts/core', () => ({ use: () => {}, init: (container: HTMLElement) => ({ on: () => {}, off: () => {}, resize: () => {}, dispose: () => {}, isDisposed: () => false, getOption: () => ({}), setOption: (option: { series: Array<{ data: Array<number | null> }> }) => charts.set(container, option) }) }));

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-11-26T04:00:00Z'));
  vi.stubEnv('MODE', 'production');
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('chart-regression');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  localStorage.clear(); charts.clear(); network.fetch.mockReset();
  useAuthStore.setState({ userId: 'cache-user', tenantId: 'cache-tenant', activeWorkspaceId: 'cache-workspace' });
});
afterEach(() => { cleanup(); charts.clear(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('revalidates a cached missing historical store chart after publication in the same Beijing day', async () => {
  let published = false;
  network.fetch.mockImplementation(async (value: string) => {
    const url = new URL(value, 'http://localhost');
    if (url.pathname.endsWith('/store-scope-tree')) return ok({ nodes: [{ key: 'shop:801', type: 'store', label: '门店801', store_key: '801' }], store_count: 1 });
    if (url.pathname.endsWith('/trends/revenue/delta') || url.pathname.endsWith('/trend/delta')) return new Response('{}', { status: 404 });
    if (url.pathname.endsWith('/trends/revenue')) return ok({ metric: 'net_income', granularity: 'day', date_from: url.searchParams.get('date_from'), date_to: url.searchParams.get('date_to'), store_key: 'ALL', source_type: 'all', points: [{ period: '2026-11-25', net_income: published ? 123 : 0, order_count: published ? 3 : 0, missing: !published }], moving_averages: [] });
    if (url.pathname.endsWith('/meal-periods/turnover')) return ok({ data_status: 'missing', points: [], summary: [], store_summaries: [], store_trends: {}, eligible_store_count: 0, table_count: 0, excluded_stores: [] });
    if (url.pathname.endsWith('/meal-periods/trend')) return ok({ points: [], store_trends: {} });
    if (url.pathname.endsWith('/meal-periods')) return ok({ periods: [] });
    throw new Error(`Unexpected test request: ${url.pathname}`);
  });
  const selectedStoreReads = () => network.fetch.mock.calls.filter(([value]) => {
    const url = new URL(value, 'http://localhost');
    return url.pathname.endsWith('/trends/revenue') && url.searchParams.get('date_from') === '2026-11-25' && url.searchParams.get('date_to') === '2026-11-25' && url.searchParams.get('store_keys') === '801';
  });
  const selectHistoryAndStore = async () => {
    fireEvent.click(screen.getAllByText('查看25日')[0]);
    await waitFor(() => expect(network.fetch.mock.calls.some(([value]) => String(value).includes('store-scope-tree'))).toBe(true));
    fireEvent.click(screen.getAllByText('选择门店801')[0]);
    await screen.findByRole('img', { name: '门店801净实收趋势图' });
  };
  const first = render(<DashboardPage show={vi.fn()} />);
  await selectHistoryAndStore();
  await waitFor(() => expect(selectedStoreReads()).toHaveLength(1));
  const firstChart = screen.getByRole('img', { name: '门店801净实收趋势图' });
  await waitFor(() => expect(charts.get(firstChart)?.series[0].data).toEqual([null]));
  first.unmount();
  published = true;
  render(<DashboardPage show={vi.fn()} />);
  await selectHistoryAndStore();
  await waitFor(() => expect(selectedStoreReads()).toHaveLength(2));
  const chart = screen.getByRole('img', { name: '门店801净实收趋势图' });
  await waitFor(() => expect(charts.get(chart)?.series[0].data).toEqual([123]));
  expect(new URL(selectedStoreReads()[1][0], 'http://localhost').searchParams.get('refresh')).toBe('false');
  const count = selectedStoreReads().length;
  await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
  expect(selectedStoreReads()).toHaveLength(count + 2);
});
