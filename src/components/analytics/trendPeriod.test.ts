import { describe, expect, it } from 'vitest';
import {
  buildDetailPeriodOptions,
  defaultTrendRange,
  normalizeTrendRange,
  trendHistoryStart,
  toggleCurrentPeriod,
} from './trendPeriod';

describe('trend period', () => {
  it('returns five completed weeks by default', () => {
    expect(defaultTrendRange('week', '2026-07-20')).toEqual({
      dateFrom: '2026-06-15',
      dateTo: '2026-07-19',
      includeCurrent: false,
    });
  });

  it('returns five completed months by default', () => {
    expect(defaultTrendRange('month', '2026-07-20')).toEqual({
      dateFrom: '2026-02-01',
      dateTo: '2026-06-30',
      includeCurrent: false,
    });
  });

  it('returns ten completed days by default', () => {
    expect(defaultTrendRange('day', '2026-07-20')).toEqual({
      dateFrom: '2026-07-10',
      dateTo: '2026-07-19',
      includeCurrent: false,
    });
  });

  it('expands the calculation range to cover the longest moving average', () => {
    expect(trendHistoryStart('day', '2026-08-02')).toBe('2026-02-04');
    expect(trendHistoryStart('week', '2026-07-13')).toBe('2026-01-19');
    expect(trendHistoryStart('month', '2026-08-01')).toBe('2025-09-01');
  });

  it('adds the current period only through yesterday', () => {
    expect(toggleCurrentPeriod(
      'week',
      { dateFrom: '2026-06-15', dateTo: '2026-07-19' },
      true,
      '2026-07-20',
    )).toEqual({ dateFrom: '2026-06-15', dateTo: '2026-07-19', includeCurrent: true });

    expect(toggleCurrentPeriod(
      'week',
      { dateFrom: '2026-06-15', dateTo: '2026-07-19' },
      true,
      '2026-07-22',
    )).toEqual({ dateFrom: '2026-06-15', dateTo: '2026-07-21', includeCurrent: true });
  });

  it('normalizes ISO weeks and calendar months without future dates', () => {
    expect(normalizeTrendRange('week', '2026-07-14', '2026-07-16', false, '2026-07-20'))
      .toEqual(['2026-07-13', '2026-07-19']);
    expect(normalizeTrendRange('month', '2026-05-12', '2026-06-03', false, '2026-07-20'))
      .toEqual(['2026-05-01', '2026-06-30']);
    expect(normalizeTrendRange('month', '2026-06-12', '2026-07-20', true, '2026-07-20'))
      .toEqual(['2026-06-01', '2026-07-19']);
  });

  it('falls back to the previous complete week when Monday has no current-week data', () => {
    expect(normalizeTrendRange('week', '2026-07-20', '2026-07-20', true, '2026-07-20'))
      .toEqual(['2026-07-13', '2026-07-19']);
  });

  it('falls back to the previous complete month on the first day of a month', () => {
    expect(normalizeTrendRange('month', '2026-08-01', '2026-08-01', true, '2026-08-01'))
      .toEqual(['2026-07-01', '2026-07-31']);
  });

  it('builds selectable daily detail periods and keeps the latest last', () => {
    const periods = buildDetailPeriodOptions('day', '2026-07-10', '2026-07-19');

    expect(periods).toHaveLength(10);
    expect(periods[0]).toEqual({
      key: '2026-07-10',
      label: '2026-07-10',
      dateFrom: '2026-07-10',
      dateTo: '2026-07-10',
    });
    expect(periods[periods.length - 1]).toEqual({
      key: '2026-07-19',
      label: '2026-07-19',
      dateFrom: '2026-07-19',
      dateTo: '2026-07-19',
    });
  });

  it('builds ISO-week detail periods including a partial current week', () => {
    expect(buildDetailPeriodOptions('week', '2026-06-15', '2026-07-19')).toEqual([
      { key: '2026-06-15', label: '2026-06-15 至 2026-06-21', dateFrom: '2026-06-15', dateTo: '2026-06-21' },
      { key: '2026-06-22', label: '2026-06-22 至 2026-06-28', dateFrom: '2026-06-22', dateTo: '2026-06-28' },
      { key: '2026-06-29', label: '2026-06-29 至 2026-07-05', dateFrom: '2026-06-29', dateTo: '2026-07-05' },
      { key: '2026-07-06', label: '2026-07-06 至 2026-07-12', dateFrom: '2026-07-06', dateTo: '2026-07-12' },
      { key: '2026-07-13', label: '2026-07-13 至 2026-07-19', dateFrom: '2026-07-13', dateTo: '2026-07-19' },
    ]);
    const partialWeekPeriods = buildDetailPeriodOptions('week', '2026-07-13', '2026-07-21');
    expect(partialWeekPeriods[partialWeekPeriods.length - 1]).toEqual({
      key: '2026-07-20',
      label: '2026-07-20 至 2026-07-21',
      dateFrom: '2026-07-20',
      dateTo: '2026-07-21',
    });
  });

  it('builds calendar-month detail periods and returns none for an invalid range', () => {
    expect(buildDetailPeriodOptions('month', '2026-05-01', '2026-07-31')).toEqual([
      { key: '2026-05', label: '2026年05月', dateFrom: '2026-05-01', dateTo: '2026-05-31' },
      { key: '2026-06', label: '2026年06月', dateFrom: '2026-06-01', dateTo: '2026-06-30' },
      { key: '2026-07', label: '2026年07月', dateFrom: '2026-07-01', dateTo: '2026-07-31' },
    ]);
    expect(buildDetailPeriodOptions('month', '2026-08-01', '2026-07-31')).toEqual([]);
  });
});


describe('realtime order ranges', () => {
  it('opts into today without changing historical consumers', () => {
    expect(defaultTrendRange('day', '2026-10-10', true))
      .toEqual({ dateFrom: '2026-09-30', dateTo: '2026-10-10', includeCurrent: true });
    expect(defaultTrendRange('day', '2026-10-10').dateTo).toBe('2026-10-09');
    expect(normalizeTrendRange('day', '2026-10-01', '2026-10-11', true, '2026-10-10', true))
      .toEqual(['2026-10-01', '2026-10-10']);
    expect(normalizeTrendRange('week', '2026-10-05', '2026-10-11', true, '2026-10-10', true))
      .toEqual(['2026-10-05', '2026-10-10']);
    expect(toggleCurrentPeriod('month', { dateFrom: '2026-09-01', dateTo: '2026-09-30' }, true, '2026-10-10', true).dateTo)
      .toBe('2026-10-10');
  });
});
