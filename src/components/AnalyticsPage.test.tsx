import { currentBeijingDate } from '../utils/time';
/** AnalyticsPage 冒烟测试：订单视图加载 + 设置确认映射。 */

import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getOrders: vi.fn().mockResolvedValue({
    rows: [
      { dim_key: 'ALL', dim_label: '全部', order_count: 937, paid_amount: 19235.01, income_amount: 17800.50, refund_amount: 355.38, net_amount: 18879.63, net_income: 17445.12, avg_order_value: 18.62, refund_rate: 0.0185, computed_at: null },
    ],
    excluded: { excluded_orders: 0, excluded_shops: [], confirmed_shops: 11 },
  }),
  getRevenueTrend: vi.fn().mockResolvedValue({
    metric: 'net_income',
    date_from: '2026-06-01',
    date_to: '2026-06-03',
    store_key: 'ALL',
    points: [
      { period: '2026-06-01', net_income: 100, order_count: 10, ma7: 100, ma30: 100, ma180: 100, missing: false },
      { period: '2026-06-02', net_income: 200, order_count: 20, ma7: 150, ma30: 150, ma180: 150, missing: false },
      { period: '2026-06-03', net_income: 300, order_count: 30, ma7: 200, ma30: 200, ma180: 200, missing: false },
    ],
  }),
  getMealPeriods: vi.fn().mockResolvedValue({
    store_key: 'ALL',
    business_date: '2026-06-03',
    periods: [
      { period_key: 'breakfast', period_label: '早餐', order_count: 10, paid_amount: 100, income_amount: 90, refund_amount: 0, net_income: 90, avg_order_value: 10 },
      { period_key: 'lunch', period_label: '午餐', order_count: 20, paid_amount: 200, income_amount: 180, refund_amount: 0, net_income: 180, avg_order_value: 10 },
      { period_key: 'afternoon_tea', period_label: '下午茶', order_count: 5, paid_amount: 50, income_amount: 45, refund_amount: 0, net_income: 45, avg_order_value: 10 },
      { period_key: 'dinner', period_label: '晚餐', order_count: 30, paid_amount: 300, income_amount: 270, refund_amount: 0, net_income: 270, avg_order_value: 10 },
      { period_key: 'late_night', period_label: '夜宵', order_count: 3, paid_amount: 30, income_amount: 27, refund_amount: 0, net_income: 27, avg_order_value: 10 },
    ],
    excluded: { excluded_orders: 0, excluded_shops: [], confirmed_shops: 11 },
  }),
  getMealPeriodTrend: vi.fn().mockResolvedValue({
    store_key: 'ALL',
    date_from: '2026-06-01',
    date_to: '2026-06-03',
    points: [
      {
        date: '2026-06-01',
        breakfast: { period_key: 'breakfast', period_label: '早餐', order_count: 10, paid_amount: 100, income_amount: 90, refund_amount: 0, net_income: 90, avg_order_value: 10 },
        lunch: { period_key: 'lunch', period_label: '午餐', order_count: 20, paid_amount: 200, income_amount: 180, refund_amount: 0, net_income: 180, avg_order_value: 10 },
        afternoon_tea: { period_key: 'afternoon_tea', period_label: '下午茶', order_count: 5, paid_amount: 50, income_amount: 45, refund_amount: 0, net_income: 45, avg_order_value: 10 },
        dinner: { period_key: 'dinner', period_label: '晚餐', order_count: 30, paid_amount: 300, income_amount: 270, refund_amount: 0, net_income: 270, avg_order_value: 10 },
        late_night: { period_key: 'late_night', period_label: '夜宵', order_count: 3, paid_amount: 30, income_amount: 27, refund_amount: 0, net_income: 27, avg_order_value: 10 },
      },
    ],
  }),
  getMealPeriodTurnover: vi.fn().mockResolvedValue({
    data_status: 'missing',
    points: [],
    summary: [],
  }),
  getOrdersInsight: vi.fn().mockResolvedValue({ content_md: '整体净收 ¥18879，茅坡新城店领涨。', cached: false, model: 'x' }),
  getBusinessReport: vi.fn().mockResolvedValue({
    content_md: '#### AI 经营解读\n\n【事实】净实收增长。\n\n#### 建议动作\n\n1. P1｜北大街：复核午餐高峰。',
    cached: false,
    model: 'x',
    trace_id: 'trace-business-report',
    data_sources: ['订单快照', '天气'],
    missing_context: [{ message: '部分门店缺少商圈画像' }],
    knowledge_candidate_count: 1,
  }),
  getRevenueAlerts: vi.fn().mockResolvedValue([
    {
      shop_key: '1',
      shop_label: '北大街店',
      business_date: '2026-06-21',
      actual_amount: 300,
      baseline_amount: 1000,
      deviation_pct: -0.7,
      direction: 'under',
      status: 'open',
      baseline_sample_count: 3,
      baseline_expected_count: 4,
      reason_hints: ['订单数较历史基线减少 30%，可能是客流下降或平台订单数据缺失。'],
    },
  ]),
  getRevenueAlertSettings: vi.fn().mockResolvedValue({ threshold_pct: 0.1, recipient_user_ids: [] }),
  saveRevenueAlertSettings: vi.fn().mockResolvedValue({ threshold_pct: 0.1, recipient_user_ids: ['u1'] }),
  detectRevenueAlerts: vi.fn().mockResolvedValue({ detected: 1, alerts: [] }),
  getProducts: vi.fn().mockResolvedValue({
    top: [{ product_key: 'A', product_name: '招牌擀面皮', quantity: 30, sales_amount: 300, order_count: 25, sales_share: 0.4 }],
    bottom: [],
  }),
  getProductTrend: vi.fn().mockResolvedValue({
    metric: 'sales_amount',
    date_from: '2026-06-01',
    date_to: '2026-06-07',
    dim_type: 'all',
    dim_key: 'ALL',
    product_key: 'A',
    product_name: '招牌擀面皮',
    points: [
      { period: '2026-06-01', quantity: 2, sales_amount: 20, order_count: 2, missing: false, ma7: 20, ma30: 20, ma180: 20 },
      { period: '2026-06-02', quantity: 3, sales_amount: 30, order_count: 3, missing: false, ma7: 25, ma30: 25, ma180: 25 },
    ],
  }),
  getLaborEfficiency: vi.fn().mockResolvedValue({
    rows: [
      { store_key: '100', store_label: '北大街', net_revenue: 1000, actual_hours: 40, planned_hours: 42, revenue_per_hour: 25, headcount: 2, hours_gap: 2, uncovered: false },
    ],
  }),
  getLaborEfficiencyTrend: vi.fn().mockResolvedValue({
    granularity: 'range',
    period: '2026-06-20_2026-06-30',
    store_key: 'ALL',
    points: [
      {
        period: '2026-06-29',
        net_revenue: 1000,
        actual_hours: 40,
        planned_hours: 42,
        actual_revenue_per_hour: 25,
        planned_revenue_per_hour: 23.81,
        headcount: 2,
        missing: false,
        actual_hours_ma7: 40,
        actual_hours_ma30: 40,
        actual_hours_ma180: 40,
        planned_hours_ma7: 42,
        planned_hours_ma30: 42,
        planned_hours_ma180: 42,
        actual_revenue_per_hour_ma7: 25,
        actual_revenue_per_hour_ma30: 25,
        actual_revenue_per_hour_ma180: 25,
        planned_revenue_per_hour_ma7: 23.81,
        planned_revenue_per_hour_ma30: 23.81,
        planned_revenue_per_hour_ma180: 23.81,
      },
    ],
  }),
  getLaborEfficiencyDetail: vi.fn().mockResolvedValue({
    granularity: 'week',
    period: '2026-W27',
    store_key: '100',
    store_label: '北大街',
    labor: { planned_hours: 42, actual_hours: 40, hours_gap: 2, headcount: 2, employees: [] },
    revenue: {
      paid_amount: 300,
      income_amount: 280,
      refund_amount: 10,
      net_income: 270,
      order_count: 15,
      daily: [
        { business_date: '2026-06-29', order_count: 8, paid_amount: 160, income_amount: 150, refund_amount: 5, net_income: 145 },
        { business_date: '2026-06-30', order_count: 7, paid_amount: 140, income_amount: 130, refund_amount: 5, net_income: 125 },
      ],
      shops: [
        { shop_id: 'h12351556670', shop_name: '袁记肉夹馍（北大街直营店）', order_count: 15, paid_amount: 300, income_amount: 280, refund_amount: 10, net_income: 270 },
      ],
    },
  }),
  listStoreScopeTree: vi.fn().mockResolvedValue({
    nodes: [
      {
        key: 'dept:11',
        type: 'department',
        label: '事业1部',
        children: [
          { key: 'shop:801', type: 'store', label: '北大街', store_key: '801', department_id: '111' },
          { key: 'shop:802', type: 'store', label: '南大街', store_key: '802', department_id: '112' },
        ],
      },
      {
        key: 'dept:12',
        type: 'department',
        label: '事业2部',
        children: [
          { key: 'shop:803', type: 'store', label: '华远店', store_key: '803', department_id: '113' },
          { key: 'shop:804', type: 'store', label: '科技路', store_key: '804', department_id: '114' },
        ],
      },
    ],
  }),
  listShopMappings: vi.fn().mockResolvedValue([
    { shiheng_shop_id: 'h12351556670', shiheng_shop_name: '袁记肉夹馍（北大街直营店）', hr_department_id: '100', hr_department_name: '北大街', match_score: 0.95, status: 'proposed' },
  ]),
  proposeShopMappings: vi.fn().mockResolvedValue([]),
  confirmShopMapping: vi.fn().mockResolvedValue([
    { shiheng_shop_id: 'h12351556670', shiheng_shop_name: '袁记肉夹馍（北大街直营店）', hr_department_id: '100', hr_department_name: '北大街', match_score: 0.95, status: 'confirmed' },
  ]),
  listHrDepartments: vi.fn().mockResolvedValue([{ id: '100', name: '北大街' }]),
  listPlatformDim: vi.fn().mockResolvedValue([{ platform_code: 10, platform_name: '平台10', confirmed: false }]),
  savePlatformName: vi.fn().mockResolvedValue(undefined),
  listStoreGeoProfiles: vi.fn().mockResolvedValue([]),
  geocodeStore: vi.fn().mockResolvedValue({ store_key: '100', address: '北大街', longitude: 108.9, latitude: 34.2, formatted_address: '北大街', status: 'pending' }),
  confirmGeoProfile: vi.fn().mockResolvedValue({ store_key: '100', shop_id: 'h12351556670', status: 'confirmed' }),
  getTradeArea: vi.fn().mockResolvedValue({ store_key: '100', month: '2026-06', status: 'missing', pois: [], summary: {} }),
  refreshTradeArea: vi.fn().mockResolvedValue({ status: 'queued' }),
  listTradeAreaPois: vi.fn().mockResolvedValue([]),
  getStoreWeather: vi.fn().mockResolvedValue({ rows: [] }),
  saveOrdersInsightCandidate: vi.fn().mockResolvedValue({ status: 'ok' }),
  getRevenueForecastModel: vi.fn().mockResolvedValue({
    status: 'active',
    scenario: 'revenue_forecast',
    version: 'historical_feature_weighted_v2',
    readiness: {
      status: 'collecting_samples',
      sample_count: 12,
      backfilled_sample_count: 0,
      pending_sample_count: 12,
      min_backfilled_samples: 20,
      remaining_backfilled_samples: 20,
      available_feature_keys: ['weather', 'holiday'],
      available_feature_labels: { weather: '天气', holiday: '节假日' },
      feature_coverage: {},
    },
    current_asset_readiness: {
      status: 'degraded',
      granularity: 'week',
      period: '2026-W27',
      dim: 'shop',
      assets: {
        order_history: { status: 'ready', required: true, sample_count: 4 },
        calendar: { status: 'ready' },
        weather: { status: 'partial', expected_count: 11, covered_count: 8 },
        trade_area: { status: 'ready', expected_count: 11, covered_count: 11 },
        product: { status: 'missing' },
        labor: { status: 'ready' },
        platform: { status: 'ready' },
        channel: { status: 'ready' },
        activity: { status: 'planned' },
        knowledge_feedback: { status: 'planned' },
      },
      weak_assets: ['weather', 'product'],
      required_missing: [],
    },
  }),
  optimizeRevenueForecastModel: vi.fn().mockResolvedValue({ status: 'collecting_samples' }),
}));
vi.mock('../api/analytics', () => api);

