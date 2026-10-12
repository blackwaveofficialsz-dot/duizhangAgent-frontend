import { getMyStoreAccess } from './storeAccess';
// 经营分析 API（P1：订单统计 / 店铺映射 / 平台字典）。

import { apiFetch } from './client';
import type { StoreScopeNode } from '../components/analytics/storeScope';
import type { TrendGranularity, TrendMovingAverageMeta } from '../components/analytics/trendPeriod';
import { addMoney, sumMoney } from '../utils/money';

type AnalyticsRequestOptions = {
  signal?: AbortSignal;
  forceRefresh?: boolean;
  revalidate?: boolean;
  includeStoreTrends?: boolean;
  cacheKey?: string;
  namespace?: string;
  ttlSeconds?: number;
  storeKeys?: string[];
};
export type TrendRequestOptions = AnalyticsRequestOptions & {
  granularity?: TrendGranularity;
  includeCurrent?: boolean;
};
type ProductRequestOptions = AnalyticsRequestOptions & { dateFrom?: string; dateTo?: string };

function completeTrendCacheKey(cacheKey: string, options: AnalyticsRequestOptions): string {
  return options.includeStoreTrends ? `${cacheKey}:store-trends-v1` : cacheKey;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let detail = `请求失败（${res.status}）`;
    try {
      const body = await res.json();
      detail = body.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

function normalizedStoreKeys(storeKeys?: string[]): string[] {
  return [...new Set((storeKeys || []).filter(key => key && key !== 'ALL'))].sort();
}

function appendStoreKeys(params: URLSearchParams, storeKeys?: string[]): void {
  for (const key of normalizedStoreKeys(storeKeys)) params.append('store_keys', key);
}

function appendTrendOptions(params: URLSearchParams, options: TrendRequestOptions): void {
  params.set('granularity', options.granularity || 'day');
  params.set('include_current', String(!!options.includeCurrent));
}

const ANALYTICS_CACHE_PREFIX = 'analytics-api-cache-v2';
const DEFAULT_ANALYTICS_CACHE_TTL_SECONDS = 24 * 60 * 60;
const LOCAL_STORAGE_CACHE_MAX_CHARS = 200_000;
const LOCAL_STORAGE_DAILY_BUCKET_MAX_CHARS = 50_000;
const INDEXED_ANALYTICS_CACHE_DB = 'duizhang-analytics-cache-v1';
const INDEXED_ANALYTICS_CACHE_STORE = 'entries';
const INDEXED_ANALYTICS_CACHE_MAX_ENTRIES = 300;
const ANALYTICS_CACHE_BUST_KEY = `${ANALYTICS_CACHE_PREFIX}:cache-bust`;
const ANALYTICS_CACHE_KEY_PREFIX = `${ANALYTICS_CACHE_PREFIX}:`;
const DAILY_BUCKET_SCHEMA_VERSION = 'daily-bucket-v1';
const DAILY_BUCKET_MAX_DAYS = 365;
const inflightAnalyticsRequests = new Map<string, Promise<unknown>>();
let indexedCacheDbPromise: Promise<IDBDatabase | null> | null = null;
let indexedCacheDbFactoryRef: IDBFactory | null = null;

type AnalyticsFrontendCacheEntry<T> = {
  savedAt: string;
  lastAccessedAt?: string;
  tenantId: string;
  namespace: string;
  cacheKey: string;
  ttlSeconds: number;
  payload: T;
};

type AnalyticsCacheBustPayload = {
  tenantId: string;
  day: string;
  namespace?: string;
  cacheKey?: string;
  nonce: string;
};

type DailyBucketDay<T> = {
  version: string;
  payload: T;
  savedAt: string;
};

type DailyDeltaBucket<T> = {
  schemaVersion: string;
  tenantId: string;
  namespace: string;
  paramsHash: string;
  savedAt: string;
  lastAccessedAt: string;
  days: Record<string, DailyBucketDay<T>>;
  meta?: Record<string, unknown>;
};

function currentTenantId(): string {
  try {
    return localStorage.getItem('auth_tenant_id') || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function currentUserId(): string {
  try {
    return localStorage.getItem('auth_user_id') || 'anonymous';
  } catch {
    return 'anonymous';
  }
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function analyticsCacheKey(namespace: string, cacheKey: string): string {
  return `${ANALYTICS_CACHE_PREFIX}:${todayKey()}:${currentTenantId()}:${currentUserId()}:${namespace}:${cacheKey}`;
}

function analyticsCacheDateFromKey(key: string): string | null {
  if (!key.startsWith(ANALYTICS_CACHE_KEY_PREFIX)) return null;
  const day = key.slice(ANALYTICS_CACHE_KEY_PREFIX.length).split(':', 1)[0];
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

function isHistoricalAnalyticsCacheKey(key: string, today = todayKey()): boolean {
  const day = analyticsCacheDateFromKey(key);
  return !!day && day !== today;
}

function cacheEntry<T>(namespace: string, cacheKey: string, data: T, ttlSeconds: number): AnalyticsFrontendCacheEntry<T> {
  const now = new Date().toISOString();
  return {
    savedAt: now,
    lastAccessedAt: now,
    tenantId: currentTenantId(),
    namespace,
    cacheKey,
    ttlSeconds,
    payload: data,
  };
}

function isFreshEntry<T>(entry: AnalyticsFrontendCacheEntry<T>): boolean {
  const savedAt = Date.parse(entry.savedAt);
  return Number.isFinite(savedAt) && Date.now() - savedAt <= entry.ttlSeconds * 1000;
}

function clearLocalAnalyticsCache(namespace?: string, cacheKey?: string): void {
  try {
    const tenantPrefix = `${ANALYTICS_CACHE_PREFIX}:${todayKey()}:${currentTenantId()}:${currentUserId()}:`;
    const prefix = namespace ? `${tenantPrefix}${namespace}:` : tenantPrefix;
    const exactKey = namespace && cacheKey ? analyticsCacheKey(namespace, cacheKey) : null;
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && (exactKey ? key === exactKey : key.startsWith(prefix))) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

function pruneHistoricalLocalAnalyticsCache(): void {
  try {
    const today = todayKey();
    for (let index = localStorage.length - 1; index >= 0; index -= 1) {
      const key = localStorage.key(index);
      if (key && isHistoricalAnalyticsCacheKey(key, today)) localStorage.removeItem(key);
    }
  } catch {
    /* ignore */
  }
}

function indexedDBFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
}

function openIndexedCacheDb(): Promise<IDBDatabase | null> {
  const factory = indexedDBFactory();
  if (!factory) return Promise.resolve(null);
  if (indexedCacheDbFactoryRef !== factory) {
    indexedCacheDbPromise = null;
    indexedCacheDbFactoryRef = factory;
  }
  if (indexedCacheDbPromise) return indexedCacheDbPromise;
  indexedCacheDbPromise = new Promise((resolve) => {
    const request = factory.open(INDEXED_ANALYTICS_CACHE_DB, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(INDEXED_ANALYTICS_CACHE_STORE)) {
        db.createObjectStore(INDEXED_ANALYTICS_CACHE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      indexedCacheDbPromise = null;
      resolve(null);
    };
    request.onblocked = () => resolve(null);
  });
  return indexedCacheDbPromise;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTransactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

async function deleteIndexedAnalyticsKey(storageKey: string): Promise<void> {
  const db = await openIndexedCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readwrite');
    tx.objectStore(INDEXED_ANALYTICS_CACHE_STORE).delete(storageKey);
    await idbTransactionDone(tx);
  } catch {
    /* ignore indexedDB failures */
  }
}

async function clearIndexedAnalyticsCache(namespace?: string, cacheKey?: string): Promise<void> {
  const db = await openIndexedCacheDb();
  if (!db) return;
  const tenantPrefix = `${ANALYTICS_CACHE_PREFIX}:${todayKey()}:${currentTenantId()}:${currentUserId()}:`;
  const prefix = namespace ? `${tenantPrefix}${namespace}:` : tenantPrefix;
  const exactKey = namespace && cacheKey ? analyticsCacheKey(namespace, cacheKey) : null;
  try {
    const tx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readwrite');
    const store = tx.objectStore(INDEXED_ANALYTICS_CACHE_STORE);
    if (exactKey) {
      store.delete(exactKey);
    } else {
      await new Promise<void>((resolve, reject) => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) {
            resolve();
            return;
          }
          if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) cursor.delete();
          cursor.continue();
        };
        request.onerror = () => reject(request.error);
      });
    }
    await idbTransactionDone(tx);
  } catch {
    /* ignore indexedDB failures */
  }
}

async function pruneIndexedAnalyticsCache(): Promise<void> {
  const db = await openIndexedCacheDb();
  if (!db) return;
  try {
    const entries: { key: string; savedAt: number; lastAccessedAt: number }[] = [];
    const today = todayKey();
    const historicalKeys: string[] = [];
    const readTx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readonly');
    await new Promise<void>((resolve, reject) => {
      const request = readTx.objectStore(INDEXED_ANALYTICS_CACHE_STORE).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        if (typeof cursor.key === 'string') {
          if (isHistoricalAnalyticsCacheKey(cursor.key, today)) historicalKeys.push(cursor.key);
          const value = cursor.value as Partial<AnalyticsFrontendCacheEntry<unknown>> | null;
          const savedAt = Date.parse(String(value?.savedAt || '')) || 0;
          entries.push({
            key: cursor.key,
            savedAt,
            lastAccessedAt: Date.parse(String(value?.lastAccessedAt || '')) || savedAt,
          });
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error);
    });
    const staleKeys = entries
      .filter((entry) => !historicalKeys.includes(entry.key))
      .sort((a, b) => (a.lastAccessedAt - b.lastAccessedAt) || (a.savedAt - b.savedAt) || a.key.localeCompare(b.key))
      .slice(0, Math.max(0, entries.length - historicalKeys.length - INDEXED_ANALYTICS_CACHE_MAX_ENTRIES))
      .map((entry) => entry.key);
    const keysToDelete = [...new Set([...historicalKeys, ...staleKeys])];
    if (!keysToDelete.length) return;
    const deleteTx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readwrite');
    const store = deleteTx.objectStore(INDEXED_ANALYTICS_CACHE_STORE);
    keysToDelete.forEach((key) => store.delete(key));
    await idbTransactionDone(deleteTx);
  } catch {
    /* ignore indexedDB prune failures */
  }
}

async function clearAnalyticsCacheAsync(namespace?: string, cacheKey?: string, broadcast = false): Promise<void> {
  clearLocalAnalyticsCache(namespace, cacheKey);
  await clearIndexedAnalyticsCache(namespace, cacheKey);
  if (broadcast) notifyAnalyticsCacheBust(namespace, cacheKey);
}

function notifyAnalyticsCacheBust(namespace?: string, cacheKey?: string): void {
  try {
    const payload: AnalyticsCacheBustPayload = {
      tenantId: currentTenantId(),
      day: todayKey(),
      namespace,
      cacheKey,
      nonce: `${Date.now()}:${Math.random()}`,
    };
    localStorage.setItem(ANALYTICS_CACHE_BUST_KEY, JSON.stringify(payload));
  } catch {
    /* ignore private mode/storage failures */
  }
}

function installAnalyticsCacheBustListener(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (event) => {
    if (event.key !== ANALYTICS_CACHE_BUST_KEY || !event.newValue) return;
    try {
      const payload = JSON.parse(event.newValue) as AnalyticsCacheBustPayload;
      if (payload.tenantId !== currentTenantId() || payload.day !== todayKey()) return;
      clearLocalAnalyticsCache(payload.namespace, payload.cacheKey);
      void clearIndexedAnalyticsCache(payload.namespace, payload.cacheKey);
    } catch {
      /* ignore malformed cache-bust events */
    }
  });
}

installAnalyticsCacheBustListener();
pruneHistoricalLocalAnalyticsCache();
void pruneIndexedAnalyticsCache();

function readAnalyticsCache<T>(namespace: string, cacheKey: string): T | null {
  try {
    const storageKey = analyticsCacheKey(namespace, cacheKey);
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as T | AnalyticsFrontendCacheEntry<T>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      'payload' in parsed &&
      'savedAt' in parsed
    ) {
      const entry = parsed as AnalyticsFrontendCacheEntry<T>;
      if (!isFreshEntry(entry)) {
        localStorage.removeItem(storageKey);
        return null;
      }
      return entry.payload;
    }
    return parsed as T;
  } catch {
    return null;
  }
}

async function readIndexedAnalyticsCache<T>(namespace: string, cacheKey: string): Promise<T | null> {
  const storageKey = analyticsCacheKey(namespace, cacheKey);
  const db = await openIndexedCacheDb();
  if (!db) return null;
  try {
    const tx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readonly');
    const entry = await idbRequest<AnalyticsFrontendCacheEntry<T> | undefined>(
      tx.objectStore(INDEXED_ANALYTICS_CACHE_STORE).get(storageKey),
    );
    if (!entry) return null;
    if (!isFreshEntry(entry)) {
      await deleteIndexedAnalyticsKey(storageKey);
      return null;
    }
    entry.lastAccessedAt = new Date().toISOString();
    try {
      const writeTx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readwrite');
      writeTx.objectStore(INDEXED_ANALYTICS_CACHE_STORE).put(entry, storageKey);
      await idbTransactionDone(writeTx);
    } catch {
      /* ignore touch failures */
    }
    return entry.payload;
  } catch {
    return null;
  }
}

function writeAnalyticsCache<T>(namespace: string, cacheKey: string, data: T, ttlSeconds: number): boolean {
  try {
    const entry = cacheEntry(namespace, cacheKey, data, ttlSeconds);
    const serialized = JSON.stringify(entry);
    if (serialized.length > LOCAL_STORAGE_CACHE_MAX_CHARS) return false;
    localStorage.setItem(analyticsCacheKey(namespace, cacheKey), serialized);
    return true;
  } catch {
    /* ignore quota/private mode */
    return false;
  }
}

async function writeIndexedAnalyticsCache<T>(namespace: string, cacheKey: string, data: T, ttlSeconds: number): Promise<void> {
  const db = await openIndexedCacheDb();
  if (!db) return;
  try {
    const tx = db.transaction(INDEXED_ANALYTICS_CACHE_STORE, 'readwrite');
    tx.objectStore(INDEXED_ANALYTICS_CACHE_STORE).put(cacheEntry(namespace, cacheKey, data, ttlSeconds), analyticsCacheKey(namespace, cacheKey));
    await idbTransactionDone(tx);
    await pruneIndexedAnalyticsCache();
  } catch {
    /* ignore indexedDB failures */
  }
}

function isDailyDeltaBucket<T>(value: DailyDeltaBucket<T> | null | undefined): value is DailyDeltaBucket<T> {
  return !!value && value.schemaVersion === DAILY_BUCKET_SCHEMA_VERSION && !!value.days && typeof value.days === 'object';
}

function createDailyBucket<T>(namespace: string, paramsHash: string): DailyDeltaBucket<T> {
  const now = new Date().toISOString();
  return {
    schemaVersion: DAILY_BUCKET_SCHEMA_VERSION,
    tenantId: currentTenantId(),
    namespace,
    paramsHash,
    savedAt: now,
    lastAccessedAt: now,
    days: {},
  };
}

function pruneDailyBucket<T>(bucket: DailyDeltaBucket<T>): DailyDeltaBucket<T> {
  const days = Object.keys(bucket.days).sort();
  for (const day of days.slice(0, Math.max(0, days.length - DAILY_BUCKET_MAX_DAYS))) {
    delete bucket.days[day];
  }
  return bucket;
}

async function readDailyBucket<T>(namespace: string, paramsHash: string): Promise<DailyDeltaBucket<T>> {
  const indexed = await readIndexedAnalyticsCache<DailyDeltaBucket<T>>(namespace, paramsHash);
  if (isDailyDeltaBucket(indexed)) return indexed;
  const local = readAnalyticsCache<DailyDeltaBucket<T>>(namespace, paramsHash);
  if (isDailyDeltaBucket(local)) return local;
  return createDailyBucket<T>(namespace, paramsHash);
}

function writeSmallDailyBucketFallback<T>(namespace: string, paramsHash: string, bucket: DailyDeltaBucket<T>, ttlSeconds: number): void {
  try {
    const entry = cacheEntry(namespace, paramsHash, bucket, ttlSeconds);
    const serialized = JSON.stringify(entry);
    const storageKey = analyticsCacheKey(namespace, paramsHash);
    if (serialized.length <= LOCAL_STORAGE_DAILY_BUCKET_MAX_CHARS) {
      localStorage.setItem(storageKey, serialized);
    } else {
      localStorage.removeItem(storageKey);
    }
  } catch {
    /* ignore localStorage failures */
  }
}

async function writeDailyBucket<T>(namespace: string, paramsHash: string, bucket: DailyDeltaBucket<T>, ttlSeconds: number): Promise<void> {
  bucket.lastAccessedAt = new Date().toISOString();
  pruneDailyBucket(bucket);
  await writeIndexedAnalyticsCache(namespace, paramsHash, bucket, ttlSeconds);
  writeSmallDailyBucketFallback(namespace, paramsHash, bucket, ttlSeconds);
}

async function cachedJson<T>(url: string, options: AnalyticsRequestOptions = {}): Promise<T> {
  const cacheKey = options.cacheKey || url;
  const namespace = options.namespace || 'analytics.general';
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const access = await getMyStoreAccess(options.signal);
  if (!access.all_stores) return json<T>(await apiFetch(url, { signal: options.signal }));
  const bypassClientCache = options.forceRefresh || options.revalidate;
  if (bypassClientCache) {
    await clearAnalyticsCacheAsync(namespace, cacheKey, true);
  }
  if (!bypassClientCache) {
    const cached = readAnalyticsCache<T>(namespace, cacheKey);
    if (cached) return cached;
    const indexedCached = await readIndexedAnalyticsCache<T>(namespace, cacheKey);
    if (indexedCached) return indexedCached;
  }
  const inflightKey = analyticsCacheKey(namespace, cacheKey);
  const inflight = inflightAnalyticsRequests.get(inflightKey);
  if (inflight) return inflight as Promise<T>;
  const request = apiFetch(url, { signal: options.signal })
    .then((res) => json<T>(res))
    .then(async (data) => {
      if (!options.signal?.aborted) {
        const wroteLocal = writeAnalyticsCache(namespace, cacheKey, data, ttlSeconds);
        if (!wroteLocal) {
          try {
            localStorage.removeItem(analyticsCacheKey(namespace, cacheKey));
          } catch {
            /* ignore localStorage cleanup failures */
          }
          await writeIndexedAnalyticsCache(namespace, cacheKey, data, ttlSeconds);
        } else {
          void writeIndexedAnalyticsCache(namespace, cacheKey, data, ttlSeconds);
        }
      }
      return data;
    })
    .finally(() => {
      inflightAnalyticsRequests.delete(inflightKey);
    });
  inflightAnalyticsRequests.set(inflightKey, request);
  return request;
}

export type OrderRow = {
  dim_key: string;
  dim_label: string | null;
  source_type?: string;
  order_count: number;
  paid_amount: number;     // 营业额
  income_amount: number;   // 实收（商家结算）
  refund_amount: number;
  net_amount: number;      // 净营业额
  net_income: number;      // 净实收（头条口径）
  avg_order_value: number;
  refund_rate: number;
  computed_at: string | null;
};

export type OrdersExcluded = {
  excluded_orders: number;
  excluded_shops: { shop_id: string; shop_name: string }[];
  confirmed_shops: number;
};

export type SnapshotStatus = 'ready' | 'missing' | 'stale' | 'partial';
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
export type RefreshMeta = { snapshot_status?: SnapshotStatus | string; refresh_queued?: boolean; backfill_queued?: boolean; cache_meta?: AnalyticsCacheMeta };
export type OrdersResult = { rows: OrderRow[]; excluded: OrdersExcluded; exclude_today?: boolean; effective_date_to?: string | null } & RefreshMeta;

type OrdersDeltaDay = {
  date: string;
  version: string;
  payload: OrdersResult | null;
};

type OrdersDeltaResult = {
  changed_days?: OrdersDeltaDay[];
  unchanged_days?: string[];
  cache_meta?: AnalyticsCacheMeta;
};

const ORDERS_NAMESPACE = 'analytics.orders.v2';
const ORDERS_DAILY_NAMESPACE = 'analytics.orders.daily.v2';

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function isoWeekDateRange(period: string): [string, string] | null {
  const match = /^(\d{4})-W(\d{1,2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (!Number.isInteger(year) || !Number.isInteger(week) || week < 1 || week > 53) return null;
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - jan4Day + 1 + (week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return [isoDate(monday), isoDate(sunday)];
}

function monthDateRange(period: string): [string, string] | null {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0));
  return [isoDate(start), isoDate(end)];
}

function ordersPeriodRange(granularity: string, period: string): [string, string] | null {
  if (/^\d{4}-\d{2}-\d{2}~\d{4}-\d{2}-\d{2}$/.test(period)) {
    const [dateFrom, dateTo] = period.split('~');
    return eachDate(dateFrom, dateTo).length ? [dateFrom, dateTo] : null;
  }
  if (granularity === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(period)) return [period, period];
  if (granularity === 'week') return isoWeekDateRange(period);
  if (granularity === 'month') return monthDateRange(period);
  return null;
}

function aggregateOrdersResult(days: string[], payloads: OrdersResult[]): OrdersResult {
  const rows = new Map<string, OrderRow>();
  const excludedShops = new Map<string, { shop_id: string; shop_name: string }>();
  let excludedOrders = 0;
  let confirmedShops = 0;
  for (const payload of payloads) {
    excludedOrders += Number(payload.excluded?.excluded_orders || 0);
    confirmedShops = Math.max(confirmedShops, Number(payload.excluded?.confirmed_shops || 0));
    for (const shop of payload.excluded?.excluded_shops || []) excludedShops.set(shop.shop_id, shop);
    for (const row of payload.rows || []) {
      const key = row.dim_key || 'ALL';
      const current = rows.get(key) || {
        dim_key: key,
        dim_label: row.dim_label || null,
        order_count: 0,
        paid_amount: 0,
        income_amount: 0,
        refund_amount: 0,
        net_amount: 0,
        net_income: 0,
        avg_order_value: 0,
        refund_rate: 0,
        computed_at: null,
      };
      current.dim_label = current.dim_label || row.dim_label || null;
      current.order_count += Number(row.order_count || 0);
      current.paid_amount = addMoney(current.paid_amount, row.paid_amount);
      current.income_amount = addMoney(current.income_amount, row.income_amount);
      current.refund_amount = addMoney(current.refund_amount, row.refund_amount);
      current.net_amount = addMoney(
        current.net_amount,
        row.net_amount ?? (Number(row.paid_amount || 0) - Number(row.refund_amount || 0)),
      );
      current.net_income = addMoney(
        current.net_income,
        row.net_income ?? (Number(row.income_amount || 0) - Number(row.refund_amount || 0)),
      );
      if (row.computed_at && (!current.computed_at || row.computed_at > current.computed_at)) current.computed_at = row.computed_at;
      rows.set(key, current);
    }
  }
  const finalRows = Array.from(rows.values()).map((row) => ({
    ...row,
    paid_amount: Number(row.paid_amount.toFixed(2)),
    income_amount: Number(row.income_amount.toFixed(2)),
    refund_amount: Number(row.refund_amount.toFixed(2)),
    net_amount: Number(row.net_amount.toFixed(2)),
    net_income: Number(row.net_income.toFixed(2)),
    avg_order_value: row.order_count ? Number((row.net_income / row.order_count).toFixed(2)) : 0,
    refund_rate: row.paid_amount ? Number((row.refund_amount / row.paid_amount).toFixed(4)) : 0,
  }));
  const hasMissing = payloads.length !== days.length || payloads.some((payload) => payload.snapshot_status && payload.snapshot_status !== 'ready');
  return {
    rows: finalRows,
    excluded: {
      excluded_orders: excludedOrders,
      excluded_shops: Array.from(excludedShops.values()),
      confirmed_shops: confirmedShops,
    },
    exclude_today: false,
    effective_date_to: null,
    snapshot_status: finalRows.length ? (hasMissing ? 'partial' : 'ready') : 'missing',
    refresh_queued: payloads.some((payload) => !!payload.refresh_queued),
    backfill_queued: payloads.some((payload) => !!payload.backfill_queued),
  };
}

export type RevenueTrendPoint = {
  period: string;
  net_income: number;
  order_count: number;
  ma3?: number | null;
  ma4?: number | null;
  ma6?: number | null;
  ma7?: number | null;
  ma12?: number | null;
  ma26?: number | null;
  ma30?: number | null;
  ma180?: number | null;
  missing: boolean;
  period_start?: string;
  period_end?: string;
  in_progress?: boolean;
  [field: string]: string | number | boolean | null | undefined;
};

export type RevenueTrendResult = {
  metric: 'net_income' | string;
  date_from: string;
  date_to: string;
  store_key: string;
  source_type?: string;
  granularity?: TrendGranularity;
  moving_averages?: TrendMovingAverageMeta[];
  points: RevenueTrendPoint[];
  store_keys?: string[];
  store_trends?: Record<string, RevenueTrendPoint[]>;
};

type RevenueTrendDeltaDay = {
  date: string;
  version: string;
  payload: RevenueTrendPoint | null;
};

type RevenueTrendDeltaResult = {
  changed_days?: RevenueTrendDeltaDay[];
  unchanged_days?: string[];
  moving_averages?: TrendMovingAverageMeta[] | null;
  cache_meta?: { status?: string; returned_days?: number; server_checked_days?: number };
};

const REVENUE_TREND_NAMESPACE = 'analytics.revenue_trend.v2';
const REVENUE_TREND_DAILY_NAMESPACE = 'analytics.revenue_trend.daily.v2';

function eachDate(dateFrom: string, dateTo: string): string[] {
  const start = new Date(`${dateFrom}T00:00:00Z`);
  const end = new Date(`${dateTo}T00:00:00Z`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const days: string[] = [];
  for (const cursor = start; cursor <= end && days.length < 3660; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function revenueTrendCacheKey(dateFrom: string, dateTo: string, storeKey: string, sourceType: string, options: TrendRequestOptions): string {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, store_key: storeKey, source_type: sourceType });
  appendStoreKeys(params, options.storeKeys);
  appendTrendOptions(params, options);
  return `/api/v1/analytics/trends/revenue?${params.toString()}`;
}

function revenueTrendBucketKey(storeKey: string, sourceType: string): string {
  return `${storeKey}:${sourceType}`;
}

function dailyRevenueMovingAverages(points: RevenueTrendPoint[]): TrendMovingAverageMeta[] {
  const availablePeriods = points.filter(point => !point.missing && !point.in_progress && typeof point.net_income === 'number').length;
  return [7, 30, 180].map(window => {
    const field = `ma${window}`;
    return {
      field,
      label: field.toUpperCase(),
      window,
      available: points.some(point => typeof point[field] === 'number'),
      available_periods: availablePeriods,
    };
  });
}

async function getRevenueTrendFallback(dateFrom: string, dateTo: string, storeKey: string, sourceType: string, options: TrendRequestOptions): Promise<RevenueTrendResult> {
  const cacheKey = revenueTrendCacheKey(dateFrom, dateTo, storeKey, sourceType, options);
  const qs = `${cacheKey.split('?')[1]}&refresh=${!!options.forceRefresh}`;
  return cachedJson<RevenueTrendResult>(`/api/v1/analytics/trends/revenue?${qs}`, {
    ...options,
    namespace: REVENUE_TREND_NAMESPACE,
    cacheKey: completeTrendCacheKey(cacheKey, options),
  });
}

async function getRevenueTrendDelta(dateFrom: string, dateTo: string, storeKey: string, sourceType: string, options: AnalyticsRequestOptions): Promise<RevenueTrendResult> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const days = eachDate(dateFrom, dateTo);
  const bucketKey = revenueTrendBucketKey(storeKey, sourceType);
  const bucket = await readDailyBucket<RevenueTrendPoint>(REVENUE_TREND_DAILY_NAMESPACE, bucketKey);
  const clientDays = days.flatMap((day) => {
    const cached = bucket.days[day];
    if (!cached || options.forceRefresh) return [];
    return [{ date: day, version: cached.version }];
  });
  const res = await apiFetch('/api/v1/analytics/trends/revenue/delta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date_from: dateFrom,
      date_to: dateTo,
      params: { store_key: storeKey, source_type: sourceType },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<RevenueTrendDeltaResult>(res);
  if (delta.moving_averages) bucket.meta = { ...bucket.meta, moving_averages: delta.moving_averages };
  const merged = new Map<string, RevenueTrendPoint>();
  for (const item of delta.changed_days || []) {
    if (!item.payload?.period) continue;
    const day = item.date || item.payload.period;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    merged.set(day, item.payload);
  }
  for (const day of delta.unchanged_days || []) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  for (const day of days) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  if (days.some((day) => !merged.has(day))) {
    throw new Error('营收趋势日缓存不完整');
  }
  const points = days.map((day) => merged.get(day)).filter((point): point is RevenueTrendPoint => !!point);
  const cachedMovingAverages = bucket.meta?.moving_averages;
  const result: RevenueTrendResult = {
    metric: 'net_income',
    granularity: 'day',
    date_from: dateFrom,
    date_to: dateTo,
    store_key: storeKey,
    source_type: sourceType,
    moving_averages: Array.isArray(cachedMovingAverages)
      ? cachedMovingAverages as TrendMovingAverageMeta[]
      : dailyRevenueMovingAverages(points),
    points,
  };
  if (!options.signal?.aborted) await writeDailyBucket(REVENUE_TREND_DAILY_NAMESPACE, bucketKey, bucket, ttlSeconds);
  return result;
}

export type MealPeriodRow = {
  period_key: string;
  period_label: string;
  order_count: number;
  paid_amount: number;
  income_amount: number;
  refund_amount: number;
  net_income: number;
  avg_order_value: number;
  ma3?: number | null;
  ma4?: number | null;
  ma6?: number | null;
  ma7?: number | null;
  ma12?: number | null;
  ma26?: number | null;
  ma30?: number | null;
  ma180?: number | null;
};

export type MealPeriodsResult = {
  store_key: string;
  business_date: string;
  periods: MealPeriodRow[];
  excluded: OrdersExcluded;
};

export type MealPeriodTrendPoint = {
  date: string;
  period_start?: string;
  period_end?: string;
  missing?: boolean;
  in_progress?: boolean;
  breakfast: MealPeriodRow;
  lunch: MealPeriodRow;
  afternoon_tea: MealPeriodRow;
  dinner: MealPeriodRow;
  late_night: MealPeriodRow;
};

export type MealPeriodTrendResult = {
  store_key: string;
  date_from: string;
  date_to: string;
  points: MealPeriodTrendPoint[];
  store_keys?: string[];
  store_trends?: Record<string, MealPeriodTrendPoint[]>;
};

export type MealPeriodKey =
  | 'breakfast'
  | 'lunch'
  | 'afternoon_tea'
  | 'dinner'
  | 'late_night';

export type MealPeriodTurnoverRow = {
  period_key: MealPeriodKey;
  period_label: string;
  shop_order_count: number;
  avg_daily_turnover: number;
};

export type MealPeriodTurnoverPoint = {
  date: string;
  period_start?: string;
  period_end?: string;
  missing?: boolean;
  in_progress?: boolean;
} & Record<MealPeriodKey, {
  shop_order_count: number;
  turnover: number;
  ma3?: number | null;
  ma4?: number | null;
  ma6?: number | null;
  ma7?: number | null;
  ma12?: number | null;
  ma26?: number | null;
  ma30?: number | null;
  ma180?: number | null;
}>;

export type MealPeriodTurnoverResult = {
  data_status: 'ok' | 'missing';
  date_from: string;
  date_to: string;
  day_count: number;
  eligible_store_count: number;
  table_count: number;
  excluded_stores: Array<{ store_key: string; store_label: string; reason: string }>;
  summary: MealPeriodTurnoverRow[];
  points: MealPeriodTurnoverPoint[];
  store_trends?: Record<string, MealPeriodTurnoverPoint[]>;
  store_summaries: Array<{
    store_key: string;
    store_label: string;
    table_count: number;
    summary: MealPeriodTurnoverRow[];
  }>;
};

type MealPeriodTrendDeltaDay = {
  date: string;
  version: string;
  payload: MealPeriodTrendPoint | null;
};

type MealPeriodTrendDeltaResult = {
  changed_days?: MealPeriodTrendDeltaDay[];
  unchanged_days?: string[];
  cache_meta?: { status?: string; returned_days?: number; server_checked_days?: number };
};

const MEAL_PERIOD_TREND_NAMESPACE = 'analytics.meal_period_trend';
const MEAL_PERIOD_TREND_DAILY_NAMESPACE = 'analytics.meal_period_trend.daily';

export type AnalyticsContextPack = {
  namespace: 'analytics.context_pack' | string;
  status: 'ready' | 'partial' | 'stale' | string;
  tenant_id: string;
  date_from: string;
  date_to: string;
  store_key: string;
  modules: Record<string, { name: string; status: string; data?: unknown; message?: string; recommended_action?: string }>;
  missing_context: { module: string; message?: string; recommended_action?: string }[];
  data_policy?: Record<string, unknown>;
};

export type LaborRow = {
  store_key: string;
  store_label: string | null;
  net_revenue: number;
  actual_hours: number;
  planned_hours: number;
  revenue_per_hour: number;
  headcount: number;
  hours_gap: number;
  uncovered: boolean;
};

export type LaborEmployeeDetail = {
  user_id: string;
  name: string;
  department: string;
  home_department?: string;
  work_department?: string;
  support_type?: string;
  attendance_group?: string;
  support_hours?: number;
  support_planned_hours?: number;
  support_actual_hours?: number;
  planned_hours: number;
  actual_hours: number;
  hours_gap: number;
  missing_count: number;
  anomaly_count: number;
  segment_count: number;
};

export type LaborTrendPoint = {
  period: string;
  net_revenue: number;
  actual_hours: number;
  planned_hours: number;
  actual_revenue_per_hour: number;
  planned_revenue_per_hour: number;
  headcount: number;
  missing: boolean;
  hours_synced?: boolean | null;
  actual_hours_ma3?: number | null;
  actual_hours_ma4?: number | null;
  actual_hours_ma6?: number | null;
  actual_hours_ma7?: number | null;
  actual_hours_ma12?: number | null;
  actual_hours_ma26?: number | null;
  actual_hours_ma30?: number | null;
  actual_hours_ma180?: number | null;
  planned_hours_ma3?: number | null;
  planned_hours_ma4?: number | null;
  planned_hours_ma6?: number | null;
  planned_hours_ma7?: number | null;
  planned_hours_ma12?: number | null;
  planned_hours_ma26?: number | null;
  planned_hours_ma30?: number | null;
  planned_hours_ma180?: number | null;
  actual_revenue_per_hour_ma3?: number | null;
  actual_revenue_per_hour_ma4?: number | null;
  actual_revenue_per_hour_ma6?: number | null;
  actual_revenue_per_hour_ma7?: number | null;
  actual_revenue_per_hour_ma12?: number | null;
  actual_revenue_per_hour_ma26?: number | null;
  actual_revenue_per_hour_ma30?: number | null;
  actual_revenue_per_hour_ma180?: number | null;
  planned_revenue_per_hour_ma3?: number | null;
  planned_revenue_per_hour_ma4?: number | null;
  planned_revenue_per_hour_ma6?: number | null;
  planned_revenue_per_hour_ma7?: number | null;
  planned_revenue_per_hour_ma12?: number | null;
  planned_revenue_per_hour_ma26?: number | null;
  planned_revenue_per_hour_ma30?: number | null;
  planned_revenue_per_hour_ma180?: number | null;
  period_start?: string;
  period_end?: string;
  in_progress?: boolean;
  [field: string]: string | number | boolean | null | undefined;
};

export type LaborTrendResult = {
  granularity: string;
  period: string;
  store_key: string;
  date_from?: string;
  date_to?: string;
  moving_averages?: TrendMovingAverageMeta[];
  points: LaborTrendPoint[];
  store_keys?: string[];
  store_trends?: Record<string, LaborTrendPoint[]>;
};

type LaborTrendDeltaPayload = LaborTrendPoint & { _store_trends?: Record<string, LaborTrendPoint> };

type LaborTrendDeltaDay = {
  date: string;
  version: string;
  payload: LaborTrendDeltaPayload | null;
};

type LaborTrendDeltaResult = {
  changed_days?: LaborTrendDeltaDay[];
  unchanged_days?: string[];
  cache_meta?: { status?: string; returned_days?: number; server_checked_days?: number };
};

const LABOR_TREND_NAMESPACE = 'analytics.labor_trend.v2';
const LABOR_TREND_DAILY_NAMESPACE = 'analytics.labor_trend.daily.v2';

export type LaborRevenueShopDetail = {
  shop_id: string;
  shop_name: string;
  order_count: number;
  paid_amount: number;
  income_amount: number;
  refund_amount: number;
  net_income: number;
};

export type LaborRevenueDailyDetail = {
  business_date: string;
  order_count: number;
  paid_amount: number;
  income_amount: number;
  refund_amount: number;
  net_income: number;
};

export type LaborEfficiencyDetail = {
  granularity: string;
  period: string;
  store_key: string;
  store_label: string;
  labor: {
    planned_hours: number;
    actual_hours: number;
    hours_gap: number;
    headcount: number;
    employees: LaborEmployeeDetail[];
  };
  revenue: {
    paid_amount: number;
    income_amount: number;
    refund_amount: number;
    net_income: number;
    order_count: number;
    daily: LaborRevenueDailyDetail[];
    shops: LaborRevenueShopDetail[];
  };
};

export type LaborResult = { rows: LaborRow[] } & RefreshMeta;

export async function getLaborEfficiency(dateFrom: string, dateTo: string, refresh = false, options: AnalyticsRequestOptions = {}): Promise<LaborResult> {
  const cacheParams = new URLSearchParams({ granularity: 'week', date_from: dateFrom, date_to: dateTo });
  appendStoreKeys(cacheParams, options.storeKeys);
  const cacheQs = cacheParams.toString();
  const qs = `${cacheQs}&refresh=${refresh || !!options.forceRefresh}`;
  return cachedJson<LaborResult>(`/api/v1/analytics/labor-efficiency?${qs}`, {
    ...options,
    revalidate: options.revalidate ?? true,
    forceRefresh: refresh || options.forceRefresh,
    namespace: 'analytics.labor_efficiency',
    cacheKey: `/api/v1/analytics/labor-efficiency?${cacheQs}`,
  });
}

export async function getLaborEfficiencyDetail(dateFrom: string, dateTo: string, storeKey: string, options: AnalyticsRequestOptions = {}): Promise<LaborEfficiencyDetail> {
  const qs = `granularity=week&date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}`;
  const url = `/api/v1/analytics/labor-efficiency/${encodeURIComponent(storeKey)}/detail?${qs}`;
  return cachedJson<LaborEfficiencyDetail>(url, { ...options, namespace: 'analytics.labor_efficiency_detail' });
}

export async function getLaborEfficiencyTrend(dateFrom: string, dateTo: string, storeKey = 'ALL', periods = 30, options: TrendRequestOptions = {}): Promise<LaborTrendResult> {
  const storeKeys = normalizedStoreKeys(options.storeKeys);
  const granularity = options.granularity || 'day';
  const inflightKey = analyticsCacheKey('analytics.labor_trend.delta', `${dateFrom}:${dateTo}:${storeKeys.join(',') || storeKey}:${periods}:${granularity}:${!!options.includeCurrent}:${!!options.forceRefresh}`);
  const inflight = inflightAnalyticsRequests.get(inflightKey);
  if (inflight) return inflight as Promise<LaborTrendResult>;
  const baseRequest = granularity !== 'day' || storeKeys.length
    ? getLaborEfficiencyTrendFallback(dateFrom, dateTo, storeKey, periods, options)
    : getLaborEfficiencyTrendDelta(dateFrom, dateTo, storeKey, periods, options).catch((err) => {
      if (options.signal?.aborted) throw err;
      return getLaborEfficiencyTrendFallback(dateFrom, dateTo, storeKey, periods, options);
    });
  const request = baseRequest.finally(() => {
      inflightAnalyticsRequests.delete(inflightKey);
    });
  inflightAnalyticsRequests.set(inflightKey, request);
  return request;
}

function laborTrendCacheKey(dateFrom: string, dateTo: string, storeKey: string, periods: number, options: TrendRequestOptions): string {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, store_key: storeKey, periods: String(periods) });
  appendStoreKeys(params, options.storeKeys);
  appendTrendOptions(params, options);
  return `/api/v1/analytics/labor-efficiency/trend?${params.toString()}`;
}

async function getLaborEfficiencyTrendFallback(dateFrom: string, dateTo: string, storeKey: string, periods: number, options: TrendRequestOptions): Promise<LaborTrendResult> {
  const cacheKey = laborTrendCacheKey(dateFrom, dateTo, storeKey, periods, options);
  const qs = `${cacheKey.split('?')[1]}&refresh=${!!options.forceRefresh}`;
  return cachedJson<LaborTrendResult>(`/api/v1/analytics/labor-efficiency/trend?${qs}`, {
    ...options,
    namespace: LABOR_TREND_NAMESPACE,
    cacheKey,
  });
}

async function getLaborEfficiencyTrendDelta(dateFrom: string, dateTo: string, storeKey: string, periods: number, options: AnalyticsRequestOptions): Promise<LaborTrendResult> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const days = eachDate(dateFrom, dateTo);
  const bucketKey = `${storeKey}:${periods}`;
  const bucket = await readDailyBucket<LaborTrendDeltaPayload>(LABOR_TREND_DAILY_NAMESPACE, bucketKey);
  const clientDays = days.flatMap((day) => {
    const cached = bucket.days[day];
    return cached && !options.forceRefresh ? [{ date: day, version: cached.version }] : [];
  });
  const res = await apiFetch('/api/v1/analytics/labor-efficiency/trend/delta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'labor-daily-fact-v3',
      date_from: dateFrom,
      date_to: dateTo,
      params: { store_key: storeKey, periods },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<LaborTrendDeltaResult>(res);
  const merged = new Map<string, LaborTrendDeltaPayload>();
  for (const item of delta.changed_days || []) {
    if (!item.payload?.period) continue;
    const day = item.date || item.payload.period;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    merged.set(day, item.payload);
  }
  for (const day of delta.unchanged_days || []) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  for (const day of days) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  if (days.some((day) => !merged.has(day))) throw new Error('人效趋势日缓存不完整');
  const storeTrendMaps: Record<string, Record<string, LaborTrendPoint>> = {};
  for (const day of days) {
    const item = merged.get(day);
    for (const [key, point] of Object.entries(item?._store_trends || {})) {
      (storeTrendMaps[key] ||= {})[day] = point;
    }
  }
  const store_trends = Object.fromEntries(
    Object.entries(storeTrendMaps).map(([key, byDay]) => [key, days.map((day) => byDay[day]).filter((point): point is LaborTrendPoint => !!point)]),
  );
  if (!options.signal?.aborted) await writeDailyBucket(LABOR_TREND_DAILY_NAMESPACE, bucketKey, bucket, ttlSeconds);
  return {
    granularity: 'day',
    period: `${dateFrom}_${dateTo}`,
    store_key: storeKey,
    points: days.map((day) => merged.get(day)).filter((point): point is LaborTrendPoint => !!point),
    ...(Object.keys(store_trends).length ? { store_trends } : {}),
  };
}

export async function getRevenueTrend(dateFrom: string, dateTo: string, storeKey = 'ALL', sourceType = 'all', options: TrendRequestOptions = {}): Promise<RevenueTrendResult> {
  const storeKeys = normalizedStoreKeys(options.storeKeys);
  const granularity = options.granularity || 'day';
  const inflightKey = analyticsCacheKey('analytics.revenue_trend.delta', `${dateFrom}:${dateTo}:${storeKeys.join(',') || storeKey}:${sourceType}:${granularity}:${!!options.includeCurrent}:${!!options.includeStoreTrends}:${!!options.forceRefresh}`);
  const inflight = inflightAnalyticsRequests.get(inflightKey);
  if (inflight) return inflight as Promise<RevenueTrendResult>;
  const baseRequest = granularity !== 'day' || storeKeys.length || options.includeStoreTrends
    ? getRevenueTrendFallback(dateFrom, dateTo, storeKey, sourceType, options)
    : getRevenueTrendDelta(dateFrom, dateTo, storeKey, sourceType, options).catch((err) => {
      if (options.signal?.aborted) throw err;
      return getRevenueTrendFallback(dateFrom, dateTo, storeKey, sourceType, options);
    });
  const request = baseRequest.finally(() => {
      inflightAnalyticsRequests.delete(inflightKey);
    });
  inflightAnalyticsRequests.set(inflightKey, request);
  return request;
}

export async function getMealPeriods(storeKey: string, businessDate: string, options: AnalyticsRequestOptions = {}): Promise<MealPeriodsResult> {
  const cacheQs = `date=${encodeURIComponent(businessDate)}`;
  const qs = `${cacheQs}&refresh=${!!options.forceRefresh}`;
  const base = `/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/meal-periods`;
  return cachedJson<MealPeriodsResult>(`${base}?${qs}`, { ...options, namespace: 'analytics.meal_periods', cacheKey: `${base}?${cacheQs}` });
}

function mealPeriodTrendCacheKey(storeKey: string, dateFrom: string, dateTo: string, storeKeys?: string[]): string {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
  appendStoreKeys(params, storeKeys);
  return `/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/meal-periods/trend?${params.toString()}`;
}

function mealPeriodTrendBucketKey(storeKey: string): string {
  return storeKey;
}

async function getMealPeriodTrendFallback(storeKey: string, dateFrom: string, dateTo: string, options: AnalyticsRequestOptions): Promise<MealPeriodTrendResult> {
  const cacheKey = mealPeriodTrendCacheKey(storeKey, dateFrom, dateTo, options.storeKeys);
  const qs = `${cacheKey.split('?')[1]}&refresh=${!!options.forceRefresh}`;
  const base = `/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/meal-periods/trend`;
  return cachedJson<MealPeriodTrendResult>(`${base}?${qs}`, {
    ...options,
    namespace: MEAL_PERIOD_TREND_NAMESPACE,
    cacheKey: completeTrendCacheKey(cacheKey, options),
  });
}

async function getMealPeriodTrendDelta(storeKey: string, dateFrom: string, dateTo: string, options: AnalyticsRequestOptions): Promise<MealPeriodTrendResult> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const days = eachDate(dateFrom, dateTo);
  const bucketKey = mealPeriodTrendBucketKey(storeKey);
  const bucket = await readDailyBucket<MealPeriodTrendPoint>(MEAL_PERIOD_TREND_DAILY_NAMESPACE, bucketKey);
  const clientDays = days.flatMap((day) => {
    const cached = bucket.days[day];
    if (!cached || options.forceRefresh) return [];
    return [{ date: day, version: cached.version }];
  });
  const res = await apiFetch(`/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/meal-periods/trend/delta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date_from: dateFrom,
      date_to: dateTo,
      params: { store_key: storeKey },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<MealPeriodTrendDeltaResult>(res);
  const merged = new Map<string, MealPeriodTrendPoint>();
  for (const item of delta.changed_days || []) {
    if (!item.payload?.date) continue;
    const day = item.date || item.payload.date;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    merged.set(day, item.payload);
  }
  for (const day of delta.unchanged_days || []) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  for (const day of days) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  if (days.some((day) => !merged.has(day))) {
    throw new Error('餐段趋势日缓存不完整');
  }
  const result: MealPeriodTrendResult = {
    store_key: storeKey,
    date_from: dateFrom,
    date_to: dateTo,
    points: days.map((day) => merged.get(day)).filter((point): point is MealPeriodTrendPoint => !!point),
  };
  if (!options.signal?.aborted) await writeDailyBucket(MEAL_PERIOD_TREND_DAILY_NAMESPACE, bucketKey, bucket, ttlSeconds);
  return result;
}

export async function getMealPeriodTrend(storeKey: string, dateFrom: string, dateTo: string, options: AnalyticsRequestOptions = {}): Promise<MealPeriodTrendResult> {
  const storeKeys = normalizedStoreKeys(options.storeKeys);
  const inflightKey = analyticsCacheKey('analytics.meal_period_trend.delta', `${storeKeys.join(',') || storeKey}:${dateFrom}:${dateTo}:${!!options.includeStoreTrends}:${!!options.forceRefresh}`);
  const inflight = inflightAnalyticsRequests.get(inflightKey);
  if (inflight) return inflight as Promise<MealPeriodTrendResult>;
  const request = (storeKeys.length || options.includeStoreTrends
    ? getMealPeriodTrendFallback(storeKey, dateFrom, dateTo, options)
    : getMealPeriodTrendDelta(storeKey, dateFrom, dateTo, options))
    .catch((err) => {
      if (options.signal?.aborted) throw err;
      return getMealPeriodTrendFallback(storeKey, dateFrom, dateTo, options);
    })
    .finally(() => {
      inflightAnalyticsRequests.delete(inflightKey);
    });
  inflightAnalyticsRequests.set(inflightKey, request);
  return request;
}

export function getMealPeriodTurnover(
  storeKey: string,
  dateFrom: string,
  dateTo: string,
  options: AnalyticsRequestOptions = {},
): Promise<MealPeriodTurnoverResult> {
  const params = new URLSearchParams({ date_from: dateFrom, date_to: dateTo, refresh: String(!!options.forceRefresh) });
  appendStoreKeys(params, options.storeKeys);
  const cacheKey = `${normalizedStoreKeys(options.storeKeys).join(',') || storeKey}:${dateFrom}:${dateTo}`;
  return cachedJson(
    `/api/v1/analytics/stores/${storeKey}/meal-periods/turnover?${params.toString()}`,
    {
      ...options,
      namespace: 'analytics.meal_period_turnover.v2',
      cacheKey,
    },
  );
}

export async function getAnalyticsContextPack(dateFrom: string, dateTo: string, storeKey = 'ALL', options: AnalyticsRequestOptions = {}): Promise<AnalyticsContextPack> {
  const cacheQs = `date_from=${encodeURIComponent(dateFrom)}&date_to=${encodeURIComponent(dateTo)}&store_key=${encodeURIComponent(storeKey)}`;
  const qs = `${cacheQs}&refresh=${!!options.forceRefresh}`;
  return cachedJson<AnalyticsContextPack>(`/api/v1/analytics/context-pack?${qs}`, {
    ...options,
    namespace: 'analytics.context_pack',
    cacheKey: `/api/v1/analytics/context-pack?${cacheQs}`,
  });
}

export type ProductRow = { product_key: string; product_name: string | null; quantity: number; sales_amount: number; order_count: number; sales_share: number };

export type ProductsResult = { top: ProductRow[]; bottom: ProductRow[]; total?: number } & RefreshMeta;

type ProductsDeltaDay = {
  date: string;
  version: string;
  payload: ProductsResult | null;
};

type ProductsDeltaResult = {
  changed_days?: ProductsDeltaDay[];
  unchanged_days?: string[];
  cache_meta?: { status?: string; returned_days?: number; server_checked_days?: number };
};

const PRODUCTS_NAMESPACE = 'analytics.products';
const PRODUCTS_DAILY_NAMESPACE = 'analytics.products.daily';

export async function getProducts(granularity: string, period: string, shop = 'ALL', refresh = false, limit = 10, dimType?: string, backfill = false, options: ProductRequestOptions = {}): Promise<ProductsResult> {
  const explicitRange = options.dateFrom && options.dateTo ? [options.dateFrom, options.dateTo] as [string, string] : null;
  const range = explicitRange || ordersPeriodRange(granularity, period);
  const storeKeys = normalizedStoreKeys(options.storeKeys);
  if (range && storeKeys.length === 0 && !refresh && !backfill && !options.forceRefresh) {
    const [dateFrom, dateTo] = range;
    const fullRows = !!explicitRange || dateFrom !== dateTo || limit <= 0;
    const inflightKey = analyticsCacheKey('analytics.products.delta', `${dateFrom}:${dateTo}:${shop}:${limit}:${dimType || ''}:${fullRows}`);
    const inflight = inflightAnalyticsRequests.get(inflightKey);
    if (inflight) return inflight as Promise<ProductsResult>;
    const request = getProductsDailyDelta(dateFrom, dateTo, shop, limit, dimType, options, fullRows)
      .catch((err) => {
        if (options.signal?.aborted) throw err;
        return getProductsFallback(granularity, period, shop, refresh, limit, dimType, backfill, options);
      })
      .finally(() => {
        inflightAnalyticsRequests.delete(inflightKey);
      });
    inflightAnalyticsRequests.set(inflightKey, request);
    return request;
  }
  return getProductsFallback(granularity, period, shop, refresh, limit, dimType, backfill, options);
}

async function getProductsFallback(granularity: string, period: string, shop: string, refresh: boolean, limit: number, dimType: string | undefined, backfill: boolean, options: ProductRequestOptions): Promise<ProductsResult> {
  const params = new URLSearchParams({
    granularity,
    period,
    shop,
    limit: String(limit),
    refresh: String(refresh),
    backfill: String(backfill),
  });
  if (dimType) params.set('dim_type', dimType);
  appendStoreKeys(params, options.storeKeys);
  if (options.dateFrom && options.dateTo) {
    params.set('date_from', options.dateFrom);
    params.set('date_to', options.dateTo);
  }
  const cacheParams = new URLSearchParams(params);
  cacheParams.delete('refresh');
  cacheParams.delete('backfill');
  const cacheKey = `/api/v1/analytics/products?${cacheParams.toString()}`;
  const url = `/api/v1/analytics/products?${params.toString()}`;
  if (refresh || backfill || options.forceRefresh) {
    await clearAnalyticsCacheAsync(PRODUCTS_NAMESPACE, cacheKey, true);
    return json<ProductsResult>(await apiFetch(url, { signal: options.signal }));
  }
  return cachedJson<ProductsResult>(url, { ...options, namespace: PRODUCTS_NAMESPACE, cacheKey });
}

function aggregateProductsResult(days: string[], payloads: ProductsResult[], limit: number, cacheMeta?: AnalyticsCacheMeta): ProductsResult {
  const rows = new Map<string, ProductRow>();
  for (const payload of payloads) {
    for (const row of payload.top || []) {
      const key = row.product_key || row.product_name || '';
      if (!key) continue;
      const current = rows.get(key) || {
        product_key: key,
        product_name: row.product_name || null,
        quantity: 0,
        sales_amount: 0,
        order_count: 0,
        sales_share: 0,
      };
      current.product_name = current.product_name || row.product_name || null;
      current.quantity += Number(row.quantity || 0);
      current.sales_amount = addMoney(current.sales_amount, row.sales_amount);
      current.order_count += Number(row.order_count || 0);
      rows.set(key, current);
    }
  }
  const items = Array.from(rows.values()).map((row) => ({
    ...row,
    quantity: Number(row.quantity || 0),
    sales_amount: Number(Number(row.sales_amount || 0).toFixed(2)),
    order_count: Number(row.order_count || 0),
  }));
  items.sort((a, b) => (Number(b.sales_amount || 0) - Number(a.sales_amount || 0)) || (Number(b.quantity || 0) - Number(a.quantity || 0)));
  const totalSales = sumMoney(items.map(row => row.sales_amount)) || 1;
  const withShare = items.map(row => ({ ...row, sales_share: Number((Number(row.sales_amount || 0) / totalSales).toFixed(4)) }));
  const displayLimit = Math.max(0, Number(limit || 0));
  const top = displayLimit > 0 ? withShare.slice(0, displayLimit) : withShare;
  const bottom = displayLimit > 0 && withShare.length > displayLimit ? [...withShare.slice(-displayLimit)].reverse() : [];
  const hasMissing = payloads.length !== days.length || payloads.some(payload => payload.snapshot_status && payload.snapshot_status !== 'ready');
  return {
    top,
    bottom,
    total: withShare.length,
    snapshot_status: withShare.length ? (hasMissing ? 'partial' : 'ready') : 'missing',
    refresh_queued: payloads.some(payload => !!payload.refresh_queued),
    backfill_queued: payloads.some(payload => !!payload.backfill_queued),
    cache_meta: cacheMeta,
  };
}

async function getProductsDailyDelta(dateFrom: string, dateTo: string, shop: string, limit: number, dimType: string | undefined, options: AnalyticsRequestOptions, fullRows: boolean): Promise<ProductsResult> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const days = eachDate(dateFrom, dateTo);
  const bucketKey = `${shop}:${dimType || (shop === 'ALL' ? 'all' : 'shop')}:${fullRows ? 'full' : limit}`;
  const bucket = await readDailyBucket<ProductsResult>(PRODUCTS_DAILY_NAMESPACE, bucketKey);
  const clientDays = days.flatMap((day) => {
    const cached = bucket.days[day];
    return cached && !options.forceRefresh ? [{ date: day, version: cached.version }] : [];
  });
  const res = await apiFetch('/api/v1/analytics/products/delta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date_from: dateFrom,
      date_to: dateTo,
      params: { shop, dim_type: dimType || (shop === 'ALL' ? 'all' : 'shop'), limit, full_rows: fullRows },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<ProductsDeltaResult>(res);
  const merged = new Map<string, ProductsResult>();
  for (const item of delta.changed_days || []) {
    if (!item.payload?.top) continue;
    const day = item.date;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    merged.set(day, item.payload);
  }
  for (const day of delta.unchanged_days || []) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  for (const day of days) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  if (days.some((day) => !merged.has(day))) throw new Error('产品排行日缓存不完整');
  if (!options.signal?.aborted) await writeDailyBucket(PRODUCTS_DAILY_NAMESPACE, bucketKey, bucket, ttlSeconds);
  if (days.length === 1 && !fullRows) {
    return { ...(merged.get(days[0]) as ProductsResult), cache_meta: delta.cache_meta };
  }
  return aggregateProductsResult(days, days.map((day) => merged.get(day)).filter((payload): payload is ProductsResult => !!payload), limit, delta.cache_meta);
}

export type ProductTrendPoint = {
  period: string;
  quantity: number;
  sales_amount: number;
  order_count: number;
  missing: boolean;
  ma3?: number | null;
  ma4?: number | null;
  ma6?: number | null;
  ma7?: number | null;
  ma12?: number | null;
  ma26?: number | null;
  ma30?: number | null;
  ma180?: number | null;
  period_start?: string;
  period_end?: string;
  in_progress?: boolean;
  [field: string]: string | number | boolean | null | undefined;
};

export type ProductTrendResult = {
  metric: 'quantity';
  date_from: string;
  date_to: string;
  dim_type: string;
  dim_key: string;
  product_key: string;
  product_name: string | null;
  granularity?: TrendGranularity;
  moving_averages?: TrendMovingAverageMeta[];
  points: ProductTrendPoint[];
  store_keys?: string[];
  store_trends?: Record<string, ProductTrendPoint[]>;
};

type ProductTrendDeltaDay = {
  date: string;
  version: string;
  payload: ProductTrendPoint | null;
};

type ProductTrendDeltaResult = {
  product_name?: string | null;
  changed_days?: ProductTrendDeltaDay[];
  unchanged_days?: string[];
  cache_meta?: { status?: string; returned_days?: number; server_checked_days?: number };
};

const PRODUCT_TREND_NAMESPACE = 'analytics.product_trend.v2';
const PRODUCT_TREND_DAILY_NAMESPACE = 'analytics.product_trend.daily.v2';

function productTrendCacheKey(productKey: string, dateFrom: string, dateTo: string, dimKey: string, dimType: string | undefined, options: TrendRequestOptions): string {
  const params = new URLSearchParams({ product_key: productKey, date_from: dateFrom, date_to: dateTo, dim_key: dimKey });
  if (dimType) params.set('dim_type', dimType);
  appendStoreKeys(params, options.storeKeys);
  appendTrendOptions(params, options);
  return `/api/v1/analytics/products/trend?${params.toString()}`;
}

function productTrendBucketKey(productKey: string, dimKey: string, dimType: string | undefined): string {
  return `${productKey}:${dimKey}:${dimType || ''}`;
}

async function getProductTrendFallback(productKey: string, dateFrom: string, dateTo: string, dimKey: string, dimType: string | undefined, options: TrendRequestOptions): Promise<ProductTrendResult> {
  const cacheKey = productTrendCacheKey(productKey, dateFrom, dateTo, dimKey, dimType, options);
  const qs = `${cacheKey.split('?')[1]}&refresh=${!!options.forceRefresh}`;
  return cachedJson<ProductTrendResult>(`/api/v1/analytics/products/trend?${qs}`, {
    ...options,
    namespace: PRODUCT_TREND_NAMESPACE,
    cacheKey: completeTrendCacheKey(cacheKey, options),
  });
}

async function getProductTrendDelta(productKey: string, dateFrom: string, dateTo: string, dimKey: string, dimType: string | undefined, options: AnalyticsRequestOptions): Promise<ProductTrendResult> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const cacheKey = productTrendCacheKey(productKey, dateFrom, dateTo, dimKey, dimType, options);
  const cachedResult = readAnalyticsCache<ProductTrendResult>(PRODUCT_TREND_NAMESPACE, cacheKey);
  const days = eachDate(dateFrom, dateTo);
  const bucketKey = productTrendBucketKey(productKey, dimKey, dimType);
  const bucket = await readDailyBucket<ProductTrendPoint>(PRODUCT_TREND_DAILY_NAMESPACE, bucketKey);
  const clientDays = days.flatMap((day) => {
    const cached = bucket.days[day];
    if (!cached || options.forceRefresh) return [];
    return [{ date: day, version: cached.version }];
  });
  const res = await apiFetch('/api/v1/analytics/products/trend/delta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      schema_version: 'product-daily-fact-v2',
      date_from: dateFrom,
      date_to: dateTo,
      params: { product_key: productKey, dim_key: dimKey, dim_type: dimType },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<ProductTrendDeltaResult>(res);
  if (delta.product_name !== undefined) bucket.meta = { ...(bucket.meta || {}), product_name: delta.product_name };
  const merged = new Map<string, ProductTrendPoint>();
  for (const item of delta.changed_days || []) {
    if (!item.payload?.period) continue;
    const day = item.date || item.payload.period;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    merged.set(day, item.payload);
  }
  for (const day of delta.unchanged_days || []) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  for (const day of days) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  if (days.some((day) => !merged.has(day))) {
    throw new Error('产品趋势日缓存不完整');
  }
  const result: ProductTrendResult = {
    metric: 'quantity',
    granularity: 'day',
    date_from: dateFrom,
    date_to: dateTo,
    dim_type: dimType || (dimKey === 'ALL' ? 'all' : 'shop'),
    dim_key: dimKey,
    product_key: productKey,
    product_name: delta.product_name ?? (bucket.meta?.product_name as string | null | undefined) ?? cachedResult?.product_name ?? null,
    points: days.map((day) => merged.get(day)).filter((point): point is ProductTrendPoint => !!point),
  };
  if (!options.signal?.aborted) await writeDailyBucket(PRODUCT_TREND_DAILY_NAMESPACE, bucketKey, bucket, ttlSeconds);
  return result;
}

export async function getProductTrend(productKey: string, dateFrom: string, dateTo: string, dimKey = 'ALL', dimType?: string, options: TrendRequestOptions = {}): Promise<ProductTrendResult> {
  const storeKeys = normalizedStoreKeys(options.storeKeys);
  const granularity = options.granularity || 'day';
  const inflightKey = analyticsCacheKey('analytics.product_trend.delta', `${productKey}:${dateFrom}:${dateTo}:${storeKeys.join(',') || dimKey}:${dimType || ''}:${granularity}:${!!options.includeCurrent}:${!!options.includeStoreTrends}:${!!options.forceRefresh}`);
  const inflight = inflightAnalyticsRequests.get(inflightKey);
  if (inflight) return inflight as Promise<ProductTrendResult>;
  const baseRequest = granularity !== 'day' || storeKeys.length || options.includeStoreTrends
    ? getProductTrendFallback(productKey, dateFrom, dateTo, dimKey, dimType, options)
    : getProductTrendDelta(productKey, dateFrom, dateTo, dimKey, dimType, options).catch((err) => {
      if (options.signal?.aborted) throw err;
      return getProductTrendFallback(productKey, dateFrom, dateTo, dimKey, dimType, options);
    });
  const request = baseRequest.finally(() => {
      inflightAnalyticsRequests.delete(inflightKey);
    });
  inflightAnalyticsRequests.set(inflightKey, request);
  return request;
}

export type RevenueAlertPrimaryCause = {
  summary: string;
  confidence: 'high' | 'medium' | 'low' | 'review';
  driver: string | null;
  supporting_signals: string[];
  primary_evidence?: string;
  recommended_action?: string;
  impact_signals?: string[];
  context_signals?: string[];
  focus_period?: string | null;
  classification: 'data_quality' | 'business_driver' | 'weather_driver' | 'unresolved';
  evidence_refs?: string[];
};

export type RevenueAlertInterpretation = {
  status: 'ready' | 'pending' | 'failed' | 'unavailable';
  summary?: string;
  priority_action?: string;
  uncertainties?: string[];
  confidence?: 'high' | 'medium' | 'low';
  generated_at?: string;
};

export type RevenueAlert = {
  shop_key: string; shop_label: string | null; business_date: string;
  actual_amount: number; baseline_amount: number; deviation_pct: number; direction: string; status: string;
  baseline_sample_count?: number; baseline_expected_count?: number; baseline_dates?: string[]; reason_hints?: string[];
  primary_cause?: RevenueAlertPrimaryCause | null;
  ai_interpretation?: RevenueAlertInterpretation | null;
};

export type RevenueAlertSettings = {
  threshold_pct: number;
  recipient_user_ids: string[];
};

export async function getRevenueAlerts(businessDate?: string): Promise<RevenueAlert[]> {
  const qs = businessDate ? `?business_date=${encodeURIComponent(businessDate)}` : '';
  const data = await json<{ alerts: RevenueAlert[] }>(await apiFetch(`/api/v1/analytics/revenue-alerts${qs}`));
  return data.alerts;
}

export async function getRevenueAlertSettings(): Promise<RevenueAlertSettings> {
  const data = await json<{ settings: RevenueAlertSettings }>(await apiFetch('/api/v1/analytics/revenue-alert-settings'));
  return data.settings;
}

export async function saveRevenueAlertSettings(body: RevenueAlertSettings): Promise<RevenueAlertSettings> {
  const data = await json<{ settings: RevenueAlertSettings }>(await apiFetch('/api/v1/analytics/revenue-alert-settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  return data.settings;
}

export async function detectRevenueAlerts(business_date: string): Promise<{ detected: number; alerts: RevenueAlert[] }> {
  return json(await apiFetch('/api/v1/analytics/revenue-alerts/detect', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ business_date }),
  }));
}

export type ShopMapping = {
  shiheng_shop_id: string;
  shiheng_shop_name: string | null;
  hr_department_id: string | null;
  hr_department_name: string | null;
  match_score: number;
  status: string;
};

export type StoreScopeTreeResponse = {
  nodes: StoreScopeNode[];
  store_count: number;
  source: string;
};

export type HrDept = { id: string; name: string };
export type PlatformDim = { platform_code: number; platform_name: string; confirmed: boolean };

function ordersBucketKey(dim: string, sourceType: string): string {
  return `${dim}:${sourceType}`;
}

async function getOrdersFallback(
  granularity: string,
  period: string,
  dim: string,
  refresh: boolean,
  backfill: boolean,
  autoRefresh: boolean,
  excludeToday: boolean,
  options: AnalyticsRequestOptions,
): Promise<OrdersResult> {
  const qs = `granularity=${granularity}&period=${encodeURIComponent(period)}&dim=${encodeURIComponent(dim)}&refresh=${refresh}&backfill=${backfill}&auto_refresh=${autoRefresh}&exclude_today=${excludeToday}`;
  const url = `/api/v1/analytics/orders?${qs}`;
  if (refresh || backfill || options.forceRefresh) {
    await clearAnalyticsCacheAsync(ORDERS_NAMESPACE, undefined, true);
    await clearAnalyticsCacheAsync(ORDERS_DAILY_NAMESPACE, undefined, true);
    return json<OrdersResult>(await apiFetch(url, { signal: options.signal }));
  }
  return cachedJson<OrdersResult>(url, { ...options, namespace: ORDERS_NAMESPACE });
}

async function getOrdersDelta(granularity: string, dateFrom: string, dateTo: string, dim: string, autoRefresh: boolean, options: AnalyticsRequestOptions): Promise<OrdersResult> {
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_ANALYTICS_CACHE_TTL_SECONDS;
  const sourceType = 'all';
  const bucketKey = ordersBucketKey(dim, sourceType);
  const bucket = await readDailyBucket<OrdersResult>(ORDERS_DAILY_NAMESPACE, bucketKey);
  const days = eachDate(dateFrom, dateTo);
  const clientDays = days.flatMap((day) => {
    const cached = bucket.days[day];
    return cached && !options.forceRefresh ? [{ date: day, version: cached.version }] : [];
  });
  const res = await apiFetch('/api/v1/analytics/orders/delta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date_from: dateFrom,
      date_to: dateTo,
      params: { dim, source_type: sourceType },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
      auto_refresh: autoRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<OrdersDeltaResult>(res);
  const merged = new Map<string, OrdersResult>();
  for (const item of delta.changed_days || []) {
    if (!item.payload?.rows) continue;
    const day = item.date || item.payload.effective_date_to || item.payload.rows[0]?.computed_at?.slice(0, 10) || '';
    if (!day) continue;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    merged.set(day, item.payload);
  }
  for (const day of delta.unchanged_days || []) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  for (const day of days) {
    const cached = bucket.days[day];
    if (cached) merged.set(day, cached.payload);
  }
  if (days.some((day) => !merged.has(day))) throw new Error('订单统计日缓存不完整');
  if (!options.signal?.aborted) await writeDailyBucket(ORDERS_DAILY_NAMESPACE, bucketKey, bucket, ttlSeconds);
  const payloads = days.map((day) => merged.get(day)).filter((payload): payload is OrdersResult => !!payload);
  return granularity === 'day' ? payloads[0] : aggregateOrdersResult(days, payloads);
}

export async function getOrders(granularity: string, period: string, dim: string, refresh = false, backfill = false, autoRefresh = true, excludeToday = false, options: AnalyticsRequestOptions = {}): Promise<OrdersResult> {
  const range = ordersPeriodRange(granularity, period);
  if (!range || refresh || backfill || excludeToday) {
    return getOrdersFallback(granularity, period, dim, refresh, backfill, autoRefresh, excludeToday, options);
  }
  const [dateFrom, dateTo] = range;
  const inflightKey = analyticsCacheKey('analytics.orders.delta', `${granularity}:${period}:${dateFrom}:${dateTo}:${dim}:${autoRefresh}:${!!options.forceRefresh}`);
  const inflight = inflightAnalyticsRequests.get(inflightKey);
  if (inflight) return inflight as Promise<OrdersResult>;
  const request = getOrdersDelta(granularity, dateFrom, dateTo, dim, autoRefresh, options)
    .catch((err) => {
      if (options.signal?.aborted) throw err;
      return getOrdersFallback(granularity, period, dim, refresh, backfill, autoRefresh, excludeToday, options);
    })
    .finally(() => {
      inflightAnalyticsRequests.delete(inflightKey);
    });
  inflightAnalyticsRequests.set(inflightKey, request);
  return request;
}

export type OrderInsight = { content_md: string; cached: boolean; model: string | null; data_sources?: string[]; knowledge_suggestions?: { title: string; source_text: string; confidence: number }[] };

export type BusinessReportInsight = {
  content_md: string;
  output_json: Record<string, unknown>;
  cached: boolean;
  model: string | null;
  trace_id: string;
  data_sources: string[];
  missing_context: { field?: string; severity?: string; message?: string }[];
  knowledge_candidate_count: number;
};

export async function getOrdersInsight(granularity: string, period: string, dim: string, refresh = false): Promise<OrderInsight> {
  const qs = `granularity=${granularity}&period=${encodeURIComponent(period)}&dim=${encodeURIComponent(dim)}&refresh=${refresh}`;
  return json<OrderInsight>(await apiFetch(`/api/v1/analytics/orders/insight?${qs}`, { method: 'POST' }));
}

export async function getBusinessReport(granularity: string, period: string, refresh = false): Promise<BusinessReportInsight> {
  const qs = `granularity=${granularity}&period=${encodeURIComponent(period)}&refresh=${refresh}`;
  return json<BusinessReportInsight>(await apiFetch(`/api/v1/analytics/business-report?${qs}`, { method: 'POST' }));
}

export async function saveOrdersInsightCandidate(body: {
  title: string;
  source_text: string;
  confidence?: number;
  category?: string;
}): Promise<{ status: string; candidate_id: string }> {
  return json(await apiFetch('/api/v1/analytics/orders/insight/candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export type ForecastFeatureCoverage = {
  feature_label: string;
  sample_count: number;
  coverage: number;
  avg_error_rate?: number | null;
  max_error_rate?: number | null;
};

export type ForecastFeatureDetailCoverage = {
  sample_count: number;
  coverage: number;
};

export type ForecastFeatureDetailEffect = {
  sample_count: number;
  avg_signed_error_rate: number;
  max_signed_error_rate?: number;
  min_signed_error_rate?: number;
  direction: 'under_prediction' | 'over_prediction' | 'balanced' | string;
};

export type ForecastModelReadiness = {
  status: 'missing_model_version' | 'collecting_samples' | 'ready_for_optimization' | string;
  sample_count: number;
  backfilled_sample_count: number;
  pending_sample_count: number;
  min_backfilled_samples: number;
  remaining_backfilled_samples: number;
  available_feature_keys: string[];
  available_feature_labels: Record<string, string>;
  feature_coverage: Record<string, ForecastFeatureCoverage>;
  feature_detail_coverage?: Record<string, ForecastFeatureDetailCoverage>;
  feature_detail_effect?: Record<string, ForecastFeatureDetailEffect>;
  error_segments?: Record<string, Record<string, ForecastFeatureCoverage>>;
  error_trend?: Record<string, unknown> | null;
  recommendations?: Record<string, unknown>[];
  last_optimizer?: ForecastModelOptimizer | null;
};

export type ForecastAssetReadiness = {
  status: 'ready' | 'degraded' | 'blocked' | 'unavailable' | string;
  granularity: string;
  period: string;
  dim: string;
  entity_count?: number;
  assets: Record<string, {
    status: 'ready' | 'partial' | 'missing' | string;
    required?: boolean;
    expected_count?: number;
    covered_count?: number;
    sample_count?: number;
    snapshot_count?: number;
  }>;
  required_missing?: string[];
  weak_assets?: string[];
  recommendations?: Record<string, unknown>[];
};

export type ForecastModelOptimizer = {
  id?: string;
  status: 'collecting_samples' | 'ready' | string;
  generated_at?: string;
  sample_count: number;
  min_backfilled_samples?: number;
  min_required?: number;
  remaining_backfilled_samples?: number;
  recommended_weights: Record<string, number>;
  recommended_detail_weights?: Record<string, number>;
  recommended_detail_mid_effects?: Record<string, number>;
  feature_stats: Record<string, ForecastFeatureCoverage>;
  feature_detail_stats?: Record<string, ForecastFeatureCoverage & Partial<ForecastFeatureDetailEffect>>;
  model_quality?: Record<string, unknown>;
  context_signals?: Record<string, unknown>;
  applied: boolean;
  policy?: string;
  knowledge_candidate_id?: string;
};

export type RevenueForecastModel = {
  status: string;
  scenario: 'revenue_forecast' | string;
  version: string;
  feature_schema?: Record<string, unknown>;
  weights?: Record<string, unknown>;
  training_summary?: Record<string, unknown>;
  validation_summary?: Record<string, unknown>;
  optimizer?: ForecastModelOptimizer | null;
  readiness: ForecastModelReadiness;
  current_asset_readiness?: ForecastAssetReadiness;
  updated_at?: string | null;
};

export async function getRevenueForecastModel(): Promise<RevenueForecastModel> {
  return json<RevenueForecastModel>(await apiFetch('/api/v1/analytics/revenue-forecast/model'));
}

export async function optimizeRevenueForecastModel(body: {
  min_backfilled_samples?: number;
  apply?: boolean;
} = {}): Promise<{
  tenant_id: string;
  model_version?: string;
  optimizer?: ForecastModelOptimizer;
  actuals_backfill?: Record<string, unknown>;
  status?: string;
  message?: string;
}> {
  return json(await apiFetch('/api/v1/analytics/revenue-forecast/model/optimize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function listShopMappings(): Promise<ShopMapping[]> {
  const data = await json<{ mappings: ShopMapping[] }>(await apiFetch('/api/v1/analytics/shop-mappings'));
  return data.mappings;
}

export async function listStoreScopeTree(): Promise<StoreScopeTreeResponse> {
  return json(await apiFetch('/api/v1/analytics/store-scope-tree'));
}

export async function proposeShopMappings(): Promise<ShopMapping[]> {
  const data = await json<{ mappings: ShopMapping[] }>(await apiFetch('/api/v1/analytics/shop-mappings/propose', { method: 'POST' }));
  return data.mappings;
}

export async function confirmShopMapping(shiheng_shop_id: string, hr_department_id: string): Promise<ShopMapping[]> {
  const data = await json<{ mappings: ShopMapping[] }>(await apiFetch('/api/v1/analytics/shop-mappings/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shiheng_shop_id, hr_department_id }),
  }));
  await clearAnalyticsCacheAsync(undefined, undefined, true);
  return data.mappings;
}

export async function listHrDepartments(): Promise<HrDept[]> {
  const data = await json<{ departments: HrDept[] }>(await apiFetch('/api/v1/analytics/hr-departments'));
  return data.departments;
}

export async function listPlatformDim(): Promise<PlatformDim[]> {
  const data = await json<{ platforms: PlatformDim[] }>(await apiFetch('/api/v1/analytics/platform-dim'));
  return data.platforms;
}

export async function savePlatformName(platform_code: number, platform_name: string): Promise<void> {
  await json(await apiFetch('/api/v1/analytics/platform-dim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform_code, platform_name }),
  }));
}


// ── 门店地理画像 ──────────────────────────────────────────────────

export interface StoreGeoProfile {
  store_key: string;
  shop_id: string;
  shop_name: string;
  source_address: string | null;
  normalized_address: string | null;
  longitude: number | null;
  latitude: number | null;
  adcode: string | null;
  province: string | null;
  city: string | null;
  district: string | null;
  business_areas: unknown[] | null;
  status: string;
  confirmed_at: string | null;
  confirmed_by: string | null;
  store_area_m2: number | null;
  kitchen_area_m2: number | null;
  dining_table_count: number | null;
  seat_count: number | null;
  facility_note: string | null;
}

export interface GeocodeCandidate {
  id: string;
  name: string;
  location: string;
  lng: number;
  lat: number;
  address: string;
  rating: number;
  cost: number;
  typecode: string;
}

export interface GeocodeResult {
  store_key: string;
  shop_id: string;
  status: string;
  address: string;
  longitude: number | null;
  latitude: number | null;
  adcode: string | null;
  province: string;
  city: string;
  district: string;
  business_areas: unknown[] | null;
  confidence: number;
  candidates: GeocodeCandidate[];
}


export async function listStoreGeoProfiles(options?: { mappedOnly?: boolean }): Promise<StoreGeoProfile[]> {
  const query = options?.mappedOnly ? '?mapped_only=true' : '';
  return json(await apiFetch(`/api/v1/analytics/stores/geo-profiles${query}`));
}

export async function geocodeStore(storeKey: string, address: string): Promise<GeocodeResult> {
  return json(await apiFetch(`/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/geocode`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  }));
}

export async function confirmGeoProfile(storeKey: string): Promise<{ store_key: string; shop_id: string; status: string }> {
  return json(await apiFetch(`/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/geo-profile/confirm`, {
    method: 'POST',
  }));
}

export async function saveStoreFacilityProfile(
  storeKey: string,
  body: {
    store_area_m2?: number | null;
    kitchen_area_m2?: number | null;
    dining_table_count?: number | null;
    seat_count?: number | null;
    facility_note?: string | null;
  },
): Promise<Partial<StoreGeoProfile> & { shop_id: string; store_key: string }> {
  const result = await json<Partial<StoreGeoProfile> & { shop_id: string; store_key: string }>(await apiFetch(`/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/geo-profile/facility`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  await clearAnalyticsCacheAsync('analytics.context_pack', undefined, true);
  return result;
}


// ── 商圈快照 ──────────────────────────────────────────────────────

export interface TradeAreaSnapshot {
  store_key: string;
  snapshot_month: string;
  poi_counts: Record<string, number> | null;
  density_metrics?: Record<string, TradeAreaDensityMetric> | null;
  scores: Record<string, number> | null;
  tags: string[] | null;
  top_competitors: TradeAreaCompetitor[] | null;
  computed_at: string | null;
}

export interface TradeAreaDensityMetric {
  raw_count: number;
  effective_count: number;
  reference_count: number;
  score: number;
}

export interface TradeAreaCompetitor {
  name: string;
  rating: number;
  cost: number;
  distance_m: number;
}

export interface TradeAreaRefreshResult {
  status: string;
  refresh_queued: boolean;
  store_key?: string;
  message?: string;
  retry_after_seconds?: number | null;
  snapshot?: {
    store_key: string;
    snapshot_month: string;
    poi_counts: Record<string, number>;
    density_metrics?: Record<string, TradeAreaDensityMetric>;
    scores: Record<string, number>;
    tags: string[];
    top_competitors: TradeAreaCompetitor[];
    total_pois: number;
    fetch_summary: Record<string, { total_fetched: number; truncated: boolean }>;
  };
}

export async function getTradeArea(storeKey: string, month?: string, options: AnalyticsRequestOptions = {}): Promise<TradeAreaSnapshot> {
  const qs = month ? `?month=${encodeURIComponent(month)}` : '';
  const url = `/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/trade-area${qs}`;
  return cachedJson<TradeAreaSnapshot>(url, { ...options, namespace: 'analytics.trade_area' });
}

export async function refreshTradeArea(storeKey: string): Promise<TradeAreaRefreshResult> {
  await clearAnalyticsCacheAsync('analytics.trade_area', undefined, true);
  await clearAnalyticsCacheAsync('analytics.trade_area_pois', undefined, true);
  return json(await apiFetch(`/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/trade-area/refresh`, {
    method: 'POST',
  }));
}

export interface TradeAreaPoiItem {
  poi_id: string;
  name: string;
  type_code: string;
  type_name: string;
  bucket: string;
  longitude: number | null;
  latitude: number | null;
  distance_m: number;
  address: string;
}

export async function listTradeAreaPois(storeKey: string, bucket?: string, month?: string, options: AnalyticsRequestOptions = {}): Promise<TradeAreaPoiItem[]> {
  const params = new URLSearchParams();
  if (bucket) params.set('bucket', bucket);
  if (month) params.set('month', month);
  params.set('limit', '200');
  const qs = params.toString();
  const url = `/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/trade-area/pois${qs ? '?' + qs : ''}`;
  const data = await cachedJson<{ pois: TradeAreaPoiItem[] }>(url, {
    ...options,
    namespace: 'analytics.trade_area_pois',
  });
  return data.pois;
}

// ── 天气 ─────────────────────────────────────────────────────────

export interface WeatherPeriod {
  store_key: string;
  granularity: string;
  period_key: string;
  rainy_hours: number;
  heavy_rain_hours: number;
  avg_temp: number | null;
  max_temp: number | null;
  min_temp: number | null;
  avg_humidity: number | null;
  bad_weather_tags: string[];
  hour_count?: number;
  partial?: boolean;
  source?: string;
}

type WeatherDeltaDay = {
  date: string;
  version: string;
  payload: WeatherPeriod | null;
};

type WeatherDeltaResult = {
  changed_days?: WeatherDeltaDay[];
  unchanged_days?: string[];
  cache_meta?: { status?: string; returned_days?: number; server_checked_days?: number };
};

const WEATHER_NAMESPACE = 'analytics.weather';
const WEATHER_DAILY_NAMESPACE = 'analytics.weather.daily';

export async function getStoreWeather(storeKey: string, granularity: string, period: string, options: AnalyticsRequestOptions = {}): Promise<WeatherPeriod> {
  if (granularity === 'day' && !options.forceRefresh) {
    const inflightKey = analyticsCacheKey('analytics.weather.delta', `${storeKey}:${period}`);
    const inflight = inflightAnalyticsRequests.get(inflightKey);
    if (inflight) return inflight as Promise<WeatherPeriod>;
    const request = getStoreWeatherDelta(storeKey, period, options)
      .catch((err) => {
        if (options.signal?.aborted) throw err;
        return getStoreWeatherFallback(storeKey, granularity, period, options);
      })
      .finally(() => {
        inflightAnalyticsRequests.delete(inflightKey);
      });
    inflightAnalyticsRequests.set(inflightKey, request);
    return request;
  }
  return getStoreWeatherFallback(storeKey, granularity, period, options);
}

function getStoreWeatherFallback(storeKey: string, granularity: string, period: string, options: AnalyticsRequestOptions = {}): Promise<WeatherPeriod> {
  const qs = `granularity=${granularity}&period=${encodeURIComponent(period)}`;
  const url = `/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/weather?${qs}`;
  return cachedJson<WeatherPeriod>(url, { ...options, namespace: WEATHER_NAMESPACE, ttlSeconds: options.ttlSeconds ?? 6 * 60 * 60 });
}

async function getStoreWeatherDelta(storeKey: string, period: string, options: AnalyticsRequestOptions): Promise<WeatherPeriod> {
  const ttlSeconds = options.ttlSeconds ?? 6 * 60 * 60;
  const bucket = await readDailyBucket<WeatherPeriod>(WEATHER_DAILY_NAMESPACE, storeKey);
  const cached = bucket.days[period];
  const clientDays = cached && !options.forceRefresh ? [{ date: period, version: cached.version }] : [];
  const res = await apiFetch(`/api/v1/analytics/stores/${encodeURIComponent(storeKey)}/weather/delta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      date_from: period,
      date_to: period,
      params: { store_key: storeKey },
      client_days: clientDays,
      force_refresh: !!options.forceRefresh,
    }),
    signal: options.signal,
  });
  const delta = await json<WeatherDeltaResult>(res);
  let payload: WeatherPeriod | null = null;
  for (const item of delta.changed_days || []) {
    if (!item.payload?.period_key) continue;
    const day = item.date || item.payload.period_key;
    bucket.days[day] = { version: item.version, payload: item.payload, savedAt: new Date().toISOString() };
    if (day === period) payload = item.payload;
  }
  if (!payload && (delta.unchanged_days || []).includes(period)) payload = bucket.days[period]?.payload || null;
  if (!payload) payload = bucket.days[period]?.payload || null;
  if (!payload) throw new Error('天气日缓存不完整');
  if (!options.signal?.aborted) await writeDailyBucket(WEATHER_DAILY_NAMESPACE, storeKey, bucket, ttlSeconds);
  return payload;
}
