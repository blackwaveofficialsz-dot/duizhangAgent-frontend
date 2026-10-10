import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsApi = vi.hoisted(() => ({
  getRevenueTrend: vi.fn(),
  getMealPeriods: vi.fn(),
  getMealPeriodTrend: vi.fn(),
  getMealPeriodTurnover: vi.fn(),
  listStoreScopeTree: vi.fn(),
  listShopMappings: vi.fn(),
}));

vi.mock('../../api/analytics', () => analyticsApi);
const pollingHook = vi.hoisted(() => ({ usePolling: vi.fn() }));
vi.mock('../../hooks/usePolling', () => pollingHook);

const operationsApi = vi.hoisted(() => ({
  fetchOperationsOverview: vi.fn().mockResolvedValue({
    period: { date_from: '2026-07-01', date_to: '2026-07-10' },
    previous_period: { date_from: '2026-06-21', date_to: '2026-06-30' },
    metrics: {
      paid_amount: { current: 1200, previous: 1000, difference: 200, change_rate: 0.2, status: 'ok' },
      net_income: { current: 1000, previous: 800, difference: 200, change_rate: 0.25, status: 'ok' },
      order_count: { current: 100, previous: 80, difference: 20, change_rate: 0.25, status: 'ok' },
      avg_order_value: { current: 12, previous: 12.5, difference: -0.5, change_rate: -0.04, status: 'ok' },
    },
    latest_metrics: {
      net_income: { current: 300, previous: 240, difference: 60, change_rate: 0.25, status: 'ok' },
      order_count: { current: 30, previous: 24, difference: 6, change_rate: 0.25, status: 'ok' },
    },
    channels: [
      {
        dim_key: 'shop',
        dim_label: '堂食',
        metrics: {
          paid_amount: { current: 700, previous: 600, difference: 100, change_rate: 1 / 6, status: 'ok' },
          net_income: { current: 600, previous: 500, difference: 100, change_rate: 0.2, status: 'ok' },
          order_count: { current: 60, previous: 50, difference: 10, change_rate: 0.2, status: 'ok' },
          avg_order_value: { current: 11.67, previous: 12, difference: -0.33, change_rate: -0.0275, status: 'ok' },
        },
        latest_metrics: {
          net_income: { current: 180, previous: 150, difference: 30, change_rate: 0.2, status: 'ok' },
          order_count: { current: 18, previous: 15, difference: 3, change_rate: 0.2, status: 'ok' },
        },
      },
      {
        dim_key: 'takeout',
        dim_label: '外卖',
        metrics: {
          paid_amount: { current: 500, previous: 400, difference: 100, change_rate: 0.25, status: 'ok' },
          net_income: { current: 400, previous: 300, difference: 100, change_rate: 1 / 3, status: 'ok' },
          order_count: { current: 40, previous: 30, difference: 10, change_rate: 1 / 3, status: 'ok' },
          avg_order_value: { current: 12.5, previous: 13.33, difference: -0.83, change_rate: -0.0623, status: 'ok' },
        },
        latest_metrics: {
          net_income: { current: 120, previous: 90, difference: 30, change_rate: 1 / 3, status: 'ok' },
          order_count: { current: 12, previous: 9, difference: 3, change_rate: 1 / 3, status: 'ok' },
        },
      },
    ],
    platforms: [], stores: [], sections: {},
    completeness: { data_status: 'ready' },
    generated_at: '2026-07-11T09:00:00+08:00',
  }),
}));

vi.mock('../../features/operations-analysis/api/client', () => operationsApi);

const dailyFactsApi = vi.hoisted(() => ({
  getOrderDailyFacts: vi.fn(),
  getMealDailyFacts: vi.fn(),
}));

vi.mock('../../api/analyticsDailyFacts', () => dailyFactsApi);

import {
  buildRevenueMovingAverageSeries,
  DashboardPage,
  formatRevenueTrendTooltip,
  legendSelectionFromEvent,
  legendSelectionFromOption,
  mealPeriodTimeRange,
  mealTrendPointsFromFacts,
  mealTurnoverFromFacts,
  mealTrendDateFromChartClick,
  mealTrendMetricUnit,
  mealTrendMetricValue,
  mergeTrendPoints,
  preserveLegendSelection,
  rememberLegendSelection,
  sameMealPeriodTrendChartProps,
  sameTrendMainChartProps,
  summarizeRevenueTrend,
  trendPointStatusText,
} from './DashboardPage';

const scopeTreeResponse = {
  nodes: [{
    key: 'dept:80',
    type: 'department' as const,
    label: '事业1部',
    children: [
      { key: 'shop:801', type: 'store' as const, label: '门店A', store_key: '801' },
      { key: 'shop:802', type: 'store' as const, label: '门店B', store_key: '802' },
    ],
  }],
  store_count: 2,
  source: 'test',
};

async function chooseScope(label: string) {
  await waitFor(() => expect(analyticsApi.listStoreScopeTree).toHaveBeenCalled());
  fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
  const options = await screen.findAllByText(label);
  fireEvent.click(options[options.length - 1]);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  dailyFactsApi.getOrderDailyFacts.mockRejectedValue(new Error('unsupported'));
  dailyFactsApi.getMealDailyFacts.mockRejectedValue(new Error('unsupported'));
  analyticsApi.getRevenueTrend.mockResolvedValue({ points: [] });
  analyticsApi.getMealPeriods.mockResolvedValue({ periods: [] });
  analyticsApi.getMealPeriodTrend.mockResolvedValue({ points: [] });
  analyticsApi.getMealPeriodTurnover.mockResolvedValue({
    data_status: 'missing',
    date_from: '2026-07-01',
    date_to: '2026-07-10',
    day_count: 10,
    eligible_store_count: 0,
    table_count: 0,
    excluded_stores: [],
    summary: [],
    points: [],
    store_summaries: [],
  });
  analyticsApi.listStoreScopeTree.mockResolvedValue({ nodes: [], store_count: 0, source: 'test' });
  analyticsApi.listShopMappings.mockResolvedValue([]);
});

describe('mealTrendDateFromChartClick', () => {
  const points = [
    { date: '2026-06-01' },
    { date: '2026-06-02' },
  ];

  it('maps ECharts dataIndex to the full business date', () => {
    expect(mealTrendDateFromChartClick({ dataIndex: 1 }, points)).toBe('2026-06-02');
  });

  it('maps clicked axis label to the full business date', () => {
    expect(mealTrendDateFromChartClick({ value: '06-02' }, points)).toBe('2026-06-02');
    expect(mealTrendDateFromChartClick({ name: '2026-06-01' }, points)).toBe('2026-06-01');
  });

  it('ignores clicks outside trend points', () => {
    expect(mealTrendDateFromChartClick({ dataIndex: 9 }, points)).toBeNull();
    expect(mealTrendDateFromChartClick({}, points)).toBeNull();
  });

});

describe('mealTrendMetricValue', () => {
  it('uses turnover data and units without mixing it with revenue', () => {
    expect(mealTrendMetricValue('business', { net_income: 88 }, undefined)).toBe(88);
    expect(
      mealTrendMetricValue('turnover', undefined, { turnover: 4.14 }),
    ).toBe(4.14);
    expect(mealTrendMetricUnit('turnover')).toBe('次/桌');
  });
});

