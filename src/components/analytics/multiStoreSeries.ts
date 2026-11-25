import type { LaborTrendPoint, ProductTrendPoint, RevenueTrendPoint } from '../../api/analytics';
import { LABOR_COMPLETENESS_STATUS, laborCompletenessStatus } from './laborCompleteness';

type StoreLabels = Record<string, string>;
type ComparableLaborPoint = Pick<LaborTrendPoint, 'period' | 'actual_hours' | 'planned_hours' | 'actual_revenue_per_hour' | 'planned_revenue_per_hour' | 'missing' | 'hours_synced'>;

const STORE_COLOR_PALETTE = [
  '#486FA6',
  '#C8733A',
  '#4F8B62',
  '#B95678',
  '#7563A6',
  '#318191',
  '#B84F4B',
  '#7B8D42',
  '#5162A0',
  '#B4872F',
  '#3F7D70',
  '#8C506F',
  '#527F9D',
  '#A76145',
  '#6B7D4C',
  '#765889',
] as const;

function buildStoreColorMap(labels: StoreLabels, keys: string[]) {
  const storeLabels = [...new Set([
    ...Object.entries(labels).map(([key, label]) => label || key),
    ...keys.map(key => labels[key] || key),
  ])].sort((left, right) => left.localeCompare(right, 'zh-CN'));

  return new Map(storeLabels.map((label, index) => [
    label,
    STORE_COLOR_PALETTE[index % STORE_COLOR_PALETTE.length],
  ]));
}

export function trendPrimaryValues<T, K extends keyof T>(points: T[], field: K): Array<number | null> {
  return points.map(point => typeof point[field] === 'number' ? point[field] as number : null);
}

export function revenuePrimaryValue(point: RevenueTrendPoint | undefined): number | null {
  return point && !point.missing && typeof point.net_income === 'number' ? point.net_income : null;
}

export function selectedStoreTrendMap<T>(
  storeTrends: Record<string, T[]>,
  storeKeys: string[],
): Record<string, T[]> {
  return Object.fromEntries(storeKeys.map(key => [key, storeTrends[key] || []]));
}

export function selectRevenueStorePoints(
  allPoints: RevenueTrendPoint[],
  storeTrends: Record<string, RevenueTrendPoint[]>,
  storeKeys: string[],
): RevenueTrendPoint[] {
  if (storeKeys.length === 0) return allPoints;
  if (storeKeys.length === 1) return storeTrends[storeKeys[0]] || [];

  const selected = selectedStoreTrendMap(storeTrends, storeKeys);
  const periods = [...new Set(Object.values(selected).flatMap(points => points.map(point => point.period)))].sort();
  return periods.map(period => {
    const points = Object.values(selected)
      .map(rows => rows.find(point => point.period === period))
      .filter((point): point is RevenueTrendPoint => Boolean(point));
    return {
      period,
      net_income: points.reduce((sum, point) => sum + point.net_income, 0),
      order_count: points.reduce((sum, point) => sum + point.order_count, 0),
      ma7: null,
      ma30: null,
      ma180: null,
      missing: points.length !== storeKeys.length || points.some(point => point.missing),
      ...(points.some(point => point.in_progress) ? { in_progress: true } : {}),
    };
  });
}

export function selectProductStorePoints(
  allPoints: ProductTrendPoint[],
  storeTrends: Record<string, ProductTrendPoint[]>,
  storeKeys: string[],
): ProductTrendPoint[] {
  if (storeKeys.length === 0) return allPoints;
  if (storeKeys.length === 1) return storeTrends[storeKeys[0]] || [];

  const selected = selectedStoreTrendMap(storeTrends, storeKeys);
  const periods = [...new Set(Object.values(selected).flatMap(points => points.map(point => point.period)))].sort();
  return periods.map(period => {
    const points = Object.values(selected)
      .map(rows => rows.find(point => point.period === period))
      .filter((point): point is ProductTrendPoint => Boolean(point));
    return {
      period,
      quantity: points.reduce((sum, point) => sum + point.quantity, 0),
      sales_amount: points.reduce((sum, point) => sum + point.sales_amount, 0),
      order_count: points.reduce((sum, point) => sum + point.order_count, 0),
      ma7: null,
      ma30: null,
      ma180: null,
      missing: points.length !== storeKeys.length || points.some(point => point.missing),
      ...(points.some(point => point.in_progress) ? { in_progress: true } : {}),
    };
  });
}

