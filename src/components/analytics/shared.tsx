import { useState, type ReactNode } from 'react';
import { Button, ConfigProvider, DatePicker } from 'antd';
import { Button as MobileButton, Calendar, Popup } from 'antd-mobile';
import zhCN from 'antd/locale/zh_CN';
import dayjs from 'dayjs';
import { currentBeijingDate, shiftBeijingDate } from '../../utils/time';

export const inputCls = 'rounded-lg border border-slate-200 px-2 py-1.5 text-sm';
export const searchableSelectProps = { showSearch: true, optionFilterProp: 'label' };
export const pad = (n: number) => String(n).padStart(2, '0');
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const yesterday = () => {
  return parseYmd(shiftBeijingDate(currentBeijingDate(), -1));
};
export const daysAgo = (days: number) => {
  return shiftBeijingDate(currentBeijingDate(), -days);
};
export const FUTURE_DATE_MESSAGE = '当前只能查看截至昨日的数据，无法查看后续日期。';
export function parseYmd(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThu = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThu.getTime()) / 86400000 - 3 + ((firstThu.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${pad(week)}`;
}

export function periodKey(g: string, anchor: Date): string {
  if (g === 'month') return `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`;
  if (g === 'week') return isoWeekKey(anchor);
  return ymd(anchor);
}

export function weekRange(anchor: Date): [Date, Date] {
  const start = new Date(anchor);
  const dayNum = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - dayNum);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return [start, end];
}

export function periodLabel(g: string, period: string, anchor: Date): string {
  if (g !== 'week') return period;
  const [start, end] = weekRange(anchor);
  return `${period}（${pad(start.getMonth() + 1)}/${pad(start.getDate())} - ${pad(end.getMonth() + 1)}/${pad(end.getDate())}）`;
}

export function periodHint(g: string, anchor: Date): string {
  if (g !== 'week') return '';
  const [start, end] = weekRange(anchor);
  return `本周范围：${ymd(start)} 至 ${ymd(end)}`;
}

export function periodDateRange(g: string, anchor: Date): [string, string] {
  if (g === 'week') {
    const [start, end] = weekRange(anchor);
    return [ymd(start), ymd(end)];
  }
  if (g === 'month') {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return [ymd(start), ymd(end)];
  }
  return [ymd(anchor), ymd(anchor)];
}

export function canViewPeriod(g: string, anchor: Date, allowToday = false): boolean {
  const [start] = periodDateRange(g, anchor);
  return start <= daysAgo(allowToday ? 0 : 1);
}

export function isFutureDate(value: string): boolean {
  return value > daysAgo(1);
}

export function isFutureRange(from: string, to: string): boolean {
  return isFutureDate(from) || isFutureDate(to);
}

export function shiftAnchor(g: string, anchor: Date, delta: number): Date {
  const d = new Date(anchor);
  if (g === 'week') d.setDate(d.getDate() + 7 * delta);
  else if (g === 'month') d.setMonth(d.getMonth() + delta);
  else d.setDate(d.getDate() + delta);
  return d;
}

export function periodIncludesToday(g: string, anchor: Date): boolean {
  if (g !== 'week' && g !== 'month') return false;
  const today = currentBeijingDate();
  const [start, end] = periodDateRange(g, anchor);
  return start <= today && today <= end;
}

export function orderPeriodNote(g: string, anchor: Date, excludeToday: boolean): string {
  if (g === 'week') {
    const base = periodHint(g, anchor);
    return excludeToday ? `${base}；当前周默认统计至昨日，不包含今天。` : base;
  }
  if (g === 'month' && excludeToday) return '当前月默认统计至昨日，不包含今天。';
  return '';
}

export const yuan = (n: number) => `¥${n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const compactYuan = (n: number) => Math.abs(n) >= 10000 ? `¥${(n / 10000).toFixed(1)}万` : yuan(n);
export const pct = (n: number) => `${Math.round(n * 100)}%`;
export const FORECAST_ASSET_LABELS: Record<string, string> = {
  order_history: '历史订单',
  calendar: '节假日',
  weather: '天气',
  trade_area: '商圈',
  product: '产品结构',
  labor: '人效',
  platform: '平台结构',
  channel: '渠道结构',
  activity: '活动',
  knowledge_feedback: '知识反馈',
};

export function displayInsightContent(value: string): string {
  const raw = String(value || '').trim();
  if (!raw.startsWith('{')) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.content_md === 'string') {
      return parsed.content_md.trim();
    }
  } catch {
    const match = raw.match(/"content_md"\s*:\s*"((?:\\.|[^"\\])*)"/s);
    if (match?.[1]) {
      try {
        return JSON.parse(`"${match[1]}"`).trim();
      } catch {
        return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim();
      }
    }
  }
  return raw;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function Card({ children }: { children: ReactNode }) {
  return <div className="bg-white rounded-lg border border-slate-200 p-4 md:p-5">{children}</div>;
}

