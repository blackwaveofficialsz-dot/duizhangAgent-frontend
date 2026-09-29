import { useEffect, useMemo, useState } from 'react';
import { Button, Table, type TableColumnsType } from 'antd';
import {
  getPlatformHealth,
  listDaily,
  listPlatformTasks,
  listPlatformTenants,
  listPlatformUsers,
  listSummaries,
  recomputePeriod,
  type BillingSummary,
  type DailyPoint,
  type PlatformHealth,
} from './adminApi';
import { DateInput } from '../components/ui/DateInput';
import { TableDisplayFrame } from '../components/TableDisplayFrame';
import { currentBeijingPeriod } from '../utils/time';
import { PlatformMetricStrip } from './components/PlatformMetricStrip';
import { PlatformPageHeader } from './components/PlatformPageHeader';

function fmtYuan(value: string | number): string {
  const amount = typeof value === 'string' ? parseFloat(value) : value;
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 4 }).format(amount);
}

function fmtTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

export function AdminDashboard() {
  const [period, setPeriod] = useState(currentBeijingPeriod());
  const [summaries, setSummaries] = useState<BillingSummary[]>([]);
  const [daily, setDaily] = useState<DailyPoint[]>([]);
  const [systemStats, setSystemStats] = useState({ tenants: 0, users: 0, failedTasks: 0, runningTasks: 0 });
  const [health, setHealth] = useState<PlatformHealth | null>(null);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);
  const [error, setError] = useState('');

  const load = async (targetPeriod: string, refreshSummaries = true) => {
    setLoading(true);
    setError('');
    try {
      if (refreshSummaries) {
        try {
          await recomputePeriod(targetPeriod);
        } catch {
          // 规则缺失等重算错误不能阻断旧汇总的展示。
        }
      }
      const [healthResult, summaryResult, dailyResult, tenantResult, userResult, failedTaskResult, runningTaskResult] = await Promise.allSettled([
        getPlatformHealth(),
        listSummaries({ period: targetPeriod, limit: 500 }),
        listDaily(targetPeriod),
        listPlatformTenants({ limit: 1 }),
        listPlatformUsers({ limit: 1 }),
        listPlatformTasks({ status: 'failed', limit: 5 }),
        listPlatformTasks({ status: 'running', limit: 1 }),
      ]);
      setHealth(healthResult.status === 'fulfilled' ? healthResult.value : null);
      setSummaries(summaryResult.status === 'fulfilled' ? summaryResult.value : []);
      setDaily(dailyResult.status === 'fulfilled' ? dailyResult.value : []);
      setSystemStats((previous) => ({
        tenants: tenantResult.status === 'fulfilled' ? tenantResult.value.total : previous.tenants,
        users: userResult.status === 'fulfilled' ? userResult.value.total : previous.users,
        failedTasks: failedTaskResult.status === 'fulfilled' ? failedTaskResult.value.total : previous.failedTasks,
        runningTasks: runningTaskResult.status === 'fulfilled' ? runningTaskResult.value.total : previous.runningTasks,
      }));

      const failedRequest = [summaryResult, dailyResult, tenantResult, userResult, failedTaskResult, runningTaskResult]
        .find((result) => result.status === 'rejected');
      if (failedRequest?.status === 'rejected') {
        setError(failedRequest.reason instanceof Error ? failedRequest.reason.message : '部分数据加载失败');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  };

  const recompute = async () => {
    setRecomputing(true);
    setError('');
    try {
      await recomputePeriod(period);
      await load(period, false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '重算失败');
    } finally {
      setRecomputing(false);
    }
  };

  useEffect(() => { void load(period); }, [period]);

  const stats = useMemo(() => {
    const totalAmount = summaries.reduce((sum, summary) => sum + parseFloat(summary.amount_yuan), 0);
    return { totalAmount };
  }, [summaries]);

  const topUsers = useMemo(
    () => [...summaries].sort((left, right) => parseFloat(right.amount_yuan) - parseFloat(left.amount_yuan)).slice(0, 10),
    [summaries],
  );
  const topUserColumns: TableColumnsType<BillingSummary> = [
    { title: '租户', dataIndex: 'tenant_id', key: 'tenant_id', width: 150, render: (value) => <span className="font-mono text-xs text-slate-700">{String(value)}</span> },
    {
      title: '用户',
      key: 'user',
      width: 130,
      render: (_, summary) => (
        <span className="text-sm text-slate-700">
          {summary.username ?? <span className="font-mono text-xs text-slate-400">{summary.user_id ? `${summary.user_id.slice(0, 8)}...` : '系统'}</span>}
        </span>
      ),
    },
    { title: '缓存命中', dataIndex: 'cache_read_tokens', key: 'cache_read_tokens', align: 'right', width: 110, render: (value) => <span className="text-slate-600">{fmtTokens(Number(value))}</span> },
    { title: '缓存写入', dataIndex: 'cache_write_tokens', key: 'cache_write_tokens', align: 'right', width: 110, render: (value) => <span className="text-slate-600">{fmtTokens(Number(value))}</span> },
    { title: '未命中输入', dataIndex: 'cache_miss_tokens', key: 'cache_miss_tokens', align: 'right', width: 116, render: (value) => <span className="text-slate-600">{fmtTokens(Number(value))}</span> },
    { title: '输出', dataIndex: 'output_tokens', key: 'output_tokens', align: 'right', width: 96, render: (value) => <span className="text-slate-600">{fmtTokens(Number(value))}</span> },
    { title: '金额（元）', dataIndex: 'amount_yuan', key: 'amount_yuan', align: 'right', width: 120, render: (value) => <span className="font-semibold text-slate-900">¥{fmtYuan(String(value))}</span> },
  ];

  const healthReady = health?.status === 'ok' || health?.status === 'ready';
  const healthLabel = health === null ? '健康检查不可用' : healthReady ? '正常' : '降级';
  const healthHint = health === null
    ? '未影响其他监控数据'
    : Object.entries(health.services).map(([name, status]) => `${name}: ${status}`).join(' · ');

  return (
    <div className="space-y-4">
      <PlatformPageHeader
        title="系统总览"
        description="全平台租户、用户、任务与 LLM 用量概览。"
        extra={(
          <>
            <div className="w-36">
              <DateInput label="账期" type="month" value={period} onChange={setPeriod} />
            </div>
            <Button type="primary" onClick={() => void recompute()} disabled={recomputing}>
              {recomputing ? '重算中...' : '重算账期'}
            </Button>
          </>
        )}
      />
      {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <PlatformMetricStrip items={[
        { label: '系统健康', value: healthLabel, tone: health === null ? 'warning' : healthReady ? 'success' : 'error', hint: healthHint },
        { label: '失败任务', value: systemStats.failedTasks, tone: systemStats.failedTasks ? 'error' : 'success' },
        { label: '运行任务', value: systemStats.runningTasks, tone: systemStats.runningTasks ? 'info' : 'neutral' },
        { label: '用户数', value: systemStats.users, hint: `管理 ${systemStats.tenants} 个租户` },
        { label: '本期金额', value: `¥${fmtYuan(stats.totalAmount)}`, tone: 'info', hint: `${period} 已汇总` },
      ]} />
      <section aria-label="运行关注" className="rounded-md border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">运行关注</h2>
          <span className="text-xs text-slate-500">优先处理失败任务，再查看成本趋势。</span>
        </div>
        <div className="px-4 py-3 text-sm">
          {systemStats.failedTasks > 0 ? (
            <span className="text-red-700">当前有 {systemStats.failedTasks} 条失败任务，请在任务日志中查看错误详情。</span>
          ) : (
            <span className="text-emerald-700">当前没有失败任务。</span>
          )}
          {systemStats.runningTasks > 0 && <span className="ml-3 text-blue-700">另有 {systemStats.runningTasks} 条任务正在运行。</span>}
        </div>
      </section>
      <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">按日金额趋势</h2>
          <span className="text-xs text-slate-500">该账期每日累计金额（元）</span>
        </div>
        <div className="p-4">
          <DailyTrendChart data={daily} period={period} />
        </div>
      </section>
      <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-900">用量 Top 10</h2>
          <span className="text-xs text-slate-500">按金额排序</span>
        </div>
        {loading ? (
          <div className="p-8 text-center text-sm text-slate-500">加载中...</div>
        ) : topUsers.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">该账期暂无数据</div>
        ) : (
          <TableDisplayFrame title="用量 Top 10" filename={`用量Top10_${period}`} tableClassName="overflow-x-auto">
            <Table<BillingSummary>
              columns={topUserColumns}
              dataSource={topUsers}
              pagination={false}
              rowKey="id"
              size="small"
              scroll={{ x: 920 }}
            />
          </TableDisplayFrame>
        )}
      </section>
    </div>
  );
}

function DailyTrendChart({ data, period }: { data: DailyPoint[]; period: string }) {
  const [hover, setHover] = useState<{ x: number; y: number; point: DailyPoint } | null>(null);
  const days = useMemo(() => buildDayGrid(period, data), [period, data]);

  if (days.length === 0) {
    return <div className="flex h-48 items-center justify-center text-sm text-slate-400">无数据</div>;
  }

  const width = 800;
  const height = 220;
  const padding = { left: 48, right: 16, top: 16, bottom: 30 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const amounts = days.map((day) => parseFloat(day.amount_yuan));
  const niceMaxY = niceCeil(Math.max(...amounts, 0.01));
  const xOf = (index: number) => padding.left + (days.length === 1 ? plotWidth / 2 : (index / (days.length - 1)) * plotWidth);
  const yOf = (value: number) => padding.top + plotHeight - (value / niceMaxY) * plotHeight;
  const linePoints = days.map((day, index) => `${xOf(index)},${yOf(parseFloat(day.amount_yuan))}`).join(' ');
  const areaPoints = `${padding.left},${padding.top + plotHeight} ${linePoints} ${xOf(days.length - 1)},${padding.top + plotHeight}`;
  const yTicks = Array.from({ length: 5 }, (_, index) => (niceMaxY / 4) * index);
  const xTickIndexes = pickXTicks(days.length);

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" preserveAspectRatio="xMidYMid meet">
        {yTicks.map((value, index) => {
          const y = yOf(value);
          return (
            <g key={index}>
              <line x1={padding.left} x2={width - padding.right} y1={y} y2={y} stroke={index === 0 ? '#94a3b8' : '#e2e8f0'} strokeWidth={index === 0 ? 1 : 0.5} />
              <text x={padding.left - 6} y={y + 3} fontSize={10} fill="#64748b" textAnchor="end">¥{value < 1 ? value.toFixed(2) : value.toFixed(0)}</text>
            </g>
          );
        })}
        {xTickIndexes.map((index) => (
          <text key={index} x={xOf(index)} y={height - padding.bottom + 14} fontSize={10} fill="#64748b" textAnchor="middle">
            {days[index].date.slice(5)}
          </text>
        ))}
        <polygon points={areaPoints} fill="#dbeafe" opacity={0.8} />
        <polyline points={linePoints} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {days.map((day, index) => (
          <circle
            key={day.date}
            cx={xOf(index)}
            cy={yOf(parseFloat(day.amount_yuan))}
            r={4}
            fill={hover?.point.date === day.date ? '#2563eb' : '#fff'}
            stroke="#2563eb"
            strokeWidth={1.5}
            onMouseEnter={() => setHover({ x: xOf(index), y: yOf(parseFloat(day.amount_yuan)), point: day })}
            onMouseLeave={() => setHover(null)}
            style={{ cursor: 'pointer' }}
          />
        ))}
      </svg>
      {hover && (
        <div
          className="pointer-events-none absolute rounded-md bg-slate-900 px-2 py-1 text-xs text-white shadow-lg"
          style={{
            left: `${(hover.x / width) * 100}%`,
            top: `${(hover.y / height) * 100}%`,
            transform: 'translate(-50%, calc(-100% - 8px))',
            whiteSpace: 'nowrap',
          }}
        >
          {hover.point.date} · ¥{fmtYuan(hover.point.amount_yuan)} · 输出 {fmtTokens(hover.point.output_tokens)}
        </div>
      )}
    </div>
  );
}

function buildDayGrid(period: string, data: DailyPoint[]): DailyPoint[] {
  const [year, month] = period.split('-').map(Number);
  if (!year || !month) return [];
  const days: DailyPoint[] = [];
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const lookup = new Map(data.map((day) => [day.date, day]));
  for (let day = 1; day <= lastDay; day += 1) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    days.push(lookup.get(date) ?? {
      date,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cache_miss_tokens: 0,
      output_tokens: 0,
      amount_yuan: '0',
    });
  }
  return days;
}

function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const exponent = Math.floor(Math.log10(value));
  const base = Math.pow(10, exponent);
  const normalized = value / base;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * base;
}

function pickXTicks(length: number): number[] {
  if (length <= 7) return Array.from({ length }, (_, index) => index);
  const step = Math.max(1, Math.floor(length / 6));
  const ticks: number[] = [];
  for (let index = 0; index < length; index += step) ticks.push(index);
  if (ticks[ticks.length - 1] !== length - 1) ticks.push(length - 1);
  return ticks;
}
