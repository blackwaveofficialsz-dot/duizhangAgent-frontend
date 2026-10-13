import { useEffect, useRef, useState } from 'react';
import { RightOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Radio, Table, notification, type TableColumnsType } from 'antd';

import { isQuestionnairePart, type AgentResponseAction, type AgentResponsePart, type AgentResponsePayload, type ChatInteraction, type ClarificationAnswer, type QuestionnairePart } from '../types';
import { useIsMobile } from '../hooks/useIsMobile';
import { useTableTypewriter, useTypewriter } from '../hooks/useTypewriter';
import { formatDisplayValue } from '../utils/displayValue';
import { parseBeijingTime } from '../utils/time';
import { TableDisplayFrame, type TableDisplayData } from './TableDisplayFrame';

const MOBILE_PREVIEW_ROW_LIMIT = 3;
const DESKTOP_PREVIEW_ROW_LIMIT = 10;
const UNIT_LABELS: Record<string, string> = {
  order: '单',
  store: '家',
  hour: '小时',
  period: '期',
  product: '种',
  item: '件',
  person: '人',
};

const RESULT_STATUS_LABELS: Partial<Record<AgentResponsePayload['result_status'], string>> = {
  partial: '部分结果可用',
  needs_confirmation: '需要确认',
  empty: '暂无可用数据',
  unavailable: '数据暂不可用',
  failed: '分析失败',
};

const COMPARISON_STATUS_LABELS: Record<string, string> = {
  comparable: '可比',
  not_comparable: '不可比',
};

type ResponsePartsRendererProps = {
  response: AgentResponsePayload;
  onPrompt?: (message: string) => Promise<void>;
  onAction?: (action: AgentResponseAction) => Promise<void>;
  onInteraction?: (interaction: ChatInteraction) => Promise<void>;
  promptDisabled?: boolean;
  questionnaireDisabled?: boolean;
  animate?: boolean;
  streaming?: boolean;
  animateInsights?: boolean;
};

type TableRow = Record<string, unknown> & { __rowKey: string };
type ResponseColumn = NonNullable<AgentResponsePart['columns']>[number];

export function formatDecimalForDisplay(value: string, unit?: string): string {
  const [integer, fraction = ''] = value.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const normalized = fraction ? `${grouped}.${fraction}` : grouped;
  return unit?.toLowerCase() === 'cny' ? `¥${normalized}` : normalized;
}

function displayDecimal(value: string, unit?: string): string {
  if (!unit) return formatDecimalForDisplay(value);
  const normalizedUnit = unit.toLowerCase();
  if (normalizedUnit === 'cny') return formatDecimalForDisplay(value, normalizedUnit);
  if (normalizedUnit === 'cny/hour' || normalizedUnit === 'cny_per_hour') {
    return `${formatDecimalForDisplay(value, 'cny')}/工时`;
  }
  if (normalizedUnit === 'ratio') {
    const ratio = Number(value);
    if (Number.isFinite(ratio)) return `${(ratio * 100).toFixed(1).replace(/\.0$/, '')}%`;
  }
  const unitLabel = UNIT_LABELS[normalizedUnit];
  if (unitLabel) return `${formatDecimalForDisplay(value)}${unitLabel}`;
  console.warn('[AgentResponse] unsupported display unit');
  return formatDecimalForDisplay(value);
}

function tableColumns(part: AgentResponsePart): ResponseColumn[] {
  if (part.columns?.length) return part.columns;
  return Object.keys(part.preview_rows?.[0] ?? {}).map((key) => ({ key, label: key }));
}