describe('mealTurnoverFromFacts', () => {
  it('calculates MA7 from daily turnover values', () => {
    const facts = Array.from({ length: 7 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      stores: {
        A: {
          store_key: 'A',
          table_count: 10,
          periods: {
            lunch: {
              period_key: 'lunch' as const,
              shop_order_count: (index + 1) * 10,
            },
          },
        },
      },
    }));

    const result = mealTurnoverFromFacts(facts, '2026-08-01', '2026-08-07', [], { A: '门店A' });

    expect(result.points[5].lunch.ma7).toBe(3.5);
    expect(result.points[6].lunch).toMatchObject({ turnover: 7, ma7: 4 });
    expect(result.store_trends?.A[6].lunch).toMatchObject({ turnover: 7, ma7: 4 });
  });

  it('uses available complete days in turnover moving averages', () => {
    const facts = Array.from({ length: 8 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      complete: index !== 3,
      stores: {
        A: {
          store_key: 'A',
          table_count: 10,
          periods: {
            lunch: {
              period_key: 'lunch' as const,
              shop_order_count: (index + 1) * 10,
            },
          },
        },
      },
    }));

    const result = mealTurnoverFromFacts(facts, '2026-08-01', '2026-08-08', [], { A: '门店A' });

    expect(result.points.map(point => point.date)).not.toContain('2026-08-04');
    expect(result.points[result.points.length - 1]?.lunch).toMatchObject({ turnover: 8, ma7: 5.17 });
    const storePoints = result.store_trends?.A || [];
    expect(storePoints[storePoints.length - 1]?.lunch.ma7).toBe(5.17);
  });
});

describe('mealTrendPointsFromFacts', () => {
  it('calculates revenue moving averages from available complete days', () => {
    const facts = Array.from({ length: 8 }, (_, index) => ({
      date: `2026-08-${String(index + 1).padStart(2, '0')}`,
      complete: index !== 3,
      stores: {
        A: {
          store_key: 'A',
          periods: {
            lunch: {
              period_key: 'lunch' as const,
              order_count: 1,
              income_amount_cent: (index + 1) * 100,
              net_income_cent: (index + 1) * 100,
            },
          },
        },
      },
    }));

    const points = mealTrendPointsFromFacts(facts, []);

    expect(points.map(point => point.date)).not.toContain('2026-08-04');
    expect(points[points.length - 1]?.lunch).toMatchObject({ net_income: 8, ma7: 5.17 });
  });

  it('calculates weekly and monthly meal moving averages from hidden complete periods', () => {
    const facts = Array.from({ length: 374 }, (_, index) => {
      const date = new Date(Date.UTC(2025, 7, 1 + index)).toISOString().slice(0, 10);
      return {
        date,
        stores: {
          A: {
            store_key: 'A',
            periods: {
              lunch: {
                period_key: 'lunch' as const,
                order_count: 1,
                income_amount_cent: 100,
                net_income_cent: 100,
              },
            },
          },
        },
      };
    });

    const weekly = mealTrendPointsFromFacts(
      facts,
      [],
      'week',
      false,
      '2026-02-09',
      '2026-08-09',
      '2026-07-06',
      '2026-08-09',
    );
    const monthly = mealTrendPointsFromFacts(
      facts,
      [],
      'month',
      false,
      '2025-08-01',
      '2026-07-31',
      '2026-03-01',
      '2026-07-31',
    );

    expect(weekly).toHaveLength(5);
    expect(weekly[weekly.length - 1]?.lunch.ma26).toBe(7);
    expect(monthly).toHaveLength(5);
    expect(monthly[monthly.length - 1]?.lunch.ma12).toBeGreaterThan(28);
  });
});

describe('chart legend state', () => {
  it('ignores empty chart options before the first ECharts setOption call', () => {
    expect(legendSelectionFromOption(undefined)).toBeUndefined();
  });

  it('keeps hidden legend lines when chart options are refreshed', () => {
    const option = preserveLegendSelection(
      {
        legend: { top: 0 },
        series: [{ name: '堂食' }, { name: '外卖' }],
      },
      { 外卖: false },
    ) as { legend: { selected?: Record<string, boolean> } };

    expect(option.legend.selected).toEqual({ 外卖: false });
  });

  it('keeps the latest legend event selection for a later chart refresh', () => {
    const option = preserveLegendSelection(
      {
        legend: { top: 0 },
        series: [{ name: '堂食' }, { name: '外卖' }],
      },
      legendSelectionFromEvent({ selected: { 堂食: false, 外卖: true } }),
    ) as { legend: { selected?: Record<string, boolean> } };

    expect(option.legend.selected).toEqual({ 堂食: false, 外卖: true });
  });

  it('restores multi-store visibility after the chart instance is rebuilt', () => {
    const shared = { current: undefined as Record<string, boolean> | undefined };
    rememberLegendSelection(shared, {
      selected: { 凤八店: false, 阳光荟: true },
    });

    const option = preserveLegendSelection({
      legend: { top: 0 },
      series: [{ name: '凤八店' }, { name: '阳光荟' }],
    }, shared.current) as { legend: { selected?: Record<string, boolean> } };

    expect(option.legend.selected).toEqual({ 凤八店: false, 阳光荟: true });
  });

  it('does not redraw source comparison series for unrelated parent updates', () => {
    const shop = [{ period: '2026-07-19', net_income: 100, order_count: 10, missing: false }];
    const takeout = [{ period: '2026-07-19', net_income: 80, order_count: 8, missing: false }];
    const shopMovingAverages = [
      { field: 'ma7', label: 'MA7', window: 7, available: true, available_periods: 10 },
    ];
    const takeoutMovingAverages = [
      { field: 'ma7', label: 'MA7', window: 7, available: true, available_periods: 10 },
    ];

    expect(sameTrendMainChartProps(
      {
        points: mergeTrendPoints(shop, takeout),
        compare: { shop, takeout },
        sourceMovingAverages: { shop: shopMovingAverages, takeout: takeoutMovingAverages },
        storeLabels: {},
        onFullscreen: vi.fn(),
      },
      {
        points: mergeTrendPoints(shop, takeout),
        compare: { shop, takeout },
        sourceMovingAverages: { shop: shopMovingAverages, takeout: takeoutMovingAverages },
        storeLabels: { '801': '迟到的门店树更新' },
        onFullscreen: vi.fn(),
      },
    )).toBe(true);
  });

  it('does not redraw meal business series for unrelated parent updates', () => {
    const points = [{ date: '2026-07-19' }] as never[];

    expect(sameMealPeriodTrendChartProps(
      {
        points,
        periodKey: 'lunch',
        onSelectDate: vi.fn(),
        onFullscreen: vi.fn(),
      },
      {
        points,
        periodKey: 'lunch',
        onSelectDate: vi.fn(),
        onFullscreen: vi.fn(),
      },
    )).toBe(true);
  });

  it('does not redraw meal turnover series for irrelevant points updates', () => {
    const turnoverPoints = [{ date: '2026-07-19' }] as never[];

    expect(sameMealPeriodTrendChartProps(
      {
        points: [],
        turnoverPoints,
        periodKey: 'lunch',
        metricMode: 'turnover',
      },
      {
        points: [],
        turnoverPoints,
        periodKey: 'lunch',
        metricMode: 'turnover',
      },
    )).toBe(true);
  });
});