const operationsApi = vi.hoisted(() => ({
  fetchOperationsOverview: vi.fn().mockResolvedValue({
    period: { date_from: '2026-06-01', date_to: '2026-06-07' },
    previous_period: { date_from: '2026-05-25', date_to: '2026-05-31' },
    metrics: {
      paid_amount: { current: 19235.01, previous: 16029.18, difference: 3205.83, change_rate: 0.2, status: 'ok' },
      income_amount: { current: 17800.50, previous: 16000.45, difference: 1800.05, change_rate: 0.1125, status: 'ok' },
      refund_amount: { current: 355.38, previous: 400.65, difference: -45.27, change_rate: -0.1125, status: 'ok' },
      net_income: { current: 17445.12, previous: 13956.10, difference: 3489.02, change_rate: 0.25, status: 'ok' },
      order_count: { current: 937, previous: 750, difference: 187, change_rate: 0.25, status: 'ok' },
      avg_order_value: { current: 18.62, previous: 19.40, difference: -0.78, change_rate: -0.04, status: 'ok' },
      refund_rate: { current: 0.0185, previous: 0.02, difference: -0.0015, change_rate: -0.075, status: 'ok' },
    },
    channels: [],
    platforms: [],
    stores: [{
      dim_key: 'ALL',
      dim_label: '全部',
      store_key: 'ALL',
      store_label: '全部',
      metrics: {
        paid_amount: { current: 19235.01, previous: 16029.18, difference: 3205.83, change_rate: 0.2, status: 'ok' },
        income_amount: { current: 17800.50, previous: 16000.45, difference: 1800.05, change_rate: 0.1125, status: 'ok' },
        refund_amount: { current: 355.38, previous: 400.65, difference: -45.27, change_rate: -0.1125, status: 'ok' },
        net_income: { current: 17445.12, previous: 13956.10, difference: 3489.02, change_rate: 0.25, status: 'ok' },
        order_count: { current: 937, previous: 750, difference: 187, change_rate: 0.25, status: 'ok' },
        avg_order_value: { current: 18.62, previous: 19.40, difference: -0.78, change_rate: -0.04, status: 'ok' },
        refund_rate: { current: 0.0185, previous: 0.02, difference: -0.0015, change_rate: -0.075, status: 'ok' },
      },
    }],
    sections: {},
    completeness: { data_status: 'ready' },
    generated_at: '2026-06-08T09:00:00+08:00',
  }),
  fetchOperationsProducts: vi.fn().mockResolvedValue({
    fact_source: 'orders',
    previous_period: { date_from: '2026-05-25', date_to: '2026-05-31' },
    items: [{
      product_key: 'A',
      product_name: '招牌擀面皮',
      quantity: 30,
      sales_amount: 300,
      order_count: 25,
      quantity_share: 0.4,
      amount_share: 0.4,
      fact_source: 'orders',
      comparison: {
        quantity: { current: 30, previous: 25, difference: 5, change_rate: 0.2, status: 'ok' },
        sales_amount: { current: 300, previous: 240, difference: 60, change_rate: 0.25, status: 'ok' },
        order_count: { current: 25, previous: 30, difference: -5, change_rate: -0.1667, status: 'ok' },
        amount_share: { current: 0.4, previous: 0.5, difference: -0.1, change_rate: -0.2, status: 'ok' },
      },
    }],
    total: 1,
    limit: 200,
    offset: 0,
    cost_completeness: { verified: false },
    data_status: 'ready',
  }),
  fetchOperationsLabor: vi.fn().mockResolvedValue({
    granularity: 'week',
    previous_period: { date_from: '2026-05-25', date_to: '2026-05-31' },
    points: [],
    summary: {
      actual_hours: 40,
      planned_hours: 42,
      net_revenue: 1000,
      headcount: 2,
      actual_revenue_per_hour: 25,
      planned_revenue_per_hour: 23.81,
      comparison: {
        actual_hours: { current: 40, previous: 36, difference: 4, change_rate: 0.1111, status: 'ok' },
        planned_hours: { current: 42, previous: 40, difference: 2, change_rate: 0.05, status: 'ok' },
        net_revenue: { current: 1000, previous: 800, difference: 200, change_rate: 0.25, status: 'ok' },
        actual_revenue_per_hour: { current: 25, previous: 22.22, difference: 2.78, change_rate: 0.1251, status: 'ok' },
        planned_revenue_per_hour: { current: 23.81, previous: 20, difference: 3.81, change_rate: 0.1905, status: 'ok' },
      },
    },
    excluded_dates: [],
    data_status: 'ready',
  }),
}));
vi.mock('../features/operations-analysis/api/client', () => operationsApi);

const chartRender = vi.hoisted(() => ({
  product: vi.fn(),
  labor: vi.fn(),
}));

vi.mock('./analytics/ProductTrendChart', () => ({
  ProductTrendChart: (props: {
    points: Array<{ period: string }>;
    productName: string;
    productTrends?: Record<string, unknown[]>;
    storeTrends?: Record<string, unknown[]>;
  }) => {
    chartRender.product(props);
    return (
      <div
        data-testid="product-trend-chart"
        data-periods={props.points.map(point => point.period).join(',')}
        data-product={props.productName}
        data-product-keys={Object.keys(props.productTrends || {}).sort().join(',')}
        data-store-keys={Object.keys(props.storeTrends || {}).sort().join(',')}
      />
    );
  },
}));

vi.mock('./analytics/LaborTrendChart', () => ({
  LaborTrendChart: (props: {
    points: Array<{ period: string }>;
    metric: string;
    storeTrends?: Record<string, unknown[]>;
  }) => {
    chartRender.labor(props);
    return (
      <div
        data-testid={`labor-${props.metric}-trend-chart`}
        data-periods={props.points.map(point => point.period).join(',')}
        data-store-keys={Object.keys(props.storeTrends || {}).sort().join(',')}
      />
    );
  },
}));

const auto = vi.hoisted(() => ({
  listChannels: vi.fn().mockResolvedValue([{ id: 'ch1', provider: 'dingtalk', channel_type: 'app_bot', name: '人事通道', enabled: true, config_summary: {}, last_test_status: null, last_test_message: null, last_test_at: null }]),
  listRecipientEmployees: vi.fn().mockResolvedValue([{ ding_user_id: 'u1', name: '张三', position: null, department_names: [] }]),
  listWorkflows: vi.fn().mockResolvedValue([]),
  createWorkflow: vi.fn().mockResolvedValue({}),
  updateWorkflow: vi.fn().mockResolvedValue({ id: 'wf-alert', rule_config: { type: 'revenue_alert' }, enabled: true, channel_id: 'ch1', cron_expr: '0 9 * * *' }),
}));
vi.mock('../api/automation', () => auto);

vi.mock('./EmployeeMultiSelect', () => ({
  EmployeeMultiSelect: ({ onChange }: { onChange: (ids: string[]) => void }) => (
    <button type="button" onClick={() => onChange(['u1'])}>选择张三</button>
  ),
}));