export function MobileInlineFilter({
  summary,
  open,
  onToggle,
  children,
}: {
  summary: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-4 md:hidden">
      <div className="mb-2 flex items-center justify-between gap-2">
        <button
          type="button"
          className="flex h-9 items-center gap-1 text-sm font-medium text-slate-700"
          onClick={onToggle}
          aria-expanded={open}
        >
          筛选条件
          <span className="text-xs text-slate-400">{open ? '收起' : '展开'}</span>
        </button>
        <div className="truncate text-[11px] tabular-nums text-slate-400">{summary}</div>
      </div>
      {open ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
          <div className="space-y-2">{children}</div>
        </div>
      ) : null}
    </div>
  );
}

export type MobileQuickRange = { label: string; from: string; to: string };
export type DesktopQuickRange = { label: ReactNode; from: string; to: string };

export function clampToPastDate(value: string): string {
  const lastSelectableDate = daysAgo(1);
  return value > lastSelectableDate ? lastSelectableDate : value;
}

export function normalizePastRange(from: string, to: string): [string, string] {
  const safeFrom = clampToPastDate(from);
  const safeTo = clampToPastDate(to);
  return safeFrom <= safeTo ? [safeFrom, safeTo] : [safeTo, safeFrom];
}

export function DesktopDateRangePicker({
  dateFrom,
  dateTo,
  onChange,
  presets,
  className = 'w-full sm:w-auto',
}: {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
  presets?: DesktopQuickRange[];
  className?: string;
}) {
  const [safeFrom, safeTo] = normalizePastRange(dateFrom, dateTo);
  const todayStart = dayjs(currentBeijingDate()).startOf('day');
  const commitRange = (from: string, to: string) => {
    const next = normalizePastRange(from, to);
    onChange(next[0], next[1]);
  };

  return (
    <ConfigProvider locale={zhCN}>
      <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
        <DatePicker
          key={`start:${safeFrom}`}
          allowClear={false}
          inputReadOnly
          needConfirm
          format="YYYY-MM-DD"
          defaultValue={dayjs(safeFrom)}
          disabledDate={(current) => Boolean(current && !current.isBefore(todayStart, 'day'))}
          className="w-[8.75rem]"
          placeholder="开始日期"
          onOk={(value) => {
            if (value) commitRange(value.format('YYYY-MM-DD'), safeTo);
          }}
        />
        <span className="text-xs text-slate-400">至</span>
        <DatePicker
          key={`end:${safeTo}`}
          allowClear={false}
          inputReadOnly
          needConfirm
          format="YYYY-MM-DD"
          defaultValue={dayjs(safeTo)}
          disabledDate={(current) => Boolean(current && !current.isBefore(todayStart, 'day'))}
          className="w-[8.75rem]"
          placeholder="结束日期"
          onOk={(value) => {
            if (value) commitRange(safeFrom, value.format('YYYY-MM-DD'));
          }}
        />
        {presets?.map((range, index) => (
          <Button
            key={`${range.from}_${range.to}_${index}`}
            autoInsertSpace={false}
            size="small"
            className="h-8 rounded-lg px-2 text-xs"
            onClick={() => commitRange(range.from, range.to)}
          >
            {range.label}
          </Button>
        ))}
      </div>
    </ConfigProvider>
  );
}

