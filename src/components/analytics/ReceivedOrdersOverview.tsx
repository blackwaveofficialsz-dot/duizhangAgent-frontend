import { useEffect, useRef, useState } from 'react';
import { Button, notification } from 'antd';
import { fetchLiveOrdersSummary, type LiveOrdersSummary } from '../../api/liveOrders';
import { usePolling } from '../../hooks/usePolling';
import { useAuthStore } from '../../store/authStore';
import { currentBeijingDate, formatBeijingTime } from '../../utils/time';
import { PeriodMetricCard } from './PeriodComparison';

type Props = { date: string; storeKeys: readonly string[]; enabled: boolean };

export function ReceivedOrdersOverview({ enabled, ...props }: Props) {
  const principal = useAuthStore(s => JSON.stringify([s.userId, s.tenantId, s.activeWorkspaceId, s.role]));
  const stores = [...new Set(props.storeKeys)].sort();
  if (!enabled) return <div className="text-sm text-slate-400">当前门店范围未就绪，暂不查询已接收订单</div>;
  return <ReceivedOrdersScope key={JSON.stringify([principal, props.date, stores])} {...props} storeKeys={stores} />;
}

function ReceivedOrdersScope({ date, storeKeys }: Omit<Props, 'enabled'>) {
  const [notice, noticeHolder] = notification.useNotification();
  const [summary, setSummary] = useState<LiveOrdersSummary | null>(null);
  const [today, setToday] = useState(currentBeijingDate);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [denied, setDenied] = useState(false);
  const activeRef = useRef(false);
  const requestRef = useRef<AbortController | null>(null);
  const completedReadRef = useRef(false);
  const deniedRef = useRef(false);

  const read = async (manual = false, signal?: AbortSignal) => {
    if (deniedRef.current || requestRef.current) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    requestRef.current = controller;
    setLoading(true);
    try {
      const result = await fetchLiveOrdersSummary({ date, storeKeys, signal: controller.signal });
      if (!activeRef.current || controller.signal.aborted) return;
      completedReadRef.current = true;
      setSummary(result);
      setFailed(false);
    } catch (error) {
      if (!activeRef.current || controller.signal.aborted) return;
      completedReadRef.current = true;
      const permissionFailure = typeof error === 'object' && error !== null && 'status' in error && (error.status === 401 || error.status === 403);
      if (permissionFailure) {
        deniedRef.current = true;
        setSummary(null);
        setDenied(true);
      } else {
        setFailed(true);
      }
      if (manual) notice.error({ title: '已接收订单刷新失败', description: permissionFailure ? '暂无权限查看已接收订单' : '请稍后重试；已有数据保持为上次读取结果。', duration: 5, closable: true });
    } finally {
      signal?.removeEventListener('abort', abort);
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (activeRef.current) setLoading(false);
      }
    }
  };

  useEffect(() => {
    activeRef.current = true;
    const cancelRead = () => {
      const controller = requestRef.current;
      requestRef.current = null;
      controller?.abort();
    };
    const onVisibility = () => {
      if (document.hidden) { cancelRead(); setLoading(false); }
      else if (date !== currentBeijingDate() && !completedReadRef.current) void read();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!document.hidden) void read();
    return () => {
      activeRef.current = false;
      document.removeEventListener('visibilitychange', onVisibility);
      cancelRead();
      notice.destroy();
    };
    // Scope and principal changes remount this component before reading a new scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  usePolling(async signal => {
    const nextToday = currentBeijingDate();
    if (nextToday !== today) setToday(nextToday);
    await read(false, signal);
  }, !denied ? 300000 : null);

  const availability = summary?.received_amount_availability;
  const amount = summary?.data?.received_verified_paid_net;
  const amountText = availability?.status === 'available' && availability.basis === 'verified_received_push_events'
    && typeof amount === 'string' && /^-?\d+(?:\.\d+)?$/.test(amount) ? `¥${amount}` : '—';
  const count = summary?.data?.sale_order_count;
  const countText = typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 ? String(count) : '—';
  const coverage = summary?.coverage;

  return (
    <section aria-label="已接收订单概览" className="rounded-lg border border-blue-100 bg-white p-4">
      {noticeHolder}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-slate-800">已接收订单概览（临时值）</div>
          <div className="mt-1 text-xs text-slate-500">{date} · 全部来源 · {date === today ? '每5分钟刷新' : '历史推送记录'}</div>
        </div>
        <Button aria-label="刷新已接收订单" autoInsertSpace={false} loading={loading} disabled={denied || loading} onClick={() => void read(true)}>刷新已接收订单</Button>
      </div>
      {denied ? <div role="status" className="text-sm text-slate-500">暂无权限查看已接收订单</div> : <>
        <div className="grid grid-cols-2 gap-3">
          <PeriodMetricCard label="已收销售订单数" value={countText} format="integer" />
          <PeriodMetricCard label="已收订单实付净额" value={amountText} />
        </div>
        {failed && <div role="status" className="mt-2 text-xs text-amber-700">{summary ? '更新失败，当前为上次已接收数据' : '已接收订单读取失败，请重试'}</div>}
        <div className="mt-2 text-xs text-slate-500">最近接收推送：{summary?.freshness?.last_received_at ? formatBeijingTime(summary.freshness.last_received_at) : '—'} · 查询时间：{summary?.freshness?.observed_at ? formatBeijingTime(summary.freshness.observed_at) : '—'}</div>
        <div className="mt-1 text-xs text-slate-500">覆盖：{coverage?.status === 'partial' ? '不完整' : '待核验'}{coverage ? ` · 待处理 ${coverage.pending_count ?? 0} 条 · 隔离 ${coverage.quarantined_count ?? 0} 条` : ''}{coverage?.unrouted_scope_status === 'unknown' ? ' · 存在尚未归属的推送' : ''}</div>
      </>}
      <p className="mt-2 text-xs text-slate-500">单数为已接收去重销售单；金额仅合计已核验且已归属的推送，不代表完整当日金额或最终结算收入。</p>
    </section>
  );
}
