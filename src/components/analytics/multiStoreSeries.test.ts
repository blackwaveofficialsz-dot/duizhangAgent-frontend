import { describe, expect, it } from 'vitest';
import {
  buildLaborStoreSeries,
  buildProductStoreSeries,
  buildRevenueStoreSourceSeries,
  buildRevenueStoreSeries,
  selectProductStorePoints,
  selectRevenueStorePoints,
  selectedStoreTrendMap,
  trendPrimaryValues,
} from './multiStoreSeries';
import {
  buildProductComparisonSeries,
  buildProductMovingAverageSeries,
  formatProductPeriodLabel,
  formatProductTrendTooltip,
} from './ProductTrendChart';
import {
  buildLaborMovingAverageSeries,
  formatLaborPeriodLabel,
  formatLaborTrendTooltip,
} from './LaborTrendChart';

const labels = { '101': '门店A', '102': '门店B' };

describe('multi-store chart series', () => {
  it('keeps partial primary values visible while missing stays metadata', () => {
    const revenue = buildRevenueStoreSeries({
      '101': [{ period: '2026-W29', net_income: 120, order_count: 6, missing: true }],
    }, labels);
    const product = buildProductStoreSeries({
      '101': [{ period: '2026-W29', quantity: 8, sales_amount: 80, order_count: 8, missing: true }],
    }, labels);
    const labor = buildLaborStoreSeries({
      '101': [{
        period: '2026-W29', actual_hours: 12, planned_hours: 14,
        actual_revenue_per_hour: 100, planned_revenue_per_hour: 85, missing: true,
      }],
    }, labels, 'hours');

    expect(revenue[0].data).toEqual([120]);
    expect(product[0].data).toEqual([8]);
    expect(labor[0].data).toEqual([12]);
    expect(labor[1].data).toEqual([14]);
    expect(trendPrimaryValues([
      { value: 12, missing: true },
      { value: undefined, missing: false },
    ], 'value')).toEqual([12, null]);

    expect(selectRevenueStorePoints([], {
      '101': [{ period: '2026-W29', net_income: 120, order_count: 6, missing: true }],
      '102': [{ period: '2026-W29', net_income: 80, order_count: 4, missing: false, in_progress: true }],
    }, ['101', '102'])).toEqual([expect.objectContaining({
      net_income: 200, order_count: 10, missing: true, in_progress: true,
    })]);
    expect(selectProductStorePoints([], {
      '101': [{ period: '2026-W29', quantity: 6, sales_amount: 60, order_count: 5, missing: false }],
      '102': [{ period: '2026-W29', quantity: 2, sales_amount: 20, order_count: 2, missing: false, in_progress: true }],
    }, ['101', '102'])).toEqual([expect.objectContaining({
      quantity: 8, sales_amount: 80, order_count: 7, in_progress: true,
    })]);
  });

  it('builds one revenue and product line per store without MA', () => {
    const revenue = buildRevenueStoreSeries({
      '101': [{ period: '2026-07-01', net_income: 100, order_count: 5, ma7: 90, ma30: 80, ma180: 70, missing: false }],
      '102': [{ period: '2026-07-01', net_income: 200, order_count: 8, ma7: 180, ma30: 170, ma180: 160, missing: false }],
    }, labels);
    const product = buildProductStoreSeries({
      '101': [{ period: '2026-07-01', quantity: 2, sales_amount: 20, order_count: 2, ma7: 2, ma30: 2, ma180: 2, missing: false }],
      '102': [{ period: '2026-07-01', quantity: 3, sales_amount: 30, order_count: 3, ma7: 3, ma30: 3, ma180: 3, missing: false }],
    }, labels);

    expect(revenue.map(series => series.name)).toEqual(['门店A', '门店B']);
    expect(product.map(series => series.name)).toEqual(['门店A', '门店B']);
    expect([...revenue, ...product].some(series => series.name.includes('MA'))).toBe(false);
  });

  it('keeps actual and planned labor lines per store without MA', () => {
    const points = {
      '101': [{ period: '2026-07-01', actual_hours: 8, planned_hours: 9, actual_revenue_per_hour: 100, planned_revenue_per_hour: 90, missing: false }],
      '102': [{ period: '2026-07-01', actual_hours: 7, planned_hours: 8, actual_revenue_per_hour: 110, planned_revenue_per_hour: 95, missing: false }],
    };
    const series = buildLaborStoreSeries(points, labels, 'hours');

    expect(series.map(item => item.name)).toEqual(['门店A 实际', '门店A 排班', '门店B 实际', '门店B 排班']);
    expect(series.some(item => item.name.includes('MA'))).toBe(false);
    expect(series[0].lineStyle.type).toBe('solid');
    expect(series[1].lineStyle.type).toBe('dashed');
  });

  it('aligns comparison lines by period and hides incomplete labor dates', () => {
    const points = {
      '101': [
        { period: '2026-07-28', actual_hours: 8, planned_hours: 10, actual_revenue_per_hour: 100, planned_revenue_per_hour: 80, missing: false },
        { period: '2026-07-29', actual_hours: 0, planned_hours: 10, actual_revenue_per_hour: 0, planned_revenue_per_hour: 90, missing: false },
      ],
      '102': [
        { period: '2026-07-28', actual_hours: 7, planned_hours: 9, actual_revenue_per_hour: 110, planned_revenue_per_hour: 85, missing: false },
      ],
    };
    const series = buildLaborStoreSeries(points, labels, 'hours', ['2026-07-28', '2026-07-29']);

    expect(series[0].data).toEqual([8, null]);
    expect(series[1].data).toEqual([10, null]);
    expect(series[2].data).toEqual([7, null]);
    expect(series[3].data).toEqual([9, null]);
  });

  it('assigns distinct stable colors to stores across comparison charts', () => {
    const revenuePoints = {
      '101': [{ period: '2026-07-01', net_income: 100, order_count: 5, ma7: 90, ma30: 80, ma180: 70, missing: false }],
      '102': [{ period: '2026-07-01', net_income: 200, order_count: 8, ma7: 180, ma30: 170, ma180: 160, missing: false }],
    };
    const productPoints = {
      '102': [{ period: '2026-07-01', quantity: 3, sales_amount: 30, order_count: 3, ma7: 3, ma30: 3, ma180: 3, missing: false }],
      '101': [{ period: '2026-07-01', quantity: 2, sales_amount: 20, order_count: 2, ma7: 2, ma30: 2, ma180: 2, missing: false }],
    };
    const laborPoints = {
      '101': [{ period: '2026-07-01', actual_hours: 8, planned_hours: 9, actual_revenue_per_hour: 100, planned_revenue_per_hour: 90, missing: false }],
      '102': [{ period: '2026-07-01', actual_hours: 7, planned_hours: 8, actual_revenue_per_hour: 110, planned_revenue_per_hour: 95, missing: false }],
    };

    const revenue = buildRevenueStoreSeries(revenuePoints, labels);
    const product = buildProductStoreSeries(productPoints, labels);
    const labor = buildLaborStoreSeries(laborPoints, labels, 'hours');
    const colorOf = (series: { name: string; lineStyle?: { color?: string } }[], name: string) =>
      series.find(item => item.name === name)?.lineStyle?.color;

    expect(colorOf(revenue, '门店A')).toBeTruthy();
    expect(colorOf(revenue, '门店A')).not.toBe(colorOf(revenue, '门店B'));
    expect(colorOf(revenue, '门店A')).toBe('#486FA6');
    expect(colorOf(revenue, '门店B')).toBe('#C8733A');
    expect(colorOf(product, '门店A')).toBe(colorOf(revenue, '门店A'));
    expect(colorOf(labor, '门店A 实际')).toBe(colorOf(revenue, '门店A'));
    expect(colorOf(labor, '门店A 排班')).toBe(colorOf(revenue, '门店A'));
  });

  it('uses one store color with solid shop and dashed takeout lines', () => {
    const point = (netIncome: number) => ({
      period: '2026-07-01',
      net_income: netIncome,
      order_count: 5,
      ma7: null,
      ma30: null,
      ma180: null,
      missing: false,
    });
    const series = buildRevenueStoreSourceSeries(
      { '101': [point(100)], '102': [point(200)] },
      { '101': [point(80)], '102': [point(160)] },
      labels,
    );

    expect(series.map(item => item.name)).toEqual([
      '门店A 堂食', '门店A 外卖', '门店B 堂食', '门店B 外卖',
    ]);
    expect(series[0].lineStyle.type).toBe('solid');
    expect(series[1].lineStyle.type).toBe('dashed');
    expect(series[0].lineStyle.color).toBe(series[1].lineStyle.color);
    expect(series[0].lineStyle.color).not.toBe(series[2].lineStyle.color);
  });

  it('reuses the original store points for a single selection', () => {
    const revenueStores = {
      '101': [{ period: '2026-07-01', net_income: 100, order_count: 5, ma7: 90, ma30: 80, ma180: 70, missing: false }],
      '102': [{ period: '2026-07-01', net_income: 200, order_count: 8, ma7: 180, ma30: 170, ma180: 160, missing: false }],
    };
    const productStores = {
      '101': [{ period: '2026-07-01', quantity: 2, sales_amount: 20, order_count: 2, ma7: 2, ma30: 2, ma180: 2, missing: false }],
    };

    expect(selectRevenueStorePoints([], revenueStores, ['101'])).toBe(revenueStores['101']);
    expect(selectProductStorePoints([], productStores, ['101'])).toBe(productStores['101']);
  });

  it('aggregates selected store points for summary values and filters comparison lines', () => {
    const stores = {
      '101': [{ period: '2026-07-01', net_income: 100, order_count: 5, ma7: 90, ma30: 80, ma180: 70, missing: false }],
      '102': [{ period: '2026-07-01', net_income: 200, order_count: 8, ma7: 180, ma30: 170, ma180: 160, missing: false }],
      '103': [{ period: '2026-07-01', net_income: 300, order_count: 9, ma7: 280, ma30: 270, ma180: 260, missing: false }],
    };

    expect(selectRevenueStorePoints([], stores, ['101', '102'])).toEqual([{
      period: '2026-07-01',
      net_income: 300,
      order_count: 13,
      ma7: null,
      ma30: null,
      ma180: null,
      missing: false,
    }]);
    expect(Object.keys(selectedStoreTrendMap(stores, ['101', '102']))).toEqual(['101', '102']);
  });
});

