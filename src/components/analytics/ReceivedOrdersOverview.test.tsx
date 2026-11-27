import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
const api = vi.hoisted(() => ({ fetchLiveOrdersSummary: vi.fn() }));
const notices = vi.hoisted(() => ({ error: vi.fn(), destroy: vi.fn() }));
vi.mock('antd', async importOriginal => ({ ...await importOriginal<typeof import('antd')>(), notification: { useNotification: () => [notices, null] } }));
vi.mock('../../api/liveOrders', () => api);
import { useAuthStore } from '../../store/authStore';
import { ReceivedOrdersOverview } from './ReceivedOrdersOverview';
import type { LiveOrdersSummary } from '../../api/liveOrders';

const summary = (amount = '123.4500'): LiveOrdersSummary => ({
  data: { basis: 'received_push_events', provisional: true, sale_order_count: 7, received_verified_paid_net: amount },
  received_amount_availability: { status: 'available', basis: 'verified_received_push_events' },
  freshness: { observed_at: '2026-11-25T12:00:00+08:00', last_received_at: '2026-11-25T11:59:00+08:00', status: 'recent_delivery' },
  coverage: { status: 'partial', pending_count: 0, quarantined_count: 0, unrouted_scope_status: 'clear' },
});
async function flush() { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); }
const props = { date: '2026-11-25', storeKeys: ['A'], enabled: true };
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-25T04:00:00Z'));
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  vi.clearAllMocks(); api.fetchLiveOrdersSummary.mockResolvedValue(summary());
  useAuthStore.setState({ userId: 'user-a', tenantId: 'tenant-a', activeWorkspaceId: 'workspace-a', role: 'admin' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('received orders overview', () => {
  it('shows server strings, deduplicated sales count and explicit received scope', async () => {
    render(<ReceivedOrdersOverview {...props} />); await flush();
    expect(screen.getByText('¥123.4500')).toBeTruthy();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText(/2026-11-25.*全部来源/)).toBeTruthy();
    expect(screen.getByText(/不代表完整当日金额或最终结算收入/)).toBeTruthy();
    expect(screen.queryByText('净实收')).toBeNull();
  });
  it.each(['0.0000', '-0.0100', '9007199254740993.0001'])('preserves the exact backend money string %s', async amount => {
    api.fetchLiveOrdersSummary.mockResolvedValue(summary(amount));
    render(<ReceivedOrdersOverview {...props} />); await flush();
    expect(screen.getByText(`¥${amount}`)).toBeTruthy();
  });
  it('reads November 25 as historical when Beijing today is November 26', async () => {
    vi.setSystemTime(new Date('2026-11-26T04:00:00Z'));
    render(<ReceivedOrdersOverview {...props} />); await flush();
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledWith(expect.objectContaining({ date: '2026-11-25' }));
    expect(screen.getByText(/2026-11-25.*历史推送记录/)).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(3);
  });
  it.each([
    { status: 'unavailable', basis: 'verified_received_push_events' },
    { status: 'available', basis: 'other' },
  ])('does not display an ungated amount ($status, $basis)', async availability => {
    api.fetchLiveOrdersSummary.mockResolvedValue({ ...summary(), received_amount_availability: availability });
    render(<ReceivedOrdersOverview {...props} />); await flush();
    expect(screen.queryByText('¥123.4500')).toBeNull();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText('7')).toBeTruthy();
  });
  it('polls today every five minutes, pauses hidden and reads on return', async () => {
    render(<ReceivedOrdersOverview {...props} />); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true }); fireEvent(document, new Event('visibilitychange'));
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, 'hidden', { configurable: true, value: false }); fireEvent(document, new Event('visibilitychange')); await flush();
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(3);
  });
  it('revalidates a fixed day after it becomes historical at Beijing midnight', async () => {
    const view = render(<ReceivedOrdersOverview {...props} date="2026-11-24" />); await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(3);
    view.rerender(<ReceivedOrdersOverview {...props} />); await flush();
    vi.setSystemTime(new Date('2026-11-25T16:01:00Z'));
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(6);
    expect(api.fetchLiveOrdersSummary).toHaveBeenLastCalledWith(expect.objectContaining({ date: '2026-11-25' }));
  });
  it('clears and aborts the old scope and rejects its late response', async () => {
    let finish!: (value: LiveOrdersSummary) => void;
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<ReceivedOrdersOverview {...props} />); await flush();
    const signal = api.fetchLiveOrdersSummary.mock.calls[0][0].signal as AbortSignal;
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(() => {}));
    view.rerender(<ReceivedOrdersOverview {...props} storeKeys={['B']} />); await flush();
    expect(signal.aborted).toBe(true);
    await act(async () => { finish(summary('999.0000')); });
    expect(screen.queryByText('¥999.0000')).toBeNull();
  });
  it('clears principal data immediately when the active workspace changes', async () => {
    render(<ReceivedOrdersOverview {...props} />); await flush();
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(() => {}));
    act(() => useAuthStore.setState({ tenantId: 'tenant-b', activeWorkspaceId: 'workspace-b' }));
    expect(screen.queryByText('¥123.4500')).toBeNull(); await flush();
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
  });
  it('does not query an unresolved scope and clears it when disabled', async () => {
    const view = render(<ReceivedOrdersOverview {...props} />); await flush();
    view.rerender(<ReceivedOrdersOverview {...props} enabled={false} storeKeys={[]} />); await flush();
    expect(screen.queryByText('¥123.4500')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(1);
  });
  it('revokes only the live region and stops polling on 403', async () => {
    render(<ReceivedOrdersOverview {...props} />); await flush();
    api.fetchLiveOrdersSummary.mockRejectedValueOnce(Object.assign(new Error('denied'), { status: 403 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(screen.queryByText('¥123.4500')).toBeNull();
    expect(screen.getByText('暂无权限查看已接收订单')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
  });
  it('keeps same-scope data stale and toasts only an explicit manual failure', async () => {
    render(<ReceivedOrdersOverview {...props} />); await flush();
    api.fetchLiveOrdersSummary.mockRejectedValue(new Error('network failed'));
    await act(async () => { await vi.advanceTimersByTimeAsync(300000); });
    expect(screen.getByText('¥123.4500')).toBeTruthy();
    expect(screen.getByText(/更新失败.*上次已接收数据/)).toBeTruthy();
    expect(notices.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '刷新已接收订单' })); await flush();
    expect(notices.error).toHaveBeenCalledWith(expect.objectContaining({ duration: 5, closable: true }));
  });
  it('reads immediately after a pending initial read is hidden and restored, ignoring its late finally', async () => {
    let finish!: (value: LiveOrdersSummary) => void;
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<ReceivedOrdersOverview {...props} />); await flush();
    const firstSignal = api.fetchLiveOrdersSummary.mock.calls[0][0].signal as AbortSignal;
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(() => {}));
    act(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true }); fireEvent(document, new Event('visibilitychange'));
      Object.defineProperty(document, 'hidden', { configurable: true, value: false }); fireEvent(document, new Event('visibilitychange'));
    }); await flush();
    expect(firstSignal.aborted).toBe(true);
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
    const secondSignal = api.fetchLiveOrdersSummary.mock.calls[1][0].signal as AbortSignal;
    await act(async () => { finish(summary('999.0000')); });
    expect(screen.queryByText('¥999.0000')).toBeNull();
    expect((screen.getByRole('button', { name: '刷新已接收订单' }) as HTMLButtonElement).disabled).toBe(true);
    view.unmount(); expect(secondSignal.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(600000); });
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
  });
  it('reissues an aborted StrictMode initial read instead of leaving the card empty', async () => {
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(() => {}));
    render(<StrictMode><ReceivedOrdersOverview {...props} /></StrictMode>); await flush();
    expect(api.fetchLiveOrdersSummary).toHaveBeenCalledTimes(2);
    expect(api.fetchLiveOrdersSummary.mock.calls[0][0].signal.aborted).toBe(true);
    expect(screen.getByText('¥123.4500')).toBeTruthy();
  });
  it('aborts pending reads on unmount', async () => {
    api.fetchLiveOrdersSummary.mockReturnValueOnce(new Promise(() => {}));
    const view = render(<ReceivedOrdersOverview {...props} />); await flush();
    const signal = api.fetchLiveOrdersSummary.mock.calls[0][0].signal as AbortSignal;
    view.unmount(); expect(signal.aborted).toBe(true);
  });
});