export function buildRevenueStoreSeries(
  storeTrends: Record<string, RevenueTrendPoint[]>,
  labels: StoreLabels,
) {
  const colors = buildStoreColorMap(labels, Object.keys(storeTrends));
  return Object.entries(storeTrends).map(([key, points]) => {
    const label = labels[key] || key;
    const color = colors.get(label);
    return {
      name: label,
      type: 'line' as const,
      smooth: true,
      symbolSize: 5,
      lineStyle: { color },
      itemStyle: { color },
      data: points.map(revenuePrimaryValue),
    };
  });
}

export function buildRevenueStoreSourceSeries(
  shopTrends: Record<string, RevenueTrendPoint[]>,
  takeoutTrends: Record<string, RevenueTrendPoint[]>,
  labels: StoreLabels,
) {
  const keys = [...new Set([...Object.keys(shopTrends), ...Object.keys(takeoutTrends)])];
  const colors = buildStoreColorMap(labels, keys);
  return keys.flatMap(key => {
    const label = labels[key] || key;
    const color = colors.get(label);
    return [
      {
        name: `${label} 堂食`,
        type: 'line' as const,
        smooth: true,
        symbolSize: 5,
        lineStyle: { color, type: 'solid' as const },
        itemStyle: { color },
        data: (shopTrends[key] || []).map(revenuePrimaryValue),
      },
      {
        name: `${label} 外卖`,
        type: 'line' as const,
        smooth: true,
        symbolSize: 5,
        lineStyle: { color, type: 'dashed' as const },
        itemStyle: { color },
        data: (takeoutTrends[key] || []).map(revenuePrimaryValue),
      },
    ];
  });
}

export function buildProductStoreSeries(
  storeTrends: Record<string, ProductTrendPoint[]>,
  labels: StoreLabels,
) {
  const colors = buildStoreColorMap(labels, Object.keys(storeTrends));
  return Object.entries(storeTrends).map(([key, points]) => {
    const label = labels[key] || key;
    const color = colors.get(label);
    return {
      name: label,
      type: 'line' as const,
      smooth: true,
      symbolSize: 5,
      lineStyle: { color },
      itemStyle: { color },
      data: trendPrimaryValues(points, 'quantity'),
    };
  });
}

export function buildLaborStoreSeries(
  storeTrends: Record<string, ComparableLaborPoint[]>,
  labels: StoreLabels,
  metric: 'hours' | 'efficiency',
  periods?: string[],
) {
  const isHours = metric === 'hours';
  const colors = buildStoreColorMap(labels, Object.keys(storeTrends));
  return Object.entries(storeTrends).flatMap(([key, points]) => {
    const label = labels[key] || key;
    const color = colors.get(label);
    const byPeriod = periods ? new Map(points.map(point => [point.period, point])) : null;
    const values = (field: keyof ComparableLaborPoint) => periods
      ? periods.map(period => {
        const point = byPeriod?.get(period);
        return point
          && laborCompletenessStatus(point) === LABOR_COMPLETENESS_STATUS.visible
          && typeof point[field] === 'number'
          ? point[field] as number
          : null;
      })
      : trendPrimaryValues(points, field);
    return [
      {
        name: `${label} 实际`,
        type: 'line' as const,
        smooth: true,
        symbolSize: 5,
        lineStyle: { color, type: 'solid' as const },
        itemStyle: { color },
        data: values(isHours ? 'actual_hours' : 'actual_revenue_per_hour'),
      },
      {
        name: `${label} 排班`,
        type: 'line' as const,
        smooth: true,
        symbolSize: 5,
        lineStyle: { color, type: 'dashed' as const },
        itemStyle: { color },
        data: values(isHours ? 'planned_hours' : 'planned_revenue_per_hour'),
      },
    ];
  });
}
