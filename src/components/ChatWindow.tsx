import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { ArrowDownOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Input, notification } from 'antd';
import type { AgentRunApprovalDecision } from '../api/agentRuns';
import type { AgentRunCommandResult } from '../api/agentRuns';
import { useChatStore } from '../store/chatStore';
import { useTaskStore } from '../store/taskStore';
import { useAuthStore } from '../store/authStore';
import { useAgentChat } from '../hooks/useAgentChat';
import type { TaskRecord } from '../types/task';
import { MessageBubble } from './MessageBubble';
import { ResponsePartsRenderer } from './ResponsePartsRenderer';
import { ToolCallCard } from './ToolCallCard';
import { FileUploadArea } from './FileUploadArea';
import { TaskCard } from './TaskCard';
import { QueryEvidencePanel } from './QueryEvidencePanel';
import { KnowledgeExtractDialog } from './KnowledgeExtractDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { Popup, SafeArea } from 'antd-mobile';
import { AGUI_STATUS_LABELS, isAguiUnresolved } from '../types/agui';
import { isQuestionnairePart } from '../types';

const LINE_HEIGHT = 24;
const MAX_ROWS = 4;
const CHAT_WINDOW_POLL_OWNER = 'chat-window';
const { TextArea } = Input;

function scrollMessageListToBottom(container: HTMLDivElement, behavior: ScrollBehavior) {
  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: container.scrollHeight, behavior });
    return;
  }
  container.scrollTop = container.scrollHeight;
}