import { AnalyticsPage } from './AnalyticsPage';
import { MovingAverageStatus } from './analytics/MovingAverageStatus';
import { StoreScopePicker } from './analytics/StoreScopePicker';
import { TrendPeriodControls } from './analytics/TrendPeriodControls';
import { useAuthStore } from '../store/authStore';
import { useChannelStore } from '../store/channelStore';
import { useEmployeeStore } from '../store/employeeStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function productTrendResult(period: string, storeTrends?: Record<string, unknown[]>) {
  return {
    metric: 'quantity',
    date_from: '2026-06-01',
    date_to: '2026-06-30',
    dim_type: 'shop',
    dim_key: 'ALL',
    product_key: 'A',
    product_name: '招牌擀面皮',
    points: [{ period, quantity: 10, sales_amount: 100, order_count: 5, missing: false }],
    store_trends: storeTrends,
  };
}

function laborTrendResult(period: string, storeTrends?: Record<string, unknown[]>) {
  const point = {
    period,
    net_revenue: 1000,
    actual_hours: 40,
    planned_hours: 42,
    actual_revenue_per_hour: 25,
    planned_revenue_per_hour: 23.81,
    headcount: 2,
    missing: false,
  };
  return {
    granularity: 'week',
    period,
    store_key: 'ALL',
    points: [point],
    store_trends: storeTrends,
  };
}

function defaultStoreScopeTree() {
  return {
    nodes: [
      {
        key: 'dept:11', type: 'department', label: '事业1部',
        children: [
          { key: 'shop:801', type: 'store', label: '北大街', store_key: '801', department_id: '111' },
          { key: 'shop:802', type: 'store', label: '南大街', store_key: '802', department_id: '112' },
        ],
      },
      {
        key: 'dept:12', type: 'department', label: '事业2部',
        children: [
          { key: 'shop:803', type: 'store', label: '华远店', store_key: '803', department_id: '113' },
          { key: 'shop:804', type: 'store', label: '科技路', store_key: '804', department_id: '114' },
        ],
      },
    ],
  };
}

async function selectAntdOption(label: string, optionText: string) {
  fireEvent.mouseDown(screen.getByLabelText(label));
  const options = await screen.findAllByText(optionText);
  fireEvent.click(options[options.length - 1]);
}

async function selectStoreScope(label: string, optionText: string) {
  fireEvent.mouseDown(screen.getByLabelText(label));
  if (optionText !== '事业1部') {
    const parentLabel = optionText === '华远店' ? '事业2部' : '事业1部';
    const parents = await screen.findAllByText(parentLabel);
    const parent = parents.find(item => item.closest('.ant-select-tree-treenode'))?.closest('.ant-select-tree-treenode');
    const switcher = parent?.querySelector('.ant-select-tree-switcher_close');
    if (switcher) fireEvent.click(switcher);
  }
  const option = await waitFor(() => {
    const match = screen.getAllByText(optionText).find(item => item.closest('.ant-select-tree-treenode'));
    expect(match).toBeTruthy();
    return match!;
  });
  fireEvent.click(option);
}


function defaultOperationsOverview() {
  const metrics = {
    paid_amount: { current: 19235.01, previous: 16029.18, difference: 3205.83, change_rate: 0.2, status: 'ok' },
    income_amount: { current: 17800.50, previous: 16000.45, difference: 1800.05, change_rate: 0.1125, status: 'ok' },
    refund_amount: { current: 355.38, previous: 400.65, difference: -45.27, change_rate: -0.1125, status: 'ok' },
    net_income: { current: 17445.12, previous: 13956.10, difference: 3489.02, change_rate: 0.25, status: 'ok' },
    order_count: { current: 937, previous: 750, difference: 187, change_rate: 0.25, status: 'ok' },
    avg_order_value: { current: 18.62, previous: 19.40, difference: -0.78, change_rate: -0.04, status: 'ok' },
    refund_rate: { current: 0.0185, previous: 0.02, difference: -0.0015, change_rate: -0.075, status: 'ok' },
  };
  return {
    period: { date_from: '2026-06-01', date_to: '2026-06-07' },
    previous_period: { date_from: '2026-05-25', date_to: '2026-05-31' },
    metrics,
    channels: [],
    platforms: [],
    stores: [{ dim_key: 'ALL', dim_label: '全部', store_key: 'ALL', store_label: '全部', metrics }],
    store_channels: [],
    store_platforms: [{ dim_key: 'ALL|10', dim_label: '全部 · 平台10', store_key: 'ALL', store_label: '全部', metrics }],
    sections: {},
    completeness: { data_status: 'ready' },
    generated_at: '2026-06-08T09:00:00+08:00',
  };
}

function operationsOverviewWithStore(storeKey: string, storeLabel: string) {
  const overview = defaultOperationsOverview();
  return {
    ...overview,
    stores: [{ dim_key: storeKey, dim_label: storeLabel, store_key: storeKey, store_label: storeLabel, metrics: overview.metrics }],
    store_platforms: [{ dim_key: `${storeKey}|10`, dim_label: `${storeLabel} · 平台10`, store_key: storeKey, store_label: storeLabel, metrics: overview.metrics }],
  };
}

function hasOperationsOverviewCall(expected: Record<string, unknown>) {
  const calls = operationsApi.fetchOperationsOverview.mock.calls as Array<[{ filters?: Record<string, unknown> }]>;
  return calls.some(([request]) => {
    const filters = request.filters || {};
    return Object.entries(expected).every(([key, value]) => {
      const actual = filters[key];
      return Array.isArray(value) ? JSON.stringify(actual) === JSON.stringify(value) : actual === value;
    });
  });
}

