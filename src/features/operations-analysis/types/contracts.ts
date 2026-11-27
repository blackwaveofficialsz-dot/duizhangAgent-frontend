export type Granularity = 'day' | 'week' | 'month';
export type ComparisonMode = 'previous' | 'none';
export type OrderChannel = 'all' | 'shop' | 'takeout';
export type OrderBreakdown = 'all' | 'none' | 'channel' | 'platform';
export type DataStatus = 'ready' | 'partial' | 'missing' | 'stale';

export type AnalyticsCacheMeta = {
  status?: string;
  source?: string;
  returned_days?: number;
  server_checked_days?: number;
  deleted_days?: number;
  redis_hit_days?: number;
  postgres_fallback_days?: number;
  redis_write_days?: number;
  redis_write_error_days?: number;
  [key: string]: string | number | boolean | null | undefined;
};

export type OperationsFilters = {
  scopeKeys: string[];
  storeKeys: string[];
  channel: OrderChannel;
  granularity: Granularity;
  dateFrom: string;
  dateTo: string;
  compare: ComparisonMode;
  includeCurrent?: boolean;
  orderChannels?: Array<Exclude<OrderChannel, 'all'>>;
  platformCodes?: Array<string | number>;
  orderBreakdown?: OrderBreakdown;
};

export type StoreScopeNode = {
  key: string;
  type: 'department' | 'store' | 'group' | 'ungrouped';
  label: string;
  department_id?: string;
  store_key?: string;
  children?: StoreScopeNode[];
};

export type StoreScopeTreeResponse = {
  nodes: StoreScopeNode[];
  store_count: number;
  source: string;
};

export type MetricComparison = {
  current: number | null;
  previous: number | null;
  difference: number | null;
  change_rate: number | null;
  status: string;
};

export type OperationsExcludedStore = string | {
  store_key: string;
  store_label?: string | null;
  reason?: string;
};

export type OperationsCompleteness = {
  status: DataStatus;
  complete_dates?: number;
  expected_dates?: number;
  missing_dates?: string[];
  included_store_keys?: string[];
  excluded_store_keys?: string[];
  watermark?: string | null;
  cache_source?: string | null;
  data_status?: DataStatus | 'ok' | 'incomplete';
  included_stores?: string[];
  excluded_stores?: OperationsExcludedStore[];
  source_watermark?: string | null;
};

export type OperationsDimensionRow = {
  dim_key?: string;
  dim_label?: string;
  store_key?: string;
  store_label?: string;
  metrics: Record<string, MetricComparison>;
  latest_metrics?: Record<string, MetricComparison>;
  labor?: Record<string, number | null>;
};

export type OperationsOverview = {
  period: { date_from: string; date_to: string };
  previous_period: { date_from: string; date_to: string } | null;
  metrics: Record<string, MetricComparison>;
  latest_metrics?: Record<string, MetricComparison>;
  channels: OperationsDimensionRow[];
  platforms: OperationsDimensionRow[];
  stores: OperationsDimensionRow[];
  store_channels: OperationsDimensionRow[];
  store_platforms?: OperationsDimensionRow[];
  sections: Record<string, { status: string; reason_code?: string; [key: string]: unknown }>;
  completeness: OperationsCompleteness;
  cache_meta?: AnalyticsCacheMeta | null;
  generated_at: string;
  freshness?: {
    mode: 'realtime' | 'historical';
    provisional: boolean;
    snapshot_version: string | null;
    data_as_of: string | null;
    generated_at: string;
    status: 'current' | 'updating' | 'repairing' | 'unavailable';
    refresh_interval_seconds: number;
  };
};

export type MealPeriodMetric = {
  period_key: string;
  period_label: string;
  order_count: number;
  paid_amount: number;
  income_amount: number;
  refund_amount: number;
  net_income: number;
  avg_order_value: number;
  comparison?: Record<string, MetricComparison>;
};

export type PeriodSalesPoint = {
  period: string;
  periods: MealPeriodMetric[];
};

export type OperationsPeriodSales = OperationsCompleteness & {
  granularity: Granularity;
  previous_period: { date_from: string; date_to: string } | null;
  points: PeriodSalesPoint[];
  summary: MealPeriodMetric[];
};

export type ProductMetricKey =
  | 'sales_amount'
  | 'quantity'
  | 'order_count'
  | 'quantity_share'
  | 'amount_share'
  | 'product_name'
  | 'product_key';

export type OperationsProductItem = {
  product_key: string;
  product_name: string;
  quantity: number;
  sales_amount: number;
  order_count: number | null;
  quantity_share: number;
  amount_share: number;
  fact_source: 'orders' | 'openapi';
  comparison?: Record<string, MetricComparison>;
};

export type OperationsProducts = OperationsCompleteness & {
  fact_source: 'orders' | 'openapi';
  previous_period: { date_from: string; date_to: string } | null;
  items: OperationsProductItem[];
  total: number;
  limit: number;
  offset: number;
  cost_completeness: { verified: boolean; reason?: string };
};

export type ProductTrendPoint = {
  period: string;
  items: OperationsProductItem[];
};

export type OperationsProductTrend = OperationsCompleteness & {
  fact_source: 'orders' | 'openapi';
  granularity: Granularity;
  previous_period: { date_from: string; date_to: string } | null;
  points: ProductTrendPoint[];
  previous_points: ProductTrendPoint[];
  total: number;
  limit: number;
  offset: number;
  cost_completeness: { verified: boolean; reason?: string };
};

export type LaborPoint = {
  period: string;
  data_status: string;
  actual_hours: number;
  planned_hours: number;
  net_revenue: number;
  headcount: number;
  actual_revenue_per_hour: number | null;
  planned_revenue_per_hour: number | null;
};

export type LaborSummary = Omit<LaborPoint, 'period' | 'data_status'> & {
  comparison?: Record<string, MetricComparison>;
};

export type OperationsLabor = OperationsCompleteness & {
  granularity: Granularity;
  previous_period: { date_from: string; date_to: string } | null;
  points: LaborPoint[];
  summary: LaborSummary;
  excluded_dates: string[];
};

export type StockingSample = {
  business_date: string;
  weekday: number;
  quantity: number;
};

export type StockingReferenceItem = {
  store_key: string;
  product_key: string;
  product_name: string;
  average_quantity: number | null;
  p75_quantity: number | null;
  max_quantity: number | null;
  reference_quantity: number | null;
  sample_count: number;
  samples: StockingSample[];
  valid_dates: string[];
  missing_dates: string[];
  reason: string | null;
};

export type StockingReference = OperationsCompleteness & {
  target_date: string;
  meal_period: string;
  history_weeks: number;
  items: StockingReferenceItem[];
  valid_dates: string[];
};

export type PlatformOption = {
  platform_code: number;
  platform_name: string;
  confirmed: boolean;
};