export function ChatWindow() {
  const sessions = useChatStore((state) => state.sessions);
  const activeSessionId = useChatStore((state) => state.activeSessionId);
  const setActiveSession = useChatStore((state) => state.setActiveSession);
  const resetToNewSession = useChatStore((state) => state.resetToNewSession);
  const loadingHistory = useChatStore((state) => state.loadingHistory);
  const startPolling = useTaskStore((state) => state.startPolling);
  const stopPolling = useTaskStore((state) => state.stopPolling);
  const tasks = useTaskStore((state) => state.tasks);
  const [dupConfirm, setDupConfirm] = useState<{
    period: string;
    existing_sources: Array<{ bill_platform: string | null; source: string; filename: string; row_count: number }>;
    onConfirm: () => void;
  } | null>(null);
  const [cancelResearch, setCancelResearch] = useState<TaskRecord | null>(null);
  const cancelResearchInFlightRef = useRef(false);
  const [cancellingResearchTaskId, setCancellingResearchTaskId] = useState<string | null>(null);

  const { sendMessage, resumeResearchRun, cancelResearchRun, reconnectAguiRun, cancelAguiRun, decideAguiApproval, canReconnectAguiRun } = useAgentChat({
    onDuplicate: ({ period, existing_sources, onConfirm }) => setDupConfirm({ period, existing_sources, onConfirm }),
  });
  const role = useAuthStore((state) => state.role);
  const workspaceType = useAuthStore((state) => state.workspaceType);
  const isPersonal = workspaceType === 'personal';
  const [input, setInput] = useState('');
  const composerRef = useRef<ComponentRef<typeof TextArea>>(null);
  const [showUpload, setShowUpload] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [cancellingAguiRunId, setCancellingAguiRunId] = useState<string | null>(null);
  const cancellingAguiRef = useRef(false);
  const [aguiApprovalDecision, setAguiApprovalDecision] = useState<{
    runId: string;
    toolLabel: string;
    decision: AgentRunApprovalDecision;
  } | null>(null);
  const decidingAguiApprovalRef = useRef(false);
  const [showExtract, setShowExtract] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const messageContentRef = useRef<HTMLDivElement>(null);
  const followLatestRef = useRef(true);
  const [showLatestButton, setShowLatestButton] = useState(false);

  const session = useMemo(
    () => sessions.find((item) => item.id === activeSessionId),
    [activeSessionId, sessions],
  );
  const messages = session?.messages ?? [];
  const isAgui = session?.conversationMode === 'agui';
  const [liveMessageIds, setLiveMessageIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    // Store events can complete within one React batch, before a streamed render.
    const rememberLiveMessages = (state: ReturnType<typeof useChatStore.getState>, previous?: ReturnType<typeof useChatStore.getState>) => {
      const current = state.sessions.find(item => item.id === state.activeSessionId);
      const previousSession = previous?.sessions.find(item => item.id === previous.activeSessionId);
      const switched = previous && state.activeSessionId !== previous.activeSessionId;
      if (previous && !switched && current?.messages === previousSession?.messages
        && state.loadingHistory === previous.loadingHistory) return;
      const ids = new Set(current?.messages.map(message => message.id));
      const renamed = switched && previousSession?.messages.some(message => ids.has(message.id));
      setLiveMessageIds(existing => {
        const next = new Set(switched && !renamed ? [] : [...existing].filter(id => ids.has(id)));
        if (!state.loadingHistory && !switched) {
          for (const message of current?.messages ?? []) {
            if (message.role === 'assistant' && message.agui && message.streaming) next.add(message.id);
          }
        }
        return next.size === existing.size && [...next].every(id => existing.has(id)) ? existing : next;
      });
    };
    rememberLiveMessages(useChatStore.getState());
    return useChatStore.subscribe(rememberLiveMessages);
  }, []);
  const unresolvedAgui = messages.find((message) => message.agui && isAguiUnresolved(message.agui.status));
  const hiddenToolCallIds = useMemo(() => {
    const hidden = new Set<string>();
    let hasPublicActivity = false;
    for (const message of messages) {
      if (message.role === 'user') {
        hasPublicActivity = false;
      } else if (message.role === 'assistant') {
        hasPublicActivity = Boolean(message.activity);
      } else if (hasPublicActivity) {
        hidden.add(message.id);
      }
    }
    return hidden;
  }, [messages]);
  const historySessions = useMemo(() => sessions.filter((item) => !item.pending), [sessions]);
  const taskById = useMemo(() => {
    const index = new Map<string, (typeof tasks)[number]>();
    for (const task of tasks) {
      if (task.session_id === activeSessionId) index.set(task.task_id, task);
    }
    return index;
  }, [activeSessionId, tasks]);
  const replayedAguiRunIds = useMemo(() => new Set(
    messages.flatMap((message) => message.agui?.runId ? [message.agui.runId] : []),
  ), [messages]);
  const previousQuestionByMessageId = useMemo(() => {
    const index = new Map<string, string>();
    let previousQuestion = '';
    for (const message of messages) {
      index.set(message.id, previousQuestion);
      if (message.role === 'user') previousQuestion = message.content;
    }
    return index;
  }, [messages]);
  const isEmptySession = messages.length === 0;
  const lastMessage = messages[messages.length - 1];
  const isGenerating = Boolean(lastMessage?.streaming
    || lastMessage?.agui?.status === 'connecting'
    || lastMessage?.agui?.status === 'running');

  useEffect(() => {
    if (activeSessionId && !sending) composerRef.current?.focus({ preventScroll: true });
  }, [activeSessionId, sending]);

  useEffect(() => {
    if (activeSessionId && !isPersonal) {
      startPolling(CHAT_WINDOW_POLL_OWNER, {
        type: 'session',
        sessionId: activeSessionId,
      });
    } else {
      stopPolling(CHAT_WINDOW_POLL_OWNER);
    }
  }, [activeSessionId, isPersonal, startPolling, stopPolling]);

  useEffect(
    () => () => stopPolling(CHAT_WINDOW_POLL_OWNER),
    [stopPolling],
  );

  useEffect(() => {
    followLatestRef.current = true;
    setShowLatestButton(false);
    const container = messageListRef.current;
    if (!container) return;
    scrollMessageListToBottom(container, 'auto');
  }, [activeSessionId]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const container = messageListRef.current;
      if (!container || !followLatestRef.current) return;
      scrollMessageListToBottom(container, 'auto');
    });
    return () => cancelAnimationFrame(frame);
  }, [activeSessionId, messages.length, lastMessage?.content, lastMessage?.id, lastMessage?.streaming]);

  useEffect(() => {
    const content = messageContentRef.current;
    if (!content || typeof ResizeObserver === 'undefined') return;
    let frame: number | undefined;
    const observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const container = messageListRef.current;
        if (container && followLatestRef.current) scrollMessageListToBottom(container, 'auto');
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [activeSessionId]);

  function handleMessageScroll() {
    const container = messageListRef.current;
    if (!container) return;
    const nearBottom = container.scrollHeight - container.clientHeight - container.scrollTop <= 64;
    followLatestRef.current = nearBottom;
    setShowLatestButton(!nearBottom);
  }

  async function handleSend(text: string) {
    if (sending || unresolvedAgui) return;
    const trimmed = text.trim();
    if (!trimmed && pendingFiles.length === 0) return;
    setInput('');
    setShowUpload(false);
    setSending(true);
    const files = pendingFiles;
    setPendingFiles([]);
    try {
      const fileSet = files.length > 0 ? { files, taskType: 'file_parsing' as const } : undefined;
      await sendMessage(trimmed || '上传账单文件', fileSet);
    } finally {
      setSending(false);
    }
  }

  async function handleAguiCancel(runId: string) {
    if (cancellingAguiRef.current) return;
    cancellingAguiRef.current = true;
    setCancellingAguiRunId(runId);
    try {
      await cancelAguiRun(runId);
      notification.success({ message: '任务状态已更新', duration: 5, closable: true });
    } catch (error) {
      notification.error({ message: '停止未确认', description: error instanceof Error ? error.message : '请稍后重试', duration: 5, closable: true });
    } finally {
      cancellingAguiRef.current = false;
      setCancellingAguiRunId(null);
    }
  }

  async function confirmAguiApproval() {
    const pending = aguiApprovalDecision;
    if (!pending || decidingAguiApprovalRef.current) return;
    decidingAguiApprovalRef.current = true;
    setAguiApprovalDecision(null);
    try {
      const accepted = await decideAguiApproval(pending.runId, pending.decision);
      if (!accepted) throw new Error('当前审批状态已变化，请刷新后重试。');
      notification.success({
        message: pending.decision === 'approve' ? '已同意执行' : '已拒绝执行',
        duration: 5,
        closable: true,
      });
    } catch (error) {
      notification.error({
        message: '审批操作失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        duration: 5,
        closable: true,
      });
    } finally {
      decidingAguiApprovalRef.current = false;
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(input);
    }
  }

  async function confirmResearchCancel() {
    if (cancelResearchInFlightRef.current) return;
    const task = cancelResearch;
    if (!task) return;
    cancelResearchInFlightRef.current = true;
    setCancellingResearchTaskId(task.task_id);
    setCancelResearch(null);
    try {
      await cancelResearchRun(task);
      notification.success({ message: '经营研究已取消', duration: 5, closable: true });
    } catch (error) {
      notification.error({
        message: '取消经营研究失败',
        description: error instanceof Error ? error.message : '请稍后重试',
        duration: 5,
        closable: true,
      });
    } finally {
      cancelResearchInFlightRef.current = false;
      setCancellingResearchTaskId(null);
    }
  }

  function renderComposer(variant: 'center' | 'dock') {
    const isCenter = variant === 'center';

    return (
      <div
        className={`mobile-soft-focus flex items-end gap-2 border transition-all duration-200 focus-within:border-blue-300 focus-within:ring-4 focus-within:ring-blue-100/70 ${
          isCenter
            ? 'min-h-[76px] rounded-[28px] border-slate-200 bg-white px-4 py-3 shadow-[0_18px_50px_-24px_rgba(15,23,42,0.35)]'
            : 'rounded-2xl border-slate-200 bg-white px-3 py-2 shadow-[0_8px_30px_-22px_rgba(15,23,42,0.55)]'
        }`}
      >
        {!isPersonal && <Button
          htmlType="button"
          onClick={() => setShowUpload((v) => !v)}
          title="上传账单文件"
          aria-label="上传账单文件"
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl border-0 p-0 shadow-none transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-300 ${
            showUpload ? 'text-blue-600 bg-blue-100' : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'
          } ${isCenter ? '' : 'mb-0.5'}`}
        >
          <svg className={isCenter ? 'w-5 h-5' : 'w-5 h-5'} viewBox="0 0 20 20" fill="currentColor">
            <path fillRule="evenodd" d="M8 4a3 3 0 00-3 3v4a5 5 0 0010 0V7a1 1 0 112 0v4a7 7 0 11-14 0V7a5 5 0 0110 0v4a3 3 0 11-6 0V7a1 1 0 012 0v4a1 1 0 102 0V7a3 3 0 00-3-3z" clipRule="evenodd" />
          </svg>
        </Button>}

        <TextArea
          ref={composerRef}
          value={input}
          aria-label="对话输入"
          autoFocus={!isCenter}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isCenter ? (isPersonal ? '咨询餐饮经营问题' : '向对账 Agent 提问') : '输入消息'}
          autoSize={{ minRows: 1, maxRows: MAX_ROWS }}
          className={`flex-1 bg-transparent resize-none self-center border-0 text-slate-800 shadow-none placeholder-slate-400 focus:outline-none focus:ring-0 ${
            isCenter ? 'text-base py-1' : 'text-sm'
          }`}
          style={{ lineHeight: `${LINE_HEIGHT}px` }}
        />

        <Button
          htmlType="button"
          onClick={() => handleSend(input)}
          disabled={sending || Boolean(unresolvedAgui) || (!input.trim() && pendingFiles.length === 0)}
          aria-label="发送消息"
          className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-2xl border-0 bg-blue-600 p-0 text-white shadow-md shadow-blue-200 hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none transition-all duration-200 cursor-pointer focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 ${
            isCenter ? '' : 'mb-0.5 rounded-lg'
          }`}
        >
          {sending ? (
            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
            </svg>
          ) : (
            <svg className="w-4 h-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
            </svg>
          )}
        </Button>
      </div>
    );
  }

  if (!activeSessionId) {
    return (
      <div className="flex-1 flex items-center justify-center bg-slate-50">
        <div className="text-center text-slate-400">
          <svg className="w-12 h-12 mx-auto mb-3 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path strokeLinecap="round" strokeLinejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
          </svg>
          <p className="text-sm">选择一个对话或新建对话</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col bg-[#f7f9fc]">
      {/* 顶部标题栏 */}
      <div className="hidden min-h-14 items-center justify-between border-b border-slate-200/80 bg-white px-6 py-3 md:flex">
        <h2 className="truncate text-sm font-semibold text-slate-800">{session?.title ?? '对话'}</h2>
        {role === 'admin' && messages.length > 0 && !session?.pending && (
          <Button
            onClick={() => setShowExtract(true)}
            title="把本次对话中的稳定结论沉淀为知识"
            className="flex h-9 items-center gap-1.5 rounded-lg border border-blue-200 bg-white px-3 text-xs font-medium text-blue-600 shadow-none transition-colors hover:bg-blue-50 focus-visible:ring-2 focus-visible:ring-blue-200 cursor-pointer"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 20 20" fill="currentColor">
              <path d="M5 4a2 2 0 012-2h6a2 2 0 012 2v14l-5-2.5L5 18V4z" />
            </svg>
            归档为知识
          </Button>
        )}
      </div>
      <div className="border-b border-slate-200 bg-white px-3 py-2 md:hidden">
        <div className="flex min-w-0 items-center gap-2">
          <Button
            autoInsertSpace={false}
            htmlType="button"
            className="h-10 shrink-0 rounded-xl border border-slate-200 bg-white px-3 text-xs font-medium text-slate-600 shadow-none"
            onClick={() => setHistoryOpen(true)}
          >
            历史
          </Button>
          <div className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{session?.title ?? '对话'}</div>
          <Button
            autoInsertSpace={false}
            htmlType="button"
            className="h-10 shrink-0 rounded-xl bg-blue-600 px-3 text-xs font-medium text-white shadow-none"
            onClick={() => resetToNewSession()}
          >
            新对话
          </Button>
        </div>
      </div>

      {/* 消息列表 */}
      <div
        ref={messageListRef}
        role="log"
        aria-label="对话消息"
        onScroll={handleMessageScroll}
        className="flex-1 overflow-y-auto overflow-x-hidden overscroll-contain px-3 py-4 md:px-6 md:py-6"
      >
        {isEmptySession && (
          <div className="flex min-h-full items-center justify-center px-1 pb-20 md:px-4 md:pb-24">
            <div className="w-full max-w-3xl">
              <div className="mb-9 flex flex-col items-center text-center">
                <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 shadow-sm">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 11h.01M12 11h.01M15 11h.01M4 19h16a2 2 0 002-2V7a2 2 0 00-2-2H4a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                </div>
                <h1 className="text-2xl font-semibold tracking-tight text-slate-800 md:text-3xl">
                  {isPersonal ? '你好，我是餐饮经营助手' : '你好，我是对账 Agent'}
                </h1>
              </div>

              {!isPersonal && showUpload && (
                <div className="mb-3 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                  <FileUploadArea
                    files={pendingFiles}
                    onFilesChange={setPendingFiles}
                    onClose={() => setShowUpload(false)}
                  />
                </div>
              )}

              {renderComposer('center')}
            </div>
          </div>
        )}
        <div ref={messageContentRef} className="mx-auto w-full max-w-[860px]">
        {messages.map((msg) => {
          if (msg.role === 'tool_call' && hiddenToolCallIds.has(msg.id)) return null;
          const task = msg.taskId && !replayedAguiRunIds.has(msg.taskId) ? taskById.get(msg.taskId) : undefined;
          const retryPrompt = previousQuestionByMessageId.get(msg.id)?.trim();
          const isActiveAgui = msg.agui?.status === 'connecting' || msg.agui?.status === 'running';
          const animateMessage = isAgui && liveMessageIds.has(msg.id)
            && ['connecting', 'running', 'completed'].includes(msg.agui?.status ?? '');
          const showAguiStatus = Boolean(
            msg.agui
            && msg.agui.status !== 'completed'
            && !isActiveAgui,
          );
          return (
          <div key={msg.id}>
            {msg.role === 'tool_call' && msg.toolCall ? (
              <ToolCallCard toolCall={msg.toolCall} />
            ) : (
              <MessageBubble
                message={msg}
                sessionId={activeSessionId!}
                canDelete={!unresolvedAgui}
                animateText={animateMessage}
                loadingAction={isActiveAgui && msg.agui && canReconnectAguiRun(msg.agui.runId) ? (
                  <Button
                    autoInsertSpace={false}
                    htmlType="button"
                    type="text"
                    size="small"
                    aria-label="停止本轮"
                    loading={cancellingAguiRunId === msg.agui.runId}
                    className="h-7 px-2 text-xs font-normal text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                    onClick={() => { void handleAguiCancel(msg.agui!.runId); }}
                  >
                    停止
                  </Button>
                ) : undefined}
                hideStructuredContent={Boolean(msg.agentResponse)}
                structuredContent={msg.role === 'assistant' && msg.agentResponse ? (
                  <ResponsePartsRenderer
                    response={msg.agentResponse}
                    animate={animateMessage}
                    streaming={Boolean(msg.streaming)}
                    animateInsights={animateMessage}
                    onPrompt={async (message) => {
                      const sent = await sendMessage(message);
                      if (sent === false) throw new Error('follow-up prompt send failed');
                    }}
                    onAction={async (action) => {
                      const candidateId = action.params?.candidate_id;
                      const message = action.params?.message;
                      if (
                        action.kind !== 'clarify'
                        || typeof action.source_turn_id !== 'string'
                        || typeof candidateId !== 'string'
                        || typeof message !== 'string'
                      ) throw new Error('invalid clarification action');
                      const sent = await sendMessage(message, undefined, {
                        kind: 'clarification_choice',
                        source_turn_id: action.source_turn_id,
                        candidate_id: candidateId,
                      });
                      if (sent === false) throw new Error('clarification send failed');
                    }}
                    onInteraction={async (interaction) => {
                      const sent = await sendMessage('', undefined, interaction);
                      if (sent === false) throw new Error('questionnaire send failed');
                    }}
                    questionnaireDisabled={sending || Boolean(lastMessage?.streaming) || msg.agui?.status === 'failed' || msg.agui?.status === 'cancelled'}
                    promptDisabled={sending || Boolean(lastMessage?.streaming) || Boolean(unresolvedAgui)}
                  />
                ) : undefined}
              />
            )}
            {msg.agui && showAguiStatus && (
              <div className={`mb-6 ml-10 min-h-9 max-w-[calc(100%_-_2.5rem)] flex-col justify-center rounded-xl text-xs ${
                msg.agui.status === 'failed' || msg.agui.status === 'disconnected'
                  ? 'flex w-[calc(100%_-_2.5rem)] border border-red-200 bg-red-50/70 px-4 py-3 text-red-700'
                  : msg.agui.status === 'waiting_for_approval' || msg.agui.status === 'interrupted'
                    ? 'inline-flex border border-amber-200 bg-amber-50/80 px-3 py-2 text-amber-700'
                    : 'inline-flex px-3 py-2 text-slate-500'
              }`}>
                <div className={msg.agui.status === 'failed' ? 'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between' : undefined}>
                  <div className="min-w-0">
                    <p role="status" aria-live="polite" className="flex items-center gap-2 font-medium text-slate-700">
                      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                        msg.agui.status === 'failed' || msg.agui.status === 'disconnected' ? 'bg-red-500'
                          : msg.agui.status === 'waiting_for_approval' || msg.agui.status === 'interrupted' ? 'bg-amber-500'
                            : msg.agui.status === 'connecting' || msg.agui.status === 'running' ? 'bg-blue-500 motion-safe:animate-pulse'
                              : 'bg-emerald-500'
                      }`} />
                      {msg.agui.status === 'failed' ? '回答生成失败' : AGUI_STATUS_LABELS[msg.agui.status]}
                    </p>
                    {msg.agui.status === 'failed' && (
                      <p className="mt-1 text-xs leading-5 text-slate-600">{msg.agui.retryable
                        ? '分析服务未能完成本次请求。你可以重新生成，或稍后再试。'
                        : '请修改查询条件后重新提问。'}</p>
                    )}
                  </div>
                  {msg.agui.status === 'failed' && msg.agui.retryable && retryPrompt && (
                    <Button
                      autoInsertSpace={false}
                      htmlType="button"
                      size="small"
                      icon={<ReloadOutlined />}
                      aria-label="重新生成"
                      disabled={sending || Boolean(unresolvedAgui)}
                      className="shrink-0 border-red-200 bg-white text-red-700 shadow-none hover:border-red-300 hover:text-red-800"
                      onClick={() => { void handleSend(retryPrompt); }}
                    >
                      重新生成
                    </Button>
                  )}
                </div>
                {msg.agui.detail && msg.agui.status !== 'failed' && (
                  <p className="mt-1 break-words text-xs text-slate-500">{msg.agui.detail}</p>
                )}
                {msg.agui.detail && msg.agui.status === 'failed' && (
                  <details className="mt-3 border-t border-red-100 pt-2 text-xs text-slate-500">
                    <summary className="w-fit cursor-pointer select-none hover:text-slate-700">查看错误详情</summary>
                    <code className="mt-1 block break-all rounded bg-white/70 px-2 py-1 text-[11px]">{msg.agui.detail}</code>
                  </details>
                )}
                {msg.agui.status === 'waiting_for_approval' && msg.agui.approval && canReconnectAguiRun(msg.agui.runId) && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button htmlType="button" type="primary" onClick={() => setAguiApprovalDecision({
                      runId: msg.agui!.runId,
                      toolLabel: msg.agui!.approval!.toolLabel,
                      decision: 'approve',
                    })}>同意执行</Button>
                    <Button htmlType="button" danger onClick={() => setAguiApprovalDecision({
                      runId: msg.agui!.runId,
                      toolLabel: msg.agui!.approval!.toolLabel,
                      decision: 'reject',
                    })}>拒绝</Button>
                  </div>
                )}
                {isAguiUnresolved(msg.agui.status)
                  && (canReconnectAguiRun(msg.agui.runId) || msg.agentResponse?.parts.some((part) => isQuestionnairePart(part)
                  && part.run_id === msg.agui!.runId && (part.status === 'pending' || part.status === 'expired')))
                  && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {msg.agui.status === 'disconnected' && <Button htmlType="button" disabled={cancellingAguiRunId === msg.agui.runId}
                      onClick={() => { void reconnectAguiRun(msg.agui!.runId); }}>重连原任务</Button>}
                    <Button htmlType="button" loading={cancellingAguiRunId === msg.agui.runId}
                      onClick={() => { void handleAguiCancel(msg.agui!.runId); }}>停止本轮</Button>
                  </div>
                )}
              </div>
            )}
            {msg.role === 'assistant' && !msg.streaming && !msg.agentResponse && (
              <LegacyIntentClarificationButtons content={msg.content} onChoose={(value) => sendMessage(value)} />
            )}
            {task && !['general_graph', 'analytics_react', 'deterministic_graph'].includes(task.task_type) ? (
              <TaskCard
                task={task}
                onResearchResume={(researchTask, result) => resumeResearchRun(researchTask, result as AgentRunCommandResult)}
                researchCancelling={cancellingResearchTaskId === task.task_id}
                onResearchCancel={(researchTask) => {
                  if (!cancelResearchInFlightRef.current) setCancelResearch(researchTask);
                }}
              />
            ) : null}
            {(msg.evidence || msg.knowledgeSuggestion || msg.queryExport?.available || hasKnowledgeContext(msg.knowledgeContext)) && (
              <QueryEvidencePanel
                evidence={msg.evidence}
                knowledgeSuggestion={msg.knowledgeSuggestion}
                queryExport={msg.queryExport}
                knowledgeContext={msg.knowledgeContext}
                sessionId={activeSessionId!}
                question={previousQuestionByMessageId.get(msg.id) ?? ''}
                onRequery={(q) => sendMessage(q)}
                isAdmin={role === 'admin'}
              />
            )}
          </div>
          );
        })}
        </div>
      </div>
      {showLatestButton && isGenerating && (
        <Button
          htmlType="button"
          shape="circle"
          size="large"
          icon={<ArrowDownOutlined />}
          aria-label="下滑到最底部"
          title="下滑到最底部"
          className="chat-jump-latest absolute bottom-[84px] right-4 z-20 h-11 w-11 border-blue-100 bg-blue-600 text-white shadow-[0_10px_28px_-8px_rgba(37,99,235,0.65)] transition-colors duration-200 hover:bg-blue-700 focus-visible:ring-2 focus-visible:ring-blue-300 focus-visible:ring-offset-2 md:bottom-[96px] md:right-6"
          onClick={() => {
            followLatestRef.current = true;
            setShowLatestButton(false);
            if (messageListRef.current) scrollMessageListToBottom(messageListRef.current, 'auto');
          }}
        />
      )}

      {/* 重复数据确认弹窗 */}
      {dupConfirm && (
        <ConfirmDialog
          title="检测到重复数据"
          message={
            <div className="space-y-1">
              <p>账期 <span className="font-mono font-medium">{dupConfirm.period}</span> 已有以下数据，是否替换？</p>
              <ul className="mt-2 space-y-1 text-sm">
                {dupConfirm.existing_sources.map((s, i) => {
                  const label = s.source === 'bank'
                    ? `银行流水${s.bill_platform ? `（${s.bill_platform}）` : s.filename ? `（${s.filename}）` : ''}`
                    : `平台账单${s.bill_platform ? `（${s.bill_platform}）` : s.filename ? `（${s.filename}）` : ''}`;
                  return (
                    <li key={i} className="flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />
                      <span>{label}，共 <span className="font-medium">{s.row_count}</span> 条</span>
                    </li>
                  );
                })}
              </ul>
            </div>
          }
          confirmLabel="确认替换"
          onConfirm={() => { dupConfirm.onConfirm(); setDupConfirm(null); }}
          onCancel={() => setDupConfirm(null)}
        />
      )}

      {cancelResearch && (
        <ConfirmDialog
          title="取消经营研究"
          message="确认取消这项经营研究吗？取消后将停止当前研究。"
          confirmLabel="确认取消"
          onConfirm={() => { void confirmResearchCancel(); }}
          onCancel={() => setCancelResearch(null)}
        />
      )}

      {aguiApprovalDecision && (
        <ConfirmDialog
          title={aguiApprovalDecision.decision === 'approve' ? '确认执行操作' : '确认拒绝操作'}
          message={aguiApprovalDecision.decision === 'approve'
            ? `确认允许 Agent 执行“${aguiApprovalDecision.toolLabel}”吗？`
            : `确认拒绝 Agent 执行“${aguiApprovalDecision.toolLabel}”吗？`}
          confirmLabel={aguiApprovalDecision.decision === 'approve' ? '确认执行' : '确认拒绝'}
          onConfirm={() => { void confirmAguiApproval(); }}
          onCancel={() => setAguiApprovalDecision(null)}
        />
      )}

      {/* 文件上传区 */}
      {!isPersonal && showUpload && !isEmptySession && (
        <FileUploadArea
          files={pendingFiles}
          onFilesChange={setPendingFiles}
          onClose={() => setShowUpload(false)}
        />
      )}

      {/* 输入区 */}
      {!isEmptySession && (
        <div className="border-t border-slate-200/80 bg-white/95 px-3 py-2 backdrop-blur md:px-6 md:py-3">
          <div className="mx-auto w-full max-w-[860px]">
            {renderComposer('dock')}
          </div>
        </div>
      )}

      {!isPersonal && showExtract && activeSessionId && (
        <KnowledgeExtractDialog
          sessionId={activeSessionId}
          onClose={() => setShowExtract(false)}
        />
      )}
      <Popup
        visible={historyOpen}
        position="bottom"
        closeOnSwipe
        onMaskClick={() => setHistoryOpen(false)}
        onClose={() => setHistoryOpen(false)}
        bodyClassName="rounded-t-2xl bg-white"
      >
        <div className="max-h-[82dvh] overflow-y-auto px-4 pb-4 pt-4">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div className="text-sm font-semibold text-slate-800">历史对话</div>
            <Button autoInsertSpace={false} htmlType="button" className="h-9 border-0 px-2 text-xs text-slate-500 shadow-none" onClick={() => setHistoryOpen(false)}>关闭</Button>
          </div>
          <Button
            autoInsertSpace={false}
            htmlType="button"
            className="mb-3 h-10 w-full rounded-lg bg-blue-600 text-sm text-white shadow-none"
            onClick={() => {
              resetToNewSession();
              setHistoryOpen(false);
            }}
          >
            新建对话
          </Button>
          {loadingHistory ? (
            <div className="py-6 text-center text-sm text-slate-400">加载中…</div>
          ) : historySessions.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-400">暂无历史对话</div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-slate-100">
              {historySessions.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`flex h-12 w-full min-w-0 items-center justify-between gap-3 border-b border-slate-100 px-3 text-left last:border-b-0 ${
                    item.id === activeSessionId ? 'bg-blue-50 text-blue-700' : 'bg-white text-slate-700'
                  }`}
                  onClick={() => {
                    setActiveSession(item.id);
                    setHistoryOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate text-sm">{item.title || '未命名对话'}</span>
                  <span className="shrink-0 text-xs text-slate-400">{item.messages.length ? `${item.messages.length} 条` : '未加载'}</span>
                </button>
              ))}
            </div>
          )}
          <SafeArea position="bottom" />
        </div>
      </Popup>
    </div>
  );
}

type ClarificationOption = {
  value: string;
  title: string;
  detail: string;
  examples: string[];
};

// LegacyIntentClarificationButtons keeps historical text-only clarification messages interactive.
export function LegacyIntentClarificationButtons({ content, onChoose }: { content: string; onChoose: (value: string) => void }) {
  const options = clarificationOptions(content);
  if (options.length === 0) return null;
  return (
    <div className="ml-0 mt-2 flex flex-col gap-2 md:ml-10 md:flex-row md:flex-wrap">
      {options.map((option) => (
        <Button
          key={option.value}
          htmlType="button"
          onClick={() => onChoose(option.value)}
          title={option.examples.length > 0 ? `例如：${option.examples.join(' / ')}` : option.detail}
          aria-label={`选择${option.title}`}
          className="group inline-flex min-h-11 max-w-full items-center gap-1.5 whitespace-normal rounded-xl border border-blue-200 bg-white px-3.5 py-2 text-left text-sm font-medium leading-5 text-blue-700 shadow-sm transition-all duration-200 hover:border-blue-300 hover:bg-blue-50 hover:shadow-md focus-visible:ring-2 focus-visible:ring-blue-200 md:min-h-9 md:text-xs"
        >
          <span className="truncate">{option.title}</span>
        </Button>
      ))}
    </div>
  );
}

export const IntentClarificationButtons = LegacyIntentClarificationButtons;

export function clarificationOptions(content: string): ClarificationOption[] {
  if (!content.includes('需要先确认你想查哪类数据')) return [];
  const options: ClarificationOption[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*(\d+)\.\s*(.+?)\s*$/);
    if (!match) continue;
    const label = match[2].trim();
    const [rawTitle, ...detailParts] = label.split(/[：:]/);
    const examples: string[] = [];
    let cursor = index + 1;
    while (cursor < lines.length && !/^\s*\d+\.\s*/.test(lines[cursor])) {
      const exampleMatch = lines[cursor].match(/^\s*例[：:]\s*(.+?)\s*$/);
      if (exampleMatch) {
        examples.push(...exampleMatch[1].split('/').map((item) => item.trim()).filter(Boolean));
      }
      cursor += 1;
    }
    options.push({
      value: match[1],
      title: rawTitle.trim() || label,
      detail: detailParts.join('：').trim(),
      examples,
    });
  }
  return options;
}

function hasKnowledgeContext(context?: { trace?: unknown[]; missing?: unknown[]; suggestions?: string[] } | null): boolean {
  return Boolean(
    (context?.trace?.length ?? 0)
    || (context?.missing?.length ?? 0)
    || context?.suggestions?.some((item) => item.trim()),
  );
}