describe('AnalyticsPage', () => {
  beforeEach(() => {
    Object.values(api).forEach(fn => fn.mockClear?.());
    Object.values(operationsApi).forEach(fn => fn.mockClear?.());
    operationsApi.fetchOperationsOverview.mockReset().mockResolvedValue(defaultOperationsOverview());
    Object.values(auto).forEach(fn => fn.mockClear?.());
    api.getProducts.mockReset().mockResolvedValue({
      top: [{ product_key: 'A', product_name: '招牌擀面皮', quantity: 30, sales_amount: 300, order_count: 25, sales_share: 0.4 }],
      bottom: [],
    });
    api.getProductTrend.mockReset().mockResolvedValue(productTrendResult('2026-W-BASE'));
    api.getLaborEfficiency.mockReset().mockResolvedValue({
      rows: [{ store_key: '100', store_label: '北大街', net_revenue: 1000, actual_hours: 40, planned_hours: 42, revenue_per_hour: 25, headcount: 2, hours_gap: 2, uncovered: false }],
    });
    api.getLaborEfficiencyTrend.mockReset().mockResolvedValue(laborTrendResult('2026-W-BASE'));
    api.listStoreScopeTree.mockReset().mockResolvedValue(defaultStoreScopeTree());
    chartRender.product.mockClear();
    chartRender.labor.mockClear();
    useChannelStore.getState().reset();   // 全局缓存 store 跨用例复位，避免缓存命中影响断言
    useEmployeeStore.getState().reset();
    useAuthStore.setState({ role: 'admin' });
  });

  it('订单统计排在经营看板前并作为默认栏目', async () => {
    render(<AnalyticsPage />);
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());
    const ordersTab = screen.getAllByText('订单统计')[0];
    const dashboardTab = screen.getAllByText('经营看板')[0];
    expect(ordersTab.compareDocumentPosition(dashboardTab) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText('订单统计维度')).toBeTruthy();
  });

  it('经营看板加载趋势主图和餐段指标', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('经营看板'));
    await waitFor(() => expect(api.getRevenueTrend).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(api.getMealPeriods).toHaveBeenCalled());
    await waitFor(() => expect(api.getMealPeriodTrend).toHaveBeenCalled());
    expect(screen.getAllByText('经营看板').length).toBeGreaterThan(0);
    expect(await screen.findByText(/净实收趋势/)).toBeTruthy();
    expect(screen.getByText('餐段趋势')).toBeTruthy();
    expect(screen.getByLabelText('餐段选择')).toBeTruthy();
    expect(screen.getByText('午餐 · MA7 / MA30 / MA180')).toBeTruthy();
    await selectAntdOption('餐段选择', '晚餐');
    expect(screen.getByText('晚餐 · MA7 / MA30 / MA180')).toBeTruthy();
    expect(api.getMealPeriodTrend).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('早餐').length).toBeGreaterThan(0);
    expect(screen.getAllByText('夜宵').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('经营看板对比方式')).toBeTruthy();
    expect(screen.getByLabelText('经营看板对比展示')).toBeTruthy();
    expect(screen.getAllByText('较上期 +25.0%').length).toBeGreaterThan(0);
  });

  it('订单统计视图加载并展示营业额+净实收双口径', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());
    expect(screen.getAllByText('¥19,235.01').length).toBeGreaterThan(0);   // 营业额（用户实付）
    expect(screen.getAllByText('¥17,445.12').length).toBeGreaterThan(0);   // 净实收（实收−退款）
    expect(screen.queryByText('净实收趋势')).toBeNull();
    expect(screen.getAllByText('全部').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('订单统计对比方式')).toBeTruthy();
    expect(screen.getByLabelText('订单统计对比展示')).toBeTruthy();
    expect(screen.getAllByText('较上期 +25.0%').length).toBeGreaterThan(0);
  });

  it('订单统计把七项波动比例放入对应单元格并移除独立对比列', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());

    const table = screen.getByRole('table');
    expect(screen.queryByRole('columnheader', { name: '较上期净实收' })).toBeNull();

    const expectations = [
      ['937', '+25.0%', 'text-emerald-600'],
      ['¥19,235.01', '+20.0%', 'text-emerald-600'],
      ['¥17,800.50', '+11.3%', 'text-emerald-600'],
      ['¥355.38', '-11.3%', 'text-red-500'],
      ['¥17,445.12', '+25.0%', 'text-emerald-600'],
      ['¥18.62', '-4.0%', 'text-red-500'],
      ['1.85%', '-7.5%', 'text-red-500'],
    ];
    expectations.forEach(([value, rate, tone]) => {
      const cell = screen.getAllByText(value).find(item => item.closest('table') === table)?.closest('td');
      expect(cell?.textContent).toContain(rate);
      expect(cell?.querySelector(`.${tone}`)).toBeTruthy();
    });
  });

  it('普通用户可查看经营分析，但不能进入设置或配置推送', async () => {
    useAuthStore.setState({ role: 'member' });
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());
    expect(screen.getByText('订单统计')).toBeTruthy();
    expect(screen.queryByText('设置')).toBeNull();
    expect(screen.queryByText('设为定时推送')).toBeNull();

    fireEvent.click(screen.getByText('营收报警'));
    await waitFor(() => expect(api.getRevenueAlerts).toHaveBeenCalled());
    expect(screen.getByText('北大街店')).toBeTruthy();
    expect(screen.queryByText('报警设置')).toBeNull();
    expect(screen.queryByRole('button', { name: '检测' })).toBeNull();
  });

  it('订单统计日统计默认查询北京时间今天', async () => {
    const expected = currentBeijingDate();

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));

    await waitFor(() => {
      expect(hasOperationsOverviewCall({ granularity: 'day', dateFrom: expected, dateTo: expected })).toBe(true);
    });
  });

  it('订单统计默认按店铺查询', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());
    await waitFor(() => {
      expect(hasOperationsOverviewCall({ scopeKeys: ['ALL'], storeKeys: [] })).toBe(true);
    });
  });

  it('订单统计周月周期包含今日并传递完整参数', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-20T12:00:00+08:00'));
    try {
      render(<AnalyticsPage />);
      fireEvent.click(screen.getByText('订单统计'));
      await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());
      operationsApi.fetchOperationsOverview.mockClear();

      await selectAntdOption('订单统计周期', '周');
      expect(screen.getByLabelText('选择周')).toBeTruthy();
      expect(screen.getByText('2026-W30（07/20 - 07/26）')).toBeTruthy();
      expect(screen.getByText('本周范围：2026-07-20 至 2026-07-26')).toBeTruthy();
      await waitFor(() => {
        expect(hasOperationsOverviewCall({ granularity: 'week', dateFrom: '2026-07-20', dateTo: '2026-07-20' })).toBe(true);
      });

      await selectAntdOption('订单统计周期', '月');
      expect(screen.getByLabelText('选择月份')).toBeTruthy();
      await waitFor(() => {
        expect(hasOperationsOverviewCall({ granularity: 'month', dateFrom: '2026-07-01', dateTo: '2026-07-20' })).toBe(true);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('订单统计切换日周月和移动周期时日期选择器始终与请求一致', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-20T12:00:00+08:00'));
    try {
      render(<AnalyticsPage />);
      fireEvent.click(screen.getByText('订单统计'));
      await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());

      fireEvent.click(screen.getAllByText('◀')[0]);
      await waitFor(() => {
        expect(hasOperationsOverviewCall({ granularity: 'day', dateFrom: '2026-07-19', dateTo: '2026-07-19' })).toBe(true);
      });
      expect((screen.getByLabelText('选择日期') as HTMLInputElement).value).toBe('2026-07-19');

      await selectAntdOption('订单统计周期', '周');
      fireEvent.click(screen.getAllByText('◀')[0]);
      await waitFor(() => {
        expect(hasOperationsOverviewCall({ granularity: 'week', dateFrom: '2026-07-13', dateTo: '2026-07-19' })).toBe(true);
      });
      expect((screen.getByLabelText('选择周') as HTMLInputElement).value).toBe('2026-W29');

      await selectAntdOption('订单统计周期', '月');
      fireEvent.click(screen.getAllByText('◀')[0]);
      await waitFor(() => {
        expect(hasOperationsOverviewCall({ granularity: 'month', dateFrom: '2026-06-01', dateTo: '2026-06-30' })).toBe(true);
      });
      expect((screen.getByLabelText('选择月份') as HTMLInputElement).value).toBe('2026-06');
    } finally {
      vi.useRealTimers();
    }
  });

  it('订单统计快照修复中展示进度并在完成后刷新数据', async () => {
    api.getOrders.mockResolvedValueOnce({
      rows: [
        { dim_key: 'ALL', dim_label: '全部', order_count: 100, paid_amount: 1000, income_amount: 900, refund_amount: 0, net_amount: 1000, net_income: 900, avg_order_value: 10, refund_rate: 0, computed_at: null },
      ],
      excluded: { excluded_orders: 0, excluded_shops: [], confirmed_shops: 11 },
      snapshot_status: 'partial',
      refresh_queued: true,
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalled());
    fireEvent.click(screen.getByText('刷新'));
    expect(await screen.findByText('正在修复经营分析快照')).toBeTruthy();
    expect(screen.getByText('页面会自动检查修复结果，完成后重新加载最新数据。')).toBeTruthy();
    expect(api.getOrders.mock.calls.some(call => call[3] === true)).toBe(true);
  });

  it('订单统计快速切换周期时忽略过期响应', async () => {
    let resolveFirst: (value: unknown) => void = () => {};
    let resolveSecond: (value: unknown) => void = () => {};
    operationsApi.fetchOperationsOverview
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveSecond = resolve; }));

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getAllByText('◀')[0]);
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(2));

    resolveSecond(operationsOverviewWithStore('NEXT', '新周期'));
    expect((await screen.findAllByText('新周期')).length).toBeGreaterThan(0);

    resolveFirst(operationsOverviewWithStore('OLD', '旧周期'));
    await waitFor(() => expect(screen.queryByText('旧周期')).toBeNull());
    expect(screen.getAllByText('新周期').length).toBeGreaterThan(0);
  });

  it('订单统计右箭头进入未来时拦截且不请求', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getAllByText('▶')[0]);

    await waitFor(() => expect(screen.getByText('当前只能查看截至今日的数据，无法查看后续日期。')).toBeTruthy());
    expect(operationsApi.fetchOperationsOverview).toHaveBeenCalledTimes(1);
  });

  it('整合维度 AI 解读展示结构化经营报告的上下文和知识候选', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(screen.getByText('生成解读')).toBeTruthy());
    fireEvent.click(screen.getByText('生成解读'));
    await waitFor(() => expect(api.getBusinessReport).toHaveBeenCalled());
    expect(await screen.findByText(/建议动作/)).toBeTruthy();
    expect(screen.getByText('数据来源：')).toBeTruthy();
    expect(screen.getByText('订单快照')).toBeTruthy();
    expect(screen.getByText(/部分门店缺少商圈画像/)).toBeTruthy();
    expect(screen.getByText(/已生成 1 条待确认知识候选/)).toBeTruthy();
  });

  it('AI 解读：原始 JSON 只展示 content_md，不暴露内部字段', async () => {
    api.getOrdersInsight.mockResolvedValueOnce({
      content_md: '{"content_md":"**经营结论**：三桥退款率偏高。","numeric_claims":[{"label":"退款率","value":2.77,"source_ref":"data_context.orders.rows[0].refund_rate"}]}',
      cached: true,
      model: 'x',
    });
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(screen.getByText('生成解读')).toBeTruthy());
    await selectAntdOption('订单统计维度', '平台');
    await waitFor(() => expect(screen.getAllByText('平台10').length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText('生成解读'));
    await waitFor(() => expect(api.getOrdersInsight).toHaveBeenCalled());
    expect(api.getOrdersInsight.mock.calls[0][2]).toBe('shop_platform');
    expect(await screen.findByText(/三桥退款率偏高/)).toBeTruthy();
    expect(screen.queryByText(/numeric_claims/)).toBeNull();
    expect(screen.queryByText(/source_ref/)).toBeNull();
  });

  it('切到设置：展示店铺映射候选，选 HR 门店即确认', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('设置'));
    await waitFor(() => expect(api.getRevenueForecastModel).toHaveBeenCalled());
    expect(screen.getByText('营业额预测模型')).toBeTruthy();
    expect(screen.getByText('可试算，等待真实值回填')).toBeTruthy();
    expect(screen.getByText('真实值回填进度')).toBeTruthy();
    expect(screen.getByText('当前预测资产覆盖')).toBeTruthy();
    expect(screen.getByText(/天气 · 部分 8\/11/)).toBeTruthy();
    expect(screen.getByText(/商圈 · 可用 11\/11/)).toBeTruthy();
    expect(screen.getByText('技术详情')).toBeTruthy();
    await waitFor(() => expect(api.listShopMappings).toHaveBeenCalled());
    fireEvent.click(screen.getByText('待确认店铺'));
    expect(await screen.findByText('袁记肉夹馍（北大街直营店）')).toBeTruthy();
    // 候选已预选「北大街」(100)，点确认即提交
    fireEvent.click(screen.getByText('确认'));
    await waitFor(() => expect(api.confirmShopMapping).toHaveBeenCalledWith('h12351556670', '100'));
  });

  it('设置页将已确认和待确认店铺分表展示并保留改绑', async () => {
    api.listShopMappings.mockResolvedValueOnce([
      {
        shiheng_shop_id: 'confirmed-shop',
        shiheng_shop_name: '已确认门店',
        hr_department_id: '100',
        hr_department_name: '北大街',
        match_score: 1,
        status: 'confirmed',
      },
      {
        shiheng_shop_id: 'proposed-shop',
        shiheng_shop_name: '待确认门店',
        hr_department_id: '100',
        hr_department_name: '北大街',
        match_score: 0.86,
        status: 'proposed',
      },
      {
        shiheng_shop_id: 'other-proposed-shop',
        shiheng_shop_name: '另一家候选门店',
        hr_department_id: '101',
        hr_department_name: '南大街',
        match_score: 0.72,
        status: 'proposed',
      },
    ]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('设置'));

    expect(await screen.findByText('已确认店铺')).toBeTruthy();
    expect(screen.getByText('待确认店铺')).toBeTruthy();
    expect(screen.getByText('已确认门店')).toBeTruthy();
    expect(screen.getByRole('button', { name: '改绑' })).toBeTruthy();
    expect(screen.queryByText('待确认门店')).toBeNull();

    fireEvent.click(screen.getByText('待确认店铺'));
    expect(await screen.findByText('待确认门店')).toBeTruthy();
    expect(screen.getByText('另一家候选门店')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: '确认' })).toHaveLength(2);

    fireEvent.change(screen.getByRole('textbox', { name: '搜索待确认店铺' }), { target: { value: '另一家' } });
    expect(screen.queryByText('待确认门店')).toBeNull();
    expect(screen.getByText('另一家候选门店')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新生成候选' }));
    await waitFor(() => expect(api.proposeShopMappings).toHaveBeenCalled());
    expect(await screen.findByText('已同步食亨门店并重新生成候选')).toBeTruthy();
  });

  it('设置页门店地理只请求已完成店铺映射门店', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('设置'));
    await waitFor(() => expect(api.listStoreGeoProfiles).toHaveBeenCalledWith({ mappedOnly: true }));
  });

  it('设为定时推送：创建 business_analysis 工作流', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('订单统计'));
    await waitFor(() => expect(screen.getByText('设为定时推送')).toBeTruthy());
    fireEvent.click(screen.getByText('设为定时推送'));
    await waitFor(() => expect(auto.listChannels).toHaveBeenCalled());
    fireEvent.click(screen.getByText('选择张三'));
    fireEvent.click(screen.getByText('创建推送'));
    await waitFor(() => expect(auto.createWorkflow).toHaveBeenCalled());
    const body = auto.createWorkflow.mock.calls[0][0];
    expect(body.rule_config).toEqual({ type: 'business_analysis', report: 'order_daily' });
    expect(body.channel_id).toBe('ch1');
    expect(body.recipient_config).toEqual({ user_ids: ['u1'] });
  });

  it('切到营收报警：展示偏低报警', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));
    await waitFor(() => expect(api.getRevenueAlerts).toHaveBeenCalled());
    expect(api.getRevenueAlerts.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText(/优先处理 Top/)).toBeTruthy();
    expect(screen.getByText('北大街店')).toBeTruthy();
    expect(screen.getByText(/明显偏低/)).toBeTruthy();
    expect(screen.getByText(/可能原因：订单数较历史基线减少/)).toBeTruthy();
  });

  it('营收报警：展示前三项之后的天气原因', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1',
      shop_label: '茅坡新城直营店',
      business_date: '2026-08-04',
      actual_amount: 11682.28,
      baseline_amount: 14055.08,
      deviation_pct: -0.17,
      direction: 'under',
      status: 'open',
      baseline_sample_count: 4,
      baseline_expected_count: 4,
      reason_hints: [
        '小时分布异常。',
        '外卖净实收下降。',
        '京东秒送净实收下降。',
        '订单数减少。',
        '天气因素可能影响客流：降雨 2 小时。',
      ],
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findByText(/可能原因：天气因素可能影响客流：降雨 2 小时/)).toBeTruthy();
  });

  it('营收报警：展示主要建议、AI经营解读和辅助证据', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1', shop_label: '北大街店', business_date: '2026-08-04',
      actual_amount: 700, baseline_amount: 1000, deviation_pct: -0.3, direction: 'under', status: 'open',
      reason_hints: ['堂食较历史基线下降 30%。'],
      primary_cause: {
        summary: '优先核查堂食客流和现场运营。', confidence: 'medium', driver: 'dine_in_drop',
        supporting_signals: ['堂食下降'], focus_period: '15:00', classification: 'business_driver', evidence_refs: ['cause:dine-in'],
      },
      ai_interpretation: {
        status: 'ready', summary: '本次下降主要表现为堂食订单减少。', priority_action: '核查午餐后客流和营业状态。',
        uncertainties: ['天气仅作为可能放大因素。'], confidence: 'medium', generated_at: '2026-08-05T09:00:00+08:00',
      },
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findByText('主要判断')).toBeTruthy();
    expect(screen.getByText('AI 经营解读')).toBeTruthy();
    expect(screen.getByText('辅助证据与线索')).toBeTruthy();
    expect(screen.getByText('优先核查堂食客流和现场运营。')).toBeTruthy();
    expect(screen.getByText('本次下降主要表现为堂食订单减少。')).toBeTruthy();
    expect(screen.getByText('优先动作：核查午餐后客流和营业状态。')).toBeTruthy();
    expect(screen.getByText('可能原因：堂食较历史基线下降 30%。')).toBeTruthy();
  });

  it('营收报警：按主要判断、影响拆分和背景线索展示结构化原因', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1', shop_label: '阳光荟店', business_date: '2026-08-06',
      actual_amount: 5167.42, baseline_amount: 7122.24, deviation_pct: -0.27, direction: 'under', status: 'open',
      reason_hints: ['订单量较历史同星期均值变化 -23.0%。', 'shop 对净实收偏离的估算影响约 ¥1,139.78。'],
      primary_cause: {
        summary: '订单量下降是本次营收偏低的主要直接表现。',
        confidence: 'high', driver: 'order_count_drop', classification: 'business_driver',
        primary_evidence: '订单量较历史同星期均值变化 -23.0%。',
        recommended_action: '优先核查门店客流、营业状态及获客或曝光变化。',
        impact_signals: ['堂食对净实收偏离的估算影响约 ¥1,139.78。'],
        context_signals: ['天气关联线索：06:00–14:00 间歇性降雨，雨时段缺口占当日缺口 44%。'],
        supporting_signals: ['堂食对净实收偏离的估算影响约 ¥1,139.78。'], evidence_refs: ['cause:orders'],
      },
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findByText('主要判断')).toBeTruthy();
    expect(screen.getByText('建议动作：优先核查门店客流、营业状态及获客或曝光变化。')).toBeTruthy();
    expect(screen.getByText('影响拆分')).toBeTruthy();
    expect(screen.getByText('背景线索')).toBeTruthy();
    expect(screen.getByText('天气关联线索：06:00–14:00 间歇性降雨，雨时段缺口占当日缺口 44%。')).toBeTruthy();
    expect(screen.queryByText('可能原因：shop 对净实收偏离的估算影响约 ¥1,139.78。')).toBeNull();
  });

  it('营收报警：只有主要依据时不回退展示重复的原始原因', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1', shop_label: '阳光荟店', business_date: '2026-08-06',
      actual_amount: 5167.42, baseline_amount: 7122.24, deviation_pct: -0.27, direction: 'under', status: 'open',
      reason_hints: ['订单量较历史同星期均值变化 -23.0%。'],
      primary_cause: {
        summary: '订单量下降是本次营收偏低的主要直接表现。',
        confidence: 'high', driver: 'order_count_drop', classification: 'business_driver',
        primary_evidence: '订单量较历史同星期均值变化 -23.0%。',
        recommended_action: '优先核查门店客流、营业状态及获客或曝光变化。',
        impact_signals: [], context_signals: [], supporting_signals: [], evidence_refs: ['cause:orders'],
      },
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findByText('主要依据：订单量较历史同星期均值变化 -23.0%。')).toBeTruthy();
    expect(screen.queryByText('可能原因：订单量较历史同星期均值变化 -23.0%。')).toBeNull();
  });

  it('营收报警：数据质量主因待核查且 pending AI 不显示错误', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1', shop_label: '名称很长的北大街直营门店', business_date: '2026-08-04',
      actual_amount: 700, baseline_amount: 1000, deviation_pct: -0.3, direction: 'under', status: 'open',
      reason_hints: ['订单数据尚未完整。'],
      primary_cause: {
        summary: '数据存在缺失，优先核对订单、门店营业状态和同步情况。', confidence: 'review', driver: 'required_context_missing',
        supporting_signals: ['order_source_watermark'], classification: 'data_quality', evidence_refs: ['watermark:order'],
      },
      ai_interpretation: { status: 'pending' },
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findByText('主要判断 · 待核查')).toBeTruthy();
    expect(screen.getByText('AI 解读生成中')).toBeTruthy();
    expect(screen.queryByText(/生成失败|错误详情/)).toBeNull();
  });

  it('营收报警：结构化主因无原始线索时仍展示辅助证据空态并保持长文本换行', async () => {
    const longPrimary = '优先核查午餐堂食客流、现场运营、营业状态与高峰期履约情况，确认门店是否存在持续性的服务能力波动。';
    const longInterpretation = '本次下降主要集中在午餐堂食，建议按时段核查客流、排班、出餐和现场运营，并在确认数据完整后继续观察。';
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1', shop_label: '北大街店', business_date: '2026-08-04',
      actual_amount: 700, baseline_amount: 1000, deviation_pct: -0.3, direction: 'under', status: 'open',
      primary_cause: {
        summary: longPrimary, confidence: 'medium', driver: 'dine_in_drop', supporting_signals: [],
        classification: 'business_driver', evidence_refs: [],
      },
      ai_interpretation: { status: 'ready', summary: longInterpretation },
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findByText('辅助证据与线索')).toBeTruthy();
    expect(screen.getByText('暂无额外线索')).toBeTruthy();
    expect(screen.getByText(longPrimary).className).toContain('break-words');
    expect(screen.getByText(longInterpretation).className).toContain('break-words');
  });

  it('营收报警：旧版最小报警也默认展开辅助证据空态', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([{
      shop_key: '1', shop_label: '北大街店', business_date: '2026-08-04',
      actual_amount: 700, baseline_amount: 1000, deviation_pct: -0.3, direction: 'under', status: 'open',
    }]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    const details = (await screen.findByText('辅助证据与线索')).closest('details');
    expect(details?.open).toBe(true);
    expect(screen.getByText('暂无额外线索')).toBeTruthy();
  });

  it('营收报警：失败和不可用的 AI 不展示内容或错误详情', async () => {
    api.getRevenueAlerts.mockResolvedValueOnce([
      {
        shop_key: '1', shop_label: '北大街店', business_date: '2026-08-04',
        actual_amount: 700, baseline_amount: 1000, deviation_pct: -0.3, direction: 'under', status: 'open',
        primary_cause: { summary: '先核对数据。', confidence: 'review', driver: 'required_context_missing', supporting_signals: [], classification: 'data_quality' },
        ai_interpretation: { status: 'failed', summary: '不应展示的失败内容' },
      },
      {
        shop_key: '2', shop_label: '南大街店', business_date: '2026-08-04',
        actual_amount: 700, baseline_amount: 1000, deviation_pct: -0.3, direction: 'under', status: 'open',
        primary_cause: { summary: '先核对数据。', confidence: 'review', driver: 'required_context_missing', supporting_signals: [], classification: 'data_quality' },
        ai_interpretation: { status: 'unavailable', summary: '不应展示的不可用内容' },
      },
    ]);

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));

    expect(await screen.findAllByText('主要判断 · 待核查')).toHaveLength(2);
    expect(screen.queryByText('不应展示的失败内容')).toBeNull();
    expect(screen.queryByText('不应展示的不可用内容')).toBeNull();
    expect(screen.queryByText('AI 经营解读')).toBeNull();
  });

  it('营收报警：切换检测日后按所选日期重新加载', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));
    await waitFor(() => expect(api.getRevenueAlerts).toHaveBeenCalled());
    fireEvent.change(screen.getByDisplayValue(api.getRevenueAlerts.mock.calls[0][0]), { target: { value: '2026-06-30' } });
    await waitFor(() => {
      expect(api.getRevenueAlerts.mock.calls.some(call => call[0] === '2026-06-30')).toBe(true);
    });
  });

  it('营收报警设置：保存阈值并创建自动推送工作流', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('营收报警'));
    await waitFor(() => expect(api.getRevenueAlertSettings).toHaveBeenCalled());
    fireEvent.click(screen.getByText('报警设置'));
    await waitFor(() => expect(auto.listWorkflows).toHaveBeenCalled());
    fireEvent.click(screen.getByText('选择张三'));
    fireEvent.click(screen.getByLabelText('启用每日自动推送'));
    fireEvent.click(screen.getByText('保存设置'));
    await waitFor(() => expect(api.saveRevenueAlertSettings).toHaveBeenCalledWith({
      threshold_pct: 0.1,
      recipient_user_ids: ['u1'],
    }));
    await waitFor(() => expect(auto.createWorkflow).toHaveBeenCalled());
    const body = auto.createWorkflow.mock.calls[0][0];
    expect(body.rule_config).toEqual({ type: 'revenue_alert' });
    expect(body.date_window_type).toBe('yesterday');
    expect(body.recipient_config).toEqual({ user_ids: ['u1'] });
  });

  it('切到产品：展示畅销榜', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(api.getProducts).toHaveBeenCalled());
    expect(await screen.findByText('全部产品')).toBeTruthy();
    expect(screen.getAllByText('招牌擀面皮').length).toBeGreaterThan(0);
    expect(screen.getByText('单品销量趋势')).toBeTruthy();
    await waitFor(() => expect(api.getProductTrend).toHaveBeenCalled());
    expect(screen.getByLabelText('产品对比方式')).toBeTruthy();
  });

  it('产品表格把各项上期比例放入对应单元格并移除独立对比列', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(operationsApi.fetchOperationsProducts).toHaveBeenCalled());

    const table = screen.getByRole('table');
    expect(screen.queryByRole('columnheader', { name: '较上期销额' })).toBeNull();
    const expectations = [
      ['30', '+20.0%', 'text-emerald-600'],
      ['¥300.00', '+25.0%', 'text-emerald-600'],
      ['25', '-16.7%', 'text-red-500'],
      ['40.0%', '-20.0%', 'text-red-500'],
    ];
    expectations.forEach(([value, rate, tone]) => {
      const cell = screen.getAllByText(value).find(item => item.closest('table') === table)?.closest('td');
      expect(cell?.textContent).toContain(rate);
      expect(cell?.querySelector(`.${tone}`)).toBeTruthy();
    });
  });

  it('产品默认选择前两项，并让选择器与表格勾选双向同步', async () => {
    api.getProducts.mockResolvedValue({
      top: [
        { product_key: 'A', product_name: '产品A', quantity: 30, sales_amount: 300, order_count: 25, sales_share: 0.4 },
        { product_key: 'B', product_name: '产品B', quantity: 20, sales_amount: 200, order_count: 15, sales_share: 0.3 },
        { product_key: 'C', product_name: '产品C', quantity: 10, sales_amount: 100, order_count: 8, sales_share: 0.2 },
      ],
      bottom: [],
    });
    api.getProductTrend.mockImplementation((productKey: string) => Promise.resolve({
      ...productTrendResult(`2026-W-${productKey}`),
      product_key: productKey,
      product_name: `产品${productKey}`,
    }));

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));

    await waitFor(() => expect(api.getProductTrend.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['A', 'B'])));
    await waitFor(() => expect(screen.getByTestId('product-trend-chart').getAttribute('data-product-keys')).toBe('A,B'));

    const productBRow = screen.getByText('产品B').closest('tr');
    const productCRow = screen.getByText('产品C').closest('tr');
    expect((productBRow?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked).toBe(true);
    fireEvent.click(productCRow?.querySelector('input[type="checkbox"]') as HTMLInputElement);

    await waitFor(() => expect(api.getProductTrend.mock.calls.some(call => call[0] === 'C')).toBe(true));
    await waitFor(() => expect(screen.getByTestId('product-trend-chart').getAttribute('data-product-keys')).toBe('A,B,C'));

    await selectAntdOption('趋势产品选择', '产品B');
    await waitFor(() => expect((productBRow?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.checked).toBe(false));
    await waitFor(() => expect(screen.getByTestId('product-trend-chart').getAttribute('data-product-keys')).toBe('A,C'));
  });

  it('产品趋势最多允许同时选择五项', async () => {
    api.getProducts.mockResolvedValue({
      top: ['A', 'B', 'C', 'D', 'E', 'F'].map((key, index) => ({
        product_key: key,
        product_name: `产品${key}`,
        quantity: 60 - index * 10,
        sales_amount: 600 - index * 100,
        order_count: 50 - index * 5,
        sales_share: 0.2 - index * 0.02,
      })),
      bottom: [],
    });
    api.getProductTrend.mockImplementation((productKey: string) => Promise.resolve({
      ...productTrendResult(`2026-W-${productKey}`),
      product_key: productKey,
      product_name: `产品${productKey}`,
    }));

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(api.getProductTrend.mock.calls.map(call => call[0])).toEqual(expect.arrayContaining(['A', 'B'])));

    for (const key of ['C', 'D', 'E']) {
      const row = screen.getByText(`产品${key}`).closest('tr');
      fireEvent.click(row?.querySelector('input[type="checkbox"]') as HTMLInputElement);
    }

    expect(await screen.findByText('已选 5 / 5 个产品')).toBeTruthy();
    const productFRow = screen.getByText('产品F').closest('tr');
    expect((productFRow?.querySelector('input[type="checkbox"]') as HTMLInputElement | null)?.disabled).toBe(true);
  });

  it('产品门店趋势优先复用全部门店返回的 store_trends', async () => {
    api.getProductTrend.mockResolvedValue({
      metric: 'quantity',
      date_from: '2026-06-01',
      date_to: '2026-06-07',
      dim_type: 'all',
      dim_key: 'ALL',
      product_key: 'A',
      product_name: '招牌擀面皮',
      points: [],
      store_trends: { '801': [], '803': [] },
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(api.getProductTrend).toHaveBeenCalled());

    await selectAntdOption('产品维度', '分店铺');
    await selectStoreScope('产品门店范围', '华远店');
    await selectStoreScope('产品门店范围', '北大街');
    await waitFor(() => expect(api.getProductTrend).toHaveBeenLastCalledWith(
      'A',
      expect.any(String),
      expect.any(String),
      'ALL',
      undefined,
      expect.objectContaining({
        granularity: 'week',
        includeStoreTrends: true,
        storeKeys: expect.arrayContaining(['801', '803']),
      }),
    ));
    expect(screen.getByText(/已选范围对比/)).toBeTruthy();
  });

  it('passes expanded shop ids to product trend for a parent scope', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(api.getProductTrend).toHaveBeenCalled());

    await selectAntdOption('产品维度', '分店铺');
    await selectStoreScope('产品门店范围', '事业1部');

    await waitFor(() => expect(api.getProductTrend).toHaveBeenLastCalledWith(
      'A', expect.any(String), expect.any(String), 'ALL', undefined,
      expect.objectContaining({ storeKeys: ['801', '802'], granularity: 'week' }),
    ));
    expect(api.getProducts).toHaveBeenLastCalledWith(
      'day', expect.any(String), 'ALL', false, 0, 'shop', false,
      expect.objectContaining({ storeKeys: ['801', '802'] }),
    );
  });

  it('产品非 ALL 范围未解析到门店时不发排名和趋势请求', async () => {
    api.listStoreScopeTree.mockResolvedValue({
      nodes: [{
        key: 'dept:broken', type: 'department', label: '事业1部',
        children: [{ key: 'shop:broken', type: 'store', label: '未映射门店' }],
      }],
    });
    api.getProductTrend.mockResolvedValue(productTrendResult('2026-W-ALL'));

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(api.getProductTrend).toHaveBeenCalled());
    await selectAntdOption('产品维度', '分店铺');
    await waitFor(() => expect(api.getProducts.mock.calls.length).toBeGreaterThan(1));
    await waitFor(() => expect(api.getProductTrend.mock.calls.length).toBeGreaterThan(1));
    const productCalls = api.getProducts.mock.calls.length;
    const trendCalls = api.getProductTrend.mock.calls.length;

    await selectStoreScope('产品门店范围', '事业1部');

    expect(await screen.findByText('当前门店范围未解析到食亨门店，请检查门店映射。')).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(api.getProducts).toHaveBeenCalledTimes(productCalls);
    expect(api.getProductTrend).toHaveBeenCalledTimes(trendCalls);
  });

  it('产品趋势快速切换和卸载会中止旧请求', async () => {
    const requests: Array<{ productKey: string; signal?: AbortSignal }> = [];
    api.getProducts.mockResolvedValue({
      top: [
        { product_key: 'A', product_name: '产品A', quantity: 30, sales_amount: 300, order_count: 25, sales_share: 0.4 },
        { product_key: 'B', product_name: '产品B', quantity: 20, sales_amount: 200, order_count: 15, sales_share: 0.3 },
        { product_key: 'C', product_name: '产品C', quantity: 10, sales_amount: 100, order_count: 8, sales_share: 0.2 },
      ],
      bottom: [],
    });
    api.getProductTrend.mockImplementation((productKey: string, ...args: unknown[]) => {
      const pending = deferred<ReturnType<typeof productTrendResult>>();
      const options = args[4] as { signal?: AbortSignal } | undefined;
      requests.push({ productKey, signal: options?.signal });
      options?.signal?.addEventListener('abort', () => {
        pending.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      }, { once: true });
      return pending.promise;
    });

    const view = render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await waitFor(() => expect(requests.map(item => item.productKey)).toEqual(['A', 'B']));
    const initialRequests = [...requests];

    const productCRow = screen.getByText('产品C').closest('tr');
    fireEvent.click(productCRow?.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await waitFor(() => expect(requests.length).toBe(5));

    expect(initialRequests.every(request => request.signal?.aborted)).toBe(true);
    const currentRequests = requests.slice(2);
    expect(currentRequests.map(request => request.productKey)).toEqual(['A', 'B', 'C']);
    expect(currentRequests.every(request => request.signal?.aborted === false)).toBe(true);

    view.unmount();
    expect(currentRequests.every(request => request.signal?.aborted)).toBe(true);
  });

  it('产品父部门与子门店共选时保留旧图并在成功后原子切换', async () => {
    const comparison = deferred<ReturnType<typeof productTrendResult>>();
    api.getProducts.mockResolvedValue({
      top: [{ product_key: 'A', product_name: '招牌擀面皮', quantity: 30, sales_amount: 300, order_count: 25, sales_share: 0.4 }],
      bottom: [],
    });
    api.getProductTrend.mockImplementation((...args: unknown[]) => {
      const options = args[5] as { storeKeys?: string[]; includeStoreTrends?: boolean } | undefined;
      const keys = (options?.storeKeys || []).join(',');
      if (keys === '801,802' && options?.includeStoreTrends) return comparison.promise;
      if (keys === '801,802') return Promise.resolve(productTrendResult('2026-W-PARENT'));
      return Promise.resolve(productTrendResult('2026-W-ALL'));
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('产品'));
    await selectAntdOption('产品维度', '分店铺');
    await selectStoreScope('产品门店范围', '事业1部');
    await waitFor(() => expect(screen.getByTestId('product-trend-chart').getAttribute('data-periods')).toBe('2026-W-PARENT'));

    await selectStoreScope('产品门店范围', '北大街');
    await waitFor(() => expect(api.getProductTrend.mock.calls.some(call => (
      call[5]?.storeKeys?.join(',') === '801,802' && call[5]?.includeStoreTrends === true
    ))).toBe(true));
    expect(screen.getByTestId('product-trend-chart').getAttribute('data-periods')).toBe('2026-W-PARENT');
    expect(screen.getByTestId('product-trend-chart').getAttribute('data-store-keys')).toBe('');

    await act(async () => {
      comparison.resolve(productTrendResult('2026-W-COMPARE', {
        '801': [{ period: '2026-W-COMPARE', quantity: 4, missing: false }],
        '802': [{ period: '2026-W-COMPARE', quantity: 6, missing: false }],
      }));
    });
    await waitFor(() => expect(screen.getByTestId('product-trend-chart').getAttribute('data-periods')).toBe('2026-W-COMPARE'));
    expect(screen.getByTestId('product-trend-chart').getAttribute('data-store-keys')).toBe('dept:11,shop:801');
  });

  it('切到人效：展示直营映射门店人效', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await waitFor(() => expect(api.getLaborEfficiency).toHaveBeenCalled());
    expect(screen.getByText('北大街')).toBeTruthy();
    expect(screen.queryByText('未进入门店人效排名')).toBeNull();
    expect(screen.queryByText(/财务部/)).toBeNull();
    expect(screen.getByLabelText('人效对比方式')).toBeTruthy();
    expect(screen.getByLabelText('人效对比展示')).toBeTruthy();
    expect(screen.getAllByText('较上期 +11.1%').length).toBeGreaterThan(0);
  });

  it('人效显式多选门店时按部门 ID 请求并展示门店对比', async () => {
    api.getLaborEfficiency.mockResolvedValueOnce({
      rows: [
        { store_key: '100', store_label: '北大街', net_revenue: 1000, actual_hours: 40, planned_hours: 42, revenue_per_hour: 25, headcount: 2, hours_gap: 2, uncovered: false },
        { store_key: '200', store_label: '华远店', net_revenue: 2000, actual_hours: 20, planned_hours: 25, revenue_per_hour: 100, headcount: 3, hours_gap: 5, uncovered: false },
      ],
    });
    api.getLaborEfficiencyTrend.mockResolvedValueOnce({
      granularity: 'range',
      period: '2026-06-20_2026-06-30',
      store_key: 'ALL',
      points: [],
      store_trends: { '111': [], '113': [] },
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenCalledTimes(1));
    expect(api.getLaborEfficiencyTrend.mock.calls[0][2]).toBe('ALL');

    await selectStoreScope('人效门店范围', '华远店');
    await selectStoreScope('人效门店范围', '北大街');
    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 30,
      expect.objectContaining({
        granularity: 'week',
        includeStoreTrends: true,
        storeKeys: expect.arrayContaining(['111', '113']),
      }),
    ));

    expect(screen.getByText('实际 / 排班 · 已选范围对比')).toBeTruthy();
  });

  it('passes mapped department ids to labor without losing the parent aggregate', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenCalled());

    await selectStoreScope('人效门店范围', '事业1部');

    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 30,
      expect.objectContaining({ storeKeys: ['111', '112'], granularity: 'week' }),
    ));
    expect(api.getLaborEfficiency).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), false,
      expect.objectContaining({ storeKeys: ['111', '112'] }),
    );
    expect(screen.queryByText(/门店对比/)).toBeNull();
  });

  it('人效非 ALL 范围未解析到部门时不发汇总和趋势请求', async () => {
    api.listStoreScopeTree.mockResolvedValue({
      nodes: [{
        key: 'dept:broken', type: 'department', label: '事业1部',
        children: [{ key: 'shop:broken', type: 'store', label: '未映射门店', store_key: 'broken' }],
      }],
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenCalled());
    const summaryCalls = api.getLaborEfficiency.mock.calls.length;
    const trendCalls = api.getLaborEfficiencyTrend.mock.calls.length;

    await selectStoreScope('人效门店范围', '事业1部');

    expect(await screen.findByText('当前门店范围未解析到人事部门，请检查门店映射。')).toBeTruthy();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(api.getLaborEfficiency).toHaveBeenCalledTimes(summaryCalls);
    expect(api.getLaborEfficiencyTrend).toHaveBeenCalledTimes(trendCalls);
  });

  it('人效两个显式门店映射同一部门时不进入门店对比', async () => {
    api.listStoreScopeTree.mockResolvedValue({
      nodes: [{
        key: 'dept:11', type: 'department', label: '事业1部',
        children: [
          { key: 'shop:801', type: 'store', label: '北大街', store_key: '801', department_id: '111' },
          { key: 'shop:802', type: 'store', label: '南大街', store_key: '802', department_id: '111' },
          { key: 'shop:804', type: 'store', label: '科技路', store_key: '804', department_id: '114' },
        ],
      }],
    });
    api.getLaborEfficiencyTrend.mockResolvedValue({
      ...laborTrendResult('2026-W-SAME-DEPT', {
        '111': [{ period: '2026-W-SAME-DEPT', actual_hours: 40, planned_hours: 42, missing: false }],
      }),
      moving_averages: [
        { field: 'actual_hours_ma4', label: 'ACTUAL_HOURS_MA4', window: 4, available: true, available_periods: 5 },
        { field: 'planned_hours_ma4', label: 'PLANNED_HOURS_MA4', window: 4, available: true, available_periods: 5 },
      ],
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenCalled());
    await selectStoreScope('人效门店范围', '北大街');
    await selectStoreScope('人效门店范围', '南大街');

    await waitFor(() => expect(api.getLaborEfficiencyTrend).toHaveBeenLastCalledWith(
      expect.any(String), expect.any(String), 'ALL', 30,
      expect.objectContaining({ storeKeys: ['111'], includeStoreTrends: false }),
    ));
    expect(screen.queryByText(/门店对比/)).toBeNull();
    expect(screen.getByText('实际 / 排班 · MA4')).toBeTruthy();
  });

  it('人效父部门与子门店共选时保留旧图并在成功后原子切换', async () => {
    const comparisonSummary = deferred<{ rows: unknown[] }>();
    const comparisonTrend = deferred<ReturnType<typeof laborTrendResult>>();
    let departmentSummaryRequests = 0;
    api.getLaborEfficiency.mockImplementation((...args: unknown[]) => {
      const keys = ((args[3] as { storeKeys?: string[] } | undefined)?.storeKeys || []).join(',');
      if (keys === '111,112') {
        departmentSummaryRequests += 1;
        if (departmentSummaryRequests > 1) return comparisonSummary.promise;
      }
      return Promise.resolve({ rows: [
        { store_key: '111', store_label: '北大街', net_revenue: 1000, actual_hours: 40, planned_hours: 42, revenue_per_hour: 25, headcount: 2, hours_gap: 2, uncovered: false },
        { store_key: '112', store_label: '南大街', net_revenue: 800, actual_hours: 30, planned_hours: 31, revenue_per_hour: 26.67, headcount: 2, hours_gap: 1, uncovered: false },
      ] });
    });
    api.getLaborEfficiencyTrend.mockImplementation((...args: unknown[]) => {
      const options = args[4] as { storeKeys?: string[]; includeStoreTrends?: boolean } | undefined;
      const keys = (options?.storeKeys || []).join(',');
      if (keys === '111,112' && options?.includeStoreTrends) return comparisonTrend.promise;
      if (keys === '111,112') return Promise.resolve(laborTrendResult('2026-W-PARENT'));
      return Promise.resolve(laborTrendResult('2026-W-ALL'));
    });

    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await selectStoreScope('人效门店范围', '事业1部');
    await waitFor(() => expect(screen.getByTestId('labor-hours-trend-chart').getAttribute('data-periods')).toBe('2026-W-PARENT'));

    await selectStoreScope('人效门店范围', '北大街');
    await waitFor(() => expect(api.getLaborEfficiencyTrend.mock.calls.some(call => (
      call[4]?.storeKeys?.join(',') === '111,112' && call[4]?.includeStoreTrends === true
    ))).toBe(true));
    expect(screen.getByTestId('labor-hours-trend-chart').getAttribute('data-periods')).toBe('2026-W-PARENT');
    expect(screen.getByTestId('labor-hours-trend-chart').getAttribute('data-store-keys')).toBe('');

    await act(async () => {
      comparisonSummary.resolve({ rows: [
        { store_key: '111', store_label: '北大街', net_revenue: 1000, actual_hours: 40, planned_hours: 42, revenue_per_hour: 25, headcount: 2, hours_gap: 2, uncovered: false },
        { store_key: '112', store_label: '南大街', net_revenue: 900, actual_hours: 35, planned_hours: 37, revenue_per_hour: 25.71, headcount: 2, hours_gap: 2, uncovered: false },
      ] });
      comparisonTrend.resolve(laborTrendResult('2026-W-COMPARE', {
        '111': [{ period: '2026-W-COMPARE', actual_hours: 40, planned_hours: 42, missing: false }],
        '112': [{ period: '2026-W-COMPARE', actual_hours: 35, planned_hours: 37, missing: false }],
      }));
    });
    await waitFor(() => expect(screen.getByTestId('labor-hours-trend-chart').getAttribute('data-periods')).toBe('2026-W-COMPARE'));
    expect(screen.getByTestId('labor-hours-trend-chart').getAttribute('data-store-keys')).toBe('dept:11,shop:801');
  });

  it('人效净实收明细：展示按日拆分和店铺汇总', async () => {
    render(<AnalyticsPage />);
    fireEvent.click(screen.getByText('人效'));
    await waitFor(() => expect(api.getLaborEfficiency).toHaveBeenCalled());
    fireEvent.click(screen.getByText('明细'));
    await waitFor(() => expect(api.getLaborEfficiencyDetail).toHaveBeenCalledWith(expect.any(String), expect.any(String), '100'));
    expect(await screen.findByText('按日明细')).toBeTruthy();
    expect(screen.getByText('2026-06-29')).toBeTruthy();
    expect(screen.getByText('2026-06-30')).toBeTruthy();
    expect(screen.getByText('食亨店铺汇总')).toBeTruthy();
  });
});

