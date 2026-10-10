import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import isoWeek from 'dayjs/plugin/isoWeek';

dayjs.extend(isoWeek);

export type TrendGranularity = 'day' | 'week' | 'month';

export type TrendMovingAverageMeta = {
  field: string;
  label: string;
  window: number;
  available: boolean;
  available_periods: number;
};

export type TrendRange = {
  dateFrom: string;
  dateTo: string;
  includeCurrent: boolean;
};

export type DetailPeriodOption = {
  key: string;
  label: string;
  dateFrom: string;
  dateTo: string;
};

export function trendPointStatusText(point?: { in_progress?: boolean; missing?: boolean }): string | null {
  const statuses = [
    point?.in_progress ? '进行中' : null,
    point?.missing ? '数据不完整' : null,
  ].filter(Boolean);
  return statuses.length ? statuses.join(' · ') : null;
}

type TrendDate = string | Dayjs;

export function defaultTrendRange(granularity: TrendGranularity, todayYmd: string, allowToday = false): TrendRange {
  const today = dayjs(todayYmd);
  if (granularity === 'week') {
    const end = today.startOf('isoWeek').subtract(1, 'day');
    return {
      dateFrom: end.subtract(4, 'week').startOf('isoWeek').format('YYYY-MM-DD'),
      dateTo: end.format('YYYY-MM-DD'),
      includeCurrent: false,
    };
  }
  if (granularity === 'month') {
    const end = today.startOf('month').subtract(1, 'day');
    return {
      dateFrom: end.subtract(4, 'month').startOf('month').format('YYYY-MM-DD'),
      dateTo: end.format('YYYY-MM-DD'),
      includeCurrent: false,
    };
  }
  return {
    dateFrom: today.subtract(10, 'day').format('YYYY-MM-DD'),
    dateTo: today.subtract(allowToday ? 0 : 1, 'day').format('YYYY-MM-DD'),
    includeCurrent: allowToday,
  };
}

export function trendHistoryStart(granularity: TrendGranularity, dateFrom: string): string {
  const start = dayjs(dateFrom);
  if (granularity === 'week') return start.startOf('isoWeek').subtract(25, 'week').format('YYYY-MM-DD');
  if (granularity === 'month') return start.startOf('month').subtract(11, 'month').format('YYYY-MM-DD');
  return start.subtract(179, 'day').format('YYYY-MM-DD');
}

export function buildDetailPeriodOptions(
  granularity: TrendGranularity,
  dateFrom: string,
  dateTo: string,
): DetailPeriodOption[] {
  const rangeStart = dayjs(dateFrom).startOf('day');
  const rangeEnd = dayjs(dateTo).startOf('day');
  if (!rangeStart.isValid() || !rangeEnd.isValid() || rangeEnd.isBefore(rangeStart, 'day')) return [];

  const options: DetailPeriodOption[] = [];
  let cursor = granularity === 'week'
    ? rangeStart.startOf('isoWeek')
    : granularity === 'month'
      ? rangeStart.startOf('month')
      : rangeStart;

  while (!cursor.isAfter(rangeEnd, 'day')) {
    const naturalEnd = granularity === 'week'
      ? cursor.endOf('isoWeek')
      : granularity === 'month'
        ? cursor.endOf('month')
        : cursor;
    const periodStart = cursor.isBefore(rangeStart, 'day') ? rangeStart : cursor;
    const periodEnd = naturalEnd.isAfter(rangeEnd, 'day') ? rangeEnd : naturalEnd;
    const startYmd = periodStart.format('YYYY-MM-DD');
    const endYmd = periodEnd.format('YYYY-MM-DD');
    options.push({
      key: granularity === 'month' ? cursor.format('YYYY-MM') : cursor.format('YYYY-MM-DD'),
      label: granularity === 'month'
        ? cursor.format('YYYY年MM月')
        : granularity === 'week'
          ? `${startYmd} 至 ${endYmd}`
          : startYmd,
      dateFrom: startYmd,
      dateTo: endYmd,
    });
    cursor = granularity === 'week'
      ? cursor.add(1, 'week')
      : granularity === 'month'
        ? cursor.add(1, 'month')
        : cursor.add(1, 'day');
  }
  return options;
}

export function normalizeTrendRange(
  granularity: TrendGranularity,
  dateFrom: TrendDate,
  dateTo: TrendDate,
  includeCurrent: boolean,
  todayYmd: string,
  allowToday = false,
): [string, string] {
  const today = dayjs(todayYmd);
  const latestDay = today.subtract(allowToday ? 0 : 1, 'day');
  let start = dayjs(dateFrom);
  let end = dayjs(dateTo);

  if (granularity === 'week') {
    start = start.startOf('isoWeek');
    end = end.endOf('isoWeek');
    const latest = includeCurrent ? latestDay : today.startOf('isoWeek').subtract(1, 'day');
    if (end.isAfter(latest)) end = latest;
  } else if (granularity === 'month') {
    start = start.startOf('month');
    end = end.endOf('month');
    const latest = includeCurrent ? latestDay : today.startOf('month').subtract(1, 'day');
    if (end.isAfter(latest)) end = latest;
  } else if (end.isAfter(latestDay)) {
    end = latestDay;
  }

  if (granularity !== 'day' && end.isBefore(start)) {
    start = granularity === 'week' ? end.startOf('isoWeek') : end.startOf('month');
  }

  return [start.format('YYYY-MM-DD'), end.format('YYYY-MM-DD')];
}

export function toggleCurrentPeriod(
  granularity: TrendGranularity,
  range: Pick<TrendRange, 'dateFrom' | 'dateTo'>,
  includeCurrent: boolean,
  todayYmd: string,
  allowToday = false,
): TrendRange {
  if (granularity === 'day') {
    const [, dateTo] = normalizeTrendRange('day', range.dateFrom, range.dateTo, includeCurrent, todayYmd, allowToday);
    return { ...range, dateTo, includeCurrent };
  }

  const today = dayjs(todayYmd);
  const currentStart = granularity === 'week' ? today.startOf('isoWeek') : today.startOf('month');
  const dateTo = includeCurrent
    ? today.subtract(allowToday ? 0 : 1, 'day')
    : dayjs(range.dateTo).isBefore(currentStart)
      ? dayjs(range.dateTo)
      : currentStart.subtract(1, 'day');
  return { ...range, dateTo: dateTo.format('YYYY-MM-DD'), includeCurrent };
}
