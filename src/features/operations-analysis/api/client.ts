import { apiFetch } from '../../../api/client';
import type {
  ComparisonMode,
  Granularity,
  OperationsFilters,
  OperationsLabor,
  OperationsOverview,
  OperationsPeriodSales,
  OperationsProducts,
  OperationsProductTrend,
  PlatformOption,
  ProductMetricKey,
  StockingReference,
  StoreScopeTreeResponse,
} from '../types/contracts';

export type {
  MetricComparison,
  OperationsOverview,
} from '../types/contracts';

type CommonRequest = {
  filters: OperationsFilters;
  signal?: AbortSignal;
  refresh?: boolean;
};

type LegacyOverviewRequest = {
  dateFrom: string;
  dateTo: string;
  granularity?: Granularity;
  compare?: ComparisonMode;
  storeKeys?: string[];
  channel?: OperationsFilters['channel'];
  includeCurrent?: boolean;
  orderChannels?: OperationsFilters['orderChannels'];
  platformCodes?: OperationsFilters['platformCodes'];
  orderBreakdown?: OperationsFilters['orderBreakdown'];
  refresh?: boolean;
  signal?: AbortSignal;
};

function appendValues(
  params: URLSearchParams,
  key: string,
  values: Array<string | number>,
) {
  values.forEach((value) => params.append(key, String(value)));
}

function commonParams(filters: OperationsFilters, refresh = false) {
  const params = new URLSearchParams({
    date_from: filters.dateFrom,
    date_to: filters.dateTo,
    compare: filters.compare,
  });
  params.set('granularity', filters.granularity);
  params.set('include_current', String(!!filters.includeCurrent));
  if (filters.orderBreakdown) params.set('order_breakdown', filters.orderBreakdown);
  if (refresh) params.set('refresh', 'true');
  appendValues(params, 'scope_keys', [...new Set(filters.scopeKeys || [])].filter(key => key && key !== 'ALL'));
  appendValues(params, 'store_keys', filters.storeKeys);
  const orderChannels = filters.orderChannels?.length
    ? filters.orderChannels
    : filters.channel === 'all'
      ? []
      : [filters.channel];
  appendValues(params, 'order_channels', orderChannels);
  appendValues(params, 'platform_codes', filters.platformCodes || []);
  return params;
}

async function requestJson<T>(
  path: string,
  params: URLSearchParams,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await apiFetch(`${path}?${params.toString()}`, { signal });
  if (!response.ok) {
    let message = `${label}加载失败（${response.status}）`;
    try {
      const body = await response.json();
      if (typeof body?.detail === 'string') message = body.detail;
    } catch {
      // Keep the status-based message when the response has no JSON body.
    }
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json() as Promise<T>;
}

function legacyFilters(request: LegacyOverviewRequest): OperationsFilters {
  return {
    scopeKeys: ['ALL'],
    storeKeys: request.storeKeys || [],
    channel: request.channel || 'all',
    granularity: request.granularity || 'day',
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    compare: request.compare || 'previous',
    includeCurrent: request.includeCurrent,
    orderChannels: request.orderChannels,
    platformCodes: request.platformCodes,
    orderBreakdown: request.orderBreakdown,
  };
}

export function fetchOperationsOverview(
  request: CommonRequest | LegacyOverviewRequest,
): Promise<OperationsOverview> {
  const filters = 'filters' in request ? request.filters : legacyFilters(request);
  return requestJson(
    '/api/v1/analytics/operations/overview',
    commonParams(filters, request.refresh),
    '经营概览',
    request.signal,
  );
}

export function fetchOperationsPeriodSales({
  filters,
  signal,
}: CommonRequest): Promise<OperationsPeriodSales> {
  return requestJson(
    '/api/v1/analytics/operations/period-sales',
    commonParams(filters, false),
    '时段销售',
    signal,
  );
}

export type ProductRequest = CommonRequest & {
  categoryKeys?: string[];
  productKeys?: string[];
  platformIds?: number[];
  sortBy?: ProductMetricKey;
  sortOrder?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
};

function productParams(request: ProductRequest) {
  const params = commonParams(request.filters, request.refresh);
  appendValues(params, 'category_keys', request.categoryKeys || []);
  appendValues(params, 'product_keys', request.productKeys || []);
  appendValues(params, 'platform_ids', request.platformIds || []);
  params.set('sort_by', request.sortBy || 'sales_amount');
  params.set('sort_order', request.sortOrder || 'desc');
  params.set('limit', String(request.limit ?? 50));
  params.set('offset', String(request.offset ?? 0));
  return params;
}

export function fetchOperationsProducts(
  request: ProductRequest,
): Promise<OperationsProducts> {
  return requestJson(
    '/api/v1/analytics/operations/products',
    productParams(request),
    '产品明细',
    request.signal,
  );
}

export function fetchOperationsProductTrend(
  request: ProductRequest,
): Promise<OperationsProductTrend> {
  return requestJson(
    '/api/v1/analytics/operations/product-trend',
    productParams(request),
    '产品趋势',
    request.signal,
  );
}

export function fetchOperationsLabor({
  filters,
  signal,
}: CommonRequest): Promise<OperationsLabor> {
  return requestJson(
    '/api/v1/analytics/operations/labor',
    commonParams(filters, false),
    '人效分析',
    signal,
  );
}

export function fetchStockingReference({
  targetDate,
  mealPeriod,
  storeKeys,
  productKeys,
  historyWeeks = 8,
  signal,
}: {
  targetDate: string;
  mealPeriod: string;
  storeKeys: string[];
  productKeys: string[];
  historyWeeks?: number;
  signal?: AbortSignal;
}): Promise<StockingReference> {
  const params = new URLSearchParams({
    target_date: targetDate,
    meal_period: mealPeriod,
    history_weeks: String(historyWeeks),
  });
  appendValues(params, 'store_keys', storeKeys);
  appendValues(params, 'product_keys', productKeys);
  return requestJson(
    '/api/v1/analytics/operations/stocking-reference',
    params,
    '备货参考',
    signal,
  );
}

export function fetchStoreScopeTree(signal?: AbortSignal) {
  return requestJson<StoreScopeTreeResponse>(
    '/api/v1/analytics/store-scope-tree',
    new URLSearchParams(),
    '门店范围',
    signal,
  );
}

export async function fetchPlatformOptions(signal?: AbortSignal) {
  const response = await apiFetch('/api/v1/analytics/platform-dim', { signal });
  if (!response.ok) throw new Error(`平台列表加载失败（${response.status}）`);
  const data = await response.json() as { platforms: PlatformOption[] };
  return data.platforms;
}

export type { ComparisonMode, Granularity };
