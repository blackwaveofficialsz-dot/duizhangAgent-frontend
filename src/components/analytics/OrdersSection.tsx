import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfigProvider, DatePicker, Input, Modal, Select, Table, type TableColumnsType } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import { currentBeijingDate, formatBeijingTime } from '../../utils/time';
import { createWorkflow } from '../../api/automation';
import { getBusinessReport, getOrders, getOrdersInsight, listPlatformDim, saveOrdersInsightCandidate, type OrderRow, type OrdersExcluded } from '../../api/analytics';
import { getOrderDailyFacts } from '../../api/analyticsDailyFacts';
import type { DailyFactRecord, OrderDailyFact, OrderFactTotals } from '../../api/analyticsDailyTypes';
import {
  fetchOperationsOverview,
  type ComparisonMode,
  type OperationsOverview,
} from '../../features/operations-analysis/api/client';
import { useChannelStore } from '../../store/channelStore';
import { useEmployeeStore } from '../../store/employeeStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import { usePolling } from '../../hooks/usePolling';
import { EmployeeMultiSelect } from '../EmployeeMultiSelect';
import {
  TableDisplayFrame,
  type TableDisplayCell,
  type TableDisplayValue,
} from '../TableDisplayFrame';
import { ChartFullscreenLayer, FullscreenFilterButton, useAnalyticsChartFullscreen } from './ChartFullscreen';
import {
  buildOrderStoreRowsFromOperationsOverview,
  buildOrderStoreSummary,
  buildOrderStoreSummaryFromOperationsOverview,
  orderComputedMetrics,
  type OrderBackendMetricComparisons,
  type OrderComputedMetrics,
  type OrderSecondaryDimension,
  type OrderStoreTableRow,
} from './orderTableModel';
import { OrderStoreDetailModal } from './OrderStoreDetailModal';
import { completenessIsReady, completenessStatus } from './completeness';
import {
  ComparisonDisplaySelect,
  ComparisonModeSelect,
  ComparisonPeriodNote,
  PeriodComparisonRate,
  PeriodMetricCard,
  comparisonDisplayItems,
  type ComparisonDisplayMode,
  type ComparisonValueFormat,
} from './PeriodComparison';
import {
  Card, MobileDatePopup, MobileField, MobileInlineFilter, canViewPeriod,
  displayInsightContent, inputCls, isAbortError, orderPeriodNote, parseYmd, periodKey,
  periodDateRange, periodLabel, searchableSelectProps, shiftAnchor, ymd, yesterday, yuan,
} from './shared';

const OrderCharts = lazy(() => import('./OrderCharts').then(module => ({ default: module.OrderCharts })));

type OrderComparisonMetricKey =
  | 'order_count'
  | 'paid_amount'
  | 'income_amount'
  | 'refund_amount'
  | 'net_income'
  | 'avg_order_value'
  | 'refund_rate';

type OrderMetricRenderConfig = {
  key: keyof OrderComputedMetrics;
  comparisonKey: OrderComparisonMetricKey;
  label: string;
  format: ComparisonValueFormat;
  render: (metrics: OrderComputedMetrics) => string;
};

const ORDER_METRIC_CONFIG: OrderMetricRenderConfig[] = [
  { key: 'order_count', comparisonKey: 'order_count', label: '订单数', format: 'integer', render: metrics => String(metrics.order_count) },
  { key: 'paid_amount_cent', comparisonKey: 'paid_amount', label: '营业额', format: 'money', render: metrics => yuan(centsToYuan(metrics.paid_amount_cent)) },
  { key: 'income_amount_cent', comparisonKey: 'income_amount', label: '实收', format: 'money', render: metrics => yuan(centsToYuan(metrics.income_amount_cent)) },
  { key: 'refund_amount_cent', comparisonKey: 'refund_amount', label: '退款', format: 'money', render: metrics => metrics.refund_amount_cent > 0 ? yuan(centsToYuan(metrics.refund_amount_cent)) : '—' },
  { key: 'net_income_cent', comparisonKey: 'net_income', label: '净实收', format: 'money', render: metrics => yuan(centsToYuan(metrics.net_income_cent)) },
  { key: 'avg_order_value_cent', comparisonKey: 'avg_order_value', label: '客单价', format: 'money', render: metrics => yuan(centsToYuan(metrics.avg_order_value_cent)) },
  { key: 'refund_rate', comparisonKey: 'refund_rate', label: '退款率', format: 'percentagePoint', render: metrics => `${(metrics.refund_rate * 100).toFixed(2)}%` },
];

const ORDER_METRIC_CONFIG_BY_KEY = Object.fromEntries(
  ORDER_METRIC_CONFIG.map(config => [config.comparisonKey, config]),
) as Record<OrderComparisonMetricKey, OrderMetricRenderConfig>;

function rowMetricComparison(
  row: Pick<OrderStoreTableRow, 'metrics' | 'breakdownMetrics'>,
  metric: OrderComparisonMetricKey,
  breakdownKey?: string,
) {
  return breakdownKey
    ? row.breakdownMetrics?.[breakdownKey]?.[metric]
    : row.metrics?.[metric];
}

function summaryMetricComparison(
  summary: { metrics?: OrderBackendMetricComparisons; breakdownMetrics?: Record<string, OrderBackendMetricComparisons> },
  metric: OrderComparisonMetricKey,
  breakdownKey?: string,
) {
  return breakdownKey
    ? summary.breakdownMetrics?.[breakdownKey]?.[metric]
    : summary.metrics?.[metric];
}

function formatMetricCurrent(
  config: OrderMetricRenderConfig,
  fallbackMetrics: OrderComputedMetrics,
  comparison?: OperationsOverview['metrics'][string],
  backendBacked = false,
) {
  const current = comparison?.current;
  if (current == null) return backendBacked ? '—' : config.render(fallbackMetrics);
  const value = Number(current);
  if (!Number.isFinite(value)) return backendBacked ? '—' : config.render(fallbackMetrics);
  if (config.comparisonKey === 'order_count') return Math.round(value).toLocaleString('zh-CN');
  if (config.comparisonKey === 'refund_amount' && value <= 0) return '—';
  if (config.format === 'money') return yuan(value);
  if (config.format === 'percentagePoint') return `${(value * 100).toFixed(2)}%`;
  return String(value);
}