describe('mealPeriodTimeRange', () => {
  it('renders fixed business time ranges for meal period cards', () => {
    expect(mealPeriodTimeRange('breakfast')).toBe('06:00-10:00');
    expect(mealPeriodTimeRange('late_night')).toBe('22:00-次日06:00');
  });
});

describe('trend point status', () => {
  it('explains current and incomplete periods in the tooltip', () => {
    expect(trendPointStatusText({ in_progress: true, missing: false })).toBe('进行中');
    expect(trendPointStatusText({ in_progress: false, missing: true })).toBe('数据不完整');
    expect(trendPointStatusText({ in_progress: true, missing: true })).toBe('进行中 · 数据不完整');
  });
});

describe('revenue trend option helpers', () => {
  describe('integer-cent money aggregation', () => {
    it('sums 0.1 and 0.2 exactly', () => {
      expect(summarizeRevenueTrend([
        { period: '2026-07-01', net_income: 0.1, order_count: 1, missing: false },
        { period: '2026-07-02', net_income: 0.2, order_count: 1, missing: false },
      ]).total).toBe(0.3);
    });

    it('sums a large batch without floating-point drift', () => {
      const points = Array.from({ length: 100_000 }, (_, index) => ({
        period: `row-${index}`,
        net_income: 0.01,
        order_count: 1,
        missing: false,
      }));

      expect(summarizeRevenueTrend(points).total).toBe(1000);
    });

    it('merges negative money exactly', () => {
      expect(mergeTrendPoints(
        [{ period: '2026-07-01', net_income: -0.1, order_count: 1, missing: false }],
        [{ period: '2026-07-01', net_income: -0.2, order_count: 2, missing: false }],
      )[0]?.net_income).toBe(-0.3);
    });
  });

  it('keeps partial values in the summary and latest point', () => {
    const partial = {
      period: '2026-W29', net_income: 120, order_count: 6, missing: true,
    };
    expect(summarizeRevenueTrend([partial])).toEqual({ total: 120, lastPoint: partial });
    expect(mergeTrendPoints([
      { ...partial, in_progress: true },
    ], [
      { period: '2026-W29', net_income: 80, order_count: 4, missing: false },
    ])).toEqual([expect.objectContaining({
      net_income: 200, order_count: 10, missing: true, in_progress: true,
    })]);
  });

  it('builds only the independently available moving averages for each source', () => {
    const points = [{
      period: '2026-07-19',
      net_income: 100,
      order_count: 10,
      ma3: 90,
      ma12: 80,
      missing: false,
    }];
    const shopSeries = buildRevenueMovingAverageSeries(points, ['2026-07-19'], [
      { field: 'ma3', label: 'MA3', window: 3, available: true, available_periods: 5 },
      { field: 'ma12', label: 'MA12', window: 12, available: false, available_periods: 5 },
    ], '堂食 ');
    const takeoutSeries = buildRevenueMovingAverageSeries(points, ['2026-07-19'], [
      { field: 'ma3', label: 'MA3', window: 3, available: false, available_periods: 5 },
      { field: 'ma12', label: 'MA12', window: 12, available: true, available_periods: 5 },
    ], '外卖 ');

    expect(shopSeries.map(series => series.name)).toEqual(['堂食 MA3']);
    expect(takeoutSeries.map(series => series.name)).toEqual(['外卖 MA12']);
  });

  it('escapes dynamic tooltip text while preserving the ECharts marker', () => {
    const marker = '<span class="echarts-marker"></span>';
    const tooltip = formatRevenueTrendTooltip(
      [{ dataIndex: 0, marker, seriesName: '门店<img src=x onerror=evil(1)>', value: 12 }],
      ['2026-07-19<b>'],
      [],
    );

    expect(tooltip).toContain(marker);
    expect(tooltip).toContain('2026-07-19&lt;b&gt;');
    expect(tooltip).toContain('门店&lt;img src=x onerror=evil(1)&gt;');
    expect(tooltip).not.toContain('2026-07-19<b>');
    expect(tooltip).not.toContain('门店<img');
  });
});

