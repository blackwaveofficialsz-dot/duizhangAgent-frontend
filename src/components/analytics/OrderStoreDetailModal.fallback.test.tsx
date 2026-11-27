import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OrderStoreDetailModal } from './OrderStoreDetailModal';

const network = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../api/client', () => ({ apiFetch: network.fetch }));
vi.mock('../../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('./OrderStoreTrendChart', () => ({ OrderStoreTrendChart: () => null }));

const props = {
  open: true, store: { storeKey: 'A', storeLabel: '测试店' }, initialGranularity: 'day' as const,
  initialRange: { dateFrom: '2026-11-26', dateTo: '2026-11-26', includeCurrent: false },
  secondaryDimension: 'none' as const, todayYmd: '2026-11-27', seedFacts: [], onClose: vi.fn(),
};
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const row = { dim_key: 'A', dim_label: '测试店', source_type: 'all', order_count: 2, paid_amount: 100,
  income_amount: 60, refund_amount: 5, net_amount: 95, net_income: 55, avg_order_value: 27.5, refund_rate: 0.05, computed_at: null };
const delta = (rows = [row]) => ({ date_from: '2026-11-26', date_to: '2026-11-26', unchanged_days: [],
  changed_days: [{ date: '2026-11-26', version: 'v1', payload: { rows, snapshot_status: rows.length ? 'ready' : 'missing' } }] });

beforeEach(() => {
  vi.stubEnv('VITE_ANALYTICS_DAILY_FACT_V2', 'false');
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  network.fetch.mockReset(); network.fetch.mockResolvedValue(ok(delta()));
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.useRealTimers(); });

it('inherits the selected historical dates and reads server amounts with V2 disabled', async () => {
  render(<OrderStoreDetailModal {...props} />);
  expect((screen.getAllByRole('textbox')[0] as HTMLInputElement).value).toBe('2026-11-26');
  await waitFor(() => expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥55.00'));
  expect(screen.getByText('最近周期订单数').parentElement?.textContent).toContain('2');
  const [endpoint, options] = network.fetch.mock.calls[0];
  expect(endpoint).toBe('/api/v1/analytics/orders/delta');
  expect(JSON.parse(options.body)).toMatchObject({ date_to: '2026-11-26', params: { dim: 'shop', store_keys: ['A'] }, force_refresh: false, auto_refresh: false });
});

it('keeps a missing snapshot unavailable while preserving a published zero', async () => {
  network.fetch.mockResolvedValueOnce(ok(delta([])));
  const view = render(<OrderStoreDetailModal {...props} />);
  await waitFor(() => expect(network.fetch).toHaveBeenCalled());
  expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('—');
  view.unmount();
  network.fetch.mockResolvedValueOnce(ok(delta([{ ...row, order_count: 0, net_income: 0 }])));
  render(<OrderStoreDetailModal {...props} />);
  await waitFor(() => expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥0.00'));
});

it('refreshes a fixed historical detail after five minutes and cancels its read on close', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-11-27T04:00:00Z'));
  const view = render(<OrderStoreDetailModal {...props} />);
  await waitFor(() => expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥55.00'));
  network.fetch.mockResolvedValueOnce(ok(delta([{ ...row, net_income: 70 }])));
  await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
  expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥70.00');
  network.fetch.mockReturnValueOnce(new Promise(() => {}));
  await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
  const signal = network.fetch.mock.calls[network.fetch.mock.calls.length - 1]?.[1].signal as AbortSignal;
  view.rerender(<OrderStoreDetailModal {...props} open={false} />);
  expect(signal.aborted).toBe(true);
});

it('cancels an initial historical read in the background and resumes the same scope', async () => {
  network.fetch.mockReturnValueOnce(new Promise(() => {}));
  render(<OrderStoreDetailModal {...props} />);
  await waitFor(() => expect(network.fetch).toHaveBeenCalledTimes(1));
  const signal = network.fetch.mock.calls[0][1].signal as AbortSignal;
  Object.defineProperty(document, 'hidden', { configurable: true, value: true });
  fireEvent(document, new Event('visibilitychange'));
  expect(signal.aborted).toBe(true);
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  fireEvent(document, new Event('visibilitychange'));
  await waitFor(() => expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥55.00'));
});

it('revokes a forbidden legacy read instead of keeping seeded values', async () => {
  network.fetch.mockResolvedValueOnce(new Response('{}', { status: 403 }));
  const onPermissionDenied = vi.fn();
  render(<OrderStoreDetailModal {...props} onPermissionDenied={onPermissionDenied} />);
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('暂无权限查看经营数据'));
  expect(onPermissionDenied).toHaveBeenCalledTimes(1);
  expect(network.fetch).toHaveBeenCalledTimes(1);
});

it('does not treat another store daily coverage as a zero for the selected store', async () => {
  const amount = { order_count: 2, paid_amount_cent: 10000, income_amount_cent: 6000,
    refund_amount_cent: 500, net_amount_cent: 9500, net_income_cent: 5500 };
  const seedFacts = Array.from({ length: 180 }, (_, index) => ({ ...amount,
    date: new Date(Date.UTC(2026, 4, 31 + index)).toISOString().slice(0, 10), complete: true,
    stores: { A: { ...amount, store_key: 'A' } },
  }));
  network.fetch.mockResolvedValueOnce(ok(delta([{ ...row, dim_key: 'B', net_income: 80 }])));
  render(<OrderStoreDetailModal {...props} store={{ storeKey: 'B', storeLabel: '另一门店' }} seedFacts={seedFacts} />);
  expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('—');
  await waitFor(() => expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥80.00'));
  expect(JSON.parse(network.fetch.mock.calls[0][1].body).params.store_keys).toEqual(['B']);
});

it('removes an earlier value when a refreshed snapshot is missing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  render(<OrderStoreDetailModal {...props} />);
  await waitFor(() => expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('¥55.00'));
  network.fetch.mockResolvedValueOnce(ok(delta([])));
  await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
  expect(screen.getByText('区间净实收').parentElement?.textContent).toContain('—');
  expect(screen.getByText('区间净实收').parentElement?.textContent).not.toContain('¥0.00');
});
