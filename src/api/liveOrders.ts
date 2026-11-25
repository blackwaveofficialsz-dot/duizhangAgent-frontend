import { apiFetch } from './client';

type AmountAvailability = { status: string; basis?: string; reasons?: string[] };
export type LiveOrdersSummary = {
  data: {
    basis: string;
    provisional: boolean;
    sale_order_count: number | null;
    received_verified_paid_net: string | null;
  };
  received_amount_availability: AmountAvailability;
  freshness: {
    observed_at: string;
    last_received_at: string | null;
    last_applied_event_at?: string | null;
    status: string;
  };
  coverage: {
    status: string;
    pending_count?: number;
    quarantined_count?: number;
    unrouted_scope_status?: string;
  };
};

export async function fetchLiveOrdersSummary({ date, storeKeys = [], signal }: {
  date: string;
  storeKeys?: readonly string[];
  signal?: AbortSignal;
}): Promise<LiveOrdersSummary> {
  const params = new URLSearchParams({ date_from: date, date_to: date });
  [...new Set(storeKeys.filter(Boolean))].sort().forEach(key => params.append('store_keys', key));
  const response = await apiFetch(`/api/v1/analytics/orders/live/summary?${params}`, { signal, cache: 'no-store' });
  if (!response.ok) {
    let message = `已接收订单读取失败（${response.status}）`;
    try {
      const body = await response.json();
      if (typeof body.detail === 'string') message = body.detail;
    } catch { /* Keep the status-based error when no JSON body is available. */ }
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json();
}