describe('DashboardPage meal metric switch', () => {
  it('defaults cards to the latest period and switches them without reloading trends', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalled());
    const initialTrendCallCount = analyticsApi.getRevenueTrend.mock.calls.length;
    const latestDate = analyticsApi.getRevenueTrend.mock.calls[analyticsApi.getRevenueTrend.mock.calls.length - 1]?.[1] as string;

    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ dateFrom: latestDate, dateTo: latestDate }),
      }),
    ));
    expect(screen.getByLabelText('经营看板卡片周期')).toBeTruthy();
    const periodSummary = screen.getByTestId('dashboard-period-summary');
    expect(periodSummary.className).toContain('bg-slate-50');
    expect(within(periodSummary).getByText('统计周期')).toBeTruthy();
    expect(screen.queryByText('最近日净实收')).toBeNull();
    expect(screen.queryByText('最近日订单')).toBeNull();

    const previousDate = new Date(`${latestDate}T00:00:00Z`);
    previousDate.setUTCDate(previousDate.getUTCDate() - 1);
    const previousDateText = previousDate.toISOString().slice(0, 10);
    fireEvent.mouseDown(screen.getByLabelText('经营看板卡片周期'));
    const options = await screen.findAllByText(previousDateText);
    fireEvent.click(options[options.length - 1]);

    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ dateFrom: previousDateText, dateTo: previousDateText }),
      }),
    ));
    expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(initialTrendCallCount);
  });

  it('keeps desktop filters in one non-wrapping row', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));

    const controls = await screen.findByTestId('dashboard-desktop-controls');
    expect(controls.className).toContain('md:flex-nowrap');
    expect(within(controls).getByTestId('trend-period-controls').className).toContain('md:flex-row');
    expect(within(controls).getByLabelText('经营看板对比方式')).toBeTruthy();
    expect(within(controls).queryByLabelText('经营看板对比展示')).toBeNull();
    expect(within(screen.getByTestId('dashboard-period-summary')).getByLabelText('经营看板对比展示')).toBeTruthy();
    expect(screen.getAllByText('较上期 +25.0%').length).toBeGreaterThan(0);
  });

  it('keeps current metrics but hides comparison text when comparison is disabled', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));
    expect((await screen.findAllByText('较上期 +25.0%')).length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByLabelText('经营看板对比方式'));
    const options = await screen.findAllByText('不对比');
    fireEvent.click(options[options.length - 1]);

    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ compare: 'none' }) }),
    ));
    await waitFor(() => expect(screen.queryAllByText('较上期 +25.0%')).toHaveLength(0));
    expect(screen.getByText('¥1,200.00')).toBeTruthy();
  });

  it('shows comparisons on the four selected-period cards', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));

    const revenueCard = (await screen.findByText('¥1,000.00')).parentElement!;
    const ordersCard = screen.getByText('100').parentElement!;
    expect(within(revenueCard).getByText('¥1,000.00')).toBeTruthy();
    expect(within(revenueCard).getByText('较上期 +25.0%')).toBeTruthy();
    expect(within(ordersCard).getByText('100')).toBeTruthy();
    expect(within(ordersCard).getByText('较上期 +25.0%')).toBeTruthy();
  });

  it('switches comparison presentation without reloading dashboard data', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));
    expect((await screen.findAllByText('较上期 +25.0%')).length).toBeGreaterThan(0);
    const requestCount = operationsApi.fetchOperationsOverview.mock.calls.length;

    fireEvent.mouseDown(screen.getByLabelText('经营看板对比展示'));
    const differenceOptions = await screen.findAllByText('差值');
    fireEvent.click(differenceOptions[differenceOptions.length - 1]);
    expect((await screen.findAllByText('较上期 +¥200.00')).length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByLabelText('经营看板对比展示'));
    const previousOptions = await screen.findAllByText('上期数据');
    fireEvent.click(previousOptions[previousOptions.length - 1]);
    expect((await screen.findAllByText('上期 ¥800.00')).length).toBeGreaterThan(0);

    fireEvent.mouseDown(screen.getByLabelText('经营看板对比展示'));
    const allOptions = await screen.findAllByText('全部');
    fireEvent.click(allOptions[allOptions.length - 1]);
    expect((await screen.findAllByText('上期 ¥800.00 · 差值 +¥200.00 · 比例 +25.0%')).length).toBeGreaterThan(0);
    expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(requestCount);
  });

  it('splits KPI statistics into shop and takeout groups in source mode', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));
    const sourceButtons = await screen.findAllByText('堂食/外卖');
    fireEvent.click(sourceButtons[sourceButtons.length - 1]);

    const shop = await screen.findByRole('region', { name: '堂食经营统计' });
    const takeout = screen.getByRole('region', { name: '外卖经营统计' });
    expect(within(shop).getByText('¥700.00')).toBeTruthy();
    expect(within(shop).getByText('¥600.00')).toBeTruthy();
    expect(within(shop).getByText('60')).toBeTruthy();
    expect(within(takeout).getByText('¥500.00')).toBeTruthy();
    expect(within(takeout).getByText('¥400.00')).toBeTruthy();
    expect(within(takeout).getByText('40')).toBeTruthy();
  });

  it('keeps shop and takeout statistics scoped to one selected store', async () => {
    analyticsApi.listStoreScopeTree.mockResolvedValue({
      nodes: [{ key: 'shop:801', type: 'store', label: '门店A', store_key: '801' }],
      store_count: 1,
      source: 'test',
    });
    render(createElement(DashboardPage, { show: vi.fn() }));

    await chooseScope('门店A');
    const sourceButtons = await screen.findAllByText('堂食/外卖');
    fireEvent.click(sourceButtons[sourceButtons.length - 1]);

    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ storeKeys: ['801'] }),
      }),
    ));
    const shop = await screen.findByRole('region', { name: '堂食经营统计' });
    const takeout = screen.getByRole('region', { name: '外卖经营统计' });
    expect(within(shop).getByText('门店A')).toBeTruthy();
    expect(within(takeout).getByText('门店A')).toBeTruthy();
  });

  it('requests one aggregate series when a parent department is selected', async () => {
    analyticsApi.listStoreScopeTree.mockResolvedValue(scopeTreeResponse);
    analyticsApi.getRevenueTrend.mockResolvedValue({
      points: [{
        period: '2026-07-19',
        net_income: 300,
        order_count: 30,
        missing: false,
      }],
      moving_averages: [],
    });
    render(createElement(DashboardPage, { show: vi.fn() }));

    await chooseScope('事业1部');

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      'ALL',
      'all',
      expect.objectContaining({ storeKeys: ['801', '802'], includeStoreTrends: false }),
    ));
    expect(screen.queryByText('门店对比')).toBeNull();
    expect(await screen.findByText('事业1部净实收趋势')).toBeTruthy();
    expect(screen.getByRole('img', { name: '事业1部净实收趋势图' })).toBeTruthy();
  });

  it('keeps separately selected child departments as independent scopes', async () => {
    const point = (netIncome: number) => ({
      period: '2026-07-19',
      net_income: netIncome,
      order_count: 10,
      missing: false,
    });
    analyticsApi.listStoreScopeTree.mockResolvedValue({
      nodes: [{
        key: 'dept:80',
        type: 'department',
        label: '事业1部',
        children: [
          {
            key: 'dept:8010',
            type: 'department',
            label: '阳光荟',
            children: [{ key: 'shop:801', type: 'store', label: '阳光荟门店', store_key: '801' }],
          },
          {
            key: 'dept:8020',
            type: 'department',
            label: '唐城店',
            children: [{ key: 'shop:802', type: 'store', label: '唐城门店', store_key: '802' }],
          },
          {
            key: 'dept:8030',
            type: 'department',
            label: '凤八店',
            children: [{ key: 'shop:803', type: 'store', label: '凤八门店', store_key: '803' }],
          },
        ],
      }],
      store_count: 3,
      source: 'test',
    });
    analyticsApi.getRevenueTrend.mockImplementation(
      (_from: string, _to: string, _store: string, _source: string, options: { storeKeys?: string[] }) =>
        options.storeKeys?.length === 2
          ? Promise.resolve({
              points: [point(300)],
              store_trends: { '801': [point(100)], '802': [point(200)] },
              moving_averages: [],
            })
          : Promise.resolve({ points: [point(100)], moving_averages: [] }),
    );
    render(createElement(DashboardPage, { show: vi.fn() }));

    await waitFor(() => expect(analyticsApi.listStoreScopeTree).toHaveBeenCalled());
    fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
    const divisionOptions = await screen.findAllByText('事业1部');
    const divisionNode = divisionOptions[divisionOptions.length - 1].closest('.ant-select-tree-treenode')!;
    fireEvent.click(divisionNode.querySelector('.ant-select-tree-switcher')!);
    const sunshineOptions = await screen.findAllByText('阳光荟');
    fireEvent.click(sunshineOptions[sunshineOptions.length - 1]);

    fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
    const tangchengOptions = await screen.findAllByText('唐城店');
    fireEvent.click(tangchengOptions[tangchengOptions.length - 1]);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ storeKeys: ['801', '802'], includeStoreTrends: true }),
    ));
    expect(await screen.findByText('已选范围净实收趋势')).toBeTruthy();

    fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
    const fengbaOptions = await screen.findAllByText('凤八店');
    fireEvent.click(fengbaOptions[fengbaOptions.length - 1]);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ storeKeys: ['801', '802', '803'], includeStoreTrends: true }),
    ));
    expect(await screen.findByText('已选范围净实收趋势')).toBeTruthy();
  });

  it('switches to five completed weeks and keeps the picker controlled', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));
    const periodControls = await screen.findAllByLabelText('趋势粒度');

    fireEvent.click(periodControls[periodControls.length - 1].querySelector('[title="周"]')!);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ granularity: 'week', includeCurrent: false }),
    ));
    const latestWeekEnd = analyticsApi.getRevenueTrend.mock.calls[analyticsApi.getRevenueTrend.mock.calls.length - 1]?.[1] as string;
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(
      expect.objectContaining({
        filters: expect.objectContaining({ granularity: 'week', dateTo: latestWeekEnd }),
      }),
    ));
    expect(screen.getByLabelText('经营看板卡片周期')).toBeTruthy();
  });

  it('shows only available moving averages and explains insufficient windows', async () => {
    analyticsApi.getRevenueTrend.mockResolvedValue({
      points: [{
        period: '2026-07-19',
        net_income: 300,
        order_count: 30,
        ma3: 250,
        ma12: null,
        missing: false,
      }],
      moving_averages: [
        { field: 'ma3', label: 'MA3', window: 3, available: true, available_periods: 5 },
        { field: 'ma12', label: 'MA12', window: 12, available: false, available_periods: 5 },
      ],
    });

    render(createElement(DashboardPage, { show: vi.fn() }));

    expect(await screen.findByText('MA3')).toBeTruthy();
    expect(screen.getByText('MA12 数据不足')).toBeTruthy();
  });

  it('keeps the fullscreen chart mounted while filters reload data', async () => {
    analyticsApi.getRevenueTrend.mockResolvedValue({
      points: [{
        period: '2026-07-19',
        net_income: 300,
        order_count: 30,
        missing: false,
      }],
      moving_averages: [],
    });
    render(createElement(DashboardPage, { show: vi.fn() }));
    await screen.findByRole('img', { name: '净实收趋势主图' });
    fireEvent.click(screen.getAllByRole('button', { name: '全屏横屏查看图表' })[0]);
    const dialog = screen.getByRole('dialog');
    const fullscreenChart = within(dialog).getByRole('img', { name: '净实收趋势主图' });
    fireEvent.click(within(dialog).getByRole('button', { name: '筛选' }));

    let finishReload = (_value: unknown) => {};
    analyticsApi.getRevenueTrend.mockReturnValueOnce(new Promise(resolve => { finishReload = resolve; }));
    const periodControl = within(dialog).getByLabelText('趋势粒度');
    fireEvent.click(periodControl.querySelector('[title="周"]')!);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ granularity: 'week' }),
    ));
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(within(dialog).getByRole('img', { name: '净实收趋势主图' })).toBe(fullscreenChart);
    finishReload({ points: [], moving_averages: [] });
  });

  it('keeps the same fullscreen chart node while trend mode is applied', async () => {
    const point = {
      period: '2026-07-19',
      net_income: 300,
      order_count: 30,
      missing: false,
    };
    analyticsApi.getRevenueTrend.mockResolvedValue({ points: [point], moving_averages: [] });
    render(createElement(DashboardPage, { show: vi.fn() }));
    await screen.findByRole('img', { name: '净实收趋势主图' });
    fireEvent.click(screen.getAllByRole('button', { name: '全屏横屏查看图表' })[0]);
    const dialog = screen.getByRole('dialog');
    const chartNode = dialog.querySelector('.chart-fullscreen-content [role="img"]');
    fireEvent.click(within(dialog).getByRole('button', { name: '筛选' }));
    const shop = deferred<{ points: (typeof point)[]; moving_averages: [] }>();
    const takeout = deferred<{ points: (typeof point)[]; moving_averages: [] }>();
    analyticsApi.getRevenueTrend
      .mockReturnValueOnce(shop.promise)
      .mockReturnValueOnce(takeout.promise);

    fireEvent.click(within(dialog).getByText('堂食/外卖'));

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(3));
    expect(dialog.querySelector('.chart-fullscreen-content [role="img"]')).toBe(chartNode);
    await act(async () => {
      shop.resolve({ points: [point], moving_averages: [] });
      takeout.resolve({ points: [{ ...point, net_income: 120 }], moving_averages: [] });
    });
    await within(dialog).findByText('堂食/外卖净实收趋势');
    expect(dialog.querySelector('.chart-fullscreen-content [role="img"]')).toBe(chartNode);
  });

  it('keeps the same fullscreen chart node from a parent scope to explicit stores', async () => {
    const point = (netIncome: number) => ({
      period: '2026-07-19',
      net_income: netIncome,
      order_count: 10,
      missing: false,
    });
    analyticsApi.listStoreScopeTree.mockResolvedValue({
      nodes: [{
        key: 'dept:80',
        type: 'department',
        label: '事业1部',
        children: [
          { key: 'shop:801', type: 'store', label: '门店A', store_key: '801' },
          { key: 'shop:802', type: 'store', label: '门店B', store_key: '802' },
          { key: 'shop:803', type: 'store', label: '门店C', store_key: '803' },
        ],
      }],
      store_count: 3,
      source: 'test',
    });
    const explicitStores = deferred<{
      points: ReturnType<typeof point>[];
      store_trends: Record<string, ReturnType<typeof point>[]>;
      moving_averages: [];
    }>();
    analyticsApi.getRevenueTrend.mockImplementation(
      (_from: string, _to: string, _store: string, _source: string, options: { storeKeys?: string[] }) =>
        options.storeKeys?.length === 3
          ? explicitStores.promise
          : Promise.resolve({ points: [point(300)], moving_averages: [] }),
    );
    render(createElement(DashboardPage, { show: vi.fn() }));
    await chooseScope('事业1部');
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ storeKeys: ['801', '802', '803'], includeStoreTrends: false }),
    ));
    fireEvent.click(screen.getAllByRole('button', { name: '全屏横屏查看图表' })[0]);
    const dialog = screen.getByRole('dialog');
    const chartNode = dialog.querySelector('.chart-fullscreen-content [role="img"]');
    fireEvent.click(within(dialog).getByRole('button', { name: '筛选' }));
    const departmentNode = within(dialog).getByText('事业1部').closest('.ant-tree-treenode')!;
    fireEvent.click(departmentNode.querySelector('.ant-tree-switcher')!);
    const storeNode = (await within(dialog).findByText('门店C')).closest('.ant-tree-treenode')!;
    fireEvent.click(storeNode.querySelector('.ant-tree-checkbox')!);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ storeKeys: ['801', '802', '803'], includeStoreTrends: true }),
    ));
    expect(dialog.querySelector('.chart-fullscreen-content [role="img"]')).toBe(chartNode);
    await act(async () => {
      explicitStores.resolve({
        points: [point(300)],
        store_trends: { '801': [point(100)], '802': [point(100)], '803': [point(100)] },
        moving_averages: [],
      });
    });
    await within(dialog).findByText('已选范围净实收趋势');
    expect(dialog.querySelector('.chart-fullscreen-content [role="img"]')).toBe(chartNode);
  });

  it('keeps source moving-average availability and insufficient status separate', async () => {
    const point = {
      period: '2026-07-19',
      net_income: 300,
      order_count: 30,
      ma3: 280,
      ma12: 250,
      missing: false,
    };
    analyticsApi.getRevenueTrend
      .mockResolvedValueOnce({ points: [point], moving_averages: [] })
      .mockResolvedValueOnce({
        points: [point],
        moving_averages: [
          { field: 'ma3', label: 'MA3', window: 3, available: true, available_periods: 5 },
          { field: 'ma12', label: 'MA12', window: 12, available: false, available_periods: 5 },
        ],
      })
      .mockResolvedValueOnce({
        points: [{ ...point, net_income: 120 }],
        moving_averages: [
          { field: 'ma3', label: 'MA3', window: 3, available: false, available_periods: 5 },
          { field: 'ma12', label: 'MA12', window: 12, available: true, available_periods: 5 },
        ],
      });
    render(createElement(DashboardPage, { show: vi.fn() }));
    await screen.findByRole('img', { name: '净实收趋势主图' });

    const sourceButtons = screen.getAllByText('堂食/外卖');
    fireEvent.click(sourceButtons[sourceButtons.length - 1]);

    const shopStatus = await screen.findByLabelText('堂食均线状态');
    const takeoutStatus = screen.getByLabelText('外卖均线状态');
    expect(within(shopStatus).getByText('MA12 数据不足')).toBeTruthy();
    expect(within(shopStatus).queryByText('MA3 数据不足')).toBeNull();
    expect(within(takeoutStatus).getByText('MA3 数据不足')).toBeTruthy();
    expect(within(takeoutStatus).queryByText('MA12 数据不足')).toBeNull();
  });

  it('skips all analytics requests and shows an empty state for a resolved empty scope', async () => {
    analyticsApi.listStoreScopeTree.mockResolvedValue({
      nodes: [{ key: 'dept:empty', type: 'department', label: '空部门', children: [] }],
      store_count: 0,
      source: 'test',
    });
    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(analyticsApi.getMealPeriodTurnover).toHaveBeenCalledTimes(1));
    analyticsApi.getRevenueTrend.mockClear();
    analyticsApi.getMealPeriods.mockClear();
    analyticsApi.getMealPeriodTrend.mockClear();
    analyticsApi.getMealPeriodTurnover.mockClear();

    await chooseScope('空部门');

    expect(await screen.findByText('当前范围无可用门店')).toBeTruthy();
    expect(analyticsApi.getRevenueTrend).not.toHaveBeenCalled();
    expect(analyticsApi.getMealPeriods).not.toHaveBeenCalled();
    expect(analyticsApi.getMealPeriodTrend).not.toHaveBeenCalled();
    expect(analyticsApi.getMealPeriodTurnover).not.toHaveBeenCalled();
  });

  it('loads both meal datasets once and does not request again when switching metrics', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));

    await waitFor(() =>
      expect(analyticsApi.getMealPeriodTurnover).toHaveBeenCalledTimes(1),
    );

    fireEvent.click(screen.getByText('翻台率'));

    expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(1);
    expect(analyticsApi.getMealPeriods).toHaveBeenCalledTimes(1);
    expect(analyticsApi.getMealPeriodTrend).toHaveBeenCalledTimes(1);
    expect(analyticsApi.getMealPeriodTurnover).toHaveBeenCalledTimes(1);
  });

  it('shows meal period time ranges instead of income in cards', async () => {
    analyticsApi.getMealPeriods.mockResolvedValueOnce({
      periods: [{
        period_key: 'breakfast',
        period_label: '早餐',
        order_count: 10,
        paid_amount: 100,
        income_amount: 80,
        refund_amount: 0,
        net_income: 80,
        avg_order_value: 10,
      }],
    });

    render(createElement(DashboardPage, { show: vi.fn() }));

    expect(await screen.findByText('06:00-10:00')).toBeTruthy();
    expect(screen.queryByText('实收 ¥80.00')).toBeNull();
  });

  it('keeps successful sections when an independent dashboard request fails', async () => {
    const show = vi.fn();
    analyticsApi.getMealPeriods.mockResolvedValueOnce({
      periods: [{
        period_key: 'breakfast',
        period_label: '早餐',
        order_count: 10,
        paid_amount: 100,
        income_amount: 80,
        refund_amount: 0,
        net_income: 80,
        avg_order_value: 10,
      }],
    });
    analyticsApi.getMealPeriodTrend.mockRejectedValueOnce(new Error('餐段趋势加载失败'));

    render(createElement(DashboardPage, { show }));

    expect(await screen.findByText('06:00-10:00')).toBeTruthy();
    await waitFor(() => expect(show).toHaveBeenCalledWith('餐段趋势加载失败'));
    expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(1);
    expect(analyticsApi.getMealPeriodTurnover).toHaveBeenCalledTimes(1);
  });

  it('requests explicit store trends when comparing multiple stores', async () => {
    analyticsApi.listStoreScopeTree.mockResolvedValueOnce({
      nodes: [
        { key: 'shop:101', type: 'store', label: '门店A', store_key: '101' },
        { key: 'shop:102', type: 'store', label: '门店B', store_key: '102' },
      ],
      store_count: 2,
      source: 'test',
    });
    const point = (netIncome: number) => ({
      period: '2026-07-01',
      net_income: netIncome,
      order_count: 10,
      ma7: netIncome,
      ma30: netIncome,
      ma180: netIncome,
      missing: false,
    });
    analyticsApi.getRevenueTrend.mockResolvedValueOnce({
      points: [point(300)],
      store_trends: { '101': [point(100)], '102': [point(200)] },
    });
    analyticsApi.getMealPeriodTrend.mockResolvedValueOnce({
      points: [],
      store_trends: { '101': [], '102': [] },
    });
    analyticsApi.getMealPeriodTurnover.mockResolvedValueOnce({
      data_status: 'missing',
      date_from: '2026-07-01',
      date_to: '2026-07-10',
      day_count: 10,
      eligible_store_count: 0,
      table_count: 0,
      excluded_stores: [],
      summary: [],
      points: [],
      store_summaries: [],
      store_trends: { '101': [], '102': [] },
    });

    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(analyticsApi.listStoreScopeTree).toHaveBeenCalledTimes(1));

    expect(analyticsApi.getRevenueTrend).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'ALL',
      'all',
      expect.objectContaining({ includeStoreTrends: false }),
    );
    expect(analyticsApi.getMealPeriodTrend).toHaveBeenCalledWith(
      'ALL',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ includeStoreTrends: false }),
    );
    expect(screen.getByLabelText('经营看板桌面门店范围')).toBeTruthy();

    const selectStore = async (label: string) => {
      fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
      const options = await screen.findAllByText(label);
      fireEvent.click(options[options.length - 1]);
    };
    await selectStore('门店A');
    await selectStore('门店B');

    expect(await screen.findByText('门店净实收趋势')).toBeTruthy();
    expect(screen.getAllByText('门店对比').length).toBeGreaterThan(0);
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ storeKeys: ['101', '102'], includeStoreTrends: true }),
    ));
    expect(analyticsApi.getMealPeriodTrend).toHaveBeenLastCalledWith(
      'ALL', expect.any(String), expect.any(String),
      expect.objectContaining({ storeKeys: ['101', '102'], includeStoreTrends: true }),
    );
    expect(analyticsApi.getMealPeriodTurnover).toHaveBeenLastCalledWith(
      'ALL', expect.any(String), expect.any(String),
      expect.objectContaining({ storeKeys: ['101', '102'] }),
    );
  });

  it('keeps an explicitly selected department and child store as separate trend scopes', async () => {
    const point = (netIncome: number) => ({
      period: '2026-07-01',
      net_income: netIncome,
      order_count: 10,
      missing: false,
    });
    analyticsApi.listStoreScopeTree.mockResolvedValueOnce(scopeTreeResponse);
    analyticsApi.getRevenueTrend.mockImplementation(
      (_from: string, _to: string, _store: string, _source: string, options: { includeStoreTrends?: boolean }) =>
        Promise.resolve(options.includeStoreTrends
          ? {
              points: [point(300)],
              store_trends: { '801': [point(100)], '802': [point(200)] },
              moving_averages: [],
            }
          : { points: [point(300)], moving_averages: [] }),
    );

    render(createElement(DashboardPage, { show: vi.fn() }));
    await chooseScope('事业1部');
    fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
    const departments = await screen.findAllByText('事业1部');
    const department = departments[departments.length - 1]!;
    const departmentNode = department.closest('.ant-select-tree-treenode')!;
    fireEvent.click(departmentNode.querySelector('.ant-select-tree-switcher')!);
    const children = await screen.findAllByText('门店A');
    const child = children[children.length - 1]!;
    fireEvent.click(child);

    expect(await screen.findByText('已选范围净实收趋势')).toBeTruthy();
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ storeKeys: ['801', '802'], includeStoreTrends: true }),
    ));
  });

  it('loads per-store shop and takeout trends when multiple stores switch source mode', async () => {
    analyticsApi.listStoreScopeTree.mockResolvedValueOnce({
      nodes: [
        { key: 'shop:101', type: 'store', label: '门店A', store_key: '101' },
        { key: 'shop:102', type: 'store', label: '门店B', store_key: '102' },
      ],
      store_count: 2,
      source: 'test',
    });
    const point = (netIncome: number) => ({
      period: '2026-07-01',
      net_income: netIncome,
      order_count: 10,
      ma7: null,
      ma30: null,
      ma180: null,
      missing: false,
    });
    analyticsApi.getRevenueTrend
      .mockResolvedValueOnce({
        points: [point(300)],
        store_trends: { '101': [point(100)], '102': [point(200)] },
      })
      .mockResolvedValueOnce({
        points: [point(180)],
        store_trends: { '101': [point(80)], '102': [point(100)] },
      })
      .mockResolvedValueOnce({
        points: [point(120)],
        store_trends: { '101': [point(20)], '102': [point(100)] },
      });
    analyticsApi.getMealPeriodTrend.mockResolvedValueOnce({
      points: [],
      store_trends: { '101': [], '102': [] },
    });
    analyticsApi.getMealPeriodTurnover.mockResolvedValueOnce({
      data_status: 'missing',
      date_from: '2026-07-01',
      date_to: '2026-07-10',
      day_count: 10,
      eligible_store_count: 0,
      table_count: 0,
      excluded_stores: [],
      summary: [],
      points: [],
      store_summaries: [],
      store_trends: { '101': [], '102': [] },
    });

    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(analyticsApi.listStoreScopeTree).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(1));

    const selectStore = async (label: string) => {
      fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
      const options = await screen.findAllByText(label);
      fireEvent.click(options[options.length - 1]);
    };
    await selectStore('门店A');
    await selectStore('门店B');
    const sourceButtons = screen.getAllByText('堂食/外卖');
    fireEvent.click(sourceButtons[sourceButtons.length - 1]);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(5));
    expect(analyticsApi.getRevenueTrend).toHaveBeenNthCalledWith(
      4,
      expect.any(String),
      expect.any(String),
      'ALL',
      'shop',
      expect.objectContaining({ storeKeys: ['101', '102'], includeStoreTrends: true }),
    );
    expect(analyticsApi.getRevenueTrend).toHaveBeenNthCalledWith(
      5,
      expect.any(String),
      expect.any(String),
      'ALL',
      'takeout',
      expect.objectContaining({ storeKeys: ['101', '102'], includeStoreTrends: true }),
    );
    expect(await screen.findByText('门店堂食/外卖净实收趋势')).toBeTruthy();
  });

  it('switches stores and source mode without refetching order facts', async () => {
    dailyFactsApi.getOrderDailyFacts.mockResolvedValueOnce([
      {
        date: '2026-08-11',
        payload: {
          date: '2026-08-11',
          complete: true,
          order_count: 30,
          paid_amount_cent: 360000,
          income_amount_cent: 300000,
          refund_amount_cent: 0,
          net_amount_cent: 360000,
          net_income_cent: 300000,
          stores: {
            '101': {
              store_key: '101',
              store_label: '门店A',
              order_count: 10,
              paid_amount_cent: 120000,
              income_amount_cent: 100000,
              refund_amount_cent: 0,
              net_amount_cent: 120000,
              net_income_cent: 100000,
              source_totals: {
                shop: {
                  order_count: 6,
                  paid_amount_cent: 70000,
                  income_amount_cent: 60000,
                  refund_amount_cent: 0,
                  net_amount_cent: 70000,
                  net_income_cent: 60000,
                },
                takeout: {
                  order_count: 4,
                  paid_amount_cent: 50000,
                  income_amount_cent: 40000,
                  refund_amount_cent: 0,
                  net_amount_cent: 50000,
                  net_income_cent: 40000,
                },
              },
            },
            '102': {
              store_key: '102',
              store_label: '门店B',
              order_count: 20,
              paid_amount_cent: 240000,
              income_amount_cent: 200000,
              refund_amount_cent: 0,
              net_amount_cent: 240000,
              net_income_cent: 200000,
            },
          },
        },
      },
    ]);
    analyticsApi.listStoreScopeTree.mockResolvedValueOnce({
      nodes: [
        { key: 'shop:101', type: 'store', label: '门店A', store_key: '101' },
        { key: 'shop:102', type: 'store', label: '门店B', store_key: '102' },
      ],
      store_count: 2,
      source: 'test',
    });

    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(1));

    const selectStore = async (label: string) => {
      fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
      const options = await screen.findAllByText(label);
      fireEvent.click(options[options.length - 1]);
    };
    await selectStore('门店A');
    const sourceModeOptions = screen.getAllByText('堂食/外卖');
    fireEvent.click(sourceModeOptions[sourceModeOptions.length - 1]);

    await waitFor(() => expect(screen.getAllByText('门店A').length).toBeGreaterThan(0));
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalledTimes(1);
  });

  it('derives meal and turnover series locally for a new store scope', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-08-12T04:00:00.000Z'));
    dailyFactsApi.getMealDailyFacts.mockResolvedValueOnce([
      {
        date: '2026-08-11',
        payload: {
          date: '2026-08-11',
          data_status: 'ready',
          stores: {
            '101': {
              store_key: '101',
              table_count: 10,
              table_count_status: 'ready',
              periods: {
                lunch: {
                  period_key: 'lunch',
                  period_label: '午餐',
                  order_count: 20,
                  shop_order_count: 8,
                  paid_amount_cent: 240000,
                  income_amount_cent: 200000,
                  refund_amount_cent: 0,
                  net_income_cent: 200000,
                },
              },
            },
            '102': {
              store_key: '102',
              table_count: 10,
              table_count_status: 'ready',
              periods: {
                lunch: {
                  period_key: 'lunch',
                  period_label: '午餐',
                  order_count: 10,
                  shop_order_count: 4,
                  paid_amount_cent: 120000,
                  income_amount_cent: 100000,
                  refund_amount_cent: 0,
                  net_income_cent: 100000,
                },
              },
            },
          },
        },
      },
    ]);
    analyticsApi.listStoreScopeTree.mockResolvedValueOnce({
      nodes: [
        { key: 'shop:101', type: 'store', label: '门店A', store_key: '101' },
        { key: 'shop:102', type: 'store', label: '门店B', store_key: '102' },
      ],
      store_count: 2,
      source: 'test',
    });

    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(dailyFactsApi.getMealDailyFacts).toHaveBeenCalledTimes(1));
    expect(dailyFactsApi.getMealDailyFacts).toHaveBeenCalledWith(
      '2026-02-04',
      '2026-08-12',
      {},
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await chooseScope('门店A');
    await chooseScope('门店B');
    fireEvent.click(screen.getByText('翻台率'));

    await waitFor(() => expect(screen.getByText('0.60次/桌/日')).toBeTruthy());
    expect(dailyFactsApi.getMealDailyFacts).toHaveBeenCalledTimes(1);
  });

  it('loads selected stores automatically when the ALL bundle is incomplete', async () => {
    analyticsApi.listStoreScopeTree.mockResolvedValueOnce({
      nodes: [{ key: 'shop:101', type: 'store', label: '门店A', store_key: '101' }],
      store_count: 1,
      source: 'test',
    });
    analyticsApi.getRevenueTrend
      .mockResolvedValueOnce({ points: [], store_trends: {} })
      .mockResolvedValueOnce({ points: [], store_trends: { '101': [] } });
    analyticsApi.getMealPeriodTrend
      .mockResolvedValueOnce({ points: [], store_trends: {} })
      .mockResolvedValueOnce({ points: [], store_trends: { '101': [] } });
    analyticsApi.getMealPeriodTurnover
      .mockResolvedValueOnce({
        data_status: 'missing',
        date_from: '2026-07-01',
        date_to: '2026-07-10',
        day_count: 10,
        eligible_store_count: 0,
        table_count: 0,
        excluded_stores: [],
        summary: [],
        points: [],
        store_summaries: [],
        store_trends: {},
      })
      .mockResolvedValueOnce({
        data_status: 'missing',
        date_from: '2026-07-01',
        date_to: '2026-07-10',
        day_count: 10,
        eligible_store_count: 0,
        table_count: 0,
        excluded_stores: [],
        summary: [],
        points: [],
        store_summaries: [],
        store_trends: { '101': [] },
      });

    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(analyticsApi.listStoreScopeTree).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(1));

    fireEvent.mouseDown(screen.getByLabelText('经营看板门店范围'));
    const options = await screen.findAllByText('门店A');
    fireEvent.click(options[options.length - 1]);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(2));
    expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(String),
      'ALL',
      'all',
      expect.objectContaining({ storeKeys: ['101'] }),
    );
    expect(analyticsApi.getMealPeriodTrend).toHaveBeenLastCalledWith(
      'ALL',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ storeKeys: ['101'] }),
    );
    expect(analyticsApi.getMealPeriodTurnover).toHaveBeenLastCalledWith(
      'ALL',
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ storeKeys: ['101'] }),
    );
  });

  it('refreshes through server cache revalidation instead of force rebuilding snapshots', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(1));

    const refreshButtons = screen.getAllByRole('button', { name: '刷新' });
    fireEvent.click(refreshButtons[refreshButtons.length - 1]);

    await waitFor(() => expect(analyticsApi.getRevenueTrend).toHaveBeenCalledTimes(2));
    const options = analyticsApi.getRevenueTrend.mock.calls[1][4];
    expect(options).toEqual(expect.objectContaining({ revalidate: true }));
    expect(options.forceRefresh).toBeUndefined();
  });
});


