import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Button } from 'antd';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useChatStore } from '../store/chatStore';
import type { Message } from '../types';
import { apiFetch, apiUrl } from '../api/client';
import { createKbEntry } from '../api/kb';
import { TableDisplayFrame } from './TableDisplayFrame';
import { FloatingNotice, type FloatingNoticeState } from './FloatingNotice';
import { formatBeijingTime } from '../utils/time';
import { AgentActivitySummary } from './AgentActivitySummary';
import { useTypewriter } from '../hooks/useTypewriter';
import { formatDisplayValue } from '../utils/displayValue';

interface Props {
  message: Message;
  sessionId: string;
  hideStructuredContent?: boolean;
  structuredContent?: ReactNode;
  loadingAction?: ReactNode;
  canDelete?: boolean;
  animateText?: boolean;
}

marked.setOptions({ gfm: true, breaks: true });

const MARKDOWN_TABLE_PREVIEW_ROWS = 10;
const MARKDOWN_ALLOWED_TAGS = [
  'a', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'hr', 'li', 'ol', 'p', 'pre', 'strong', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
];
const MARKDOWN_ALLOWED_ATTRIBUTES = ['align', 'colspan', 'href', 'rowspan', 'scope', 'start', 'title'];
const MARKDOWN_ATTRIBUTES_BY_TAG: Record<string, ReadonlySet<string>> = {
  a: new Set(['href', 'title']),
  ol: new Set(['start']),
  td: new Set(['align', 'colspan', 'rowspan']),
  th: new Set(['align', 'colspan', 'rowspan', 'scope']),
};
const MARKDOWN_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function normalizeMarkdownTables(text: string): string {
  return text.split('\n').map((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return line;
    return line
      .split('|')
      .map((cell, index, cells) => {
        if (index === 0 || index === cells.length - 1) return cell;
        return formatDisplayValue(cell);
      })
      .join('|');
  }).join('\n');
}

function enhanceMarkdownTables(html: string, expandedTables: Record<string, boolean>): string {
  if (typeof document === 'undefined') {
    return html
      .replace(/<table>/g, '<div class="markdown-table-scroll"><table>')
      .replace(/<\/table>/g, '</table></div>');
  }

  const container = document.createElement('div');
  container.innerHTML = html;
  Array.from(container.querySelectorAll('table')).forEach((table, index) => {
    const tableId = String(index);
    const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
    const rows = bodyRows.length ? bodyRows : Array.from(table.querySelectorAll('tr')).slice(1);
    const canCollapse = rows.length > MARKDOWN_TABLE_PREVIEW_ROWS;
    const expanded = Boolean(expandedTables[tableId]);

    if (canCollapse && !expanded) {
      rows.slice(MARKDOWN_TABLE_PREVIEW_ROWS).forEach((row) => {
        row.setAttribute('hidden', '');
      });
    }

    const scroll = document.createElement('div');
    scroll.className = 'markdown-table-scroll';
    table.replaceWith(scroll);
    scroll.appendChild(table);

    if (!canCollapse) return;
    const footer = document.createElement('div');
    footer.className = 'mt-2 flex items-center justify-between gap-3 text-xs text-slate-500';

    const summary = document.createElement('span');
    summary.textContent = expanded
      ? `已展开全部 ${rows.length} 行`
      : `默认展示前 ${MARKDOWN_TABLE_PREVIEW_ROWS} 行，共 ${rows.length} 行`;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shrink-0 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-blue-600 transition hover:bg-blue-50';
    button.dataset.markdownTableToggle = tableId;
    button.textContent = expanded ? '收起' : '展开全部';

    footer.append(summary, button);
    scroll.insertAdjacentElement('afterend', footer);
  });
  return container.innerHTML;
}