function OrderMetricValue({
  value,
  comparison,
  displayMode,
  format = 'decimal',
  className = '',
}: {
  value: string;
  comparison?: OperationsOverview['metrics'][string];
  displayMode: ComparisonDisplayMode;
  format?: ComparisonValueFormat;
  className?: string;
}) {
  return (
    <div className="min-w-[5.5rem] text-right">
      <div className={`tabular-nums ${className}`}>{value}</div>
      <PeriodComparisonRate
        comparison={comparison}
        displayMode={displayMode}
        format={format}
        className="mt-0.5 block whitespace-normal text-[10px] leading-tight tabular-nums"
      />
    </div>
  );
}

function OrderMobileCards({
  rows,
  dimLabel,
  comparisonForRow,
  displayMode,
  onStoreClick,
}: {
  rows: OrderStoreTableRow[];
  dimLabel: string;
  comparisonForRow: (row: OrderStoreTableRow, metric: OrderComparisonMetricKey) => OperationsOverview['metrics'][string] | undefined;
  displayMode: ComparisonDisplayMode;
  onStoreClick: (row: OrderStoreTableRow) => void;
}) {
  return (
    <div className="space-y-2 md:hidden">
      {rows.map(row => {
        const metrics = orderComputedMetrics(row.totals);
        const currentValue = (metric: OrderComparisonMetricKey) => {
          const config = ORDER_METRIC_CONFIG_BY_KEY[metric];
          return formatMetricCurrent(config, metrics, rowMetricComparison(row, metric), Boolean(row.metrics));
        };
        return (
        <div key={row.storeKey} className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[11px] text-slate-400">{dimLabel}</div>
              <Button
                type="link"
                className="mt-0.5 h-auto max-w-full truncate p-0 text-left text-sm font-medium"
                onClick={() => onStoreClick(row)}
              >
                {row.storeLabel}
              </Button>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11px] text-slate-400">订单数</div>
              <OrderMetricValue
                value={currentValue('order_count')}
                comparison={comparisonForRow(row, 'order_count')}
                displayMode={displayMode}
                format="integer"
                className="mt-0.5 text-sm font-semibold text-slate-900"
              />
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            <MobileField label="营业额" value={<OrderMetricValue value={currentValue('paid_amount')} comparison={comparisonForRow(row, 'paid_amount')} displayMode={displayMode} format="money" />} />
            <MobileField label="实收" value={<OrderMetricValue value={currentValue('income_amount')} comparison={comparisonForRow(row, 'income_amount')} displayMode={displayMode} format="money" />} />
            <MobileField label="退款" value={<OrderMetricValue value={currentValue('refund_amount')} comparison={comparisonForRow(row, 'refund_amount')} displayMode={displayMode} format="money" />} tone="warning" />
            <MobileField label="净实收" value={<OrderMetricValue value={currentValue('net_income')} comparison={comparisonForRow(row, 'net_income')} displayMode={displayMode} format="money" />} tone="strong" />
            <MobileField label="客单价" value={<OrderMetricValue value={currentValue('avg_order_value')} comparison={comparisonForRow(row, 'avg_order_value')} displayMode={displayMode} format="money" />} />
            <MobileField label="退款率" value={<OrderMetricValue value={currentValue('refund_rate')} comparison={comparisonForRow(row, 'refund_rate')} displayMode={displayMode} format="percentagePoint" />} />
          </div>
        </div>
      )})}
    </div>
  );
}


const SECONDARY_DIMENSIONS: Array<{ value: OrderSecondaryDimension; label: string }> = [
  { value: 'none', label: '不附加维度' },
  { value: 'channel', label: '堂食/外卖' },
  { value: 'platform', label: '平台' },
];
const GRANS = [{ key: 'day', label: '天' }, { key: 'week', label: '周' }, { key: 'month', label: '月' }];

const SOURCE_LABELS: Record<string, string> = {
  shop: '堂食',
  takeout: '外卖',
};

function centsToYuan(value: number | null | undefined): number {
  return Number((Number(value || 0) / 100).toFixed(2));
}

function totalsToOrderRow(dimKey: string, dimLabel: string | null, totals: OrderFactTotals, sourceType?: string): OrderRow {
  const paidAmount = centsToYuan(totals.paid_amount_cent);
  const netIncome = centsToYuan(totals.net_income_cent);
  const orderCount = Number(totals.order_count || 0);
  return {
    dim_key: dimKey,
    dim_label: dimLabel,
    source_type: sourceType,
    order_count: orderCount,
    paid_amount: paidAmount,
    income_amount: centsToYuan(totals.income_amount_cent),
    refund_amount: centsToYuan(totals.refund_amount_cent),
    net_amount: centsToYuan(totals.net_amount_cent),
    net_income: netIncome,
    avg_order_value: orderCount ? Number((netIncome / orderCount).toFixed(2)) : 0,
    refund_rate: paidAmount ? Number((centsToYuan(totals.refund_amount_cent) / paidAmount).toFixed(4)) : 0,
    computed_at: null,
  };
}

function orderFactFromRecord(record: DailyFactRecord<OrderDailyFact>): OrderDailyFact {
  const completeness = record.completeness || {};
  const status = completenessStatus(completeness, record.payload.data_status);
  return {
    ...record.payload,
    date: record.date,
    data_status: status,
    complete: completenessIsReady(completeness, status),
    excluded: (record.payload.excluded || completeness.excluded) as OrderDailyFact['excluded'],
  };
}

