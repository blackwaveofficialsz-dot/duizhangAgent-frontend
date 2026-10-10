import { useMemo, useState } from 'react';
import { Checkbox, ConfigProvider, DatePicker, Segmented } from 'antd';
import { Button as MobileButton, Popup } from 'antd-mobile';
import zhCN from 'antd/locale/zh_CN';
import dayjs, { type Dayjs } from 'dayjs';
import { MobileRangeCalendar } from './shared';
import { normalizeTrendRange, toggleCurrentPeriod, type TrendGranularity } from './trendPeriod';

type Props = {
  granularity: TrendGranularity;
  dateFrom: string;
  dateTo: string;
  includeCurrent: boolean;
  onGranularityChange: (value: TrendGranularity) => void;
  onRangeChange: (dateFrom: string, dateTo: string) => void;
  onIncludeCurrentChange: (value: boolean) => void;
  fullscreen?: boolean;
  todayYmd?: string;
  allowToday?: boolean;
};

const granularityOptions = [
  { label: '日', value: 'day' },
  { label: '周', value: 'week' },
  { label: '月', value: 'month' },
];

function beijingTodayYmd(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

export function TrendPeriodControls({
  granularity,
  dateFrom,
  dateTo,
  includeCurrent,
  onGranularityChange,
  onRangeChange,
  onIncludeCurrentChange,
  fullscreen = false,
  todayYmd = beijingTodayYmd(),
  allowToday = false,
}: Props) {
  const [open, setOpen] = useState(false);
  const pickerValue = useMemo<[Dayjs, Dayjs]>(() => [dayjs(dateFrom), dayjs(dateTo)], [dateFrom, dateTo]);
  const [mobileDraft, setMobileDraft] = useState<[string, string]>([dateFrom, dateTo]);
  const applyRange = (from: string | Dayjs, to: string | Dayjs) => {
    const [nextFrom, nextTo] = normalizeTrendRange(
      granularity, from, to, includeCurrent, todayYmd, allowToday,
    );
    onRangeChange(nextFrom, nextTo);
  };
  const disabledDate = (current: Dayjs) => {
    const selected = current.format('YYYY-MM-DD');
    const [allowedFrom, allowedTo] = normalizeTrendRange(
      granularity, current, current, includeCurrent, todayYmd, allowToday,
    );
    return selected < allowedFrom || selected > allowedTo;
  };
  const calendar = (
    <MobileRangeCalendar
      ariaLabel="趋势日期区间日历"
      dateFrom={fullscreen ? dateFrom : mobileDraft[0]}
      dateTo={fullscreen ? dateTo : mobileDraft[1]}
      shouldDisableDate={date => disabledDate(dayjs(date))}
      onChange={fullscreen
        ? applyRange
        : (from, to) => setMobileDraft([from, to])}
    />
  );

  return (
    <ConfigProvider locale={zhCN}>
      <div
        data-testid="trend-period-controls"
        className={fullscreen
          ? "min-w-0 space-y-2"
          : "min-w-0 space-y-2 md:flex md:flex-1 md:flex-row md:items-center md:gap-2 md:space-y-0"}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">
          <Segmented
            aria-label="趋势粒度"
            options={granularityOptions}
            value={granularity}
            onChange={value => onGranularityChange(value as TrendGranularity)}
          />
          {granularity !== 'day' ? (
            <Checkbox
              checked={includeCurrent}
              onChange={event => {
                const next = toggleCurrentPeriod(
                  granularity,
                  { dateFrom, dateTo },
                  event.target.checked,
                  todayYmd,
                  allowToday,
                );
                onIncludeCurrentChange(next.includeCurrent);
                onRangeChange(next.dateFrom, next.dateTo);
              }}
            >
              含当前{granularity === 'week' ? '周' : '月'}（截至{allowToday ? '今日' : '昨日'}）
            </Checkbox>
          ) : null}
        </div>

        {fullscreen ? (
          calendar
        ) : (
          <>
            <DatePicker.RangePicker
              aria-label="趋势日期区间"
              value={pickerValue}
              picker={granularity === 'day' ? 'date' : granularity}
              format="YYYY-MM-DD"
              allowClear={false}
              inputReadOnly
              needConfirm
              disabledDate={disabledDate}
              className="hidden min-w-[18rem] flex-1 md:flex"
              onOk={dates => {
                if (dates?.[0] && dates[1]) applyRange(dates[0], dates[1]);
              }}
            />
            <div className="md:hidden">
              <button
                type="button"
                aria-label="选择趋势周期"
                className="h-10 w-full min-w-0 truncate rounded-lg border border-slate-200 bg-white px-3 text-left text-sm tabular-nums text-slate-700 active:bg-slate-50"
                onClick={() => {
                  setMobileDraft([dateFrom, dateTo]);
                  setOpen(true);
                }}
              >
                <span className="mr-1 text-slate-400">区间</span>{dateFrom} 至 {dateTo}
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
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">选择趋势区间</div>
                      <div className="mt-0.5 truncate text-xs tabular-nums text-slate-400">
                        {mobileDraft[0]} 至 {mobileDraft[1]}
                      </div>
                    </div>
                    <button type="button" className="shrink-0 rounded-lg px-2 py-1 text-xs text-slate-500 active:bg-slate-100" onClick={() => setOpen(false)}>
                      关闭
                    </button>
                  </div>
                  {calendar}
                  <div className="border-t border-slate-100 p-3">
                    <MobileButton block color="primary" onClick={() => {
                      applyRange(mobileDraft[0], mobileDraft[1]);
                      setOpen(false);
                    }}>确定</MobileButton>
                  </div>
                </div>
              </Popup>
            </div>
          </>
        )}
      </div>
    </ConfigProvider>
  );
}