export function MobileDatePopup({
  value,
  onChange,
  label = '日期',
  title = '选择日期',
  hint,
  allowToday = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  title?: string;
  hint?: string;
  allowToday?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const latestDate = daysAgo(allowToday ? 0 : 1);
  const clampDate = (date: string) => date > latestDate ? latestDate : date;
  const safeValue = clampDate(value);
  const [draftValue, setDraftValue] = useState(safeValue);

  return (
    <>
      <button
        type="button"
        className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-left text-sm tabular-nums text-slate-700 active:bg-slate-50"
        onClick={() => {
          setDraftValue(safeValue);
          setOpen(true);
        }}
      >
        <span className="mr-1 text-slate-400">{label}</span>{safeValue}
      </button>
      <Popup
        visible={open}
        onMaskClick={() => setOpen(false)}
        position="bottom"
        bodyClassName="dashboard-range-popup"
        closeOnMaskClick
        destroyOnClose
      >
        <div className="dashboard-range-popup-body">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">{title}</div>
              <div className="mt-0.5 text-xs tabular-nums text-slate-400">{hint || draftValue}</div>
            </div>
            <button type="button" className="rounded-lg px-2 py-1 text-xs text-slate-500 active:bg-slate-100" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
          <Calendar
            selectionMode="single"
            value={parseYmd(draftValue)}
            max={parseYmd(latestDate)}
            shouldDisableDate={(date) => ymd(date) > latestDate}
            onChange={(date) => {
              if (date) setDraftValue(clampDate(ymd(date)));
            }}
          />
          <div className="border-t border-slate-100 p-3">
            <MobileButton block color="primary" onClick={() => {
              onChange(draftValue);
              setOpen(false);
            }}>
              确定
            </MobileButton>
          </div>
        </div>
      </Popup>
    </>
  );
}

export function MobileDateRangePopup({
  dateFrom,
  dateTo,
  onChange,
  quickRanges,
  loading,
  onRefresh,
}: {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
  quickRanges: MobileQuickRange[];
  loading?: boolean;
  onRefresh?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const todayStart = dayjs().startOf('day');
  const [safeFrom, safeTo] = normalizePastRange(dateFrom, dateTo);
  const [draftRange, setDraftRange] = useState<[string, string]>([safeFrom, safeTo]);
  const applyRange = (from: string, to: string) => {
    const [nextFrom, nextTo] = normalizePastRange(from, to);
    onChange(nextFrom, nextTo);
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-left text-sm tabular-nums text-slate-700 active:bg-slate-50"
        onClick={() => {
          setDraftRange([safeFrom, safeTo]);
          setOpen(true);
        }}
      >
        <span className="mr-1 text-slate-400">区间</span>{safeFrom.slice(5)} 至 {safeTo.slice(5)}
      </button>
      <div className={`grid gap-2 ${onRefresh ? 'grid-cols-4' : 'grid-cols-3'}`}>
        {quickRanges.map(range => (
          <MobileButton
            key={range.label}
            size="small"
            fill="outline"
            className="dashboard-mobile-button"
            onClick={() => {
              applyRange(range.from, range.to);
              setOpen(false);
            }}
          >
            {range.label}
          </MobileButton>
        ))}
        {onRefresh ? (
          <MobileButton
            size="small"
            color="primary"
            loading={loading}
            className="dashboard-mobile-button"
            onClick={onRefresh}
          >
            刷新
          </MobileButton>
        ) : null}
      </div>
      <Popup
        visible={open}
        onMaskClick={() => setOpen(false)}
        position="bottom"
        bodyClassName="dashboard-range-popup"
        closeOnMaskClick
        destroyOnClose
      >
        <div className="dashboard-range-popup-body">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">选择日期区间</div>
              <div className="mt-0.5 text-xs tabular-nums text-slate-400">{draftRange[0]} 至 {draftRange[1]}</div>
            </div>
            <button type="button" className="rounded-lg px-2 py-1 text-xs text-slate-500 active:bg-slate-100" onClick={() => setOpen(false)}>
              关闭
            </button>
          </div>
          <MobileRangeCalendar
            dateFrom={draftRange[0]}
            dateTo={draftRange[1]}
            max={todayStart.toDate()}
            shouldDisableDate={(date) => !dayjs(date).isBefore(todayStart, 'day')}
            onChange={(from, to) => setDraftRange([from, to])}
          />
          <div className="border-t border-slate-100 p-3">
            <MobileButton block color="primary" onClick={() => {
              applyRange(draftRange[0], draftRange[1]);
              setOpen(false);
            }}>
              确定
            </MobileButton>
          </div>
        </div>
      </Popup>
    </div>
  );
}

export function MobileRangeCalendar({
  dateFrom,
  dateTo,
  onChange,
  max,
  shouldDisableDate,
  ariaLabel,
}: {
  dateFrom: string;
  dateTo: string;
  onChange: (from: string, to: string) => void;
  max?: Date;
  shouldDisableDate?: (date: Date) => boolean;
  ariaLabel?: string;
}) {
  return (
    <div aria-label={ariaLabel}>
      <Calendar
        key={`range:${dateFrom}:${dateTo}`}
        selectionMode="range"
        defaultValue={[parseYmd(dateFrom), parseYmd(dateTo)]}
        max={max}
        shouldDisableDate={shouldDisableDate}
        onChange={(range) => {
          if (range) onChange(ymd(range[0]), ymd(range[1]));
        }}
      />
    </div>
  );
}

export function MobileField({ label, value, tone = 'default' }: { label: string; value: ReactNode; tone?: 'default' | 'strong' | 'warning' }) {
  const valueClass = tone === 'strong' ? 'font-semibold text-slate-900' : tone === 'warning' ? 'font-medium text-amber-600' : 'font-medium text-slate-700';
  return (
    <div className="min-w-0">
      <div className="text-[11px] text-slate-400">{label}</div>
      <div className={`mt-0.5 truncate text-sm tabular-nums ${valueClass}`}>{value}</div>
    </div>
  );
}
