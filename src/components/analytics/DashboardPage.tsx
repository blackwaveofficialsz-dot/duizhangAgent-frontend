import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePolling } from "../../hooks/usePolling";
import { formatBeijingTime } from "../../utils/time";
import { addMoney, sumMoney } from "../../utils/money";
import {
  Alert as AntAlert,
  Button as AntButton,
  Segmented,
  Select,
} from "antd";
import { Button as MobileButton, Selector } from "antd-mobile";
import { init, use, type ECharts, type EChartsCoreOption } from "echarts/core";
import { LineChart } from "echarts/charts";
import {
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import {
  getMealPeriodTurnover,
  getMealPeriodTrend,
  getMealPeriods,
  getRevenueTrend,
  listStoreScopeTree,
  type MealPeriodRow,
  type MealPeriodKey,
  type MealPeriodTurnoverPoint,
  type MealPeriodTurnoverResult,
  type MealPeriodTurnoverRow,
  type MealPeriodTrendPoint,
  type RevenueTrendPoint,
  type RevenueTrendResult,
} from "../../api/analytics";
import {
  fetchOperationsOverview,
  type ComparisonMode,
  type OperationsOverview,
} from "../../features/operations-analysis/api/client";
import { getMealDailyFacts, getOrderDailyFacts } from "../../api/analyticsDailyFacts";
import type { DailyFactRecord, OrderDailyFact } from "../../api/analyticsDailyTypes";
import { openChartFullscreenOnMobile } from "./ChartFullscreen";
import { ChartDownloadMenu } from "./ChartDownloadMenu";
import { DetailPeriodSelect } from "./DetailPeriodSelect";
import {
  ComparisonDisplaySelect,
  ComparisonModeSelect,
  ComparisonPeriodNote,
  PeriodMetricCard,
  type ComparisonDisplayMode,
} from "./PeriodComparison";
import { completenessIsReady, completenessStatus } from "./completeness";
import { MovingAverageStatus } from "./MovingAverageStatus";
import { StoreScopePicker } from "./StoreScopePicker";
import { TrendPeriodControls } from "./TrendPeriodControls";
import {
  buildRevenueStoreSourceSeries,
  buildRevenueStoreSeries,
  selectRevenueStorePoints,
  trendPrimaryValues,
} from "./multiStoreSeries";
import {
  resolveStoreScopeSelection,
  type ExplicitStoreScope,
  type StoreScopeNode,
} from "./storeScope";
import {
  MEAL_PERIOD_SERIES,
  buildMealScopeTrendSeries,
  buildMealTurnoverScopeTrendSeries,
  buildScopeTrendSeries,
  selectMealStorePoints,
  selectMealTurnover,
} from "./scopeTrendSeries";
import {
  buildRevenueSeries,
  filterOrderFactsByStores,
  groupDailyFacts,
  movingAverage,
} from "./dailyFactSelectors";
import {
  buildDetailPeriodOptions,
  defaultTrendRange,
  trendHistoryStart,
  trendPointStatusText,
  type TrendGranularity,
  type TrendMovingAverageMeta,
} from "./trendPeriod";

export { trendPointStatusText } from "./trendPeriod";

use([
  LineChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  DataZoomComponent,
  SVGRenderer,
]);

const yuan = (n: number) =>
  `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const compactYuan = (value: number | null | undefined) => {
  const n = Number.isFinite(Number(value)) ? Number(value) : 0;
  return Math.abs(n) >= 10000 ? `¥${(n / 10000).toFixed(1)}万` : yuan(n);
};
const searchableSelectProps = { showSearch: true, optionFilterProp: "label" };

function beijingTodayYmd(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function useEChart(
  option: EChartsCoreOption,
  onClick?: (params: unknown) => void,
  sharedLegendSelectionRef?: LegendSelectionRef,
) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const localLegendSelectionRef = useRef<LegendSelection>();
  const legendSelectionRef =
    sharedLegendSelectionRef || localLegendSelectionRef;

  useEffect(() => {
    if (!ref.current) return;
    if (import.meta.env.MODE === "test") return;
    if (
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("jsdom")
    )
      return;
    const container = ref.current;
    chartRef.current = init(container, undefined, { renderer: "svg" });
    const handleLegendSelectionChange = (event: unknown) => {
      rememberLegendSelection(legendSelectionRef, event);
    };
    chartRef.current.on("legendselectchanged", handleLegendSelectionChange);
    const resize = () => {
      const chart = chartRef.current;
      if (chart && !chart.isDisposed()) chart.resize();
    };
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(container);
    window.addEventListener("resize", resize);
    requestAnimationFrame(resize);
    const firstResize = window.setTimeout(resize, 80);
    const secondResize = window.setTimeout(resize, 300);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", resize);
      window.clearTimeout(firstResize);
      window.clearTimeout(secondResize);
      chartRef.current?.off("legendselectchanged", handleLegendSelectionChange);
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart && !chart.isDisposed()) {
      const selected = legendSelectionRef.current || getLegendSelection(chart);
      if (selected) legendSelectionRef.current = selected;
      chart.setOption(preserveLegendSelection(option, selected), {
        notMerge: false,
        replaceMerge: ["series"],
      });
      chart.resize();
    }
  }, [option]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !onClick) return;
    chart.on("click", onClick);
    return () => {
      if (!chart.isDisposed()) chart.off("click", onClick);
    };
  }, [onClick]);

  return { ref, chartRef };
}

type LegendSelection = Record<string, boolean>;
type LegendSelectionRef = { current: LegendSelection | undefined };

function getLegendSelection(chart: ECharts): LegendSelection | undefined {
  return legendSelectionFromOption(chart.getOption?.());
}

export function legendSelectionFromOption(option: unknown): LegendSelection | undefined {
  if (!option || typeof option !== "object") return undefined;
  const legend = (option as { legend?: unknown }).legend;
  const legends = Array.isArray(legend) ? legend : [legend];
  for (const item of legends) {
    if (!item || typeof item !== "object") continue;
    const selected = (item as { selected?: LegendSelection }).selected;
    if (selected && Object.keys(selected).length > 0) return selected;
  }
  return undefined;
}

export function legendSelectionFromEvent(event: unknown): LegendSelection | undefined {
  if (!event || typeof event !== "object") return undefined;
  const selected = (event as { selected?: unknown }).selected;
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    return undefined;
  }
  const entries = Object.entries(selected).filter(
    (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
  );
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function rememberLegendSelection(
  ref: LegendSelectionRef,
  event: unknown,
): void {
  const selected = legendSelectionFromEvent(event);
  if (selected) ref.current = selected;
}

export function preserveLegendSelection(
  option: EChartsCoreOption,
  selected?: LegendSelection,
): EChartsCoreOption {
  if (!selected) return option;
  const base = option as Record<string, unknown>;
  const legend = base.legend;
  if (Array.isArray(legend)) {
    return {
      ...base,
      legend: legend.map((item, index) =>
        index === 0 && item && typeof item === "object"
          ? { ...(item as Record<string, unknown>), selected }
          : item,
      ),
    } as EChartsCoreOption;
  }
  return {
    ...base,
    legend: {
      ...((legend && typeof legend === "object" ? legend : {}) as Record<string, unknown>),
      selected,
    },
  } as EChartsCoreOption;
}

function escapeTooltipHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function formatRevenueTrendTooltip(
  params: unknown,
  periods: string[],
  statusPoints: RevenueTrendPoint[],
): string {
  const rows = (Array.isArray(params) ? params : [params]).filter(
    (item): item is Record<string, unknown> => Boolean(item && typeof item === "object"),
  );
  const dataIndex = Number(rows[0]?.dataIndex);
  const period = periods[dataIndex] || "";
  const status = trendPointStatusText(
    statusPoints.find(point => point.period === period && (point.in_progress || point.missing)),
  );
  return [
    escapeTooltipHtml(period),
    status,
    ...rows.map(row => {
      const value = row.value;
      return `${String(row.marker || "")}${escapeTooltipHtml(row.seriesName)}: ${
        value == null ? "-" : compactYuan(Number(value || 0))
      }`;
    }),
  ].filter(Boolean).join("<br/>");
}

export function buildRevenueMovingAverageSeries(
  rows: RevenueTrendPoint[],
  periods: string[],
  movingAverages: TrendMovingAverageMeta[],
  prefix = "",
) {
  const byPeriod = new Map(rows.map(point => [point.period, point]));
  return movingAverages.filter(item => item.available).map(item => ({
    name: `${prefix}${item.label}`,
    type: "line",
    smooth: true,
    symbol: "none",
    lineStyle: { type: "dashed", width: 1 },
    data: periods.map(period => {
      const point = byPeriod.get(period);
      const value = point?.[item.field];
      return point && !point.missing && typeof value === "number" ? value : null;
    }),
  }));
}

export function mergeTrendPoints(
  left: RevenueTrendPoint[],
  right: RevenueTrendPoint[],
): RevenueTrendPoint[] {
  const byPeriod = new Map<string, RevenueTrendPoint>();
  for (const point of [...left, ...right]) {
    const current = byPeriod.get(point.period);
    byPeriod.set(point.period, {
      period: point.period,
      net_income:
        addMoney(current?.net_income, point.net_income),
      order_count:
        (current?.order_count || 0) + point.order_count,
      ma7: null,
      ma30: null,
      ma180: null,
      missing: Boolean(current?.missing) || point.missing,
      ...(current?.in_progress || point.in_progress ? { in_progress: true } : {}),
    });
  }
  return [...byPeriod.values()].sort((a, b) =>
    a.period.localeCompare(b.period),
  );
}

export function summarizeRevenueTrend(points: RevenueTrendPoint[]) {
  return {
    total: sumMoney(points.map(point => point.net_income)),
    lastPoint: points[points.length - 1],
  };
}

function ChannelMetricGroup({
  label,
  scopeLabel,
  row,
  comparisonEnabled,
  comparisonDisplayMode,
  accentClass,
}: {
  label: string;
  scopeLabel: string;
  row?: OperationsOverview['channels'][number];
  comparisonEnabled: boolean;
  comparisonDisplayMode: ComparisonDisplayMode;
  accentClass: string;
}) {
  const metric = (key: string) => row?.metrics[key];
  const paidAmount = metric('paid_amount')?.current;
  const netIncome = metric('net_income')?.current;
  const orderCount = metric('order_count')?.current;
  const avgOrderValue = metric('avg_order_value')?.current;
  const comparison = (key: string) => comparisonEnabled ? metric(key) : undefined;

  return (
    <section
      aria-label={`${label}经营统计`}
      className={`min-w-0 border-l-2 pl-3 ${accentClass}`}
    >
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">{label}</h3>
        <span className="truncate text-[11px] text-slate-400">{scopeLabel}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <PeriodMetricCard
          label="营业额"
          value={paidAmount == null ? '—' : compactYuan(paidAmount)}
          comparison={comparison('paid_amount')}
          displayMode={comparisonDisplayMode}
        />
        <PeriodMetricCard
          label="净实收"
          value={netIncome == null ? '—' : compactYuan(netIncome)}
          comparison={comparison('net_income')}
          displayMode={comparisonDisplayMode}
        />
        <PeriodMetricCard
          label="订单数"
          value={orderCount == null ? '—' : Number(orderCount).toLocaleString('zh-CN')}
          comparison={comparison('order_count')}
          format="integer"
          displayMode={comparisonDisplayMode}
        />
        <PeriodMetricCard
          label="客单价"
          value={avgOrderValue == null ? '—' : yuan(avgOrderValue)}
          comparison={comparison('avg_order_value')}
          displayMode={comparisonDisplayMode}
        />
      </div>
    </section>
  );
}

function ChartFullscreenLayer({
  title,
  subtitle,
  controls,
  children,
  showRotateHint,
  onClose,
}: {
  title: string;
  subtitle: string;
  controls: ReactNode;
  children: ReactNode;
  showRotateHint: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const previousRootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.style.overflow = previousRootOverflow;
    };
  }, []);

  return (
    <div
      className="chart-fullscreen-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="chart-fullscreen-shell">
        <div className="chart-fullscreen-header flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-white/95 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-slate-900">
              {title}
            </div>
            <div className="truncate text-[11px] text-slate-500">
              {subtitle}
            </div>
          </div>
          <div className="relative flex shrink-0 items-center gap-1.5">
            {controls}
            <MobileButton size="mini" fill="outline" onClick={onClose}>
              退出
            </MobileButton>
          </div>
        </div>
        <div className="chart-fullscreen-content min-h-0 flex-1 bg-white p-2">
          {children}
        </div>
      </div>
      {showRotateHint ? (
        <div className="chart-fullscreen-rotate-hint">
          请将手机横屏查看完整图表
        </div>
      ) : null}
    </div>
  );
}

function FullscreenFilterButton({
  label,
  expanded,
  onClick,
}: {
  label: string;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="chart-fullscreen-filter-button"
      onClick={onClick}
      aria-expanded={expanded}
    >
      <svg
        className="h-3.5 w-3.5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path strokeLinecap="round" d="M4 6h16M7 12h10M10 18h4" />
      </svg>
      <span>{label}</span>
    </button>
  );
}

function FullscreenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      className="absolute right-2 top-2 z-10 flex h-9 min-w-9 items-center justify-center rounded-full border border-slate-200 bg-white/90 px-2 text-xs font-medium text-slate-600 shadow-sm backdrop-blur active:bg-slate-100 md:hidden"
      aria-label="全屏横屏查看图表"
      title="全屏"
      onClick={onClick}
    >
      <svg
        className="h-4 w-4"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"
        />
      </svg>
    </button>
  );
}

type TrendMainChartProps = {
  points: RevenueTrendPoint[];
  compare?: { shop: RevenueTrendPoint[]; takeout: RevenueTrendPoint[] };
  storeTrends?: Record<string, RevenueTrendPoint[]>;
  storeSourceTrends?: {
    shop: Record<string, RevenueTrendPoint[]>;
    takeout: Record<string, RevenueTrendPoint[]>;
  };
  movingAverages?: TrendMovingAverageMeta[];
  sourceMovingAverages?: {
    shop: TrendMovingAverageMeta[];
    takeout: TrendMovingAverageMeta[];
  };
  storeLabels?: Record<string, string>;
  primarySeriesName?: string;
  downloadTitle?: string;
  dateFrom?: string;
  dateTo?: string;
  fullscreen?: boolean;
  onFullscreen?: () => void;
  legendSelectionRef?: LegendSelectionRef;
};

export function sameTrendMainChartProps(
  previous: TrendMainChartProps,
  next: TrendMainChartProps,
): boolean {
  if (
    previous.primarySeriesName !== next.primarySeriesName ||
    previous.downloadTitle !== next.downloadTitle ||
    previous.dateFrom !== next.dateFrom ||
    previous.dateTo !== next.dateTo ||
    previous.fullscreen !== next.fullscreen ||
    Boolean(previous.onFullscreen) !== Boolean(next.onFullscreen) ||
    previous.legendSelectionRef !== next.legendSelectionRef
  ) return false;

  if (previous.storeSourceTrends || next.storeSourceTrends) {
    return previous.storeSourceTrends?.shop === next.storeSourceTrends?.shop &&
      previous.storeSourceTrends?.takeout === next.storeSourceTrends?.takeout &&
      previous.storeLabels === next.storeLabels;
  }
  if (previous.storeTrends || next.storeTrends) {
    return previous.storeTrends === next.storeTrends &&
      previous.storeLabels === next.storeLabels;
  }
  if (previous.compare || next.compare) {
    return previous.compare?.shop === next.compare?.shop &&
      previous.compare?.takeout === next.compare?.takeout &&
      previous.sourceMovingAverages?.shop === next.sourceMovingAverages?.shop &&
      previous.sourceMovingAverages?.takeout === next.sourceMovingAverages?.takeout;
  }
  return previous.points === next.points &&
    previous.movingAverages === next.movingAverages;
}

const TrendMainChart = memo(function TrendMainChart({
  points,
  compare,
  storeTrends,
  storeSourceTrends,
  movingAverages = [],
  sourceMovingAverages,
  storeLabels = {},
  primarySeriesName = "净实收",
  downloadTitle,
  dateFrom,
  dateTo,
  fullscreen = false,
  onFullscreen,
  legendSelectionRef,
}: TrendMainChartProps) {
  const sourceStoreKeys = new Set([
    ...Object.keys(storeSourceTrends?.shop || {}),
    ...Object.keys(storeSourceTrends?.takeout || {}),
  ]);
  const compareStores = Object.keys(storeTrends || {}).length > 1 || sourceStoreKeys.size > 1;
  const periods = useMemo(() => {
    if (storeSourceTrends) {
      return [...new Set([
        ...Object.values(storeSourceTrends.shop).flatMap(rows => rows.map(point => point.period)),
        ...Object.values(storeSourceTrends.takeout).flatMap(rows => rows.map(point => point.period)),
      ])].sort();
    }
    if (!compare) return points.map((p) => p.period);
    return [
      ...new Set(
        [...compare.shop, ...compare.takeout].map((point) => point.period),
      ),
    ].sort();
  }, [compare, points, storeSourceTrends]);
  const seriesData = (
    rows: RevenueTrendPoint[],
    field = "net_income",
  ) => {
    const byPeriod = new Map(rows.map((point) => [point.period, point]));
    return periods.map((period) => {
      const point = byPeriod.get(period);
      const value = point?.[field];
      return point && typeof value === "number" ? value : null;
    });
  };
  const statusPoints = [
    ...points,
    ...(compare?.shop || []),
    ...(compare?.takeout || []),
    ...Object.values(storeTrends || {}).flat(),
    ...Object.values(storeSourceTrends?.shop || {}).flat(),
    ...Object.values(storeSourceTrends?.takeout || {}).flat(),
  ];
  const option = useMemo<EChartsCoreOption>(
    () => ({
      color: compare || compareStores
        ? [
            "#0f8bbd",
            "#f59e0b",
            "rgba(15,139,189,0.82)",
            "rgba(15,139,189,0.70)",
            "rgba(15,139,189,0.58)",
            "rgba(245,158,11,0.82)",
            "rgba(245,158,11,0.70)",
            "rgba(245,158,11,0.58)",
          ]
        : ["#0f8bbd", "#10b981", "#f59e0b", "#64748b"],
      tooltip: {
        trigger: "axis",
        appendToBody: !fullscreen,
        confine: true,
        formatter: (params: unknown) =>
          formatRevenueTrendTooltip(params, periods, statusPoints),
      },
      legend: {
        top: 0,
        right: fullscreen ? 44 : 84,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: "#64748b", fontSize: 11 },
      },
      grid: { top: compare || compareStores ? 62 : 38, left: 64, right: 24, bottom: 52 },
      dataZoom: [{ type: "inside" }],
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: periods.map((period) => period.slice(5)),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisLabel: { color: "#94a3b8", fontSize: 11 },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: "#94a3b8",
          fontSize: 11,
          formatter: (value: unknown) => compactYuan(Number(value || 0)),
        },
        splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
      },
      series: storeSourceTrends
        ? buildRevenueStoreSourceSeries(
            storeSourceTrends.shop,
            storeSourceTrends.takeout,
            storeLabels,
          )
        : compareStores
        ? buildRevenueStoreSeries(storeTrends || {}, storeLabels)
        : compare
        ? [
            {
              name: "堂食",
              type: "line",
              smooth: true,
              symbolSize: 5,
              data: seriesData(compare.shop),
            },
            {
              name: "外卖",
              type: "line",
              smooth: true,
              symbolSize: 5,
              data: seriesData(compare.takeout),
            },
            ...buildRevenueMovingAverageSeries(
              compare.shop,
              periods,
              sourceMovingAverages?.shop || [],
              "堂食 ",
            ),
            ...buildRevenueMovingAverageSeries(
              compare.takeout,
              periods,
              sourceMovingAverages?.takeout || [],
              "外卖 ",
            ),
          ]
        : [
            {
              name: primarySeriesName,
              type: "line",
              smooth: true,
              symbolSize: 5,
              data: trendPrimaryValues(points, "net_income"),
            },
            ...buildRevenueMovingAverageSeries(points, periods, movingAverages),
          ],
    }),
    [compare, compareStores, fullscreen, movingAverages, periods, points, primarySeriesName, sourceMovingAverages, storeLabels, storeSourceTrends, storeTrends],
  );
  const { ref, chartRef } = useEChart(
    option,
    undefined,
    legendSelectionRef,
  );
  const chartTitle = downloadTitle || `${primarySeriesName}趋势`;
  return (
    <div className={`relative ${fullscreen ? "h-full min-h-0" : ""}`}>
      {!fullscreen && onFullscreen ? (
        <FullscreenButton onClick={onFullscreen} />
      ) : null}
      <ChartDownloadMenu
        chartRef={chartRef}
        title={chartTitle}
        dateFrom={dateFrom || points[0]?.period}
        dateTo={dateTo || points[points.length - 1]?.period}
        className={`absolute top-2 z-10 bg-white/90 shadow-sm ${fullscreen ? "right-2" : "right-12"}`}
      />
      <div
        ref={ref}
        onDoubleClick={() => openChartFullscreenOnMobile(onFullscreen)}
        className={`${fullscreen ? "h-full min-h-[15rem]" : "h-[18rem] md:h-[22rem]"} w-full rounded-lg bg-slate-50`}
        role="img"
        aria-label={compare || storeSourceTrends
          ? "堂食和外卖净实收趋势对比图"
          : primarySeriesName === "净实收"
            ? "净实收趋势主图"
            : `${primarySeriesName}净实收趋势图`}
      />
    </div>
  );
}, sameTrendMainChartProps);

type TrendMode = "all" | "source_compare";
type MealMetricMode = "business" | "turnover";
type RevenueDisplaySnapshot = {
  trendMode: TrendMode;
  granularity: TrendGranularity;
  includeCurrent: boolean;
  dateFrom: string;
  dateTo: string;
  scopeKeys: string[];
  scopes: ExplicitStoreScope[];
  shopKeys: string[];
  compareStores: boolean;
  storeLabel: string;
  emptyScope: boolean;
  trendPoints: RevenueTrendPoint[];
  movingAverages: TrendMovingAverageMeta[];
  storeTrends: Record<string, RevenueTrendPoint[]>;
  shopTrendPoints: RevenueTrendPoint[];
  shopMovingAverages: TrendMovingAverageMeta[];
  shopStoreTrends: Record<string, RevenueTrendPoint[]>;
  takeoutTrendPoints: RevenueTrendPoint[];
  takeoutMovingAverages: TrendMovingAverageMeta[];
  takeoutStoreTrends: Record<string, RevenueTrendPoint[]>;
};

type OrderDailyFactMode = "loading" | "ready" | "fallback";
type MealDailyFactMode = "loading" | "ready" | "fallback";

type MealDailyPeriodFact = {
  period_key: MealPeriodKey;
  period_label?: string;
  order_count?: number;
  paid_amount_cent?: number;
  income_amount_cent?: number;
  refund_amount_cent?: number;
  net_income_cent?: number;
  shop_order_count?: number;
};

type MealDailyStoreFact = {
  store_key: string;
  store_label?: string | null;
  table_count?: number | null;
  table_count_status?: string;
  periods?: Partial<Record<MealPeriodKey, MealDailyPeriodFact>>;
};

type MealDailyFact = {
  date: string;
  data_status?: string;
  complete?: boolean;
  stores?: Record<string, MealDailyStoreFact>;
};

function dashboardOrderFactFromRecord(record: DailyFactRecord<OrderDailyFact>): OrderDailyFact {
  const completeness = record.completeness || {};
  const status = completenessStatus(completeness, record.payload.data_status);
  return {
    ...record.payload,
    date: record.date,
    data_status: status,
    complete: completenessIsReady(completeness, status),
  };
}

function dashboardMealFactFromRecord(record: DailyFactRecord<MealDailyFact>): MealDailyFact {
  const completeness = record.completeness || {};
  const status = completenessStatus(completeness, record.payload.data_status);
  return {
    ...record.payload,
    date: record.date,
    data_status: status,
    complete: completenessIsReady(completeness, status),
  };
}

function centsToYuan(value: number | null | undefined): number {
  return Number((Number(value || 0) / 100).toFixed(2));
}

function orderSeriesPointToRevenue(point: ReturnType<typeof buildRevenueSeries>[number]): RevenueTrendPoint {
  const converted: RevenueTrendPoint = {
    period: point.period,
    period_start: point.date_from,
    period_end: point.date_to,
    net_income: centsToYuan(point.net_income_cent),
    order_count: Number(point.order_count || 0),
    missing: Boolean(point.missing),
    ...(point.in_progress ? { in_progress: true } : {}),
  };
  (["ma3", "ma4", "ma6", "ma7", "ma12", "ma26", "ma30", "ma180"] as const).forEach((field) => {
    if (typeof point[field] === "number") converted[field] = centsToYuan(point[field]);
    else if (point[field] === null) converted[field] = null;
  });
  return converted;
}

function revenueMovingAverageMeta(
  points: RevenueTrendPoint[],
  granularity: TrendGranularity,
): TrendMovingAverageMeta[] {
  const windows = granularity === "week"
    ? [4, 12, 26]
    : granularity === "month"
      ? [3, 6, 12]
      : [7, 30, 180];
  const availablePeriods = points.filter(point => !point.missing && !point.in_progress && typeof point.net_income === "number").length;
  return windows.map(window => {
    const field = `ma${window}`;
    return {
      field,
      label: field.toUpperCase(),
      window,
      available: points.some(point => typeof point[field] === "number"),
      available_periods: availablePeriods,
    };
  });
}

function revenuePointsFromOrderFacts(
  facts: OrderDailyFact[],
  granularity: TrendGranularity,
  includeCurrent: boolean,
  storeKeys: string[],
  dateFrom: string,
  dateTo: string,
  sourceTypes?: string[],
): RevenueTrendPoint[] {
  const filtered = filterOrderFactsByStores(facts, { storeKeys, sourceTypes });
  const historyFrom = trendHistoryStart(granularity, dateFrom);
  return buildRevenueSeries(filtered, granularity, includeCurrent, historyFrom, dateTo)
    .filter(point => point.date_to >= dateFrom && point.date_from <= dateTo)
    .map(orderSeriesPointToRevenue);
}

function revenueStoreTrendsFromOrderFacts(
  facts: OrderDailyFact[],
  granularity: TrendGranularity,
  includeCurrent: boolean,
  storeKeys: string[],
  dateFrom: string,
  dateTo: string,
  sourceTypes?: string[],
): Record<string, RevenueTrendPoint[]> {
  return Object.fromEntries(storeKeys.map(key => [
    key,
    revenuePointsFromOrderFacts(facts, granularity, includeCurrent, [key], dateFrom, dateTo, sourceTypes),
  ]));
}

function revenueDisplayFromOrderFacts({
  facts,
  trendMode,
  granularity,
  includeCurrent,
  dateFrom,
  dateTo,
  scopeKeys,
  scopes,
  shopKeys,
  compareStores,
  storeLabel,
}: {
  facts: OrderDailyFact[];
  trendMode: TrendMode;
  granularity: TrendGranularity;
  includeCurrent: boolean;
  dateFrom: string;
  dateTo: string;
  scopeKeys: string[];
  scopes: ExplicitStoreScope[];
  shopKeys: string[];
  compareStores: boolean;
  storeLabel: string;
}): RevenueDisplaySnapshot {
  const selectedStoreKeys = scopeKeys.includes("ALL") ? [] : shopKeys;
  const storeTrendKeys = scopes.length > 1 || compareStores ? shopKeys : [];
  const trendPoints = revenuePointsFromOrderFacts(facts, granularity, includeCurrent, selectedStoreKeys, dateFrom, dateTo);
  const shopTrendPoints = revenuePointsFromOrderFacts(facts, granularity, includeCurrent, selectedStoreKeys, dateFrom, dateTo, ["shop"]);
  const takeoutTrendPoints = revenuePointsFromOrderFacts(facts, granularity, includeCurrent, selectedStoreKeys, dateFrom, dateTo, ["takeout"]);
  return {
    trendMode,
    granularity,
    includeCurrent,
    dateFrom,
    dateTo,
    scopeKeys: [...scopeKeys],
    scopes: [...scopes],
    shopKeys: [...shopKeys],
    compareStores,
    storeLabel,
    emptyScope: false,
    trendPoints,
    movingAverages: revenueMovingAverageMeta(trendPoints, granularity),
    storeTrends: revenueStoreTrendsFromOrderFacts(facts, granularity, includeCurrent, storeTrendKeys, dateFrom, dateTo),
    shopTrendPoints,
    shopMovingAverages: revenueMovingAverageMeta(shopTrendPoints, granularity),
    shopStoreTrends: revenueStoreTrendsFromOrderFacts(facts, granularity, includeCurrent, storeTrendKeys, dateFrom, dateTo, ["shop"]),
    takeoutTrendPoints,
    takeoutMovingAverages: revenueMovingAverageMeta(takeoutTrendPoints, granularity),
    takeoutStoreTrends: revenueStoreTrendsFromOrderFacts(facts, granularity, includeCurrent, storeTrendKeys, dateFrom, dateTo, ["takeout"]),
  };
}

function emptyMealRow(periodKey: MealPeriodKey, periodLabel: string): MealPeriodRow {
  return {
    period_key: periodKey,
    period_label: periodLabel,
    order_count: 0,
    paid_amount: 0,
    income_amount: 0,
    refund_amount: 0,
    net_income: 0,
    avg_order_value: 0,
  };
}

function mealRowFromPeriod(periodKey: MealPeriodKey, periodLabel: string, period?: MealDailyPeriodFact): MealPeriodRow {
  const orderCount = Number(period?.order_count || 0);
  const paidAmount = centsToYuan(period?.paid_amount_cent);
  const incomeAmount = centsToYuan(period?.income_amount_cent);
  const refundAmount = centsToYuan(period?.refund_amount_cent);
  return {
    period_key: periodKey,
    period_label: period?.period_label || periodLabel,
    order_count: orderCount,
    paid_amount: paidAmount,
    income_amount: incomeAmount,
    refund_amount: refundAmount,
    net_income: centsToYuan(period?.net_income_cent ?? period?.income_amount_cent),
    avg_order_value: orderCount ? Number((paidAmount / orderCount).toFixed(2)) : 0,
  };
}

function aggregateMealRows(stores: MealDailyStoreFact[]): Record<MealPeriodKey, MealPeriodRow> {
  return Object.fromEntries(MEAL_PERIOD_SERIES.map(([periodKey, periodLabel]) => {
    const row = stores.reduce((sum, store) => {
      const current = mealRowFromPeriod(periodKey, periodLabel, store.periods?.[periodKey]);
      return {
        ...sum,
        order_count: sum.order_count + current.order_count,
        paid_amount: addMoney(sum.paid_amount, current.paid_amount),
        income_amount: addMoney(sum.income_amount, current.income_amount),
        refund_amount: addMoney(sum.refund_amount, current.refund_amount),
        net_income: addMoney(sum.net_income, current.net_income),
      };
    }, emptyMealRow(periodKey, periodLabel));
    row.avg_order_value = row.order_count ? Number((row.paid_amount / row.order_count).toFixed(2)) : 0;
    return [periodKey, row];
  })) as Record<MealPeriodKey, MealPeriodRow>;
}

function selectedMealStores(fact: MealDailyFact, storeKeys: string[]): MealDailyStoreFact[] {
  const stores = Object.values(fact.stores || {});
  if (storeKeys.length === 0) return stores;
  const selected = new Set(storeKeys);
  return stores.filter(store => selected.has(String(store.store_key)));
}

const mealMovingAverageFields = (granularity: TrendGranularity) => granularity === 'week'
  ? [['ma4', 4], ['ma12', 12], ['ma26', 26]] as const
  : granularity === 'month'
    ? [['ma3', 3], ['ma6', 6], ['ma12', 12]] as const
    : [['ma7', 7], ['ma30', 30], ['ma180', 180]] as const;

export function mealTrendPointsFromFacts(
  facts: MealDailyFact[],
  storeKeys: string[],
  granularity: TrendGranularity = 'day',
  includeCurrent = true,
  expectedDateFrom?: string,
  expectedDateTo?: string,
  visibleDateFrom: string = expectedDateFrom || facts[0]?.date || '',
  visibleDateTo: string = expectedDateTo || facts[facts.length - 1]?.date || '',
): MealPeriodTrendPoint[] {
  const periods = groupDailyFacts(
    facts,
    granularity,
    true,
    expectedDateFrom,
    expectedDateTo,
  );
  const points = periods.map(period => ({
    date: period.key,
    period_start: period.dateFrom,
    period_end: period.dateTo,
    missing: !period.complete,
    ...(period.inProgress ? { in_progress: true } : {}),
    ...aggregateMealRows(period.facts.flatMap(fact => selectedMealStores(fact, storeKeys))),
  }) as MealPeriodTrendPoint);
  for (const [periodKey] of MEAL_PERIOD_SERIES) {
    const values = points.map((point) => point.missing || point.in_progress
      ? null
      : Math.round(Number(point[periodKey].net_income || 0) * 100));
    mealMovingAverageFields(granularity).forEach(([field, window]) => {
      const averages = movingAverage(values, window, granularity !== 'day');
      points.forEach((point, index) => {
        point[periodKey][field] = averages[index] === null
          ? null
          : Number((Number(averages[index]) / 100).toFixed(2));
      });
    });
  }
  return points.filter(point => (
    !point.missing
    && (includeCurrent || !point.in_progress)
    && String(point.period_end || point.date) >= visibleDateFrom
    && String(point.period_start || point.date) <= visibleDateTo
  ));
}

function mealStoreTrendsFromFacts(
  facts: MealDailyFact[],
  storeKeys: string[],
  granularity: TrendGranularity,
  includeCurrent: boolean,
  expectedDateFrom: string,
  expectedDateTo: string,
  visibleDateFrom: string,
  visibleDateTo: string,
): Record<string, MealPeriodTrendPoint[]> {
  return Object.fromEntries(storeKeys.map(key => [key, mealTrendPointsFromFacts(
    facts,
    [key],
    granularity,
    includeCurrent,
    expectedDateFrom,
    expectedDateTo,
    visibleDateFrom,
    visibleDateTo,
  )]));
}

type CompleteMealTurnoverPoint = MealPeriodTurnoverPoint & { complete?: boolean };

function applyTurnoverMovingAverages(
  points: CompleteMealTurnoverPoint[],
  granularity: TrendGranularity,
): CompleteMealTurnoverPoint[] {
  for (const [periodKey] of MEAL_PERIOD_SERIES) {
    const values = points.map(point => point.complete === false || point.in_progress
      ? null
      : Math.round(Number(point[periodKey].turnover || 0) * 100));
    mealMovingAverageFields(granularity).forEach(([field, window]) => {
      const averages = movingAverage(values, window, granularity !== 'day');
      points.forEach((point, index) => {
        point[periodKey][field] = averages[index] === null
          ? null
          : Number((Number(averages[index]) / 100).toFixed(2));
      });
    });
  }
  return points;
}

export function mealTurnoverFromFacts(
  facts: MealDailyFact[],
  dateFrom: string,
  dateTo: string,
  storeKeys: string[],
  storeLabels: Record<string, string>,
  granularity: TrendGranularity = 'day',
  includeCurrent = true,
  expectedDateFrom: string = dateFrom,
  expectedDateTo: string = dateTo,
): MealPeriodTurnoverResult {
  const displayFacts = facts.filter(fact => fact.date >= dateFrom && fact.date <= dateTo);
  const selectedStoreKeys = storeKeys.length
    ? storeKeys
    : [...new Set(facts.flatMap(fact => Object.keys(fact.stores || {})))].sort();
  const tableCountByStore = new Map<string, number>();
  const excluded = new Map<string, { store_key: string; store_label: string; reason: string }>();
  for (const fact of facts) {
    for (const [key, store] of Object.entries(fact.stores || {})) {
      if (!selectedStoreKeys.includes(key)) continue;
      const tables = Number(store.table_count || 0);
      if (tables > 0) tableCountByStore.set(key, tables);
      else {
        excluded.set(key, {
          store_key: key,
          store_label: store.store_label || storeLabels[key] || key,
          reason: '未配置桌数',
        });
      }
    }
  }
  const eligibleStoreKeys = selectedStoreKeys.filter(key => tableCountByStore.has(key));
  const tableCount = eligibleStoreKeys.reduce((sum, key) => sum + Number(tableCountByStore.get(key) || 0), 0);
  const eligibleFacts = facts.map(fact => ({
    date: fact.date,
    complete: fact.complete,
    stores: Object.fromEntries(Object.entries(fact.stores || {}).filter(([key]) => eligibleStoreKeys.includes(key))),
  })) as MealDailyFact[];
  const periods = groupDailyFacts(eligibleFacts, granularity, true, expectedDateFrom, expectedDateTo);
  const trendPoints = applyTurnoverMovingAverages(periods.map(period => ({
    date: period.key,
    period_start: period.dateFrom,
    period_end: period.dateTo,
    complete: period.complete,
    ...(period.inProgress ? { in_progress: true } : {}),
    ...Object.fromEntries(MEAL_PERIOD_SERIES.map(([periodKey]) => {
      const completeFacts = period.facts.filter(fact => fact.complete !== false);
      const orderCount = completeFacts.reduce((sum, fact) => sum + selectedMealStores(fact, eligibleStoreKeys).reduce((storeSum, store) => (
        storeSum + Number(store.periods?.[periodKey]?.shop_order_count ?? store.periods?.[periodKey]?.order_count ?? 0)
      ), 0), 0);
      const periodDays = Math.max(1, completeFacts.length);
      return [periodKey, {
        shop_order_count: orderCount,
        turnover: tableCount ? Number((orderCount / tableCount / periodDays).toFixed(2)) : 0,
        ma7: null,
        ma30: null,
        ma180: null,
      }];
    })),
  } as CompleteMealTurnoverPoint)), granularity).filter(point => (
    point.complete !== false
    && (includeCurrent || !point.in_progress)
    && String(point.period_end || point.date) >= dateFrom
    && String(point.period_start || point.date) <= dateTo
  ));
  const completeFacts = displayFacts.filter(fact => fact.complete !== false);
  const dayCount = Math.max(1, completeFacts.length);
  const summary = MEAL_PERIOD_SERIES.map(([periodKey, periodLabel]) => {
    const orderCount = trendPoints.reduce((sum, point) => sum + Number(point[periodKey].shop_order_count || 0), 0);
    return {
      period_key: periodKey,
      period_label: periodLabel,
      shop_order_count: orderCount,
      avg_daily_turnover: tableCount ? Number((orderCount / tableCount / dayCount).toFixed(2)) : 0,
    };
  });
  const store_trends = Object.fromEntries(eligibleStoreKeys.map(key => {
    const storeTableCount = Number(tableCountByStore.get(key) || 0);
    const storePeriods = groupDailyFacts(facts, granularity, true, expectedDateFrom, expectedDateTo);
    return [key, applyTurnoverMovingAverages(storePeriods.map(period => ({
      date: period.key,
      period_start: period.dateFrom,
      period_end: period.dateTo,
      complete: period.complete,
      ...(period.inProgress ? { in_progress: true } : {}),
      ...Object.fromEntries(MEAL_PERIOD_SERIES.map(([periodKey]) => {
        const completeFacts = period.facts.filter(fact => fact.complete !== false);
        const orderCount = completeFacts.reduce((sum, fact) => {
          const store = selectedMealStores(fact, [key])[0];
          return sum + Number(store?.periods?.[periodKey]?.shop_order_count ?? store?.periods?.[periodKey]?.order_count ?? 0);
        }, 0);
        const periodDays = Math.max(1, completeFacts.length);
        return [periodKey, {
          shop_order_count: orderCount,
          turnover: storeTableCount ? Number((orderCount / storeTableCount / periodDays).toFixed(2)) : 0,
          ma7: null,
          ma30: null,
          ma180: null,
        }];
      })),
    } as CompleteMealTurnoverPoint)), granularity).filter(point => (
      point.complete !== false
      && (includeCurrent || !point.in_progress)
      && String(point.period_end || point.date) >= dateFrom
      && String(point.period_start || point.date) <= dateTo
    ))];
  }));
  const store_summaries = eligibleStoreKeys.map(key => {
    const storeTableCount = Number(tableCountByStore.get(key) || 0);
    const storeSummary = MEAL_PERIOD_SERIES.map(([periodKey, periodLabel]) => {
      const orderCount = completeFacts.reduce((sum, fact) => {
        const store = selectedMealStores(fact, [key])[0];
        return sum + Number(store?.periods?.[periodKey]?.shop_order_count ?? store?.periods?.[periodKey]?.order_count ?? 0);
      }, 0);
      return {
        period_key: periodKey,
        period_label: periodLabel,
        shop_order_count: orderCount,
        avg_daily_turnover: storeTableCount
          ? Number((orderCount / storeTableCount / dayCount).toFixed(2))
          : 0,
      };
    });
    return {
      store_key: key,
      store_label: storeLabels[key] || key,
      table_count: storeTableCount,
      summary: storeSummary,
    };
  });
  return {
    data_status: eligibleStoreKeys.length ? 'ok' : 'missing',
    date_from: dateFrom,
    date_to: dateTo,
    day_count: dayCount,
    eligible_store_count: eligibleStoreKeys.length,
    table_count: tableCount,
    excluded_stores: [...excluded.values()],
    summary,
    points: trendPoints,
    store_summaries,
    store_trends,
  };
}
const MEAL_PERIOD_TIME_RANGES: Record<MealPeriodKey, string> = {
  breakfast: "06:00-10:00",
  lunch: "10:00-14:00",
  afternoon_tea: "14:00-17:00",
  dinner: "17:00-22:00",
  late_night: "22:00-次日06:00",
};

const TREND_MODE_OPTIONS: { value: TrendMode; label: string }[] = [
  { value: "all", label: "全部趋势" },
  { value: "source_compare", label: "堂食/外卖" },
];
const MEAL_METRIC_OPTIONS: { value: MealMetricMode; label: string }[] = [
  { value: "business", label: "经营指标" },
  { value: "turnover", label: "翻台率" },
];

export function mealTrendMetricValue(
  mode: MealMetricMode,
  business?: Pick<MealPeriodRow, "net_income">,
  turnover?: Pick<{ turnover: number }, "turnover">,
): number | null {
  return mode === "turnover"
    ? turnover?.turnover ?? null
    : business?.net_income ?? null;
}

export const mealTrendMetricUnit = (mode: MealMetricMode) =>
  mode === "turnover" ? "次/桌" : "元";

export function mealPeriodTimeRange(periodKey: string): string {
  return MEAL_PERIOD_TIME_RANGES[periodKey as MealPeriodKey] || "时间段未配置";
}

export function mealTrendDateFromChartClick(
  params: unknown,
  points: Pick<MealPeriodTrendPoint, "date">[],
): string | null {
  const dataIndex =
    typeof params === "object" && params !== null && "dataIndex" in params
      ? Number((params as { dataIndex?: unknown }).dataIndex)
      : NaN;
  if (
    Number.isInteger(dataIndex) &&
    dataIndex >= 0 &&
    dataIndex < points.length
  )
    return points[dataIndex]?.date || null;

  const rawValue =
    typeof params === "object" && params !== null
      ? ((params as { value?: unknown; name?: unknown }).value ??
        (params as { name?: unknown }).name)
      : null;
  if (typeof rawValue !== "string") return null;
  return (
    points.find(
      (point) => point.date === rawValue || point.date.slice(5) === rawValue,
    )?.date || null
  );
}

type MealPeriodTrendChartProps = {
  points: MealPeriodTrendPoint[];
  turnoverPoints?: MealPeriodTurnoverPoint[];
  storeTrends?: Record<string, MealPeriodTrendPoint[]>;
  turnoverStoreTrends?: Record<string, MealPeriodTurnoverPoint[]>;
  storeLabels?: Record<string, string>;
  periodKey: MealPeriodKey;
  granularity?: TrendGranularity;
  metricMode?: MealMetricMode;
  onSelectDate?: (date: string) => void;
  fullscreen?: boolean;
  onFullscreen?: () => void;
  legendSelectionRef?: LegendSelectionRef;
};

export function sameMealPeriodTrendChartProps(
  previous: MealPeriodTrendChartProps,
  next: MealPeriodTrendChartProps,
): boolean {
  const previousMode = previous.metricMode || "business";
  const nextMode = next.metricMode || "business";
  if (
    previousMode !== nextMode ||
    previous.periodKey !== next.periodKey ||
    (previous.granularity || 'day') !== (next.granularity || 'day') ||
    previous.fullscreen !== next.fullscreen ||
    Boolean(previous.onSelectDate) !== Boolean(next.onSelectDate) ||
    Boolean(previous.onFullscreen) !== Boolean(next.onFullscreen) ||
    previous.legendSelectionRef !== next.legendSelectionRef
  ) return false;

  if (nextMode === "turnover") {
    if (previous.turnoverStoreTrends || next.turnoverStoreTrends) {
      return previous.turnoverStoreTrends === next.turnoverStoreTrends &&
        previous.storeLabels === next.storeLabels;
    }
    return previous.turnoverPoints === next.turnoverPoints;
  }
  if (previous.storeTrends || next.storeTrends) {
    return previous.storeTrends === next.storeTrends &&
      previous.storeLabels === next.storeLabels;
  }
  return previous.points === next.points;
}

const MealPeriodTrendChart = memo(function MealPeriodTrendChart({
  points,
  turnoverPoints = [],
  storeTrends,
  turnoverStoreTrends,
  storeLabels = {},
  periodKey,
  granularity = 'day',
  metricMode = "business",
  onSelectDate,
  fullscreen = false,
  onFullscreen,
  legendSelectionRef,
}: MealPeriodTrendChartProps) {
  const periodName =
    MEAL_PERIOD_SERIES.find(([key]) => key === periodKey)?.[1] || "餐段";
  const isTurnover = metricMode === "turnover";
  const activePoints = isTurnover ? turnoverPoints : points;
  const comparisonStoreTrends = isTurnover ? turnoverStoreTrends : storeTrends;
  const compareStores = Object.keys(comparisonStoreTrends || {}).length > 1;
  const comparisonEntries = Object.entries(
    (comparisonStoreTrends || {}) as Record<
      string,
      Array<MealPeriodTrendPoint | MealPeriodTurnoverPoint>
    >,
  );
  const movingAverageFields = mealMovingAverageFields(granularity);
  const option = useMemo<EChartsCoreOption>(
    () => ({
      color: ["#0f8bbd", "#10b981", "#f59e0b", "#64748b"],
      tooltip: {
        trigger: "axis",
        appendToBody: !fullscreen,
        confine: true,
        valueFormatter: (value: unknown) =>
          value == null
            ? "-"
            : isTurnover
              ? `${Number(value || 0).toFixed(2)} 次/桌`
              : compactYuan(Number(value || 0)),
      },
      legend: {
        top: 0,
        right: fullscreen ? 44 : 84,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: "#64748b", fontSize: 11 },
      },
      grid: { top: compareStores ? 62 : 38, left: 64, right: 24, bottom: 42 },
      dataZoom: [{ type: "inside" }],
      xAxis: {
        type: "category",
        boundaryGap: false,
        data: activePoints.map((p) => p.date.slice(5)),
        axisTick: { show: false },
        axisLine: { lineStyle: { color: "#cbd5e1" } },
        axisLabel: { color: "#94a3b8", fontSize: 11, triggerEvent: true },
      },
      yAxis: {
        type: "value",
        axisLabel: {
          color: "#94a3b8",
          fontSize: 11,
          formatter: (value: unknown) =>
            isTurnover
              ? `${Number(value || 0).toFixed(2)}`
              : compactYuan(Number(value || 0)),
        },
        splitLine: { lineStyle: { color: "#e2e8f0", type: "dashed" } },
      },
      series: compareStores
        ? comparisonEntries.map(([storeKey, storePoints]) => ({
            name: storeLabels[storeKey] || storeKey,
            type: "line",
            smooth: true,
            symbolSize: 5,
            data: storePoints.map((point) => isTurnover
              ? (point as MealPeriodTurnoverPoint)[periodKey].turnover
              : (point as MealPeriodTrendPoint)[periodKey].net_income),
          }))
        : isTurnover
        ? [
            {
              name: `${periodName}翻台率`,
              type: "line",
              smooth: true,
              symbolSize: 5,
              data: turnoverPoints.map((point) =>
                mealTrendMetricValue("turnover", undefined, point[periodKey]),
              ),
            },
            ...movingAverageFields.map(([field]) => ({
              name: field.toUpperCase(),
              type: "line",
              smooth: true,
              symbol: "none",
              data: turnoverPoints.map((point) => point[periodKey][field] ?? null),
            })),
          ]
        : [
            {
              name: periodName,
              type: "line",
              smooth: true,
              symbolSize: 5,
              data: points.map((p) => p[periodKey].net_income),
            },
            ...movingAverageFields.map(([field]) => ({
              name: field.toUpperCase(),
              type: "line",
              smooth: true,
              symbol: "none",
              data: points.map((p) => p[periodKey][field] ?? null),
            })),
          ],
    }),
    [activePoints, compareStores, comparisonEntries, fullscreen, isTurnover, movingAverageFields, periodName, points, storeLabels, turnoverPoints, periodKey],
  );
  const handleClick = useMemo(
    () => (params: unknown) => {
      const selectedDate = mealTrendDateFromChartClick(params, activePoints);
      if (selectedDate) onSelectDate?.(selectedDate);
    },
    [activePoints, onSelectDate],
  );
  const { ref, chartRef } = useEChart(
    option,
    handleClick,
    legendSelectionRef,
  );
  return (
    <div className={`relative ${fullscreen ? "h-full min-h-0" : ""}`}>
      {!fullscreen && onFullscreen ? (
        <FullscreenButton onClick={onFullscreen} />
      ) : null}
      <ChartDownloadMenu
        chartRef={chartRef}
        title={isTurnover ? `${periodName}翻台率趋势` : `${periodName}餐段趋势`}
        dateFrom={activePoints[0]?.date}
        dateTo={activePoints[activePoints.length - 1]?.date}
        className={`absolute top-2 z-10 bg-white/90 shadow-sm ${fullscreen ? "right-2" : "right-12"}`}
      />
      <div
        ref={ref}
        onDoubleClick={() => openChartFullscreenOnMobile(onFullscreen)}
        className={`${fullscreen ? "h-full min-h-[15rem]" : "h-[18rem] md:h-[20rem]"} w-full rounded-lg bg-slate-50`}
        role="img"
        aria-label={isTurnover ? "餐段翻台率趋势图" : "餐段趋势折线图"}
      />
    </div>
  );
}, sameMealPeriodTrendChartProps);

function MealPeriodCards({ rows }: { rows: MealPeriodRow[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3">
      {rows.map((row) => (
        <div
          key={row.period_key}
          className="rounded-lg border border-slate-200 bg-white px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-slate-700">
              {row.period_label}
            </div>
            <div className="text-xs tabular-nums text-slate-400">
              {row.order_count} 单
            </div>
          </div>
          <div className="mt-3 text-lg font-semibold tabular-nums text-slate-900">
            {compactYuan(row.net_income)}
          </div>
          <div className="mt-1 text-xs tabular-nums text-slate-400">
            {mealPeriodTimeRange(row.period_key)}
          </div>
        </div>
      ))}
    </div>
  );
}

function MealPeriodTurnoverCards({ rows }: { rows: MealPeriodTurnoverRow[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(8.5rem,1fr))] gap-3">
      {rows.map((row) => (
        <div
          key={row.period_key}
          className="rounded-lg border border-slate-200 bg-white px-4 py-3"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-sm font-medium text-slate-700">
              {row.period_label}
            </div>
            <div className="text-xs tabular-nums text-slate-400">
              {row.shop_order_count} 单
            </div>
          </div>
          <div className="mt-3 text-lg font-semibold tabular-nums text-slate-900">
            {row.avg_daily_turnover.toFixed(2)}次/桌/日
          </div>
          <div className="mt-1 text-xs tabular-nums text-slate-400">
            {mealPeriodTimeRange(row.period_key)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage({ show }: { show: (m: string) => void }) {
  const [trendRange, setTrendRange] = useState(() =>
    defaultTrendRange("day", beijingTodayYmd(), true),
  );
  const { dateFrom, dateTo, includeCurrent } = trendRange;
  const [granularity, setGranularity] = useState<TrendGranularity>("day");
  const historyDateFrom = useMemo(
    () => trendHistoryStart(granularity, dateFrom),
    [dateFrom, granularity],
  );
  const [scopeKeys, setScopeKeys] = useState<string[]>(["ALL"]);
  const [scopeTree, setScopeTree] = useState<StoreScopeNode[]>([]);
  const [trendMode, setTrendMode] = useState<TrendMode>("all");
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>("previous");
  const [comparisonDisplayMode, setComparisonDisplayMode] = useState<ComparisonDisplayMode>("percentage");
  const [detailPeriodKey, setDetailPeriodKey] = useState("");
  const [comparisonOverview, setComparisonOverview] = useState<OperationsOverview | null>(null);
  const [orderFacts, setOrderFacts] = useState<OrderDailyFact[]>([]);
  const [orderFactMode, setOrderFactMode] = useState<OrderDailyFactMode>("loading");
  const [orderFactRefreshSeq, setOrderFactRefreshSeq] = useState(0);
  const [mealFacts, setMealFacts] = useState<MealDailyFact[]>([]);
  const [mealFactMode, setMealFactMode] = useState<MealDailyFactMode>("loading");
  const [mealFactRefreshSeq, setMealFactRefreshSeq] = useState(0);
  const [revenueDisplay, setRevenueDisplay] =
    useState<RevenueDisplaySnapshot | null>(null);
  const [mealRows, setMealRows] = useState<MealPeriodRow[]>([]);
  const [mealTrendPoints, setMealTrendPoints] = useState<
    MealPeriodTrendPoint[]
  >([]);
  const [mealStoreTrends, setMealStoreTrends] = useState<Record<string, MealPeriodTrendPoint[]>>({});
  const [mealMetricMode, setMealMetricMode] =
    useState<MealMetricMode>("business");
  const [mealTurnover, setMealTurnover] =
    useState<MealPeriodTurnoverResult | null>(null);
  const [selectedMealPeriod, setSelectedMealPeriod] =
    useState<MealPeriodKey>("lunch");
  const [selectedMealDate, setSelectedMealDate] = useState(dateTo);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [liveCheckedAt, setLiveCheckedAt] = useState<string | null>(null);
  const [liveCheckFailed, setLiveCheckFailed] = useState(false);
  const includesToday = dateFrom <= beijingTodayYmd() && dateTo >= beijingTodayYmd();
  const [fullscreenChart, setFullscreenChart] = useState<
    "revenue" | "meal" | null
  >(null);
  const [filterExpanded, setFilterExpanded] = useState(false);
  const [fullscreenFilterExpanded, setFullscreenFilterExpanded] =
    useState(false);
  const [fullscreenPortrait, setFullscreenPortrait] = useState(false);
  const revenueLegendSelectionRef = useRef<LegendSelection>();
  const mealLegendSelectionRef = useRef<LegendSelection>();
  const scopeSelection = useMemo(
    () => resolveStoreScopeSelection(scopeKeys, scopeTree),
    [scopeKeys, scopeTree],
  );
  const { shopKeys, compareStores, scopes, label: storeLabel } = scopeSelection;
  const detailPeriodOptions = useMemo(
    () => buildDetailPeriodOptions(granularity, dateFrom, dateTo),
    [dateFrom, dateTo, granularity],
  );
  const selectedDetailPeriod = useMemo(
    () => detailPeriodOptions.find(option => option.key === detailPeriodKey)
      ?? detailPeriodOptions[detailPeriodOptions.length - 1],
    [detailPeriodKey, detailPeriodOptions],
  );
  const displayTrendMode = revenueDisplay?.trendMode ?? trendMode;
  const displayDateFrom = revenueDisplay?.dateFrom ?? dateFrom;
  const displayDateTo = revenueDisplay?.dateTo ?? dateTo;
  const displayScopes = revenueDisplay?.scopes ?? scopes;
  const displayShopKeys = revenueDisplay?.shopKeys ?? shopKeys;
  const displayCompareStores = revenueDisplay?.compareStores ?? compareStores;
  const displayStoreLabel = revenueDisplay?.storeLabel ?? storeLabel;
  const aggregateRevenueSeriesName = displayStoreLabel === "全部门店" ? "净实收" : displayStoreLabel;
  const aggregateRevenueTitle = displayStoreLabel === "全部门店"
    ? "全部净实收趋势"
    : `${displayStoreLabel}净实收趋势`;
  const displayEmptyScope = revenueDisplay?.emptyScope ?? false;
  const trendPoints = revenueDisplay?.trendPoints || [];
  const revenueMovingAverages = revenueDisplay?.movingAverages || [];
  const revenueStoreTrends = revenueDisplay?.storeTrends || {};
  const shopTrendPoints = revenueDisplay?.shopTrendPoints || [];
  const shopMovingAverages = revenueDisplay?.shopMovingAverages || [];
  const shopStoreTrends = revenueDisplay?.shopStoreTrends || {};
  const takeoutTrendPoints = revenueDisplay?.takeoutTrendPoints || [];
  const takeoutMovingAverages = revenueDisplay?.takeoutMovingAverages || [];
  const takeoutStoreTrends = revenueDisplay?.takeoutStoreTrends || {};
  const isSourceCompare = displayTrendMode === "source_compare";
  const displayScopeComparison = displayScopes.length > 1;
  const scopeComparisonTitle = displayScopes.every(scope => scope.key.startsWith("shop:"))
    ? "门店"
    : "已选范围";
  const visibleShopTrendPoints = displayScopeComparison
    ? shopTrendPoints
    : displayCompareStores
    ? selectRevenueStorePoints(shopTrendPoints, shopStoreTrends, displayShopKeys)
    : shopTrendPoints;
  const visibleTakeoutTrendPoints = displayScopeComparison
    ? takeoutTrendPoints
    : displayCompareStores
    ? selectRevenueStorePoints(takeoutTrendPoints, takeoutStoreTrends, displayShopKeys)
    : takeoutTrendPoints;
  const activeTrendPoints = isSourceCompare
    ? mergeTrendPoints(visibleShopTrendPoints, visibleTakeoutTrendPoints)
    : displayScopeComparison
      ? trendPoints
      : displayCompareStores
      ? selectRevenueStorePoints(trendPoints, revenueStoreTrends, displayShopKeys)
      : trendPoints;
  const comparisonRevenueTrends = displayScopeComparison && !isSourceCompare
    ? buildScopeTrendSeries(displayScopes, revenueStoreTrends)
    : undefined;
  const comparisonRevenueSourceTrends = displayScopeComparison && isSourceCompare
    ? {
        shop: buildScopeTrendSeries(displayScopes, shopStoreTrends),
        takeout: buildScopeTrendSeries(displayScopes, takeoutStoreTrends),
      }
    : undefined;
  const activeMealTrendPoints = useMemo(
    () => selectMealStorePoints(mealTrendPoints, mealStoreTrends, displayShopKeys),
    [displayShopKeys, mealStoreTrends, mealTrendPoints],
  );
  const comparisonMealTrends = useMemo(
    () => displayScopeComparison
      ? buildMealScopeTrendSeries(displayScopes, mealStoreTrends)
      : undefined,
    [displayScopeComparison, displayScopes, mealStoreTrends],
  );
  const activeMealTurnover = useMemo(
    () => selectMealTurnover(mealTurnover, displayShopKeys),
    [displayShopKeys, mealTurnover],
  );
  const comparisonMealTurnoverTrends = useMemo(
    () => displayScopeComparison && activeMealTurnover
      ? buildMealTurnoverScopeTrendSeries(displayScopes, activeMealTurnover)
      : undefined,
    [activeMealTurnover, displayScopeComparison, displayScopes],
  );
  const availableMovingAverageLabel = revenueMovingAverages
    .filter(item => item.available)
    .map(item => item.label)
    .join(" / ");
  const selectedMealPeriodLabel =
    MEAL_PERIOD_SERIES.find(([key]) => key === selectedMealPeriod)?.[1] ||
    "午餐";
  const storeLabels = useMemo(() => {
    const entries: Array<[string, string]> = [];
    const visit = (node: StoreScopeNode) => {
      if (node.type === "store" && node.store_key) {
        entries.push([String(node.store_key), node.label]);
      }
      node.children?.forEach(visit);
    };
    scopeTree.forEach(visit);
    return Object.fromEntries(entries);
  }, [scopeTree]);
  const revenueTrendLabels = useMemo(() => ({
    ...storeLabels,
    ...Object.fromEntries(displayScopes.map(scope => [scope.key, scope.label])),
  }), [displayScopes, storeLabels]);
  const loadSeqRef = useRef(0);
  const loadAbortRef = useRef<AbortController | null>(null);
  const orderFactAbortRef = useRef<AbortController | null>(null);
  const mealFactAbortRef = useRef<AbortController | null>(null);
  const orderFactRefreshConsumedRef = useRef(0);
  const mealFactRefreshConsumedRef = useRef(0);
  const detailLoadSeqRef = useRef(0);
  const detailLoadAbortRef = useRef<AbortController | null>(null);

  const loadComparison = () => {
    const seq = detailLoadSeqRef.current + 1;
    detailLoadSeqRef.current = seq;
    detailLoadAbortRef.current?.abort('dashboard detail load');
    const emptyScope = !scopeKeys.includes("ALL") && shopKeys.length === 0;
    if (emptyScope || !selectedDetailPeriod) {
      detailLoadAbortRef.current = null;
      setDetailLoading(false);
      setComparisonOverview(null);
      return;
    }
    const controller = new AbortController();
    detailLoadAbortRef.current = controller;
    setDetailLoading(true);
    setComparisonOverview(null);
    fetchOperationsOverview({
      filters: {
        scopeKeys,
        storeKeys: scopeKeys.includes("ALL") ? [] : shopKeys,
        channel: "all",
        granularity,
        dateFrom: selectedDetailPeriod.dateFrom,
        dateTo: selectedDetailPeriod.dateTo,
        compare: comparisonMode,
      },
      signal: controller.signal,
    })
      .then(overview => {
        if (seq === detailLoadSeqRef.current) setComparisonOverview(overview);
      })
      .catch(error => {
        if (
          seq === detailLoadSeqRef.current
          && !(error instanceof DOMException && error.name === "AbortError")
        ) {
          setComparisonOverview(null);
        }
      })
      .finally(() => {
        if (seq === detailLoadSeqRef.current) setDetailLoading(false);
      });
  };

  const load = (
    revalidate = false,
    includeRevenue = orderFactMode !== "ready",
    includeMeal = mealFactMode !== "ready",
    pollSignal?: AbortSignal,
  ) => {
    if (pollSignal?.aborted) return Promise.resolve(false);
    const seq = loadSeqRef.current + 1;
    loadSeqRef.current = seq;
    loadAbortRef.current?.abort('ssd load');
    const emptyScope = !scopeKeys.includes("ALL") && shopKeys.length === 0;
    if (emptyScope) {
      loadAbortRef.current = null;
      setLoading(false);
      setRevenueDisplay({
        trendMode,
        granularity,
        includeCurrent,
        dateFrom,
        dateTo,
        scopeKeys: [...scopeKeys],
        scopes: [],
        shopKeys: [],
        compareStores: false,
        storeLabel,
        emptyScope: true,
        trendPoints: [],
        movingAverages: [],
        storeTrends: {},
        shopTrendPoints: [],
        shopMovingAverages: [],
        shopStoreTrends: {},
        takeoutTrendPoints: [],
        takeoutMovingAverages: [],
        takeoutStoreTrends: {},
      });
      setSelectedMealDate(dateTo);
      setMealRows([]);
      setMealTrendPoints([]);
      setMealStoreTrends({});
      setMealTurnover(null);
      setComparisonOverview(null);
      return;
    }
    const controller = new AbortController();
    loadAbortRef.current = controller;
    const abort = () => controller.abort();
    pollSignal?.addEventListener("abort", abort, { once: true });
    if (!pollSignal) setLoading(true);
    const selectedStoreOptions = {
      signal: controller.signal,
      revalidate,
      storeKeys: scopeKeys.includes("ALL") ? undefined : shopKeys,
    };
    const revenueOptions = {
      ...selectedStoreOptions,
      includeStoreTrends: scopes.length > 1,
      granularity,
      includeCurrent,
    };
    const trendRequests = !includeRevenue ? [] : trendMode === "source_compare"
      ? [
          getRevenueTrend(dateFrom, dateTo, "ALL", "shop", revenueOptions),
          getRevenueTrend(dateFrom, dateTo, "ALL", "takeout", revenueOptions),
        ]
      : [getRevenueTrend(dateFrom, dateTo, "ALL", "all", revenueOptions)];
    const trendRequest = includeRevenue
      ? Promise.allSettled(trendRequests)
      : Promise.resolve([] as PromiseSettledResult<RevenueTrendResult>[]);
    const mealRequest = includeMeal
      ? getMealPeriods("ALL", dateTo, {
          signal: controller.signal,
          revalidate,
        })
      : Promise.resolve(null);
    const mealTrendRequest = includeMeal
      ? getMealPeriodTrend("ALL", dateFrom, dateTo, {
          ...selectedStoreOptions,
          includeStoreTrends: shopKeys.length > 0,
        })
      : Promise.resolve(null);
    const turnoverRequest = includeMeal
      ? getMealPeriodTurnover(
          "ALL",
          dateFrom,
          dateTo,
          selectedStoreOptions,
        )
      : Promise.resolve(null);
    return Promise.allSettled([
      trendRequest,
      mealRequest,
      mealTrendRequest,
      turnoverRequest,
    ])
      .then(([trendGroupResult, mealResult, mealTrendResult, turnoverResult]) => {
        if (seq !== loadSeqRef.current || controller.signal.aborted) return;
        const displayBase = {
          trendMode,
          granularity,
          includeCurrent,
          dateFrom,
          dateTo,
          scopeKeys: [...scopeKeys],
          scopes: [...scopes],
          shopKeys: [...shopKeys],
          compareStores,
          storeLabel,
          emptyScope: false,
        };
        const trendResults = includeRevenue && trendGroupResult.status === "fulfilled"
          ? trendGroupResult.value
          : [];
        if (trendMode === "source_compare") {
          const shopTrend = trendResults[0]?.status === "fulfilled" ? trendResults[0].value : null;
          const takeoutTrend = trendResults[1]?.status === "fulfilled" ? trendResults[1].value : null;
          if (shopTrend || takeoutTrend) {
            setRevenueDisplay({
              ...displayBase,
              trendPoints: [],
              movingAverages: [],
              storeTrends: {},
              shopTrendPoints: shopTrend?.points || [],
              shopMovingAverages: shopTrend?.moving_averages || [],
              shopStoreTrends: shopTrend?.store_trends || {},
              takeoutTrendPoints: takeoutTrend?.points || [],
              takeoutMovingAverages: takeoutTrend?.moving_averages || [],
              takeoutStoreTrends: takeoutTrend?.store_trends || {},
            });
          }
        } else if (trendResults[0]?.status === "fulfilled") {
          const trend = trendResults[0].value;
          setRevenueDisplay({
            ...displayBase,
            trendPoints: trend.points,
            movingAverages: trend.moving_averages || [],
            storeTrends: trend.store_trends || {},
            shopTrendPoints: [],
            shopMovingAverages: [],
            shopStoreTrends: {},
            takeoutTrendPoints: [],
            takeoutMovingAverages: [],
            takeoutStoreTrends: {},
          });
        }
        const mealTrend = mealTrendResult.status === "fulfilled" ? mealTrendResult.value : null;
        const selectedMealPoints = mealTrend
          ? selectMealStorePoints(mealTrend.points, mealTrend.store_trends || {}, shopKeys)
          : [];
        const selectedDayPoint = selectedMealPoints.find(point => point.date === dateTo);
        const mealPeriods = mealResult.status === "fulfilled" ? mealResult.value?.periods : undefined;
        if (includeMeal && (mealPeriods || mealTrend)) {
          setSelectedMealDate(dateTo);
          setMealRows((shopKeys.length === 0 && mealPeriods?.length)
            ? mealPeriods
            : selectedDayPoint
            ? MEAL_PERIOD_SERIES.map(([key]) => selectedDayPoint[key])
            : []);
        }
        if (includeMeal && mealTrend) {
          setMealTrendPoints(mealTrend.points.length > 0 ? mealTrend.points : []);
          setMealStoreTrends(mealTrend.store_trends || {});
        }
        if (includeMeal && turnoverResult.status === "fulfilled") setMealTurnover(turnoverResult.value);

        const results = [
          ...(includeRevenue
            ? (trendGroupResult.status === "fulfilled" ? trendGroupResult.value : [trendGroupResult])
            : []),
          ...(includeMeal ? [mealResult, mealTrendResult, turnoverResult] : []),
        ];
        results.forEach(result => {
          if (result.status !== "rejected") return;
          if (pollSignal) return;
          console.error(result.reason);
          show(result.reason instanceof Error ? result.reason.message : String(result.reason));
        });
        return results.every(result => result.status === "fulfilled");
      })
      .finally(() => {
        pollSignal?.removeEventListener("abort", abort);
        if (!pollSignal && seq === loadSeqRef.current) {
          setLoading(false);
        }
      });
  };

  const loadMealDay = (businessDate: string) => {
    setSelectedMealDate(businessDate);
    const point = activeMealTrendPoints.find(item => item.date === businessDate);
    setMealRows(point ? MEAL_PERIOD_SERIES.map(([key]) => point[key]) : []);
  };

  useEffect(() => {
    const controller = new AbortController();
    orderFactAbortRef.current?.abort("order daily facts reload");
    orderFactAbortRef.current = controller;
    const forceRefresh = orderFactRefreshSeq > orderFactRefreshConsumedRef.current;
    if (forceRefresh) orderFactRefreshConsumedRef.current = orderFactRefreshSeq;
    setOrderFactMode("loading");
    getOrderDailyFacts<OrderDailyFact>(historyDateFrom, dateTo, {}, {
      signal: controller.signal,
      forceRefresh,
    })
      .then((records: DailyFactRecord<OrderDailyFact>[]) => {
        if (controller.signal.aborted) return;
        setOrderFacts(records.map(dashboardOrderFactFromRecord));
        setOrderFactMode("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setOrderFacts([]);
        setOrderFactMode("fallback");
        if (forceRefresh) {
          console.error(error);
          show(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort("order daily facts cleanup");
    /* eslint-disable-next-line */
  }, [dateTo, historyDateFrom, orderFactRefreshSeq]);

  useEffect(() => {
    if (orderFactMode !== "ready") return;
    const emptyScope = !scopeKeys.includes("ALL") && shopKeys.length === 0;
    if (emptyScope) {
      setRevenueDisplay({
        trendMode,
        granularity,
        includeCurrent,
        dateFrom,
        dateTo,
        scopeKeys: [...scopeKeys],
        scopes: [],
        shopKeys: [],
        compareStores: false,
        storeLabel,
        emptyScope: true,
        trendPoints: [],
        movingAverages: [],
        storeTrends: {},
        shopTrendPoints: [],
        shopMovingAverages: [],
        shopStoreTrends: {},
        takeoutTrendPoints: [],
        takeoutMovingAverages: [],
        takeoutStoreTrends: {},
      });
      return;
    }
    setRevenueDisplay(revenueDisplayFromOrderFacts({
      facts: orderFacts,
      trendMode,
      granularity,
      includeCurrent,
      dateFrom,
      dateTo,
      scopeKeys,
      scopes,
      shopKeys,
      compareStores,
      storeLabel,
    }));
  }, [compareStores, dateFrom, dateTo, granularity, includeCurrent, orderFactMode, orderFacts, scopeKeys, scopes, shopKeys, storeLabel, trendMode]);

  useEffect(() => {
    const controller = new AbortController();
    mealFactAbortRef.current?.abort("meal daily facts reload");
    mealFactAbortRef.current = controller;
    const forceRefresh = mealFactRefreshSeq > mealFactRefreshConsumedRef.current;
    if (forceRefresh) mealFactRefreshConsumedRef.current = mealFactRefreshSeq;
    setMealFactMode("loading");
    getMealDailyFacts<MealDailyFact>(historyDateFrom, dateTo, {}, {
      signal: controller.signal,
      forceRefresh,
    })
      .then((records: DailyFactRecord<MealDailyFact>[]) => {
        if (controller.signal.aborted) return;
        setMealFacts(records.map(dashboardMealFactFromRecord));
        setMealFactMode("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setMealFacts([]);
        setMealFactMode("fallback");
        if (forceRefresh) {
          console.error(error);
          show(error instanceof Error ? error.message : String(error));
        }
      });
    return () => controller.abort("meal daily facts cleanup");
    /* eslint-disable-next-line */
  }, [dateTo, historyDateFrom, mealFactRefreshSeq]);

  useEffect(() => {
    if (mealFactMode !== "ready") return;
    const trendPoints = mealTrendPointsFromFacts(
      mealFacts,
      [],
      granularity,
      includeCurrent,
      historyDateFrom,
      dateTo,
      dateFrom,
      dateTo,
    );
    const storeTrends = mealStoreTrendsFromFacts(
      mealFacts,
      shopKeys,
      granularity,
      includeCurrent,
      historyDateFrom,
      dateTo,
      dateFrom,
      dateTo,
    );
    setMealTrendPoints(trendPoints);
    setMealStoreTrends(storeTrends);
    const selectedPoints = selectMealStorePoints(trendPoints, storeTrends, shopKeys);
    const selectedPoint = selectedPoints.find(point => point.date === selectedMealDate)
      || selectedPoints[selectedPoints.length - 1];
    setSelectedMealDate(selectedPoint?.date || dateTo);
    setMealRows(selectedPoint ? MEAL_PERIOD_SERIES.map(([key]) => selectedPoint[key]) : []);
    setMealTurnover(mealTurnoverFromFacts(
      mealFacts,
      dateFrom,
      dateTo,
      shopKeys,
      storeLabels,
      granularity,
      includeCurrent,
      historyDateFrom,
      dateTo,
    ));
  }, [dateFrom, dateTo, granularity, historyDateFrom, includeCurrent, mealFactMode, mealFacts, selectedMealDate, shopKeys, storeLabels]);

  useEffect(() => {
    if (orderFactMode === "loading" || mealFactMode === "loading") return undefined;
    load(false, orderFactMode !== "ready", mealFactMode !== "ready");
    return () => {
      loadAbortRef.current?.abort('sddsd loadMealDay abort');
    };
    /* eslint-disable-next-line */
  }, [dateFrom, dateTo, trendMode, granularity, includeCurrent, scopeKeys.join(','), shopKeys.join(','), compareStores, orderFactMode, mealFactMode]);
  useEffect(() => {
    if (selectedDetailPeriod && detailPeriodKey !== selectedDetailPeriod.key) {
      setDetailPeriodKey(selectedDetailPeriod.key);
    }
  }, [detailPeriodKey, selectedDetailPeriod]);
  useEffect(() => {
    loadComparison();
    return () => {
      detailLoadAbortRef.current?.abort('dashboard detail effect cleanup');
    };
    /* eslint-disable-next-line */
  }, [selectedDetailPeriod?.dateFrom, selectedDetailPeriod?.dateTo, granularity, comparisonMode, scopeKeys.join(','), shopKeys.join(',')]);
  useEffect(() => {
    const point = activeMealTrendPoints.find(item => item.date === selectedMealDate);
    if (point) setMealRows(MEAL_PERIOD_SERIES.map(([key]) => point[key]));
    /* eslint-disable-next-line */
  }, [displayShopKeys.join(','), mealTrendPoints, mealStoreTrends]);
  useEffect(() => {
    Promise.resolve(listStoreScopeTree?.())
      .then(result => setScopeTree(result?.nodes || []))
      .catch(() => setScopeTree([]));
  }, []);
  useEffect(() => {
    if (!fullscreenChart) {
      setFullscreenFilterExpanded(false);
    }
  }, [fullscreenChart]);
  usePolling(
    async signal => {
      const detailSeq = detailLoadSeqRef.current;
      const needsLegacy = orderFactMode !== "ready" || mealFactMode !== "ready";
      const [orders, meals, legacy, overview] = await Promise.allSettled([
        orderFactMode === "ready"
          ? getOrderDailyFacts<OrderDailyFact>(historyDateFrom, dateTo, {}, { signal, forceRefresh: false })
          : Promise.resolve(null),
        mealFactMode === "ready"
          ? getMealDailyFacts<MealDailyFact>(historyDateFrom, dateTo, {}, { signal, forceRefresh: false })
          : Promise.resolve(null),
        needsLegacy ? load(false, orderFactMode !== "ready", mealFactMode !== "ready", signal) : Promise.resolve(true),
        selectedDetailPeriod ? fetchOperationsOverview({
          filters: {
            scopeKeys,
            storeKeys: scopeKeys.includes("ALL") ? [] : shopKeys,
            channel: "all",
            granularity,
            dateFrom: selectedDetailPeriod.dateFrom,
            dateTo: selectedDetailPeriod.dateTo,
            compare: comparisonMode,
          },
          signal,
        }) : Promise.resolve(null),
      ]);
      if (signal.aborted || detailSeq !== detailLoadSeqRef.current) return;
      if (orders.status === "fulfilled" && orders.value) setOrderFacts(orders.value.map(dashboardOrderFactFromRecord));
      if (meals.status === "fulfilled" && meals.value) setMealFacts(meals.value.map(dashboardMealFactFromRecord));
      if (overview.status === "fulfilled" && overview.value) setComparisonOverview(overview.value);
      const failed = [orders, meals, overview, legacy].some(result => result.status === "rejected")
        || (legacy.status === "fulfilled" && legacy.value === false);
      setLiveCheckFailed(failed);
      if (!failed) setLiveCheckedAt(new Date().toISOString());
    },
    includesToday && !loading && !detailLoading && orderFactMode !== "loading" && mealFactMode !== "loading"
      && (scopeKeys.includes("ALL") || shopKeys.length > 0) ? 30000 : null,
    [dateFrom, dateTo, historyDateFrom, granularity, includeCurrent, trendMode, scopeKeys.join(','), shopKeys.join(','),
      comparisonMode, selectedDetailPeriod?.key, orderFactMode, mealFactMode, orderFactRefreshSeq, mealFactRefreshSeq],
  );
  const handleGranularityChange = (next: TrendGranularity) => {
    setGranularity(next);
    setTrendRange(defaultTrendRange(next, beijingTodayYmd(), true));
  };
  const handleRangeChange = (nextFrom: string, nextTo: string) => {
    setTrendRange(current => ({
      ...current,
      dateFrom: nextFrom,
      dateTo: nextTo,
    }));
  };
  const refresh = () => {
    if (orderFactMode === "ready") {
      setOrderFactRefreshSeq(value => value + 1);
    }
    if (mealFactMode === "ready") {
      setMealFactRefreshSeq(value => value + 1);
    }
    if (orderFactMode === "ready" || mealFactMode === "ready") {
      load(true, orderFactMode !== "ready", mealFactMode !== "ready");
    } else {
      load(true, true, true);
    }
    loadComparison();
  };
  const openFullscreen = (chart: "revenue" | "meal") => {
    setFullscreenChart(chart);
    setFullscreenFilterExpanded(false);
    setFullscreenPortrait(window.innerWidth < window.innerHeight);
    void document.documentElement.requestFullscreen?.().catch(() => {});
    const orientation = screen.orientation as ScreenOrientation & {
      lock?: (orientation: "landscape") => Promise<void>;
    };
    void orientation?.lock?.("landscape").catch(() => {});
    window.setTimeout(() => {
      setFullscreenPortrait(window.innerWidth < window.innerHeight);
      window.dispatchEvent(new Event("resize"));
    }, 350);
  };
  const closeFullscreen = () => {
    setFullscreenChart(null);
    setFullscreenFilterExpanded(false);
    setFullscreenPortrait(false);
    const orientation = screen.orientation as ScreenOrientation & {
      unlock?: () => void;
    };
    orientation?.unlock?.();
    if (document.fullscreenElement)
      void document.exitFullscreen?.().catch(() => {});
  };
  useEffect(() => {
    if (!fullscreenChart) return;
    const updatePortrait = () =>
      setFullscreenPortrait(window.innerWidth < window.innerHeight);
    updatePortrait();
    window.addEventListener("resize", updatePortrait);
    window.addEventListener("orientationchange", updatePortrait);
    const timer = window.setTimeout(
      () => window.dispatchEvent(new Event("resize")),
      80,
    );
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", updatePortrait);
      window.removeEventListener("orientationchange", updatePortrait);
    };
  }, [fullscreenChart, fullscreenFilterExpanded]);
  const renderDesktopControls = () => (
    <>
      <div className="w-[260px] min-w-[220px] shrink-0">
        <StoreScopePicker
          nodes={scopeTree}
          value={scopeKeys}
          onChange={setScopeKeys}
          ariaLabel="经营看板桌面门店范围"
        />
      </div>
      <Segmented
        className="shrink-0"
        aria-label="趋势展示方式"
        value={trendMode}
        onChange={(value) => setTrendMode(value as TrendMode)}
        options={TREND_MODE_OPTIONS}
      />
      <ComparisonModeSelect
        ariaLabel="经营看板对比方式"
        value={comparisonMode}
        onChange={setComparisonMode}
      />
      <div className="min-w-[20rem] flex-1">
        <TrendPeriodControls
          allowToday
          granularity={granularity}
          dateFrom={dateFrom}
          dateTo={dateTo}
          includeCurrent={includeCurrent}
          onGranularityChange={handleGranularityChange}
          onRangeChange={handleRangeChange}
          onIncludeCurrentChange={value =>
            setTrendRange(current => ({ ...current, includeCurrent: value }))
          }
        />
      </div>
      <AntButton
        autoInsertSpace={false}
        htmlType="button"
        className="h-10 shrink-0 rounded-lg bg-blue-600 px-3 text-sm text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer"
        disabled={loading || detailLoading}
        onClick={refresh}
      >
        {loading || detailLoading ? "刷新中…" : "刷新"}
      </AntButton>
    </>
  );
  const renderMobileControls = (fullscreen = false) => (
    <div className="space-y-2">
      <StoreScopePicker
        nodes={scopeTree}
        value={scopeKeys}
        onChange={setScopeKeys}
        fullscreen={fullscreen}
        ariaLabel={fullscreen ? "经营看板全屏门店范围" : "经营看板门店范围"}
      />
      <Selector<TrendMode>
        value={[trendMode]}
        options={TREND_MODE_OPTIONS}
        columns={2}
        showCheckMark={false}
        onChange={(value) => value[0] && setTrendMode(value[0])}
        className={`dashboard-mobile-selector${fullscreen ? " compact" : ""}`}
      />
      <ComparisonModeSelect
        ariaLabel={fullscreen ? "经营看板全屏对比方式" : "经营看板移动端对比方式"}
        value={comparisonMode}
        onChange={setComparisonMode}
        mobile
      />
      <TrendPeriodControls
        allowToday
        granularity={granularity}
        dateFrom={dateFrom}
        dateTo={dateTo}
        includeCurrent={includeCurrent}
        onGranularityChange={handleGranularityChange}
        onRangeChange={handleRangeChange}
        onIncludeCurrentChange={value =>
          setTrendRange(current => ({ ...current, includeCurrent: value }))
        }
        fullscreen={fullscreen}
      />
      <div className={fullscreen ? "flex justify-end" : "grid grid-cols-1"}>
        <MobileButton
          size={fullscreen ? "mini" : "small"}
          color="primary"
          loading={loading || detailLoading}
          onClick={refresh}
          className="dashboard-mobile-button"
        >
          刷新
        </MobileButton>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {includesToday && <p className="text-xs text-slate-500" role="status">
        含当日数据，每 30 秒检查最新汇总。{liveCheckFailed ? '读取暂时失败，保留上次结果并继续重试。' : liveCheckedAt ? `最近读取：${formatBeijingTime(liveCheckedAt)}` : ''}
      </p>}
      <div className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
        <div className="md:hidden">
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              className="flex h-9 items-center gap-1 text-sm font-medium text-slate-700"
              onClick={() => setFilterExpanded((v) => !v)}
              aria-expanded={filterExpanded}
            >
              经营看板
              <span className="text-xs text-slate-400">
                {filterExpanded ? "收起" : "筛选"}
              </span>
            </button>
            <div className="truncate text-[11px] tabular-nums text-slate-400">
              {storeLabel} · {dateFrom.slice(5)} 至 {dateTo.slice(5)}
            </div>
          </div>
          <div
            className={`rounded-lg border border-slate-200 bg-slate-50 p-3 ${filterExpanded ? "block" : "hidden"}`}
          >
            {renderMobileControls(false)}
          </div>
        </div>
        <div
          data-testid="dashboard-desktop-controls"
          className="hidden min-w-0 items-center gap-2 overflow-x-auto md:flex md:flex-nowrap"
        >
          <span className="shrink-0 text-sm font-medium text-slate-700">经营看板</span>
          {renderDesktopControls()}
        </div>
        <div data-testid="dashboard-period-summary" className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 md:p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-slate-500">统计周期</div>
              <div className="mt-1 text-base font-semibold text-slate-900">{selectedDetailPeriod?.label || '暂无'}</div>
            </div>
            <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
              <span className="shrink-0 text-xs text-slate-500">对比展示</span>
              <ComparisonDisplaySelect
                ariaLabel="经营看板对比展示"
                value={comparisonDisplayMode}
                onChange={setComparisonDisplayMode}
                disabled={comparisonMode !== "previous"}
              />
              <DetailPeriodSelect
                options={detailPeriodOptions}
                value={selectedDetailPeriod?.key}
                onChange={setDetailPeriodKey}
                label="切换周期"
                ariaLabel="经营看板卡片周期"
              />
            </div>
          </div>
          {isSourceCompare ? (
            <div className="mt-4 grid gap-4 xl:grid-cols-2">
              <ChannelMetricGroup
                label="堂食"
                scopeLabel={displayStoreLabel}
                row={comparisonOverview?.channels.find(item => item.dim_key === 'shop')}
                comparisonEnabled={comparisonMode === 'previous'}
                comparisonDisplayMode={comparisonDisplayMode}
                accentClass="border-sky-500"
              />
              <ChannelMetricGroup
                label="外卖"
                scopeLabel={displayStoreLabel}
                row={comparisonOverview?.channels.find(item => item.dim_key === 'takeout')}
                comparisonEnabled={comparisonMode === 'previous'}
                comparisonDisplayMode={comparisonDisplayMode}
                accentClass="border-amber-500"
              />
            </div>
          ) : (
            <div className="mt-4 grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-3">
              <PeriodMetricCard
                label="营业额"
                value={comparisonOverview?.metrics.paid_amount?.current == null ? "—" : compactYuan(comparisonOverview.metrics.paid_amount.current)}
                comparison={comparisonMode === "previous" ? comparisonOverview?.metrics.paid_amount : undefined}
                displayMode={comparisonDisplayMode}
              />
              <PeriodMetricCard
                label="净实收"
                value={comparisonOverview?.metrics.net_income?.current == null ? "—" : compactYuan(comparisonOverview.metrics.net_income.current)}
                comparison={comparisonMode === "previous" ? comparisonOverview?.metrics.net_income : undefined}
                displayMode={comparisonDisplayMode}
              />
              <PeriodMetricCard
                label="订单数"
                value={comparisonOverview?.metrics.order_count?.current == null ? "—" : Number(comparisonOverview.metrics.order_count.current).toLocaleString("zh-CN")}
                comparison={comparisonMode === "previous" ? comparisonOverview?.metrics.order_count : undefined}
                format="integer"
                displayMode={comparisonDisplayMode}
              />
              <PeriodMetricCard
                label="客单价"
                value={comparisonOverview?.metrics.avg_order_value?.current == null ? "—" : yuan(comparisonOverview.metrics.avg_order_value.current)}
                comparison={comparisonMode === "previous" ? comparisonOverview?.metrics.avg_order_value : undefined}
                displayMode={comparisonDisplayMode}
              />
            </div>
          )}
          <ComparisonPeriodNote previousPeriod={comparisonMode === "previous" ? comparisonOverview?.previous_period : null} />
        </div>
        <div className="mt-4">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-slate-800">
                {isSourceCompare
                  ? displayScopeComparison ? `${scopeComparisonTitle}堂食/外卖净实收趋势` : "堂食/外卖净实收趋势"
                  : displayScopeComparison ? `${scopeComparisonTitle}净实收趋势` : aggregateRevenueTitle}
              </div>
              <div className="mt-1 text-xs text-slate-400">
                {isSourceCompare
                  ? displayScopeComparison
                    ? `${scopeComparisonTitle === "门店" ? "门店" : "范围"}同色 · 堂食实线 / 外卖虚线`
                    : "同图对比"
                  : displayScopeComparison
                    ? scopeComparisonTitle === "门店" ? "门店对比" : "按已选范围对比"
                    : availableMovingAverageLabel || "净实收"}
              </div>
              {!displayScopeComparison ? (
                isSourceCompare ? (
                  <div className="space-y-0.5">
                    {shopMovingAverages.some(item => !item.available) ? (
                      <div aria-label="堂食均线状态" className="flex items-start gap-1 text-xs text-slate-400">
                        <span>堂食</span>
                        <MovingAverageStatus items={shopMovingAverages} />
                      </div>
                    ) : null}
                    {takeoutMovingAverages.some(item => !item.available) ? (
                      <div aria-label="外卖均线状态" className="flex items-start gap-1 text-xs text-slate-400">
                        <span>外卖</span>
                        <MovingAverageStatus items={takeoutMovingAverages} />
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <MovingAverageStatus items={revenueMovingAverages} />
                )
              ) : null}
            </div>
          </div>
          {displayEmptyScope ? (
            <div className="flex h-[18rem] items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400 md:h-[22rem]">
              当前范围无可用门店
            </div>
          ) : activeTrendPoints.length > 0 ? (
            <div className="relative">
              <TrendMainChart
                points={activeTrendPoints}
                compare={
                  isSourceCompare && !displayScopeComparison
                    ? { shop: shopTrendPoints, takeout: takeoutTrendPoints }
                    : undefined
                }
                storeTrends={comparisonRevenueTrends}
                storeSourceTrends={comparisonRevenueSourceTrends}
                movingAverages={revenueMovingAverages}
                sourceMovingAverages={{
                  shop: shopMovingAverages,
                  takeout: takeoutMovingAverages,
                }}
                storeLabels={revenueTrendLabels}
                primarySeriesName={aggregateRevenueSeriesName}
                onFullscreen={() => openFullscreen("revenue")}
                legendSelectionRef={revenueLegendSelectionRef}
              />
              {loading ? (
                <div
                  aria-label="趋势数据更新中"
                  className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/50 text-sm text-slate-500"
                >
                  更新中…
                </div>
              ) : null}
            </div>
          ) : loading ? (
            <div className="flex h-[18rem] items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400 md:h-[22rem]">
              加载中…
            </div>
          ) : (
            <div className="flex h-[18rem] items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400 md:h-[22rem]">
              暂无趋势数据
            </div>
          )}
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-700">餐段指标</span>
            <span className="text-xs text-slate-400">
              {mealMetricMode === "business"
                ? `${granularity === 'week' ? '周' : granularity === 'month' ? '月' : '单日'}卡片：${selectedMealDate}`
                : `区间：${displayDateFrom} 至 ${displayDateTo}`}
            </span>
          </div>
          <Segmented
            aria-label="餐段指标类型"
            size="small"
            value={mealMetricMode}
            onChange={(value) => setMealMetricMode(value as MealMetricMode)}
            options={MEAL_METRIC_OPTIONS}
          />
        </div>
        {loading ? (
          <div className="py-8 text-center text-sm text-slate-400">加载中…</div>
        ) : mealMetricMode === "turnover" ? (
          activeMealTurnover?.data_status === "ok" ? (
            <div className="space-y-4">
              <div>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-medium text-slate-800">
                      餐段翻台率趋势
                    </div>
                    <div className="mt-1 text-xs text-slate-400">
                      {selectedMealPeriodLabel} · {displayScopeComparison
                        ? scopeComparisonTitle === "门店" ? "门店对比" : "按已选范围对比"
                        : mealTrendMetricUnit("turnover")}
                    </div>
                  </div>
                  <label className="flex w-full items-center gap-2 text-xs text-slate-500 sm:w-auto">
                    <span>餐段</span>
                    <Select
                      {...searchableSelectProps}
                      aria-label="餐段选择"
                      className="rounded-lg border border-slate-200 text-sm text-slate-700"
                      value={selectedMealPeriod}
                      onChange={(value) =>
                        setSelectedMealPeriod(value as MealPeriodKey)
                      }
                      options={MEAL_PERIOD_SERIES.map(([key, label]) => ({
                        value: key,
                        label,
                      }))}
                      popupMatchSelectWidth={false}
                    />
                  </label>
                </div>
                <MealPeriodTrendChart
                  points={[]}
                  turnoverPoints={activeMealTurnover.points}
                  turnoverStoreTrends={comparisonMealTurnoverTrends}
                  storeLabels={revenueTrendLabels}
                  periodKey={selectedMealPeriod}
                  granularity={granularity}
                  metricMode="turnover"
                  onFullscreen={() => openFullscreen("meal")}
                  legendSelectionRef={mealLegendSelectionRef}
                />
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
                <span>
                  参与 {activeMealTurnover.eligible_store_count} 家 · 共 {activeMealTurnover.table_count} 桌
                </span>
                <span>仅统计堂食订单</span>
              </div>
              {activeMealTurnover.excluded_stores.length > 0 ? (
                <AntAlert
                  type="warning"
                  showIcon
                  message={`另有 ${activeMealTurnover.excluded_stores.length} 家已确认门店未参与计算`}
                  description={activeMealTurnover.excluded_stores
                    .map((store) => `${store.store_label}：${store.reason}`)
                    .join("；")}
                />
              ) : null}
              <MealPeriodTurnoverCards rows={activeMealTurnover.summary} />
            </div>
          ) : (
            <div className="py-8 text-center text-sm text-slate-400">
              暂无可计算的餐段翻台率，请确认已同步堂食订单并在设置中配置门店桌数。
            </div>
          )
        ) : mealRows.length > 0 || activeMealTrendPoints.length > 0 ? (
          <div className="space-y-4">
            <div>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-slate-800">
                    餐段趋势
                  </div>
                  <div className="mt-1 text-xs text-slate-400">
                    {selectedMealPeriodLabel} · {displayScopeComparison
                      ? scopeComparisonTitle === "门店" ? "门店对比" : "按已选范围对比"
                      : mealMovingAverageFields(granularity).map(([field]) => field.toUpperCase()).join(' / ')}
                  </div>
                </div>
                <label className="flex w-full items-center gap-2 text-xs text-slate-500 sm:w-auto">
                  <span>餐段</span>
                  <Select
                    {...searchableSelectProps}
                    aria-label="餐段选择"
                    className="rounded-lg border border-slate-200 text-sm text-slate-700"
                    value={selectedMealPeriod}
                    onChange={(value) =>
                      setSelectedMealPeriod(value as MealPeriodKey)
                    }
                    options={MEAL_PERIOD_SERIES.map(([key, label]) => ({
                      value: key,
                      label,
                    }))}
                    popupMatchSelectWidth={false}
                  />
                </label>
              </div>
              {activeMealTrendPoints.length > 0 ? (
                <MealPeriodTrendChart
                  points={activeMealTrendPoints}
                  storeTrends={comparisonMealTrends}
                  storeLabels={revenueTrendLabels}
                  periodKey={selectedMealPeriod}
                  granularity={granularity}
                  onSelectDate={loadMealDay}
                  onFullscreen={() => openFullscreen("meal")}
                  legendSelectionRef={mealLegendSelectionRef}
                />
              ) : (
                <div className="flex h-[18rem] items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400 md:h-[20rem]">
                  暂无餐段趋势数据
                </div>
              )}
            </div>
            {mealRows.length > 0 ? (
              <MealPeriodCards rows={mealRows} />
            ) : null}
          </div>
        ) : (
          <div className="py-8 text-center text-sm text-slate-400">
            暂无餐段数据
          </div>
        )}
      </div>
      {fullscreenChart === "revenue" ? (
        <ChartFullscreenLayer
          title={isSourceCompare
            ? displayScopeComparison ? `${scopeComparisonTitle}堂食/外卖净实收趋势` : "堂食/外卖净实收趋势"
            : displayScopeComparison ? `${scopeComparisonTitle}净实收趋势` : aggregateRevenueTitle}
          subtitle={`${displayStoreLabel} · ${displayDateFrom.slice(5)} 至 ${displayDateTo.slice(5)}`}
          showRotateHint={fullscreenPortrait}
          controls={
            <div className="relative">
              <FullscreenFilterButton
                label="筛选"
                expanded={fullscreenFilterExpanded}
                onClick={() => setFullscreenFilterExpanded((v) => !v)}
              />
              {fullscreenFilterExpanded ? (
                <div className="chart-fullscreen-filter-panel">
                  <div className="mb-1.5 truncate text-[11px] text-slate-400">
                    {storeLabel} · {dateFrom.slice(5)} 至 {dateTo.slice(5)}
                  </div>
                  {renderMobileControls(true)}
                </div>
              ) : null}
            </div>
          }
          onClose={closeFullscreen}
        >
          {displayEmptyScope ? (
            <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
              当前范围无可用门店
            </div>
          ) : activeTrendPoints.length > 0 ? (
            <div className="relative h-full min-h-0">
              <TrendMainChart
                points={activeTrendPoints}
                compare={
                  isSourceCompare && !displayScopeComparison
                    ? { shop: shopTrendPoints, takeout: takeoutTrendPoints }
                    : undefined
                }
                storeTrends={comparisonRevenueTrends}
                storeSourceTrends={comparisonRevenueSourceTrends}
                movingAverages={revenueMovingAverages}
                sourceMovingAverages={{
                  shop: shopMovingAverages,
                  takeout: takeoutMovingAverages,
                }}
                storeLabels={revenueTrendLabels}
                primarySeriesName={aggregateRevenueSeriesName}
                fullscreen
                legendSelectionRef={revenueLegendSelectionRef}
              />
              {loading ? (
                <div
                  aria-label="全屏趋势数据更新中"
                  className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/50 text-sm text-slate-500"
                >
                  更新中…
                </div>
              ) : null}
            </div>
          ) : loading ? (
            <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
              加载中...
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
              暂无趋势数据
            </div>
          )}
        </ChartFullscreenLayer>
      ) : null}
      {fullscreenChart === "meal" ? (
        <ChartFullscreenLayer
          title={mealMetricMode === "turnover" ? "餐段翻台率趋势" : "餐段经营趋势"}
          subtitle={`${selectedMealPeriodLabel} · ${displayStoreLabel} · ${displayDateFrom.slice(5)} 至 ${displayDateTo.slice(5)}`}
          showRotateHint={fullscreenPortrait}
          controls={
            <div className="relative">
              <FullscreenFilterButton
                label="筛选"
                expanded={fullscreenFilterExpanded}
                onClick={() => setFullscreenFilterExpanded((v) => !v)}
              />
              {fullscreenFilterExpanded ? (
                <div className="chart-fullscreen-filter-panel space-y-1.5">
                  <div className="truncate text-[11px] text-slate-400">
                    {selectedMealPeriodLabel} · {storeLabel}
                  </div>
                  {renderMobileControls(true)}
                  <Segmented
                    aria-label="餐段指标类型"
                    size="small"
                    value={mealMetricMode}
                    onChange={(value) =>
                      setMealMetricMode(value as MealMetricMode)
                    }
                    options={MEAL_METRIC_OPTIONS}
                  />
                  <Selector<MealPeriodKey>
                    value={[selectedMealPeriod]}
                    options={MEAL_PERIOD_SERIES.map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    columns={5}
                    showCheckMark={false}
                    onChange={(value) =>
                      value[0] && setSelectedMealPeriod(value[0])
                    }
                    className="dashboard-mobile-selector compact"
                  />
                </div>
              ) : null}
            </div>
          }
          onClose={closeFullscreen}
        >
          {mealMetricMode === "turnover" ? (
            activeMealTurnover?.data_status === "ok" && activeMealTurnover.points.length > 0 ? (
              <MealPeriodTrendChart
                points={[]}
                turnoverPoints={activeMealTurnover.points}
                turnoverStoreTrends={comparisonMealTurnoverTrends}
                storeLabels={revenueTrendLabels}
                periodKey={selectedMealPeriod}
                granularity={granularity}
                metricMode="turnover"
                fullscreen
                legendSelectionRef={mealLegendSelectionRef}
              />
            ) : loading ? (
              <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
                加载中...
              </div>
            ) : (
              <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
                暂无可计算的餐段翻台率
              </div>
            )
          ) : activeMealTrendPoints.length > 0 ? (
            <MealPeriodTrendChart
              points={activeMealTrendPoints}
              storeTrends={comparisonMealTrends}
              storeLabels={revenueTrendLabels}
              periodKey={selectedMealPeriod}
              granularity={granularity}
              onSelectDate={loadMealDay}
              fullscreen
              legendSelectionRef={mealLegendSelectionRef}
            />
          ) : loading ? (
            <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
              加载中...
            </div>
          ) : (
            <div className="flex h-full items-center justify-center rounded-lg bg-slate-50 text-sm text-slate-400">
              暂无餐段趋势数据
            </div>
          )}
        </ChartFullscreenLayer>
      ) : null}
    </div>
  );
}