export function OrdersSection({ show, canManage }: { show: (m: string) => void; canManage: boolean }) {
  const isMobile = useIsMobile();
  const [gran, setGran] = useState('day');
  const [anchor, setAnchor] = useState(() => parseYmd(currentBeijingDate()));
  const pickerValue = useMemo(() => dayjs(anchor), [anchor]);
  const [secondaryDimension, setSecondaryDimension] = useState<OrderSecondaryDimension>('none');
  const [platformLabels, setPlatformLabels] = useState<Record<string, string>>({});
  const [detailStore, setDetailStore] = useState<{ storeKey: string; storeLabel: string } | null>(null);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('previous');
  const [comparisonDisplayMode, setComparisonDisplayMode] = useState<ComparisonDisplayMode>('percentage');
  const [comparisonOverview, setComparisonOverview] = useState<OperationsOverview | null>(null);
  const [orderFacts, setOrderFacts] = useState<OrderDailyFact[]>([]);
  const [ordersFactRefreshSeq, setOrdersFactRefreshSeq] = useState(0);
  const [rows, setRows] = useState<OrderStoreTableRow[]>([]);
  const [excluded, setExcluded] = useState<OrdersExcluded | null>(null);
  const [snapshotStatus, setSnapshotStatus] = useState<string>('missing');
  const [liveCheckedAt, setLiveCheckedAt] = useState<string | null>(null);
  const [liveCheckFailed, setLiveCheckFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [repairProgress, setRepairProgress] = useState(0);
  const [pushOpen, setPushOpen] = useState(false);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [fullscreenFilterExpanded, setFullscreenFilterExpanded] = useState(false);
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const orderFactAbortRef = useRef<AbortController | null>(null);
  const orderFactRefreshConsumedRef = useRef(0);
  const platformLabelsLoadedRef = useRef(false);
  const repairResetTimerRef = useRef<number | null>(null);
  const { fullscreenChart, fullscreenPortrait, openFullscreen, closeFullscreen } = useAnalyticsChartFullscreen<'orders-share'>();
  const period = useMemo(() => periodKey(gran, anchor), [gran, anchor]);
  const excludeToday = false;
  const includesToday = periodDateRange(gran, anchor)[0] <= currentBeijingDate()
    && periodDateRange(gran, anchor)[1] >= currentBeijingDate();
  const dim = secondaryDimension === 'none' ? 'shop' : `shop_${secondaryDimension}`;
  const dimText = secondaryDimension === 'none'
    ? '分店铺'
    : `分店铺 · ${secondaryDimension === 'channel' ? '堂食/外卖' : '平台'}`;
  const periodText = useMemo(() => periodLabel(gran, period, anchor), [gran, period, anchor]);
  const periodDescription = useMemo(() => orderPeriodNote(gran, anchor, excludeToday), [gran, anchor, excludeToday]);
  const comparisonRange = useMemo(() => {
    const [dateFrom, rawDateTo] = periodDateRange(gran, anchor);
    const latestCompleteDate = currentBeijingDate();
    return [dateFrom, rawDateTo > latestCompleteDate ? latestCompleteDate : rawDateTo] as const;
  }, [gran, anchor]);
  const orderFactQueryKey = `${comparisonRange[0]}|${comparisonRange[1]}|${ordersFactRefreshSeq}`;
  const defaultReport = gran === 'week' ? 'order_weekly' : gran === 'month' ? 'order_monthly' : 'order_daily';
  const pickerMode: 'date' | 'week' | 'month' = gran === 'week' ? 'week' : gran === 'month' ? 'month' : 'date';
  const changeGranularity = (value: string) => {
    setGran(value);
    setAnchor(parseYmd(currentBeijingDate()));
  };
  const setAnchorIfAllowed = (next: Date) => {
    if (!canViewPeriod(gran, next, true)) {
      show('当前只能查看截至今日的数据，无法查看后续日期。');
      return;
    }
    setAnchor(next);
  };
  const moveAnchor = (delta: number) => {
    setAnchorIfAllowed(shiftAnchor(gran, anchor, delta));
  };


  const applyOperationsOverview = (overview: OperationsOverview) => {
    setComparisonOverview(overview);
    setRows(buildOrderStoreRowsFromOperationsOverview(overview, secondaryDimension));
    setExcluded(null);
    const status = completenessStatus(overview.completeness, overview.sections?.orders?.status);
    setSnapshotStatus(status);
    if (repairResetTimerRef.current !== null) {
      window.clearTimeout(repairResetTimerRef.current);
      repairResetTimerRef.current = null;
    }
    if (status === 'partial') {
      setRepairing(true);
      setRepairProgress(p => Math.max(p, 12));
    } else if (status === 'ready') {
      setRepairProgress(100);
      repairResetTimerRef.current = window.setTimeout(() => {
        repairResetTimerRef.current = null;
        setRepairing(false);
        setRepairProgress(0);
      }, 700);
    }
  };

  const loadOperationsOverview = (signal?: AbortSignal, refresh = false) => fetchOperationsOverview({
    filters: {
      scopeKeys: ['ALL'],
      storeKeys: [],
      channel: 'all',
      granularity: gran as 'day' | 'week' | 'month',
      dateFrom: comparisonRange[0],
      dateTo: comparisonRange[1],
      compare: comparisonMode,
      orderBreakdown: secondaryDimension,
    },
    signal,
    refresh,
  });

  const load = (refresh = false, backfill = false, clear = true) => {
    if (!canViewPeriod(gran, anchor, true)) {
      show('当前只能查看截至今日的数据，无法查看后续日期。');
      return;
    }
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    loadAbortRef.current?.abort();
    const controller = new AbortController();
    loadAbortRef.current = controller;
    if (clear) {
      setLoading(true);
      setRows([]);
    }
    const repairRequest = (refresh || backfill)
      ? getOrders(gran, period, dim, refresh, backfill, true, excludeToday, { signal: controller.signal })
      : Promise.resolve(null);
    Promise.all([
      loadOperationsOverview(controller.signal, refresh),
      repairRequest,
    ])
      .then(([overview, repairResult]) => {
        if (seq !== loadSeqRef.current) return;
        applyOperationsOverview(overview);
        if (repairResult?.refresh_queued || repairResult?.backfill_queued) {
          if (repairResetTimerRef.current !== null) {
            window.clearTimeout(repairResetTimerRef.current);
            repairResetTimerRef.current = null;
          }
          setRepairing(true);
          setRepairProgress(p => Math.max(p, 12));
        }
        if (refresh && repairResult) show(repairResult.refresh_queued ? '已提交后台刷新，稍后自动读取最新快照' : '后台刷新提交失败，请稍后重试');
        if (backfill && repairResult) show(repairResult.backfill_queued ? '已提交快照补全任务，完成后刷新查看' : '快照补全提交失败，请稍后重试');
      })
      .catch(e => {
        if (seq !== loadSeqRef.current || isAbortError(e)) return;
        show((e as Error).message);
      })
      .finally(() => {
        if (seq !== loadSeqRef.current) return;
        if (clear) setLoading(false);
      });
  };
  useEffect(() => {
    const controller = new AbortController();
    orderFactAbortRef.current?.abort();
    orderFactAbortRef.current = controller;
    const forceRefresh = ordersFactRefreshSeq > orderFactRefreshConsumedRef.current;
    if (forceRefresh) orderFactRefreshConsumedRef.current = ordersFactRefreshSeq;
    getOrderDailyFacts<OrderDailyFact>(comparisonRange[0], comparisonRange[1], {}, {
      signal: controller.signal,
      forceRefresh,
    })
      .then((records: DailyFactRecord<OrderDailyFact>[]) => {
        if (controller.signal.aborted) return;
        setOrderFacts(records.map(orderFactFromRecord));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setOrderFacts([]);
        if (forceRefresh) show(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
    /* eslint-disable-next-line */
  }, [orderFactQueryKey]);

  useEffect(() => {
    if (secondaryDimension !== 'platform' || platformLabelsLoadedRef.current) return;
    platformLabelsLoadedRef.current = true;
    let active = true;
    listPlatformDim()
      .then(platforms => {
        if (!active) return;
        setPlatformLabels(Object.fromEntries(platforms.map(item => [String(item.platform_code), item.platform_name])));
      })
      .catch(() => { platformLabelsLoadedRef.current = false; });
    return () => { active = false; };
  }, [secondaryDimension]);

  useEffect(() => {
    load();
    return () => {
      loadAbortRef.current?.abort();
      if (repairResetTimerRef.current !== null) {
        window.clearTimeout(repairResetTimerRef.current);
        repairResetTimerRef.current = null;
      }
    };
    /* eslint-disable-next-line */
  }, [gran, period, dim, excludeToday, comparisonMode, comparisonRange, secondaryDimension]);

  useEffect(() => {
    if (!repairing) return;
    const timer = window.setInterval(() => {
      setRepairProgress(p => Math.min(92, p + (p < 55 ? 7 : 3)));
    }, 900);
    return () => window.clearInterval(timer);
  }, [repairing]);

  usePolling(
    async (signal) => {
      const seq = loadSeqRef.current;
      const [overview, facts] = await Promise.allSettled([
        loadOperationsOverview(signal),
        getOrderDailyFacts<OrderDailyFact>(comparisonRange[0], comparisonRange[1], {}, {
          signal, forceRefresh: false,
        }),
      ]);
      if (seq !== loadSeqRef.current || signal.aborted) return;
      if (overview.status === 'fulfilled') {
        applyOperationsOverview(overview.value);
        setLiveCheckedAt(new Date().toISOString());
      }
      if (facts.status === 'fulfilled') setOrderFacts(facts.value.map(orderFactFromRecord));
      setLiveCheckFailed(overview.status === 'rejected');
    },
    includesToday ? 30000 : repairing ? 5000 : null,
    [gran, period, dim, comparisonMode, comparisonRange, secondaryDimension, ordersFactRefreshSeq],
  );
  useEffect(() => {
    if (!fullscreenChart) setFullscreenFilterExpanded(false);
  }, [fullscreenChart]);

  const comparisonForRow = (row: OrderStoreTableRow, metric: OrderComparisonMetricKey) => {
    if (comparisonMode !== 'previous') return undefined;
    if (row.storeKey === 'ALL') return comparisonOverview?.metrics[metric];
    return comparisonOverview?.stores?.find(item => (
      String(item.store_key || item.dim_key || '') === row.storeKey
      || String(item.dim_label || item.store_label || '') === row.storeLabel
    ))?.metrics[metric];
  };
  const breakdownKeys = useMemo(() => {
    const keys = new Set(rows.flatMap(row => Object.keys(row.breakdown)));
    if (secondaryDimension === 'channel') return ['shop', 'takeout'];
    return [...keys].sort((left, right) => left.localeCompare(right, 'zh-CN', { numeric: true }));
  }, [rows, secondaryDimension]);
  const breakdownLabel = (key: string) => secondaryDimension === 'channel'
    ? SOURCE_LABELS[key] || key
    : platformLabels[key] || `平台${key}`;
  const metricConfig = ORDER_METRIC_CONFIG;
  const renderMetric = (row: OrderStoreTableRow, config: typeof metricConfig[number], breakdownKey?: string) => {
    const metrics = orderComputedMetrics(breakdownKey ? row.breakdown[breakdownKey] || ({} as OrderFactTotals) : row.totals);
    const comparison = rowMetricComparison(row, config.comparisonKey, breakdownKey);
    const backendBacked = breakdownKey ? Boolean(row.breakdownMetrics?.[breakdownKey]) : Boolean(row.metrics);
    return <OrderMetricValue
      value={formatMetricCurrent(config, metrics, comparison, backendBacked)}
      comparison={comparisonMode === 'previous' ? comparison : undefined}
      displayMode={comparisonDisplayMode}
      format={config.format}
      className={config.key === 'net_income_cent' ? 'font-medium text-slate-800' : 'text-slate-600'}
    />;
  };
  const orderColumns: TableColumnsType<OrderStoreTableRow> = [
    {
      title: '分店铺', key: 'store', fixed: 'left',
      render: (_, row) => <Button type="link" className="h-auto p-0 text-sm" onClick={() => setDetailStore({ storeKey: row.storeKey, storeLabel: row.storeLabel })}>{row.storeLabel}</Button>,
    },
    ...metricConfig.map(config => secondaryDimension === 'none'
      ? {
          title: config.label,
          key: config.key,
          align: 'right' as const,
          render: (_: unknown, row: OrderStoreTableRow) => renderMetric(row, config),
        }
      : {
          title: config.label,
          key: config.key,
          children: breakdownKeys.map(breakdownKey => ({
            title: breakdownLabel(breakdownKey),
            key: `${config.key}:${breakdownKey}`,
            align: 'right' as const,
            render: (_: unknown, row: OrderStoreTableRow) => renderMetric(row, config, breakdownKey),
          })),
        }),
  ];
  const comparisonExportCell = (
    value: TableDisplayValue,
    comparison?: OperationsOverview['metrics'][string],
    format: ComparisonValueFormat = 'money',
  ): TableDisplayCell => {
    if (comparisonMode !== 'previous') return value;
    return {
      value,
      comparisons: comparisonDisplayItems(comparison, comparisonDisplayMode, format),
    };
  };
  const overviewComparisonMetrics = comparisonMode === 'previous' ? comparisonOverview?.metrics : undefined;
  const summary = useMemo(() => (comparisonOverview
    ? buildOrderStoreSummaryFromOperationsOverview(comparisonOverview, secondaryDimension)
    : buildOrderStoreSummary(rows)), [comparisonOverview, rows, secondaryDimension]);
  const summaryMetrics = orderComputedMetrics(summary.totals);
  const formatOverviewMetric = (
    key: OrderComparisonMetricKey,
    fallback: number,
    formatter: (value: number) => string,
  ) => {
    const current = comparisonOverview?.metrics[key]?.current;
    if (comparisonOverview && current == null) return '—';
    return formatter(Number(current ?? fallback));
  };
  const chartRows = useMemo(() => rows
    .filter(row => !row.metrics || row.metrics.net_income?.current != null)
    .map(row => totalsToOrderRow(
      row.storeKey,
      row.storeLabel,
      row.totals,
    )), [rows]);
  const exportHeaders = secondaryDimension === 'none'
    ? ['分店铺', ...metricConfig.map(config => config.label)]
    : ['分店铺', ...metricConfig.flatMap(config => breakdownKeys.map(key => `${config.label}/${breakdownLabel(key)}`))];
  const exportRow = (row: OrderStoreTableRow, total = false): Array<TableDisplayValue | TableDisplayCell> => {
    if (secondaryDimension !== 'none') {
      return [total ? '总数据' : row.storeLabel, ...metricConfig.flatMap(config => breakdownKeys.map(key => comparisonExportCell(
        formatMetricCurrent(
          config,
          orderComputedMetrics(row.breakdown[key] || ({} as OrderFactTotals)),
          total ? summaryMetricComparison(summary, config.comparisonKey, key) : rowMetricComparison(row, config.comparisonKey, key),
          total ? Boolean(summary.breakdownMetrics?.[key]) : Boolean(row.breakdownMetrics?.[key]),
        ),
        total
          ? summaryMetricComparison(summary, config.comparisonKey, key)
          : rowMetricComparison(row, config.comparisonKey, key),
        config.format,
      )))];
    }
    const metrics = orderComputedMetrics(row.totals);
    return [
      total ? '总数据' : row.storeLabel,
      ...metricConfig.map(config => comparisonExportCell(
        formatMetricCurrent(config, metrics, total ? summaryMetricComparison(summary, config.comparisonKey) : rowMetricComparison(row, config.comparisonKey), total ? Boolean(summary.metrics) : Boolean(row.metrics)),
        total ? summaryMetricComparison(summary, config.comparisonKey) : rowMetricComparison(row, config.comparisonKey),
        config.format,
      )),
    ];
  };
  const orderExportTables = [{
    title: `${dimText}订单统计`,
    headers: exportHeaders,
    rows: [...rows.map(row => exportRow(row)), exportRow({
      key: 'SUMMARY', storeKey: 'SUMMARY', storeLabel: '总数据', totals: summary.totals, metrics: summary.metrics, breakdown: summary.breakdown, breakdownMetrics: summary.breakdownMetrics,
    }, true)],
  }];
  const renderControls = (mobile = false) => (
    <>
      <Select<OrderSecondaryDimension>
        {...searchableSelectProps}
        aria-label="订单统计维度"
        className={`${inputCls} ${mobile ? 'w-full' : 'min-w-[180px]'}`}
        value={secondaryDimension}
        onChange={setSecondaryDimension}
        options={SECONDARY_DIMENSIONS}
        popupMatchSelectWidth={false}
      />
      <Select {...searchableSelectProps} aria-label="订单统计周期" className={`${inputCls} ${mobile ? 'w-full' : ''}`} value={gran} onChange={changeGranularity} options={GRANS.map(g => ({ value: g.key, label: g.label }))} popupMatchSelectWidth={false} />
      <ComparisonModeSelect ariaLabel={mobile ? '订单统计移动端对比方式' : '订单统计对比方式'} value={comparisonMode} onChange={setComparisonMode} mobile={mobile} />
      <ComparisonDisplaySelect
        ariaLabel={mobile ? '订单统计移动端对比展示' : '订单统计对比展示'}
        value={comparisonDisplayMode}
        onChange={setComparisonDisplayMode}
        disabled={comparisonMode !== 'previous'}
        mobile={mobile}
      />
      <div className={`flex items-center gap-1 ${mobile ? 'w-full' : ''}`}>
        <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 px-2 py-1.5 text-sm text-slate-500 shadow-none hover:text-slate-700 cursor-pointer" onClick={() => moveAnchor(-1)}>◀</Button>
        {mobile ? (
          <div className="min-w-0 flex-1">
            <MobileDatePopup
              allowToday
              label={gran === 'day' ? '日期' : gran === 'week' ? '周' : '月份'}
              title={gran === 'day' ? '选择日期' : gran === 'week' ? '选择周内任意一天' : '选择月份内任意一天'}
              hint={periodText}
              value={ymd(anchor)}
              onChange={value => setAnchorIfAllowed(parseYmd(value))}
            />
          </div>
        ) : (
          <span className="min-w-44 text-center text-sm font-medium text-slate-700">{periodText}</span>
        )}
        <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 px-2 py-1.5 text-sm text-slate-500 shadow-none hover:text-slate-700 cursor-pointer" onClick={() => moveAnchor(1)}>▶</Button>
      </div>
      {!mobile && (
        <ConfigProvider locale={zhCN}>
          <DatePicker
            aria-label={gran === 'week' ? '选择周' : gran === 'month' ? '选择月份' : '选择日期'}
            allowClear={false}
            inputReadOnly
            needConfirm
            picker={pickerMode}
            value={pickerValue}
            format={gran === 'week' ? 'YYYY-[W]WW' : gran === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'}
            className="w-[140px]"
            disabledDate={(current) => Boolean(current && current.format('YYYY-MM-DD') > currentBeijingDate())}
            onOk={value => { if (value) setAnchorIfAllowed(value.toDate()); }}
          />
        </ConfigProvider>
      )}
      {!mobile && <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 px-2 py-1.5 text-xs text-slate-500 shadow-none hover:text-slate-700 cursor-pointer" onClick={() => setAnchor(yesterday())}>昨天</Button>}
      {!mobile && <Button autoInsertSpace={false} htmlType="button" onClick={() => setAnchor(parseYmd(currentBeijingDate()))}>今天</Button>}
      {canManage && <Button autoInsertSpace={false} htmlType="button" className={`h-auto rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 cursor-pointer ${mobile ? 'w-full' : 'md:ml-auto'}`} onClick={() => setPushOpen(true)}>设为定时推送</Button>}
      <Button autoInsertSpace={false} htmlType="button" className={`h-auto rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer ${mobile ? 'w-full' : ''}`} disabled={loading} onClick={() => {
        setOrdersFactRefreshSeq(value => value + 1);
        load(true);
      }}>
        {loading ? '刷新中…' : '刷新'}
      </Button>
    </>
  );

  return (
    <div className="space-y-4">
    <Card>
      <MobileInlineFilter
        summary={`${dimText} · ${periodText}`}
        open={filterExpanded}
        onToggle={() => setFilterExpanded(v => !v)}
      >
          {renderControls(true)}
      </MobileInlineFilter>
      <div className="mb-4 hidden flex-wrap items-center gap-2 md:flex">
        {renderControls(false)}
      </div>
      {includesToday && <p className="mb-3 text-xs text-slate-500" role="status">
        含当日数据，每 30 秒检查最新汇总。{liveCheckFailed ? '读取暂时失败，保留上次结果并继续重试。' : liveCheckedAt ? `最近读取：${formatBeijingTime(liveCheckedAt)}` : ''}
      </p>}
      {periodDescription && <p className="mb-3 text-xs text-slate-400">{periodDescription}</p>}
      <div className="mb-4 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <PeriodMetricCard
          label="营业额"
          value={formatOverviewMetric('paid_amount', centsToYuan(summaryMetrics.paid_amount_cent), yuan)}
          comparison={overviewComparisonMetrics?.paid_amount}
          displayMode={comparisonDisplayMode}
        />
        <PeriodMetricCard
          label="净实收"
          value={formatOverviewMetric('net_income', centsToYuan(summaryMetrics.net_income_cent), yuan)}
          comparison={overviewComparisonMetrics?.net_income}
          displayMode={comparisonDisplayMode}
        />
        <PeriodMetricCard
          label="订单数"
          value={formatOverviewMetric('order_count', summaryMetrics.order_count, value => value.toLocaleString('zh-CN'))}
          comparison={overviewComparisonMetrics?.order_count}
          format="integer"
          displayMode={comparisonDisplayMode}
        />
        <PeriodMetricCard
          label="客单价"
          value={formatOverviewMetric('avg_order_value', centsToYuan(summaryMetrics.avg_order_value_cent), yuan)}
          comparison={overviewComparisonMetrics?.avg_order_value}
          displayMode={comparisonDisplayMode}
        />
      </div>
      <ComparisonPeriodNote previousPeriod={comparisonOverview?.previous_period} />
      {rows.length > 0 && (
        <Suspense fallback={<div className="mb-4 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-400">图表加载中…</div>}>
          <OrderCharts rows={chartRows} dimLabel="分店铺" onFullscreen={() => openFullscreen('orders-share')} />
        </Suspense>
      )}
      {(repairing || snapshotStatus === 'partial') && (
        <div className="mb-3 rounded-lg border border-blue-100 bg-blue-50 px-3 py-2 text-xs text-blue-700" role="status" aria-live="polite">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="font-medium">{snapshotStatus === 'partial' ? '已发现快照不完整，等待后台修复' : '正在修复经营分析快照'}</span>
            <span className="tabular-nums text-blue-500">{Math.round(repairProgress)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-blue-100">
            <div className="h-full rounded-full bg-blue-500 transition-all duration-500" style={{ width: `${repairProgress}%` }} />
          </div>
          <p className="mt-2 text-blue-500">页面会自动检查修复结果，完成后重新加载最新数据。</p>
        </div>
      )}
      {canManage && pushOpen && <PushModal defaultReport={defaultReport} onClose={() => setPushOpen(false)} show={show} />}
      {excluded && excluded.excluded_orders > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          已排除 <b>{excluded.excluded_orders}</b> 笔未映射店铺订单（{excluded.excluded_shops.length} 家未确认：
          {excluded.excluded_shops.slice(0, 3).map(s => s.shop_name).join('、')}
          {excluded.excluded_shops.length > 3 ? ' 等' : ''}）。统计仅含已确认映射的 {excluded.confirmed_shops} 家店铺，去
          <span className="font-medium">「设置」</span>确认更多。
        </div>
      )}
      {excluded && excluded.confirmed_shops === 0 ? (
        <div className="text-slate-400 text-sm py-8 text-center">
          尚未确认任何店铺映射，去<span className="font-medium text-slate-600">「设置」</span>确认后才会统计。
        </div>
      ) : rows.length === 0 ? (
        <div className="text-slate-400 text-sm py-8 text-center">{loading ? '加载中…' : '该周期暂无数据'}</div>
      ) : (
        <TableDisplayFrame
          title="订单统计明细"
          filename={`订单统计-${dimText}-${periodText}`}
          className="rounded-lg border border-slate-200"
          tableClassName="overflow-x-auto"
          exportTables={orderExportTables}
        >
          {isMobile ? (
            <div className="p-3">
              <OrderMobileCards
                rows={rows}
                dimLabel="分店铺"
                comparisonForRow={comparisonForRow}
                displayMode={comparisonDisplayMode}
                onStoreClick={row => setDetailStore({ storeKey: row.storeKey, storeLabel: row.storeLabel })}
              />
              <p className="mt-2 text-[11px] text-slate-400">营业额=订单原价/平台用户实付口径；实收=商家结算(扣平台佣金/服务费)；净实收=实收−退款。</p>
            </div>
          ) : (
            <>
              <Table<OrderStoreTableRow>
                bordered
                columns={orderColumns}
                dataSource={rows}
                pagination={false}
                rowKey="storeKey"
                size="small"
                scroll={{ x: 'max-content' }}
                summary={() => (
                  <Table.Summary.Row className="bg-slate-50 font-medium">
                    <Table.Summary.Cell index={0}>总数据</Table.Summary.Cell>
                    {secondaryDimension === 'none'
                      ? metricConfig.map((config, index) => (
                          <Table.Summary.Cell key={config.key} index={index + 1} align="right">
                            <OrderMetricValue
                              value={formatMetricCurrent(config, summaryMetrics, summaryMetricComparison(summary, config.comparisonKey), Boolean(summary.metrics))}
                              comparison={comparisonMode === 'previous' ? summaryMetricComparison(summary, config.comparisonKey) : undefined}
                              displayMode={comparisonDisplayMode}
                              format={config.format}
                              className={config.key === 'net_income_cent' ? 'font-medium text-slate-800' : 'text-slate-600'}
                            />
                          </Table.Summary.Cell>
                        ))
                      : metricConfig.flatMap(config => breakdownKeys.map(key => ({ config, key }))).map(({ config, key }, index) => (
                          <Table.Summary.Cell key={`${config.key}:${key}`} index={index + 1} align="right">
                            <OrderMetricValue
                              value={formatMetricCurrent(
                                config,
                                orderComputedMetrics(summary.breakdown[key] || ({} as OrderFactTotals)),
                                summaryMetricComparison(summary, config.comparisonKey, key),
                                Boolean(summary.breakdownMetrics?.[key]),
                              )}
                              comparison={comparisonMode === 'previous' ? summaryMetricComparison(summary, config.comparisonKey, key) : undefined}
                              displayMode={comparisonDisplayMode}
                              format={config.format}
                              className={config.key === 'net_income_cent' ? 'font-medium text-slate-800' : 'text-slate-600'}
                            />
                          </Table.Summary.Cell>
                        ))}
                  </Table.Summary.Row>
                )}
              />
              <p className="px-3 pb-3 pt-2 text-[11px] text-slate-400">营业额=订单原价/平台用户实付口径；实收=商家结算(扣平台佣金/服务费)；净实收=实收−退款。</p>
            </>
          )}
        </TableDisplayFrame>
      )}
    </Card>
    {fullscreenChart === 'orders-share' ? (
      <ChartFullscreenLayer
        title={`${dimText}占比`}
        subtitle={`${periodText}`}
        showRotateHint={fullscreenPortrait}
        controls={(
          <div className="relative">
            <FullscreenFilterButton
              expanded={fullscreenFilterExpanded}
              onClick={() => setFullscreenFilterExpanded(v => !v)}
            />
            {fullscreenFilterExpanded ? (
              <div className="chart-fullscreen-filter-panel">
                <div className="mb-1.5 truncate text-[11px] text-slate-400">{dimText} · {periodText}</div>
                <div className="space-y-2">{renderControls(true)}</div>
              </div>
            ) : null}
          </div>
        )}
        onClose={closeFullscreen}
      >
        {rows.length > 0 ? (
          <Suspense fallback={<div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">图表加载中…</div>}>
            <OrderCharts rows={chartRows} dimLabel="分店铺" fullscreen />
          </Suspense>
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">暂无占比数据</div>
        )}
      </ChartFullscreenLayer>
    ) : null}
    {rows.length > 0 && <InsightPanel granularity={gran} period={period} dim={dim} show={show} />}
    <OrderStoreDetailModal
      open={Boolean(detailStore)}
      store={detailStore}
      initialGranularity={gran as 'day' | 'week' | 'month'}
      secondaryDimension={secondaryDimension}
      breakdowns={breakdownKeys.map(key => ({ key, label: breakdownLabel(key) }))}
      seedFacts={orderFacts}
      onClose={() => setDetailStore(null)}
    />
    </div>
  );
}


function InsightPanel({ granularity, period, dim, show, onShowWeather, onShowTradeArea }: {
  granularity: string; period: string; dim: string; show: (m: string) => void;
  onShowWeather?: () => void; onShowTradeArea?: () => void;
}) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [dataSources, setDataSources] = useState<string[]>([]);
  const [missingContext, setMissingContext] = useState<string[]>([]);
  const [knowledgeCandidateCount, setKnowledgeCandidateCount] = useState(0);
  const [suggestions, setSuggestions] = useState<{ title: string; source_text: string; confidence: number }[]>([]);
  const [savingSuggestion, setSavingSuggestion] = useState('');

  // 切换周期/维度后清空旧解读，避免贴在过期上下文
  useEffect(() => {
    setContent('');
    setOpen(false);
    setDataSources([]);
    setMissingContext([]);
    setKnowledgeCandidateCount(0);
    setSuggestions([]);
  }, [granularity, period, dim]);

  const gen = (refresh: boolean) => {
    setLoading(true);
    setOpen(true);
    const request = dim === 'shop'
      ? getBusinessReport(granularity, period, refresh)
      : getOrdersInsight(granularity, period, dim, refresh);
    request
      .then(r => {
        setContent(displayInsightContent(r.content_md));
        setDataSources(r.data_sources || []);
        setSuggestions('knowledge_suggestions' in r ? r.knowledge_suggestions || [] : []);
        setMissingContext('missing_context' in r ? r.missing_context.map(item => item.message || '缺少分析上下文') : []);
        setKnowledgeCandidateCount('knowledge_candidate_count' in r ? r.knowledge_candidate_count : 0);
      })
      .catch(e => show((e as Error).message))
      .finally(() => setLoading(false));
  };

  const saveSuggestion = async (item: { title: string; source_text: string; confidence: number }) => {
    setSavingSuggestion(item.title);
    try {
      await saveOrdersInsightCandidate({
        title: item.title,
        source_text: item.source_text || item.title,
        confidence: item.confidence,
        category: 'analytics_insight_rule',
      });
      setSuggestions(prev => prev.filter(x => x.title !== item.title));
      show('已保存为候选知识，管理员确认后进入知识库');
    } catch (e) {
      show((e as Error).message);
    } finally {
      setSavingSuggestion('');
    }
  };

  return (
    <Card>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">🤖 AI 解读 <span className="text-xs font-normal text-slate-400">（数字由系统确定性计算，分析仅供参考）</span></span>
        {content
          ? <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 p-0 text-xs text-blue-600 shadow-none hover:underline cursor-pointer disabled:opacity-50" disabled={loading} onClick={() => gen(false)}>{loading ? '解读中…' : '重新解读'}</Button>
          : <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 p-0 text-xs text-blue-600 shadow-none hover:underline cursor-pointer disabled:opacity-50" disabled={loading} onClick={() => gen(false)}>{loading ? '解读中…' : '生成解读'}</Button>}
      </div>
      {open && (
        <>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-600">{loading ? '正在分析…' : content}</div>
          {dataSources.length > 0 && !loading && (
            <div className="mt-2 text-xs text-slate-400 border-t border-slate-100 pt-2">
              数据来源：
              {dataSources.map((s, i) => (
                <span key={s}>
                  {i > 0 && ' · '}
                  {s === '天气' && onShowWeather
                    ? <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 p-0 text-blue-500 shadow-none hover:underline cursor-pointer" onClick={onShowWeather}>天气</Button>
                    : s === '商圈' && onShowTradeArea
                    ? <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 p-0 text-blue-500 shadow-none hover:underline cursor-pointer" onClick={onShowTradeArea}>商圈</Button>
                    : s}
                </span>
              ))}
            </div>
          )}
          {missingContext.length > 0 && !loading && (
            <div className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-700">
              数据限制：{missingContext.join('；')}
            </div>
          )}
          {knowledgeCandidateCount > 0 && !loading && (
            <div className="mt-2 rounded-md bg-blue-50 px-3 py-2 text-xs text-blue-700">
              已生成 {knowledgeCandidateCount} 条待确认知识候选，<a className="underline" href="#/knowledge">前往知识库确认</a>。
            </div>
          )}
          {suggestions.length > 0 && !loading && (
            <div className="mt-2 border-t border-slate-100 pt-2">
              <div className="text-xs font-medium text-slate-500 mb-1">📌 可沉淀知识</div>
              {suggestions.map((s, i) => (
                <div key={i} className="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 mb-1 last:mb-0">
                  <span className="flex-1 text-xs text-slate-600">{s.title}</span>
                  <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 p-0 text-xs text-blue-600 shadow-none hover:underline whitespace-nowrap cursor-pointer disabled:opacity-50"
                    disabled={savingSuggestion === s.title}
                    onClick={() => saveSuggestion(s)}>{savingSuggestion === s.title ? '保存中…' : '保存候选'}</Button>
                  <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 p-0 text-xs text-slate-400 shadow-none hover:text-slate-600 whitespace-nowrap cursor-pointer"
                    onClick={() => setSuggestions(prev => prev.filter((_, j) => j !== i))}>忽略</Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

// ── 人效（P2）──────────────────────────────────────────────────────────────


const REPORTS = [
  { key: 'order_daily', label: '日报', cron: (h: number, m: number) => `${m} ${h} * * *` },
  { key: 'order_weekly', label: '周报（每周一）', cron: (h: number, m: number) => `${m} ${h} * * 1` },
  { key: 'order_monthly', label: '月报（每月1日）', cron: (h: number, m: number) => `${m} ${h} 1 * *` },
];

function PushModal({ defaultReport, onClose, show }: { defaultReport: string; onClose: () => void; show: (m: string) => void }) {
  const [report, setReport] = useState(defaultReport);
  const channels = useChannelStore(s => s.items);   // 通道/员工走全局缓存：弹窗反复开不重复拉
  const loadChannels = useChannelStore(s => s.load);
  const emps = useEmployeeStore(s => s.items);
  const empsLoading = useEmployeeStore(s => s.loading);
  const loadEmps = useEmployeeStore(s => s.load);
  const [channelId, setChannelId] = useState('');
  const [userIds, setUserIds] = useState<string[]>([]);
  const [time, setTime] = useState('09:00');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    loadChannels().then(cs => { if (cs[0]) setChannelId(cs[0].id); }).catch(e => show((e as Error).message));
    loadEmps().catch(() => {});
  }, []);

  const submit = () => {
    if (!channelId) { show('请选择通道'); return; }
    if (userIds.length === 0) { show('请选择接收人'); return; }
    const [h, m] = time.split(':').map(Number);
    const spec = REPORTS.find(r => r.key === report)!;
    setBusy(true);
    createWorkflow({
      name: `经营${spec.label.replace(/（.*/, '')}推送`, workflow_type: 'notification', trigger_type: 'cron',
      cron_expr: spec.cron(h, m), timezone: 'Asia/Shanghai', date_window_type: 'yesterday',
      channel_id: channelId, recipient_config: { user_ids: userIds },
      rule_config: { type: 'business_analysis', report },
    }).then(() => { show('已创建定时推送'); onClose(); }).catch(e => show((e as Error).message)).finally(() => setBusy(false));
  };

  return (
    <Modal open centered footer={null} closable={false} width="34rem" onCancel={onClose} styles={{ body: { padding: 0 } }}>
      <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="font-medium text-slate-800">设为定时推送</h3>
        <label className="block text-sm"><span className="text-slate-500">报表</span>
          <Select
            {...searchableSelectProps}
            className={inputCls + ' w-full mt-1'}
            value={report}
            onChange={setReport}
            options={REPORTS.map(r => ({ value: r.key, label: r.label }))}
            popupMatchSelectWidth={false}
          />
        </label>
        <label className="block text-sm"><span className="text-slate-500">推送时间</span>
          <Input type="time" className={inputCls + ' w-full mt-1'} value={time} onChange={e => setTime(e.target.value)} />
        </label>
        <label className="block text-sm"><span className="text-slate-500">通道</span>
          <Select
            {...searchableSelectProps}
            className={inputCls + ' w-full mt-1'}
            value={channelId}
            onChange={setChannelId}
            options={channels.length === 0
              ? [{ value: '', label: '（无通道，请先在自动化与消息里创建）' }]
              : channels.map(c => ({ value: c.id, label: c.name }))}
            popupMatchSelectWidth={false}
          />
        </label>
        <div className="block text-sm">
          <div className="mb-1 text-slate-500">接收人（从员工通讯录选择）</div>
          <EmployeeMultiSelect employees={emps} loading={empsLoading} selectedIds={userIds} onChange={setUserIds} />
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button autoInsertSpace={false} htmlType="button" className="h-auto border-0 px-3 py-1.5 text-sm text-slate-500 shadow-none hover:text-slate-700 cursor-pointer" onClick={onClose}>取消</Button>
          <Button autoInsertSpace={false} htmlType="button" className="h-auto rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer" disabled={busy} onClick={submit}>{busy ? '创建中…' : '创建推送'}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── 设置：店铺映射 + 平台名 ────────────────────────────────────────────────


// ── 门店地理 ────────────────────────────────────────────────────
