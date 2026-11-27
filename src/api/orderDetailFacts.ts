import dayjs from 'dayjs';
import { apiFetch } from './client';
import { getOrderDailyFacts } from './analyticsDailyFacts';
import type { OrderDailyFact, OrderFactTotals } from './analyticsDailyTypes';
import type { OrderRow } from './analytics';
import { moneyToCents } from '../utils/money';

type LegacyDay = { date: string; payload: { rows: OrderRow[]; snapshot_status?: string } };

function totals(row: OrderRow): OrderFactTotals {
  return {
    order_count: row.order_count,
    paid_amount_cent: moneyToCents(row.paid_amount), income_amount_cent: moneyToCents(row.income_amount),
    refund_amount_cent: moneyToCents(row.refund_amount), net_amount_cent: moneyToCents(row.net_amount),
    net_income_cent: moneyToCents(row.net_income),
  };
}

/** The legacy delta also reads published daily snapshots; no raw-order calculation or rebuild. */
export async function getOrderDetailFacts(dateFrom: string, dateTo: string, storeKey: string,
  dimension: 'none' | 'channel' | 'platform', signal: AbortSignal): Promise<OrderDailyFact[]> {
  try {
    const records = await getOrderDailyFacts<OrderDailyFact>(dateFrom, dateTo, { store_keys: [storeKey] }, { signal });
    return records.map(record => record.payload);
  } catch (error) {
    if (signal.aborted || !(error instanceof Error) || error.name !== 'DailyFactUnsupportedError') throw error;
  }
  const result: OrderDailyFact[] = [];
  for (let cursor = dayjs(dateFrom); !cursor.isAfter(dateTo, 'day');) {
    const end = cursor.add(365, 'day').isAfter(dateTo, 'day') ? dayjs(dateTo) : cursor.add(365, 'day');
    const read = async (dim: string): Promise<LegacyDay[]> => {
      const response = await apiFetch('/api/v1/analytics/orders/delta', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ date_from: cursor.format('YYYY-MM-DD'), date_to: end.format('YYYY-MM-DD'),
          params: { dim, source_type: 'all', store_keys: [storeKey] }, client_days: [], force_refresh: false, auto_refresh: false }),
      });
      if (!response.ok) throw Object.assign(new Error(`订单明细读取失败（${response.status}）`), { status: response.status });
      return (await response.json()).changed_days;
    };
    const days = await read('shop');
    const breakdown = dimension === 'none' ? [] : await read(`shop_${dimension}`);
    for (const day of days) {
      const row = day.payload.rows.find(item => item.dim_key === storeKey);
      if (!row || day.payload.snapshot_status === 'missing') continue;
      const amount = totals(row);
      const parts = Object.fromEntries((breakdown.find(item => item.date === day.date)?.payload.rows || [])
        .filter(item => item.dim_key.startsWith(`${storeKey}|`))
        .map(item => [item.dim_key.slice(storeKey.length + 1), totals(item)]));
      result.push({ ...amount, date: day.date, complete: day.payload.snapshot_status === 'ready', stores: {
        [storeKey]: { ...amount, store_key: storeKey, store_label: row.dim_label,
          ...(dimension === 'channel' ? { source_totals: parts } : dimension === 'platform' ? { platform_totals: parts } : {}) },
      } });
    }
    cursor = end.add(1, 'day');
  }
  return result;
}