describe('共享经营分析控件', () => {
  const tree = [
    {
      key: 'dept:11',
      type: 'department' as const,
      label: '事业1部',
      children: [
        { key: 'shop:101', type: 'store' as const, label: '北大街店', store_key: '101' },
        { key: 'shop:102', type: 'store' as const, label: '南大街店', store_key: '102' },
        { key: 'shop:103', type: 'store' as const, label: '华远店', store_key: '103' },
      ],
    },
  ];

  it('emits department scope keys without flattening the controlled value', async () => {
    const onChange = vi.fn();
    render(<StoreScopePicker nodes={tree} value={['ALL']} onChange={onChange} ariaLabel="门店范围" />);
    fireEvent.mouseDown(screen.getByLabelText('门店范围'));
    fireEvent.click(await screen.findByText('事业1部'));
    expect(onChange).toHaveBeenCalledWith(['dept:11']);
  });

  it('keeps an explicitly selected child alongside its parent department', () => {
    const onChange = vi.fn();
    render(
      <StoreScopePicker
        nodes={tree}
        value={['dept:11']}
        onChange={onChange}
        ariaLabel="全屏门店范围"
        fullscreen
      />,
    );
    const departmentNode = screen.getByText('事业1部').closest('.ant-tree-treenode');
    fireEvent.click(departmentNode!.querySelector('.ant-tree-switcher')!);
    const node = screen.getByText('北大街店').closest('.ant-tree-treenode');
    fireEvent.click(node!.querySelector('.ant-tree-checkbox')!);
    expect(onChange).toHaveBeenCalledWith(['dept:11', 'shop:101']);
  });

  it('keeps a selected leaf when its parent department is added', () => {
    const onChange = vi.fn();
    render(
      <StoreScopePicker
        nodes={tree}
        value={['shop:102']}
        onChange={onChange}
        ariaLabel="全屏门店范围"
        fullscreen
      />,
    );
    const node = screen.getByText('事业1部').closest('.ant-tree-treenode');
    fireEvent.click(node!.querySelector('.ant-tree-checkbox')!);
    expect(onChange).toHaveBeenCalledWith(['shop:102', 'dept:11']);
  });

  it('keeps explicitly checked sibling stores as separate comparison scopes', () => {
    const onChange = vi.fn();
    render(
      <StoreScopePicker
        nodes={tree}
        value={['shop:101']}
        onChange={onChange}
        ariaLabel="全屏门店范围"
        fullscreen
      />,
    );
    const departmentNode = screen.getByText('事业1部').closest('.ant-tree-treenode');
    fireEvent.click(departmentNode!.querySelector('.ant-tree-switcher')!);
    const node = screen.getByText('南大街店').closest('.ant-tree-treenode');
    fireEvent.click(node!.querySelector('.ant-tree-checkbox')!);
    expect(onChange).toHaveBeenCalledWith(['shop:101', 'shop:102']);
  });

  it('keeps all explicitly checked sibling stores as separate scopes', () => {
    const onChange = vi.fn();
    render(
      <StoreScopePicker
        nodes={tree}
        value={['shop:101', 'shop:102']}
        onChange={onChange}
        ariaLabel="全屏门店范围"
        fullscreen
      />,
    );
    const departmentNode = screen.getByText('事业1部').closest('.ant-tree-treenode');
    fireEvent.click(departmentNode!.querySelector('.ant-tree-switcher')!);
    const node = screen.getByText('华远店').closest('.ant-tree-treenode');
    fireEvent.click(node!.querySelector('.ant-tree-checkbox')!);
    expect(onChange).toHaveBeenCalledWith(['shop:101', 'shop:102', 'shop:103']);
  });

  it('syncs the week picker when the requested range changes', () => {
    const props = {
      granularity: 'week' as const,
      includeCurrent: false,
      onGranularityChange: vi.fn(),
      onRangeChange: vi.fn(),
      onIncludeCurrentChange: vi.fn(),
      todayYmd: '2026-07-20',
    };
    const { rerender } = render(
      <TrendPeriodControls {...props} dateFrom="2026-06-15" dateTo="2026-07-19" />,
    );
    rerender(
      <TrendPeriodControls {...props} dateFrom="2026-06-22" dateTo="2026-07-26" />,
    );
    expect(screen.queryByDisplayValue(/2026-06-15/)).toBeNull();
    expect(screen.getByDisplayValue(/2026-06-22/)).toBeTruthy();
    expect(screen.getByDisplayValue(/2026-07-26/)).toBeTruthy();
  });

  it('normalizes the controlled range when the current period toggle changes', () => {
    const onRangeChange = vi.fn();
    const onIncludeCurrentChange = vi.fn();
    render(
      <TrendPeriodControls
        granularity="month"
        dateFrom="2026-06-01"
        dateTo="2026-07-19"
        includeCurrent
        onGranularityChange={vi.fn()}
        onRangeChange={onRangeChange}
        onIncludeCurrentChange={onIncludeCurrentChange}
        todayYmd="2026-07-20"
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onIncludeCurrentChange).toHaveBeenCalledWith(false);
    expect(onRangeChange).toHaveBeenCalledWith('2026-06-01', '2026-06-30');
  });

  it('uses a bottom popup on mobile and an inline calendar in fullscreen', () => {
    const props = {
      granularity: 'day' as const,
      dateFrom: '2026-07-01',
      dateTo: '2026-07-19',
      includeCurrent: false,
      onGranularityChange: vi.fn(),
      onRangeChange: vi.fn(),
      onIncludeCurrentChange: vi.fn(),
      todayYmd: '2026-07-20',
    };
    const { rerender } = render(<TrendPeriodControls {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '选择趋势周期' }));
    expect(screen.getByText('选择趋势区间')).toBeTruthy();

    rerender(<TrendPeriodControls {...props} fullscreen />);
    expect(screen.getByLabelText('趋势日期区间日历')).toBeTruthy();
    expect(screen.queryByText('选择趋势区间')).toBeNull();
  });

  it('only shows unavailable moving averages as secondary status text', () => {
    render(<MovingAverageStatus items={[
      { field: 'ma7', label: 'MA7', window: 7, available: true, available_periods: 7 },
      { field: 'ma30', label: 'MA30', window: 30, available: false, available_periods: 12 },
    ]} />);
    expect(screen.queryByText('MA7 数据不足')).toBeNull();
    expect(screen.getByText('MA30 数据不足')).toBeTruthy();
  });
});