function isAllowedMarkdownHref(value: string): boolean {
  const href = value.trim();
  if (!href) return false;
  const protocolProbe = href.replace(/[\u0000-\u0020\u007f]/g, '');
  if (!protocolProbe || protocolProbe.startsWith('//') || protocolProbe.startsWith('\\')) return false;
  const scheme = protocolProbe.match(/^([a-z][a-z\d+.-]*):/i);
  return !scheme || MARKDOWN_LINK_PROTOCOLS.has(`${scheme[1].toLowerCase()}:`);
}

function sanitizeMarkdownHtml(html: string): string {
  if (typeof document === 'undefined') return '';

  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MARKDOWN_ALLOWED_TAGS,
    ALLOWED_ATTR: MARKDOWN_ALLOWED_ATTRIBUTES,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
  });
  const container = document.createElement('div');
  container.innerHTML = String(sanitized);
  Array.from(container.querySelectorAll('*')).forEach((element) => {
    const tag = element.tagName.toLowerCase();
    const allowedAttributes = MARKDOWN_ATTRIBUTES_BY_TAG[tag] ?? new Set<string>();
    Array.from(element.attributes).forEach((attr) => {
      if (!allowedAttributes.has(attr.name.toLowerCase())) {
        element.removeAttribute(attr.name);
      }
    });
    if (tag === 'a') {
      const href = element.getAttribute('href');
      if (href && !isAllowedMarkdownHref(href)) element.removeAttribute('href');
    }
  });
  return container.innerHTML;
}

function renderMarkdown(text: string, expandedTables: Record<string, boolean> = {}): string {
  const html = marked.parse(normalizeMarkdownTables(text.replace(/^\n+/, ''))) as string;
  return enhanceMarkdownTables(sanitizeMarkdownHtml(html), expandedTables);
}

type MarkdownSegment = {
  type: 'html' | 'table';
  html: string;
  tableIndex?: number;
};

function splitRenderedMarkdownTables(html: string): MarkdownSegment[] {
  if (typeof document === 'undefined') return [{ type: 'html', html }];

  const container = document.createElement('div');
  container.innerHTML = html;
  const nodes = Array.from(container.childNodes);
  const segments: MarkdownSegment[] = [];
  let htmlNodes: Node[] = [];
  let tableIndex = 0;

  const flushHtml = () => {
    if (htmlNodes.length === 0) return;
    const wrapper = document.createElement('div');
    htmlNodes.forEach((node) => wrapper.appendChild(node));
    const segmentHtml = wrapper.innerHTML.trim();
    if (segmentHtml) segments.push({ type: 'html', html: segmentHtml });
    htmlNodes = [];
  };

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const isTableScroll = node instanceof HTMLElement && node.classList.contains('markdown-table-scroll');
    if (!isTableScroll) {
      htmlNodes.push(node.cloneNode(true));
      continue;
    }

    flushHtml();
    const wrapper = document.createElement('div');
    wrapper.appendChild(node.cloneNode(true));

    const nextNode = nodes[index + 1];
    const isTableFooter = nextNode instanceof HTMLElement && Boolean(nextNode.querySelector('[data-markdown-table-toggle]'));
    if (isTableFooter) {
      wrapper.appendChild(nextNode.cloneNode(true));
      index += 1;
    }

    segments.push({ type: 'table', html: wrapper.innerHTML, tableIndex });
    tableIndex += 1;
  }

  flushHtml();
  return segments;
}

function formatMessageTime(value?: number): string {
  if (!value) return '';
  return formatBeijingTime(value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface ReportDownloadLink {
  label: string;
  href: string;
  filename: string;
}

interface KnowledgeDraft {
  title: string;
  categoryLabel: string;
  category: string;
  content: string;
}

const EXCEL_DOWNLOAD_RE = /\[([^\]]+)\]\((\/api\/v1\/(?:reports\/download|kb\/payroll\/download)\/[^)\s]+)\)/g;

