import { useEffect, useMemo, useRef, useState } from 'react';
import { Modal, Segmented, Table, type TableColumnsType } from 'antd';
import dayjs from 'dayjs';

import { getOrderDailyFacts } from '../../api/analyticsDailyFacts';
import type { DailyFactRecord, OrderDailyFact } from '../../api/analyticsDailyTypes';
import type { ComparisonMode } from '../../features/operations-analysis/api/client';
import type { MetricComparison } from '../../features/operations-analysis/api/client';
import { useIsMobile } from '../../hooks/useIsMobile';
import { TableDisplayFrame, type TableDisplayCell } from '../TableDisplayFrame';
import { aggregateOrderFacts, buildRevenueSeries, filterOrderFactsByStores } from './dailyFactSelectors';
import { OrderStoreTrendChart } from './OrderStoreTrendChart';
import {
  buildStorePeriodRows,
  compareOrderMetrics,
  type OrderSecondaryDimension,
  type OrderStorePeriodRow,
} from './orderTableModel';
import {
  ComparisonDisplaySelect,
  ComparisonModeSelect,
  PeriodComparisonRate,
  PeriodMetricCard,
  comparisonDisplayItems,
  type ComparisonDisplayMode,
  type ComparisonValueFormat,
} from './PeriodComparison';
import { TrendPeriodControls } from './TrendPeriodControls';
import { defaultTrendRange, trendHistoryStart, type TrendGranularity } from './trendPeriod';

type StoreRef = { storeKey: string; storeLabel: string };
type ViewMode = 'chart' | 'detail';

function previousRange(dateFrom: string, dateTo: string): [string, string] {
  const dayCount = dayjs(dateTo).diff(dayjs(dateFrom), 'day') + 1;
  const previousTo = dayjs(dateFrom).subtract(1, 'day');
  return [
    previousTo.subtract(dayCount - 1, 'day').format('YYYY-MM-DD'),
    previousTo.format('YYYY-MM-DD'),
  ];
}

function hasDateCoverage(facts: OrderDailyFact[], dateFrom: string, dateTo: string): boolean {
  const dates = new Set(facts.map(fact => fact.date));
  let cursor = dayjs(dateFrom);
  const end = dayjs(dateTo);
  while (!cursor.isAfter(end, 'day')) {
    if (!dates.has(cursor.format('YYYY-MM-DD'))) return false;
    cursor = cursor.add(1, 'day');
  }
  return true;
}