function tableCell(value: unknown, column: ResponseColumn): string {
  if (value == null || (typeof value === 'string' && value.trim() === '')) return '—';
  if (column.key === 'comparison_status' && typeof value === 'string') {
    const label = COMPARISON_STATUS_LABELS[value];
    if (label) return label;
    console.warn('[AgentResponse] unsupported comparison state');
    return '未知';
  }
  if (
    (column.data_type === 'decimal' || column.data_type === 'integer')
    && (typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
  ) return displayDecimal(String(value), column.unit);
  return typeof value === 'string' ? formatDisplayValue(value) : String(value);
}

function TablePart({
  part,
  expandable,
  tableKey,
  animate,
  streaming,
  startOnMount,
}: {
  part: AgentResponsePart;
  expandable: boolean;
  tableKey: string;
  animate: boolean;
  streaming: boolean;
  startOnMount: boolean;
}) {
  const isMobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const rows = part.preview_rows ?? [];
  const columns = tableColumns(part);
  const collapsedRowLimit = isMobile ? MOBILE_PREVIEW_ROW_LIMIT : DESKTOP_PREVIEW_ROW_LIMIT;
  const canToggleRows = expandable && rows.length > collapsedRowLimit;
  const targetRows = canToggleRows && !expanded ? rows.slice(0, collapsedRowLimit) : rows;
  const playback = useTableTypewriter(targetRows.length, animate && !expanded, streaming, startOnMount, startOnMount ? 160 : 96);
  const visibleRows = targetRows.slice(0, playback.count);
  const hasCompleteRows = typeof part.row_count !== 'number' || part.row_count <= rows.length;
  const rowCountLabel = playback.isTyping
    ? `正在逐行展示 ${visibleRows.length} / ${targetRows.length} 行`
    : canToggleRows
    ? expanded
      ? hasCompleteRows ? `已展开全部 ${visibleRows.length} 行` : `已展开预览 ${visibleRows.length} 行，共 ${part.row_count} 行`
      : hasCompleteRows ? `默认展示前 ${visibleRows.length} 行，共 ${rows.length} 行` : `当前仅预览 ${visibleRows.length} 行，共 ${part.row_count} 行`
    : typeof part.row_count === 'number'
      ? hasCompleteRows ? `${part.row_count} 行` : `当前仅预览 ${visibleRows.length} 行，共 ${part.row_count} 行`
      : `${rows.length} 行`;
  const dataSource: TableRow[] = visibleRows.map((row, index) => ({ ...row, __rowKey: `${tableKey}-${index}` }));
  const antdColumns: TableColumnsType<TableRow> = columns.map((column) => ({
    title: column.label,
    dataIndex: column.key,
    key: column.key,
    minWidth: 112,
    width: 196,
    ellipsis: { showTitle: false },
    render: (value: unknown) => {
      const displayValue = tableCell(value, column);
      return <span className="block min-w-[112px] max-w-[280px] truncate" title={displayValue}>{displayValue}</span>;
    },
  }));

  if (columns.length === 0) return null;

  const exportTables: TableDisplayData[] = [{
    title: part.title,
    headers: columns.map(column => column.label),
    rows: rows.map(row => columns.map(column => tableCell(row[column.key], column))),
  }];

  const toolbarExtra = (
    <>
      <span className="whitespace-nowrap text-xs text-slate-400">{rowCountLabel}</span>
      {canToggleRows && (
        <Button
          type="link"
          size="small"
          className="shrink-0 px-1 text-xs text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-500"
          onClick={() => setExpanded(value => !value)}
        >
          {expanded ? '收起' : '展开全部'}
        </Button>
      )}
    </>
  );

  return (
    <section className="structured-table-enter mt-2" aria-label={part.title || '数据表'} aria-busy={playback.isTyping}>
      <TableDisplayFrame
        title={part.title || '数据表'}
        filename={part.title || '数据表'}
        className="rounded-xl border border-slate-100 bg-white"
        tableClassName="max-h-[18rem] overflow-auto md:max-h-none"
        exportTables={exportTables}
        toolbarExtra={toolbarExtra}
        showDownload={hasCompleteRows}
      >
        <Table<TableRow>
          columns={antdColumns}
          dataSource={dataSource}
          rowKey="__rowKey"
          pagination={false}
          size="small"
          bordered
          scroll={{ x: 'max-content' }}
          rowClassName={(_row, index) => playback.isTyping && index === visibleRows.length - 1 ? 'structured-table-row-typing' : ''}
        />
      </TableDisplayFrame>
    </section>
  );
}

const insightLabels = {
  fact: '事实',
  hypothesis: '假设',
  recommendation: '建议',
} as const;

function InsightPart({ part, animate }: { part: AgentResponsePart; animate: boolean }) {
  if (!part.items?.length) return null;

  const label = part.title || '经营结论';
  return (
    <section className="border-l-2 border-slate-200 py-1 pl-3">
      {part.title && <h3 className="mb-2 text-sm font-medium text-slate-700">{part.title}</h3>}
      <ul className="space-y-2 text-sm text-slate-700" aria-label={label}>
        {part.items.map((item, index) => (
          <li
            key={`${item.statement_type}-${index}`}
            className={`flex gap-2 ${animate ? 'agui-insight-reveal' : ''}`}
            style={animate ? { animationDelay: `${Math.min(index, 4) * 90}ms` } : undefined}
          >
            <span className="shrink-0 text-xs font-medium text-slate-500">{insightLabels[item.statement_type]}</span>
            <span>{item.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SummaryPart({ part, animate, streaming }: { part: AgentResponsePart; animate: boolean; streaming: boolean }) {
  const metrics = part.metrics ?? [];
  const playback = useTableTypewriter(metrics.length, animate, streaming, true, 240);
  return (
    <section className="rounded-2xl border border-slate-200/80 bg-white px-4 py-3 shadow-sm" aria-label={part.title || '汇总'}>
      {part.title && <h3 className="mb-2 text-sm font-medium text-slate-700">{part.title}</h3>}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {metrics.slice(0, playback.count).map((metric) => (
          <div key={metric.key} className="min-w-0">
            <div className="truncate text-xs text-slate-500">{metric.label || metric.key}</div>
            <div className="truncate text-sm font-medium text-slate-800">{displayDecimal(metric.value, metric.unit)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function NoticePart({ part, animate, streaming }: { part: AgentResponsePart; animate: boolean; streaming: boolean }) {
  const playback = useTypewriter(part.message ?? '', animate, streaming, true);
  if (!part.message || !part.severity) return null;

  return <Alert title={part.title} description={playback.text} type={part.severity} showIcon aria-live={animate ? 'off' : undefined} />;
}

function QuestionnaireCard({
  part, sourceTurnId, disabled, onInteraction,
}: {
  part: QuestionnairePart;
  sourceTurnId: string;
  disabled: boolean;
  onInteraction?: (interaction: ChatInteraction) => Promise<void>;
}) {
  const [draftAnswers, setDraftAnswers] = useState<Record<string, ClarificationAnswer>>({});
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [expired, setExpired] = useState(() => Date.now() >= parseBeijingTime(part.expires_at));
  const submissionInFlight = useRef(false);
  const [notificationApi, notificationContextHolder] = notification.useNotification();
  useEffect(() => {
    if (part.status !== 'pending') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function checkExpiry() {
      const remaining = parseBeijingTime(part.expires_at) - Date.now();
      setExpired(remaining <= 0);
      if (remaining > 0) timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
    }
    checkExpiry();
    return () => { if (timer !== undefined) clearTimeout(timer); };
  }, [part.expires_at, part.status]);

  const status = part.status === 'pending' && expired ? 'expired' : part.status;
  const readOnly = status !== 'pending' || submitted;
  const answers = part.status === 'answered' ? part.answers ?? {} : draftAnswers;
  const complete = part.questions.every((question) => {
    const answer = draftAnswers[question.id];
    return Boolean(answer?.option_id || answer?.text?.trim());
  });

  async function submit() {
    if (disabled || readOnly || submissionInFlight.current || !complete || !onInteraction
      || Date.now() >= parseBeijingTime(part.expires_at)) return;
    submissionInFlight.current = true;
    setPending(true);
    const normalizedAnswers = Object.fromEntries(part.questions.map((question) => {
      const answer = draftAnswers[question.id];
      return [question.id, answer.option_id ? { option_id: answer.option_id } : { text: answer.text!.trim() }];
    }));
    try {
      await onInteraction({
        kind: 'clarification_answer', source_turn_id: sourceTurnId,
        run_id: part.run_id, clarification_id: part.clarification_id, answers: normalizedAnswers,
      });
      setDraftAnswers(normalizedAnswers);
      setSubmitted(true);
    } catch {
      notificationApi.error({ title: '提交答案失败', duration: 5, closable: true });
    } finally {
      submissionInFlight.current = false;
      setPending(false);
    }
  }

  return (
    <section className="space-y-4 rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-sm text-slate-700 shadow-sm" aria-label="确认问题">
      {notificationContextHolder}
      {readOnly && <p className="text-xs text-slate-500">{status === 'answered' ? '已回答' : status === 'expired' ? '已过期' : status === 'cancelled' ? '已取消' : '已提交'}</p>}
      {part.questions.map((question) => {
        const answer = answers[question.id];
        const selected = answer?.text !== undefined ? 0 : question.options.findIndex((option) => option.id === answer?.option_id) + 1 || undefined;
        const freeText = question.options.length === 0 || selected === 0;
        return (
          <fieldset key={question.id} className="min-w-0 space-y-2" aria-label={question.question}>
            <legend className="mb-2 font-medium text-slate-800">
              <span className="mr-2 text-xs text-slate-500">{question.header}</span>{question.question}
            </legend>
            {readOnly ? (
              <p className="whitespace-pre-wrap">{answer?.text || question.options.find((option) => option.id === answer?.option_id)?.label || '未回答'}</p>
            ) : (
              <>
                {question.options.length > 0 && (
                  <Radio.Group className="flex w-full flex-col gap-2" value={selected} disabled={disabled || pending || !onInteraction}
                    onChange={(event) => setDraftAnswers((current) => ({
                      ...current, [question.id]: event.target.value === 0 ? { text: '' } : { option_id: question.options[event.target.value - 1].id },
                    }))}>
                    {question.options.map((option, index) => (
                      <Radio key={option.id} value={index + 1} className="!m-0 rounded-lg border border-slate-200 px-3 py-2">
                        <span>{option.label}</span>
                        {option.recommended && <span className="ml-2 rounded bg-blue-50 px-1.5 py-0.5 text-xs text-blue-700">推荐</span>}
                        {option.description && <span className="mt-1 block text-xs leading-5 text-slate-500">{option.description}</span>}
                      </Radio>
                    ))}
                    {question.allow_free_text && <Radio value={0} className="!m-0 px-3 py-2">其他</Radio>}
                  </Radio.Group>
                )}
                {freeText && (
                  <Input.TextArea aria-label={question.options.length ? `${question.question}：其他` : question.question}
                    value={answer?.text ?? ''} disabled={disabled || pending || !onInteraction} rows={2} maxLength={2000}
                    onChange={(event) => setDraftAnswers((current) => ({ ...current, [question.id]: { text: event.target.value } }))} />
                )}
              </>
            )}
          </fieldset>
        );
      })}
      {!readOnly && <Button type="primary" autoInsertSpace={false} loading={pending}
        disabled={disabled || pending || !complete || !onInteraction} onClick={submit}>提交答案</Button>}
    </section>
  );
}

export function ResponsePartsRenderer({
  response,
  onPrompt,
  onAction,
  onInteraction,
  promptDisabled = false,
  questionnaireDisabled = false,
  animate = false,
  streaming = false,
  animateInsights = false,
}: ResponsePartsRendererProps) {
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [notificationApi, notificationContextHolder] = notification.useNotification();
  const questionnaires = response.parts.filter(isQuestionnairePart);
  const hideConfirmationStatus = response.result_status === 'needs_confirmation'
    && questionnaires.length > 0 && questionnaires.every((part) => part.status !== 'pending');
  const payloadActionsBlocked = response.result_status === 'failed' || response.result_status === 'unavailable';
  const paceStructured = animate && !payloadActionsBlocked && response.result_status !== 'needs_confirmation'
    && response.parts.some(part => part.kind === 'table' || (part.kind === 'summary' && part.metrics?.length));
  const partPlayback = useTableTypewriter(response.parts.length, paceStructured && response.parts.length > 1, streaming, true, 240);
  const promptActions = response.actions?.filter((action) => (
    action.kind === 'prompt' && typeof action.params?.message === 'string'
  )) ?? [];
  const clarificationActions = response.actions?.filter((action) => (
    action.kind === 'clarify'
    && typeof action.params?.candidate_id === 'string'
    && typeof action.params?.message === 'string'
  )) ?? [];

  async function handlePrompt(actionId: string, message: string) {
    if (!onPrompt || promptDisabled || payloadActionsBlocked || pendingActionId) return;
    setPendingActionId(actionId);
    try {
      await onPrompt(message);
    } catch {
      notificationApi.error({ title: '发送后续问题失败', duration: 5, closable: true });
    } finally {
      setPendingActionId(null);
    }
  }

  async function handleClarification(action: AgentResponseAction) {
    if (!onAction || promptDisabled || payloadActionsBlocked || pendingActionId) return;
    setPendingActionId(action.action_id);
    try {
      await onAction(action);
    } catch {
      notificationApi.error({ title: '发送后续问题失败', duration: 5, closable: true });
    } finally {
      setPendingActionId(null);
    }
  }

  return (
    <div className="w-full space-y-3">
      {notificationContextHolder}
      {RESULT_STATUS_LABELS[response.result_status] && !hideConfirmationStatus && (
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" aria-hidden="true" />
          {RESULT_STATUS_LABELS[response.result_status]}
        </div>
      )}
      {response.parts.map((part, index) => {
        if (index >= partPlayback.count) return null;
        if (isQuestionnairePart(part)) {
          return <QuestionnaireCard key={`questionnaire-${part.run_id}-${part.clarification_id}`} part={part}
            sourceTurnId={response.source_turn_id} onInteraction={onInteraction}
            disabled={questionnaireDisabled || payloadActionsBlocked} />;
        }
        if (part.kind === 'summary' && part.metrics?.length) {
          return <SummaryPart key={`summary-${index}`} part={part} animate={paceStructured} streaming={streaming} />;
        }

        if (part.kind === 'table') {
          return (
            <TablePart
              key={`table-${part.table_id ?? index}`}
              part={part}
              expandable={!payloadActionsBlocked}
              tableKey={part.table_id ?? String(index)}
              animate={animate}
              streaming={streaming}
              startOnMount={paceStructured}
            />
          );
        }

        if (part.kind === 'insights') {
          return <InsightPart key={`insights-${index}`} part={part} animate={animateInsights} />;
        }

        if (part.kind === 'notice') {
          return <NoticePart key={`notice-${part.code ?? index}`} part={part} animate={paceStructured} streaming={streaming} />;
        }

        if (part.kind === 'clarification' && part.message) {
          return (
            <section key={`clarification-${index}`} className="space-y-3 rounded-2xl border border-slate-200/80 bg-white px-4 py-3.5 text-sm text-slate-700 shadow-sm">
              <p className="whitespace-pre-line leading-6">{part.message}</p>
              {clarificationActions.length > 0 && (
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {clarificationActions.map((action) => {
                    const isPending = pendingActionId === action.action_id;
                    return (
                      <Button
                        key={action.action_id}
                        autoInsertSpace={false}
                        icon={<RightOutlined aria-hidden="true" />}
                        iconPlacement="end"
                        disabled={promptDisabled || payloadActionsBlocked || Boolean(pendingActionId) || !onAction}
                        loading={isPending}
                        onClick={() => handleClarification(action)}
                        className="min-h-11 w-full justify-between whitespace-normal rounded-xl border-blue-200 bg-blue-50 px-3.5 py-2 text-left text-sm font-medium leading-5 text-blue-700 shadow-none transition-all duration-200 hover:border-blue-300 hover:bg-blue-100 focus-visible:ring-2 focus-visible:ring-blue-200 sm:w-auto"
                      >
                        {action.label}
                      </Button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        }

        console.warn('[AgentResponse] unsupported response part');
        return null;
      })}
      {promptActions.length > 0 && (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {promptActions.map((action) => {
            const message = action.params?.message as string;
            const isPending = pendingActionId === action.action_id;
            return (
              <Button
                key={action.action_id}
                autoInsertSpace={false}
                icon={<RightOutlined aria-hidden="true" />}
                iconPlacement="end"
                disabled={promptDisabled || payloadActionsBlocked || Boolean(pendingActionId) || !onPrompt}
                loading={isPending}
                onClick={() => handlePrompt(action.action_id, message)}
                className="min-h-11 w-full justify-between whitespace-normal rounded-xl border-slate-200 bg-white px-3.5 py-2 text-left text-sm font-medium leading-5 text-slate-700 shadow-sm transition-all duration-200 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 focus-visible:ring-2 focus-visible:ring-blue-200 sm:w-auto"
              >
                {action.label}
              </Button>
            );
          })}
        </div>
      )}
    </div>
  );
}