function extractReportDownloads(content: string): ReportDownloadLink[] {
  return [...content.matchAll(EXCEL_DOWNLOAD_RE)].map((match) => {
    const label = match[1] || 'Excel 报表.xlsx';
    const href = match[2];
    const url = new URL(apiUrl(href), window.location.origin);
    const filename = url.searchParams.get('filename') || label;
    return {
      label,
      href,
      filename: filename.endsWith('.xlsx') ? filename : `${filename}.xlsx`,
    };
  });
}

function stripReportDownloadLinks(content: string): string {
  return content.replace(EXCEL_DOWNLOAD_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

function extractKnowledgeDraft(content: string): KnowledgeDraft | null {
  if (!content.includes('建议标题：') || !content.includes('知识正文：')) return null;
  const title = content.match(/建议标题：(.+)/)?.[1]?.trim();
  const categoryLabel = content.match(/建议分类：(.+)/)?.[1]?.trim() || '数据字段说明';
  const body = content.split('知识正文：').slice(1).join('知识正文：').trim();
  if (!title || !body) return null;
  return {
    title,
    categoryLabel,
    category: categoryLabel.includes('数据字段') ? 'connector_query_knowledge' : categoryLabel,
    content: body,
  };
}

export function MessageBubble({ message, sessionId, hideStructuredContent = false, structuredContent, loadingAction, canDelete = true, animateText = false }: Props) {
  const { deleteMessagePair } = useChatStore();
  const isUser = message.role === 'user';
  const [copied, setCopied] = useState(false);
  const [knowledgeSaving, setKnowledgeSaving] = useState(false);
  const [knowledgeSaved, setKnowledgeSaved] = useState(false);
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const [expandedMarkdownTables, setExpandedMarkdownTables] = useState<Record<string, boolean>>({});
  const [longContentExpanded, setLongContentExpanded] = useState(false);
  const [showLoadingStage, setShowLoadingStage] = useState(false);

  const shouldHideContent = hideStructuredContent && !isUser && Boolean(message.agentResponse) && !message.streaming;
  const hasPublicActivity = !isUser && Boolean(message.activity);
  const contentForDisplay = shouldHideContent ? '' : (message.content ?? '');
  const hasTable = !isUser && /^\s*\|.+\|\s*$/m.test(contentForDisplay);
  const reportDownloads = !isUser && contentForDisplay ? extractReportDownloads(contentForDisplay) : [];
  const knowledgeDraft = !isUser && contentForDisplay ? extractKnowledgeDraft(contentForDisplay) : null;
  const visibleContent = reportDownloads.length ? stripReportDownloadLinks(contentForDisplay) : contentForDisplay;
  // Code and HTML bypass animation; Markdown tables can reveal their text progressively.
  const complexMarkdown = /[`<>]|^\s*~{3}|^(?: {4}|\t)\S/m.test(visibleContent);
  const canAnimate = animateText && !isUser && Boolean(message.agui)
    && ['connecting', 'running', 'completed'].includes(message.agui!.status)
    && !message.agentResponse && !complexMarkdown && !reportDownloads.length && !knowledgeDraft;
  const playback = useTypewriter(visibleContent, canAnimate, Boolean(message.streaming), animateText);
  const canCollapseLongContent = !isUser && !hasTable && !message.streaming && !playback.isTyping && (visibleContent?.length || 0) > 1200;
  const tableTitleMatch = contentForDisplay.match(/\*\*(.+?)\*\*/);
  const tableTitle = tableTitleMatch ? tableTitleMatch[1].replace(/[\\/:*?"<>|]/g, '_') : '表格数据';
  const renderedMarkdown = useMemo(() => playback.text ? renderMarkdown(playback.text, expandedMarkdownTables) : '', [playback.text, expandedMarkdownTables]);
  const markdownSegments = useMemo(() => renderedMarkdown ? splitRenderedMarkdownTables(renderedMarkdown) : [], [renderedMarkdown]);
  const tableSegmentCount = markdownSegments.filter((segment) => segment.type === 'table').length;
  const messageTime = formatMessageTime(message.createdAt);

  useEffect(() => {
    setExpandedMarkdownTables({});
    setLongContentExpanded(false);
    setKnowledgeSaved(false);
    setNotice(null);
  }, [message.id]);

  useEffect(() => {
    setShowLoadingStage(false);
    if (!message.streaming || !message.agui) return;
    const timer = window.setTimeout(() => setShowLoadingStage(true), 3000);
    return () => window.clearTimeout(timer);
  }, [message.agui?.runId, message.id, message.streaming]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function handleCopy() {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleDelete() {
    deleteMessagePair(sessionId, message.id);
  }

  async function handleSaveKnowledgeDraft() {
    if (!knowledgeDraft || knowledgeSaving) return;
    setKnowledgeSaving(true);
    try {
      await createKbEntry({
        title: knowledgeDraft.title,
        category: knowledgeDraft.category,
        content: knowledgeDraft.content,
        source: 'extracted',
        source_session_id: sessionId,
      });
      setKnowledgeSaved(true);
      setNotice({ variant: 'success', message: `已保存为知识：${knowledgeDraft.title}` });
    } catch (e) {
      setNotice({ variant: 'error', message: (e as Error).message || '保存知识失败' });
    } finally {
      setKnowledgeSaving(false);
    }
  }

  async function downloadReport(href: string, fallbackFilename = '财务报表.xlsx') {
    const res = await apiFetch(href);
    if (!res.ok) return;
    const blob = await res.blob();
    const disposition = res.headers.get('Content-Disposition') || '';
    const utf8Match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
    const asciiMatch = disposition.match(/filename="?([^";]+)"?/i);
    const filename = decodeURIComponent(utf8Match?.[1] || asciiMatch?.[1] || fallbackFilename);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleMarkdownClick(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    const toggle = target.closest('[data-markdown-table-toggle]') as HTMLElement | null;
    if (toggle) {
      event.preventDefault();
      const tableId = toggle.dataset.markdownTableToggle;
      if (!tableId) return;
      setExpandedMarkdownTables((current) => ({
        ...current,
        [tableId]: !current[tableId],
      }));
      return;
    }

    const anchor = target.closest('a');
    if (!anchor) return;
    const href = anchor.getAttribute('href') || '';
    if (!href.startsWith('/api/v1/reports/download/') && !href.startsWith('/api/v1/kb/payroll/download/')) return;
    event.preventDefault();
    await downloadReport(href);
  }

  // 首次 loading：AG-UI 只保留一个紧凑状态，较久后再补充具体阶段。
  function renderLoading() {
    const stageLabel = message.agui ? '分析中' : (message.stage?.label || '分析中');
    const delayedStage = showLoadingStage && message.stage?.label && message.stage.label !== stageLabel
      ? message.stage.label
      : null;
    return (
      <span className="inline-flex min-h-8 items-center gap-2 text-sm text-slate-500">
        <span
          aria-hidden="true"
          className="h-5 w-5 shrink-0 rounded-full border-2 border-blue-200 border-t-blue-600 shadow-sm motion-safe:animate-spin"
        />
        <span role="status" aria-live="polite" className="font-medium text-slate-600">
          {stageLabel}
          {delayedStage && <span className="font-normal text-slate-400"> · {delayedStage}</span>}
        </span>
        {loadingAction}
      </span>
    );
  }

  const hasVisibleMessage = Boolean(
    isUser
    || hasPublicActivity
    || contentForDisplay
    || reportDownloads.length > 0
    || structuredContent
    || message.streaming,
  );

  if (!hasVisibleMessage) return null;

  return (
    <div className={`group/message mb-7 flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      {!isUser && (
        <div className="mr-3 mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-lg bg-blue-600 text-[10px] font-semibold text-white shadow-sm shadow-blue-200">
          AI
        </div>
      )}

      <div
        className={`flex min-w-0 flex-col ${isUser ? 'items-end' : 'items-start'} ${hasPublicActivity || (!isUser && structuredContent) ? 'gap-2' : ''} ${
          !isUser
            ? 'w-full max-w-[calc(100%_-_2.5rem)]'
            : 'max-w-[92%] md:max-w-[78%]'
        }`}
      >
        {hasPublicActivity && <AgentActivitySummary activity={message.activity!} />}
        {(contentForDisplay || reportDownloads.length > 0 || (message.streaming && !hasPublicActivity)) && (
          <div
            aria-live={animateText ? 'off' : undefined}
            className={`min-w-0 ${
              hasTable && !isUser ? 'w-full max-w-full overflow-hidden' : ''
            } ${
              isUser
                ? 'message-user rounded-2xl rounded-br-md bg-blue-600 px-4 py-3 text-sm leading-6 text-white shadow-sm shadow-blue-200/70'
                : 'message-assistant w-full py-0.5 text-[15px] leading-7 text-slate-800'
            }`}
          >
            {contentForDisplay ? (
            <>
              {visibleContent && (
                hasTable ? (
                  <div className="space-y-3">
                    {markdownSegments.map((segment, index) => {
                      if (segment.type === 'table') {
                        const displayIndex = (segment.tableIndex ?? 0) + 1;
                        const segmentTitle = tableSegmentCount > 1 ? `${tableTitle} ${displayIndex}` : tableTitle;
                        return (
                          <TableDisplayFrame
                            key={`table-${displayIndex}-${index}`}
                            title={segmentTitle}
                            filename={segmentTitle}
                            className="rounded-xl border border-slate-100 bg-white"
                            tableClassName="max-h-[18rem] overflow-auto md:max-h-none"
                          >
                            <div
                              className="markdown-body"
                              onClick={handleMarkdownClick}
                              dangerouslySetInnerHTML={{ __html: segment.html }}
                            />
                          </TableDisplayFrame>
                        );
                      }
                      return (
                        <div
                          key={`html-${index}`}
                          className="markdown-body"
                          onClick={handleMarkdownClick}
                          dangerouslySetInnerHTML={{ __html: segment.html }}
                        />
                      );
                    })}
                  </div>
                ) : (
                  <>
                    <div className={`relative ${canCollapseLongContent && !longContentExpanded ? 'max-h-72 overflow-hidden' : ''}`}>
                      <div
                        className="markdown-body"
                        onClick={handleMarkdownClick}
                        dangerouslySetInnerHTML={{ __html: renderedMarkdown }}
                      />
                      {canCollapseLongContent && !longContentExpanded && (
                        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-[#f7f9fc] to-transparent" />
                      )}
                    </div>
                    {canCollapseLongContent && (
                      <Button
                        autoInsertSpace={false}
                        htmlType="button"
                        className="mt-2 h-auto rounded-lg border border-slate-200 px-3 py-1 text-xs text-blue-600 shadow-none"
                        onClick={() => setLongContentExpanded(v => !v)}
                      >
                        {longContentExpanded ? '收起' : '展开全文'}
                      </Button>
                    )}
                  </>
                )
              )}
              {reportDownloads.length > 0 && (
                <div className={visibleContent ? 'mt-3 space-y-2' : 'space-y-2'}>
                  {reportDownloads.map((item) => (
                    <div
                      key={item.href}
                      className="w-full max-w-md rounded-lg border border-emerald-200 bg-emerald-50/70 p-3 shadow-sm"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg bg-emerald-600 flex items-center justify-center text-white flex-shrink-0">
                          <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                            <path d="M4 2a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V7.414A2 2 0 0017.414 6L14 2.586A2 2 0 0012.586 2H4zm3 7.5a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5A.75.75 0 017 9.5zm0 3a.75.75 0 01.75-.75h4.5a.75.75 0 010 1.5h-4.5A.75.75 0 017 12.5z" />
                          </svg>
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-slate-800 truncate">{item.filename}</p>
                          <p className="text-xs text-slate-500">Excel 报表 · xlsx</p>
                        </div>
                        <Button
                          autoInsertSpace={false}
                          onClick={() => downloadReport(item.href, item.filename)}
                          className="h-10 px-3 rounded-md bg-emerald-600 text-white text-xs font-medium hover:bg-emerald-700 focus:outline-none focus:ring-2 focus:ring-emerald-200 cursor-pointer transition-colors flex-shrink-0"
                        >
                          下载
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            message.streaming && renderLoading()
          )}
          {(message.streaming || playback.isTyping) && message.content && (
            <span aria-hidden="true" className="inline-block w-0.5 h-4 bg-current ml-0.5 animate-pulse motion-reduce:animate-none align-middle" />
          )}
          </div>
        )}
        {animateText && !isUser && playback.isTyping && (
          <div className="flex max-w-full flex-wrap items-center gap-2 px-1 text-xs text-slate-500">
            <span role="status" aria-live="polite">
              {message.streaming ? '正在显示回复' : '回答已生成，正在显示'}
            </span>
          </div>
        )}
        {structuredContent}
        {message.streaming && loadingAction && (contentForDisplay || hasPublicActivity || structuredContent) && (
          <div className="flex min-h-8 items-center px-1">{loadingAction}</div>
        )}

        {messageTime && (
          <div className={`mt-1 px-1 text-[11px] leading-none text-slate-400 transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100 ${isUser ? 'text-right' : 'text-left'}`}>
            {messageTime}
          </div>
        )}

        {/* 接收和动画展示结束后显示操作按钮；复制始终使用完整原文。 */}
        {!message.streaming && !playback.isTyping && (
          <div className={`mt-1 flex max-w-full flex-nowrap items-center gap-1.5 transition-opacity md:group-hover/message:opacity-100 md:group-focus-within/message:opacity-100 ${isUser ? 'self-end' : 'self-start'}`}>
            {knowledgeDraft && !isUser && (
              <button
                type="button"
                onClick={handleSaveKnowledgeDraft}
                disabled={knowledgeSaving || knowledgeSaved}
                title={`保存到知识库：${knowledgeDraft.categoryLabel}`}
                className="inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs text-emerald-600 transition-colors hover:bg-emerald-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-400 disabled:cursor-default disabled:text-emerald-400 md:h-8"
              >
                <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                  <path d="M9 2a1 1 0 00-1 1v5H3a1 1 0 100 2h5v5a1 1 0 102 0v-5h5a1 1 0 100-2h-5V3a1 1 0 00-1-1z" />
                </svg>
                {knowledgeSaved ? '已保存知识' : knowledgeSaving ? '保存中' : '保存为知识'}
              </button>
            )}
            <button
              type="button"
              onClick={handleCopy}
              title="复制内容"
              className="inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs text-slate-500 transition-colors hover:bg-blue-50 hover:text-blue-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-400 md:h-8"
            >
              {copied ? (
                <>
                  <svg className="w-3 h-3 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                  </svg>
                  <span className="text-green-500">已复制</span>
                </>
              ) : (
                <>
                  <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                    <path d="M8 3a1 1 0 011-1h2a1 1 0 110 2H9a1 1 0 01-1-1z" />
                    <path d="M6 3a2 2 0 00-2 2v11a2 2 0 002 2h8a2 2 0 002-2V5a2 2 0 00-2-2 3 3 0 01-3 3H9a3 3 0 01-3-3z" />
                  </svg>
                  复制
                </>
              )}
            </button>
            {canDelete && <button
              type="button"
              onClick={handleDelete}
              title="删除问答"
              className="inline-flex h-11 shrink-0 items-center gap-1 whitespace-nowrap rounded-lg px-2.5 text-xs text-slate-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-400 md:h-8"
            >
              <svg className="w-3 h-3" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              删除
            </button>}
          </div>
        )}
      </div>

      {isUser && <div className="w-7 flex-shrink-0 ml-2" />}
      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} closeLabel="关闭" />}
    </div>
  );
}