describe('dynamic trend chart series', () => {
  it('aligns selected products into one quantity line per product', () => {
    const comparison = buildProductComparisonSeries({
      A: [
        { period: '2026-W28', quantity: 8, sales_amount: 80, order_count: 6, missing: false },
        { period: '2026-W29', quantity: 9, sales_amount: 90, order_count: 7, missing: false },
      ],
      B: [
        { period: '2026-W29', quantity: 5, sales_amount: 50, order_count: 4, missing: false },
        { period: '2026-W30', quantity: 6, sales_amount: 60, order_count: 5, missing: false },
      ],
    }, { A: '产品A', B: '产品B' });

    expect(comparison.periods).toEqual(['2026-W28', '2026-W29', '2026-W30']);
    expect(comparison.series.map(item => item.name)).toEqual(['产品A', '产品B']);
    expect(comparison.series[0].data).toEqual([8, 9, null]);
    expect(comparison.series[1].data).toEqual([null, 5, 6]);
  });

  it('uses only available product moving-average fields from the response', () => {
    const points = [{
      period: '2026-W29', quantity: 10, sales_amount: 100, order_count: 5,
      missing: false, ma4: 8, ma12: null, sales_amount_ma4: 80,
    }];
    const series = buildProductMovingAverageSeries(points, [
      { field: 'ma4', label: 'MA4', window: 4, available: true, available_periods: 5 },
      { field: 'sales_amount_ma4', label: 'SALES_AMOUNT_MA4', window: 4, available: true, available_periods: 5 },
      { field: 'ma12', label: 'MA12', window: 12, available: false, available_periods: 5 },
    ]);

    expect(series.map(item => item.name)).toEqual(['MA4']);
    expect(series[0].data).toEqual([8]);
  });

  it('maps labor metadata to the four real metric field families', () => {
    const points = [{
      period: '2026-W29', net_revenue: 900, actual_hours: 8, planned_hours: 9,
      actual_revenue_per_hour: 112.5, planned_revenue_per_hour: 100, headcount: 2,
      missing: false, actual_hours_ma4: 7, planned_hours_ma4: 8,
      actual_revenue_per_hour_ma4: 110, planned_revenue_per_hour_ma4: 98,
      actual_hours_ma4_shadow: 99,
    }];
    const metadata = [
      { field: 'actual_hours_ma4', label: 'ACTUAL_HOURS_MA4', window: 4, available: true, available_periods: 5 },
      { field: 'planned_hours_ma4', label: 'PLANNED_HOURS_MA4', window: 4, available: true, available_periods: 5 },
      { field: 'actual_revenue_per_hour_ma4', label: 'ACTUAL_REVENUE_PER_HOUR_MA4', window: 4, available: true, available_periods: 5 },
      { field: 'planned_revenue_per_hour_ma4', label: 'PLANNED_REVENUE_PER_HOUR_MA4', window: 4, available: true, available_periods: 5 },
      { field: 'actual_hours_ma4_shadow', label: 'INVALID', window: 4, available: true, available_periods: 5 },
    ];

    expect(buildLaborMovingAverageSeries(points, metadata, 'hours').map(item => [item.name, item.data])).toEqual([
      ['实际 MA4', [7]], ['排班 MA4', [8]],
    ]);
    expect(buildLaborMovingAverageSeries(points, metadata, 'efficiency').map(item => [item.name, item.data])).toEqual([
      ['实际 MA4', [110]], ['排班 MA4', [98]],
    ]);
  });

  it('formats period labels and exposes incomplete period status in tooltips', () => {
    expect(formatProductPeriodLabel('2026-07-20', 'day')).toBe('07-20');
    expect(formatProductPeriodLabel('2026-W29', 'week')).toBe('W29');
    expect(formatLaborPeriodLabel('2026-07', 'month')).toBe('2026-07');
    expect(formatProductTrendTooltip([{ dataIndex: 0, seriesName: '销量', value: 10 }], [{
      period: '2026-W29', quantity: 10, sales_amount: 100, order_count: 5, missing: false, in_progress: true,
    }])).toContain('进行中');
    expect(formatLaborTrendTooltip([{ dataIndex: 0, seriesName: '实际工时', value: null }], [{
      period: '2026-W29', net_revenue: 0, actual_hours: 0, planned_hours: 0,
      actual_revenue_per_hour: 0, planned_revenue_per_hour: 0, headcount: 0, missing: true,
    }], 'h')).toContain('数据不完整');
    expect(formatProductTrendTooltip([{ dataIndex: 0, seriesName: '销量', value: 10 }], [{
      period: '2026-W29', quantity: 10, sales_amount: 100, order_count: 5,
      missing: true, in_progress: true,
    }])).toContain('进行中 · 数据不完整');
  });
});