describe('live business dashboard', () => {
  it('uses today and refreshes daily deltas without force rebuilding', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-10T00:30:00+08:00'));
    dailyFactsApi.getOrderDailyFacts.mockResolvedValue([]);
    dailyFactsApi.getMealDailyFacts.mockResolvedValue([]);
    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenCalled());
    await waitFor(() => expect(pollingHook.usePolling.mock.calls.some(([, ms]) => ms === 30000)).toBe(true));
    expect(dailyFactsApi.getOrderDailyFacts.mock.calls[0][1]).toBe('2026-10-10');
    analyticsApi.getRevenueTrend.mockClear();
    const controller = new AbortController();
    const poll = pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1][0];
    await act(async () => { await poll(controller.signal); });
    expect(dailyFactsApi.getOrderDailyFacts).toHaveBeenLastCalledWith(expect.any(String), '2026-10-10', {}, {
      signal: controller.signal, forceRefresh: false,
    });
    expect(dailyFactsApi.getMealDailyFacts).toHaveBeenLastCalledWith(expect.any(String), '2026-10-10', {}, {
      signal: controller.signal, forceRefresh: false,
    });
    expect(analyticsApi.getRevenueTrend).not.toHaveBeenCalled();
    expect(operationsApi.fetchOperationsOverview).toHaveBeenLastCalledWith(expect.objectContaining({
      signal: controller.signal, filters: expect.objectContaining({ dateTo: '2026-10-10' }),
    }));
  });
  it('polls the legacy fallback without forced rebuilds and keeps data on failure', async () => {
    const show = vi.fn();
    render(createElement(DashboardPage, { show }));
    await waitFor(() => expect(pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1]?.[1]).toBe(30000));
    analyticsApi.getRevenueTrend.mockRejectedValueOnce(new Error('temporary outage'));
    const poll = pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1][0];
    const controller = new AbortController();
    await act(async () => { await poll(controller.signal); });
    expect(analyticsApi.getRevenueTrend).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), 'ALL', 'all',
      expect.objectContaining({ revalidate: false, signal: expect.any(AbortSignal) }));
    expect(screen.getByText(/读取暂时失败，保留上次结果/)).toBeTruthy();
    expect(show).not.toHaveBeenCalled();
    await act(async () => { await poll(controller.signal); });
    expect(screen.queryByText(/读取暂时失败，保留上次结果/)).toBeNull();
  });

  it('aborts fallback requests and ignores late polling responses', async () => {
    render(createElement(DashboardPage, { show: vi.fn() }));
    await waitFor(() => expect(pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1]?.[1]).toBe(30000));
    let resolveTrend!: (value: { points: [] }) => void;
    analyticsApi.getRevenueTrend.mockImplementationOnce(() => new Promise(resolve => { resolveTrend = resolve; }));
    const poll = pollingHook.usePolling.mock.calls[pollingHook.usePolling.mock.calls.length - 1][0];
    const controller = new AbortController();
    let pending!: Promise<void>;
    act(() => { pending = poll(controller.signal); });
    const requestSignal = analyticsApi.getRevenueTrend.mock.calls[analyticsApi.getRevenueTrend.mock.calls.length - 1][4].signal;
    controller.abort();
    expect(requestSignal.aborted).toBe(true);
    await act(async () => { resolveTrend({ points: [] }); await pending; });
    expect(screen.queryByText(/最近读取：/)).toBeNull();
  });

});