function mergeFacts(current: OrderDailyFact[], incoming: OrderDailyFact[]): OrderDailyFact[] {
  if (!incoming.length) return current;
  const byDate = new Map(current.map(fact => [fact.date, fact]));
  let changed = false;
  incoming.forEach(fact => {
    if (byDate.get(fact.date) !== fact) changed = true;
    byDate.set(fact.date, fact);
  });
  if (!changed) return current;
  return [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
}

const yuanFromCent = (cent: number) => `¥${(cent / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function displayComparison(comparison: MetricComparison, format: ComparisonValueFormat): MetricComparison {
  if (format !== 'money') return comparison;
  return {
    ...comparison,
    current: comparison.current == null ? null : comparison.current / 100,
    previous: comparison.previous == null ? null : comparison.previous / 100,
    difference: comparison.difference == null ? null : comparison.difference / 100,
  };
}

export function OrderStoreDetailModal({
  open,
  store,
  initialGranularity,
  secondaryDimension,
  breakdowns = [],
  seedFacts,
  todayYmd,
  onClose,
  onPermissionDenied,
}: {
  open: boolean;
  store: StoreRef | null;
  initialGranularity: TrendGranularity;
  secondaryDimension: OrderSecondaryDimension;
  breakdowns?: Array<{ key: string; label: string }>;
  seedFacts: OrderDailyFact[];
  todayYmd?: string;
  onClose: () => void;
  onPermissionDenied?: () => void;
}) {
  const isMobile = useIsMobile();
  const today = todayYmd || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const initialRange = defaultTrendRange(initialGranularity, today, true);
  const [granularity, setGranularity] = useState<TrendGranularity>(initialGranularity);
  const [dateFrom, setDateFrom] = useState(initialRange.dateFrom);
  const [dateTo, setDateTo] = useState(initialRange.dateTo);
  const [includeCurrent, setIncludeCurrent] = useState(initialRange.includeCurrent);
  const [view, setView] = useState<ViewMode>('chart');
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('previous');
  const [displayMode, setDisplayMode] = useState<ComparisonDisplayMode>('percentage');
  const [sessionFacts, setSessionFacts] = useState<OrderDailyFact[]>(seedFacts);
  const requestRef = useRef<AbortController | null>(null);
  const requestedRangeRef = useRef('');
  const accessRevokedRef = useRef(false);
  const permissionCallbackRef = useRef(onPermissionDenied);
  permissionCallbackRef.current = onPermissionDenied;
  const [permissionDenied, setPermissionDenied] = useState(false);

  useEffect(() => {
    if (accessRevokedRef.current) return;
    setSessionFacts(current => mergeFacts(current, seedFacts));
  }, [seedFacts]);

  useEffect(() => {
    if (!open) return;
    const range = defaultTrendRange(initialGranularity, today, true);
    setGranularity(initialGranularity);
    setDateFrom(range.dateFrom);
    setDateTo(range.dateTo);
    setIncludeCurrent(range.includeCurrent);
    setView('chart');
    requestedRangeRef.current = '';
  }, [open, store?.storeKey, initialGranularity, today]);

  useEffect(() => {
    if (!open || !store || accessRevokedRef.current) return;
    const [previousFrom] = previousRange(dateFrom, dateTo);
    const historyFrom = trendHistoryStart(granularity, dateFrom);
    const fetchFrom = historyFrom < previousFrom ? historyFrom : previousFrom;
    const requestKey = `${store.storeKey}|${fetchFrom}|${dateTo}`;
    if (hasDateCoverage(sessionFacts, fetchFrom, dateTo) || requestedRangeRef.current === requestKey) return;
    requestedRangeRef.current = requestKey;
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    getOrderDailyFacts<OrderDailyFact>(fetchFrom, dateTo, {}, { signal: controller.signal })
      .then((records: DailyFactRecord<OrderDailyFact>[]) => {
        if (!controller.signal.aborted) setSessionFacts(current => mergeFacts(current, records.map(record => record.payload)));
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        if (typeof error === 'object' && error !== null && 'status' in error
          && (error.status === 401 || error.status === 403)) {
          accessRevokedRef.current = true;
          requestRef.current?.abort();
          requestRef.current = null;
          setSessionFacts([]);
          setPermissionDenied(true);
          permissionCallbackRef.current?.();
        }
      });
    return () => controller.abort();
  }, [open, store?.storeKey, granularity, dateFrom, dateTo, sessionFacts]);

  useEffect(() => () => requestRef.current?.abort(), []);

  const storeFacts = useMemo(() => store
    ? filterOrderFactsByStores(sessionFacts, { storeKeys: [store.storeKey] })
    : [], [sessionFacts, store]);
  const visibleFacts = useMemo(() => storeFacts.filter(fact => fact.date >= dateFrom && fact.date <= dateTo), [storeFacts, dateFrom, dateTo]);
  const historyFrom = useMemo(() => trendHistoryStart(granularity, dateFrom), [dateFrom, granularity]);
  const comparisonDateRange = useMemo(() => previousRange(dateFrom, dateTo), [dateFrom, dateTo]);
  const previousFacts = useMemo(() => storeFacts.filter(fact => (
    fact.date >= comparisonDateRange[0] && fact.date <= comparisonDateRange[1]
  )), [comparisonDateRange, storeFacts]);
  const rangeComparison = useMemo(() => compareOrderMetrics(
    aggregateOrderFacts(visibleFacts),
    previousFacts.length ? aggregateOrderFacts(previousFacts) : null,
  ), [previousFacts, visibleFacts]);
  const activeBreakdowns = useMemo(() => secondaryDimension === 'none'
    ? []
    : breakdowns.length
      ? breakdowns
      : secondaryDimension === 'channel'
        ? [{ key: 'shop', label: '堂食' }, { key: 'takeout', label: '外卖' }]
        : [], [breakdowns, secondaryDimension]);
  const filterBreakdownFacts = (key: string) => filterOrderFactsByStores(storeFacts, secondaryDimension === 'channel'
    ? { sourceTypes: [key] }
    : { platformKeys: [key] });
  const chartSeries = useMemo(() => secondaryDimension === 'none'
    ? [{
        key: 'all',
        label: '净实收',
        points: buildRevenueSeries(storeFacts, granularity, includeCurrent, historyFrom, dateTo)
          .filter(point => point.date_to >= dateFrom && point.date_from <= dateTo),
      }]
    : activeBreakdowns.map(item => ({
        ...item,
        points: buildRevenueSeries(
          filterBreakdownFacts(item.key),
          granularity,
          includeCurrent,
          historyFrom,
          dateTo,
        ).filter(point => point.date_to >= dateFrom && point.date_from <= dateTo),
      })), [activeBreakdowns, dateFrom, dateTo, granularity, historyFrom, includeCurrent, secondaryDimension, storeFacts]);
  const detailRows = useMemo(() => store
    ? buildStorePeriodRows(storeFacts, store.storeKey, granularity, dateFrom, dateTo)
    : [], [storeFacts, store, granularity, dateFrom, dateTo]);
  const breakdownPeriodRows = useMemo(() => Object.fromEntries(activeBreakdowns.map(item => [
    item.key,
    new Map(buildStorePeriodRows(
      filterBreakdownFacts(item.key),
      store?.storeKey || '',
      granularity,
      dateFrom,
      dateTo,
    ).map(row => [row.key, row])),
  ])), [activeBreakdowns, dateFrom, dateTo, granularity, secondaryDimension, store, storeFacts]);
  const latest = detailRows[detailRows.length - 1];
  const totalNetIncome = detailRows.reduce((sum, row) => sum + row.totals.net_income_cent, 0);
  const hasSummaryData = visibleFacts.length > 0 && detailRows.length > 0;

  const compareHistorical = comparisonMode === 'previous' && dateTo < today;
  const comparisonCell = (
    value: string | number,
    comparison: OrderStorePeriodRow['comparison'][keyof OrderStorePeriodRow['comparison']],
    format: ComparisonValueFormat,
  ): TableDisplayCell => !compareHistorical
    ? value
    : { value, comparisons: comparisonDisplayItems(displayComparison(comparison, format), displayMode, format) };
  const baseMetricColumns: TableColumnsType<OrderStorePeriodRow> = [
    { title: '周期', dataIndex: 'label', key: 'label', fixed: 'left' },
    { title: '订单数', key: 'orders', align: 'right', render: (_, row) => <><div>{row.metrics.order_count}</div>{compareHistorical && <PeriodComparisonRate comparison={row.comparison.order_count} displayMode={displayMode} format="integer" />}</> },
    { title: '营业额', key: 'paid', align: 'right', render: (_, row) => <><div>{yuanFromCent(row.metrics.paid_amount_cent)}</div>{compareHistorical && <PeriodComparisonRate comparison={displayComparison(row.comparison.paid_amount_cent, 'money')} displayMode={displayMode} format="money" />}</> },
    { title: '实收', key: 'income', align: 'right', render: (_, row) => <><div>{yuanFromCent(row.metrics.income_amount_cent)}</div>{compareHistorical && <PeriodComparisonRate comparison={displayComparison(row.comparison.income_amount_cent, 'money')} displayMode={displayMode} format="money" />}</> },
    { title: '退款', key: 'refund', align: 'right', render: (_, row) => <><div>{yuanFromCent(row.metrics.refund_amount_cent)}</div>{compareHistorical && <PeriodComparisonRate comparison={displayComparison(row.comparison.refund_amount_cent, 'money')} displayMode={displayMode} format="money" />}</> },
    { title: '净实收', key: 'net', align: 'right', render: (_, row) => <><div>{yuanFromCent(row.metrics.net_income_cent)}</div>{compareHistorical && <PeriodComparisonRate comparison={displayComparison(row.comparison.net_income_cent, 'money')} displayMode={displayMode} format="money" />}</> },
    { title: '客单价', key: 'aov', align: 'right', render: (_, row) => <><div>{yuanFromCent(row.metrics.avg_order_value_cent)}</div>{compareHistorical && <PeriodComparisonRate comparison={displayComparison(row.comparison.avg_order_value_cent, 'money')} displayMode={displayMode} format="money" />}</> },
    { title: '退款率', key: 'rate', align: 'right', render: (_, row) => <><div>{(row.metrics.refund_rate * 100).toFixed(2)}%</div>{compareHistorical && <PeriodComparisonRate comparison={row.comparison.refund_rate} displayMode={displayMode} format="percentagePoint" />}</> },
  ];
  const metricColumns = baseMetricColumns.slice(1);
  const columns: TableColumnsType<OrderStorePeriodRow> = secondaryDimension === 'none'
    ? baseMetricColumns
    : [baseMetricColumns[0], ...metricColumns.map(column => ({
        title: column.title,
        key: column.key,
        children: activeBreakdowns.map(item => ({
          title: item.label,
          key: `${String(column.key)}:${item.key}`,
          align: 'right' as const,
          render: (_: unknown, row: OrderStorePeriodRow) => {
            const breakdownRow = breakdownPeriodRows[item.key]?.get(row.key);
            return breakdownRow && typeof column.render === 'function'
              ? column.render(undefined, breakdownRow, 0)
              : '—';
          },
        })),
      }))];
  const exportHeaders = secondaryDimension === 'none'
    ? ['周期', '订单数', '营业额', '实收', '退款', '净实收', '客单价', '退款率']
    : ['周期', ...['订单数', '营业额', '实收', '退款', '净实收', '客单价', '退款率']
        .flatMap(metric => activeBreakdowns.map(item => `${metric}/${item.label}`))];
  const exportRowCells = (row: OrderStorePeriodRow) => [
    comparisonCell(row.metrics.order_count, row.comparison.order_count, 'integer'),
    comparisonCell((row.metrics.paid_amount_cent / 100).toFixed(2), row.comparison.paid_amount_cent, 'money'),
    comparisonCell((row.metrics.income_amount_cent / 100).toFixed(2), row.comparison.income_amount_cent, 'money'),
    comparisonCell((row.metrics.refund_amount_cent / 100).toFixed(2), row.comparison.refund_amount_cent, 'money'),
    comparisonCell((row.metrics.net_income_cent / 100).toFixed(2), row.comparison.net_income_cent, 'money'),
    comparisonCell((row.metrics.avg_order_value_cent / 100).toFixed(2), row.comparison.avg_order_value_cent, 'money'),
    comparisonCell(`${(row.metrics.refund_rate * 100).toFixed(2)}%`, row.comparison.refund_rate, 'percentagePoint'),
  ];
  const exportTables = [{
    title: `${store?.storeLabel || ''}逐周期明细`,
    headers: exportHeaders,
    rows: detailRows.map(row => secondaryDimension === 'none'
      ? [row.label, ...exportRowCells(row)]
      : [row.label, ...[0, 1, 2, 3, 4, 5, 6].flatMap(metricIndex => activeBreakdowns.map(item => {
          const breakdownRow = breakdownPeriodRows[item.key]?.get(row.key);
          return breakdownRow ? exportRowCells(breakdownRow)[metricIndex] : '—';
        }))]),
  }];

  const changeGranularity = (next: TrendGranularity) => {
    const range = defaultTrendRange(next, today, true);
    setGranularity(next);
    setDateFrom(range.dateFrom);
    setDateTo(range.dateTo);
    setIncludeCurrent(range.includeCurrent);
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      destroyOnHidden={false}
      width={isMobile ? '100%' : 1180}
      title={permissionDenied ? '订单趋势' : `${store?.storeLabel || ''}订单趋势`}
      styles={{ body: { maxHeight: isMobile ? 'calc(100vh - 90px)' : '78vh', overflowY: 'auto' } }}
    >
      {permissionDenied ? <div role="alert">暂无权限查看经营数据</div> : <div className="space-y-4">
        {dateTo >= today && <p className="text-xs text-slate-500">今日数据为实时暂估，暂不与完整历史周期比较</p>}
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 p-3">
          <TrendPeriodControls
            allowToday
            granularity={granularity}
            dateFrom={dateFrom}
            dateTo={dateTo}
            includeCurrent={includeCurrent}
            onGranularityChange={changeGranularity}
            onRangeChange={(from, to) => { setDateFrom(from); setDateTo(to); }}
            onIncludeCurrentChange={setIncludeCurrent}
            todayYmd={today}
          />
          <ComparisonModeSelect ariaLabel="单店对比方式" value={comparisonMode} onChange={setComparisonMode} />
          <ComparisonDisplaySelect ariaLabel="单店对比展示" value={displayMode} onChange={setDisplayMode} disabled={comparisonMode === 'none'} />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <PeriodMetricCard
            label="区间净实收"
            value={hasSummaryData ? yuanFromCent(totalNetIncome) : '—'}
            comparison={compareHistorical ? displayComparison(rangeComparison.net_income_cent, 'money') : undefined}
            displayMode={displayMode}
          />
          <PeriodMetricCard label="最近周期净实收" value={hasSummaryData && latest ? yuanFromCent(latest.metrics.net_income_cent) : '—'} comparison={compareHistorical && latest ? displayComparison(latest.comparison.net_income_cent, 'money') : undefined} displayMode={displayMode} />
          <PeriodMetricCard label="最近周期订单数" value={hasSummaryData && latest ? String(latest.metrics.order_count) : '—'} comparison={compareHistorical ? latest?.comparison.order_count : undefined} displayMode={displayMode} format="integer" />
        </div>
        <Segmented
          aria-label="单店详情视图"
          value={view}
          onChange={value => setView(value as ViewMode)}
          options={[{ value: 'chart', label: '趋势图' }, { value: 'detail', label: '详细数据' }]}
        />
        {view === 'chart' ? (
          <OrderStoreTrendChart series={chartSeries} storeLabel={store?.storeLabel || ''} granularity={granularity} />
        ) : (
          <TableDisplayFrame
            title="逐周期明细"
            filename={`${store?.storeLabel || '门店'}-${granularity}-${dateFrom}-${dateTo}`}
            exportTables={exportTables}
            className="rounded-lg border border-slate-200"
          >
            <Table bordered columns={columns} dataSource={detailRows} rowKey="key" pagination={false} size="small" scroll={{ x: 'max-content' }} />
          </TableDisplayFrame>
        )}
      </div>}
    </Modal>
  );
}
