import { useCallback, useEffect, useRef } from 'react';
import { apiFetch } from '../api/client';
import { cancelAgentRun, type AgentRunCommandResult } from '../api/agentRuns';
import { getQueryEvidence } from '../api/connectors';
import { readSseData } from '../api/sse';
import { useChatStore } from '../store/chatStore';
import { useTaskStore } from '../store/taskStore';
import { parseAgentActivity, parseAgentResponsePayload, parsePublicAgentActivityStep, type AgentActivityStatus, type AgentActivityStep, type AgentResponsePayload, type ChatInteraction, type FileSet, type Message, type MessageStage } from '../types';
import type { AgentRunPublicEvent } from '../types/agentRun';
import { TASK_RUN_STATUS_LABELS, type TaskRecord } from '../types/task';
import { createId } from '../utils/id';
import { useAgentRunEvents } from './useAgentRunEvents';
import { useAguiChat } from './useAguiChat';

interface ExistingSource {
  bill_platform: string | null;
  source: 'bank' | 'platform';
  filename: string;
  row_count: number;
}

interface DuplicateInfo {
  period: string;
  existing_sources: ExistingSource[];
  onConfirm: () => void;
}

interface AgentChatOptions {
  onDuplicate?: (info: DuplicateInfo) => void;
}

interface ResearchRunBinding {
  runId: string;
  sessionId: string;
  messageId: string;
  afterSequence: number;
}

interface ActiveStream {
  controller: AbortController;
  sessionId: string;
  messageId: string;
}

type SendMessageResult = boolean | null;

export function useAgentChat(options: AgentChatOptions = {}) {
  const agui = useAguiChat();
  const loadTasks = useTaskStore((state) => state.loadTasks);
  const durableEvents = useAgentRunEvents();
  const abortRef = useRef<AbortController | null>(null);
  const activeStreamRef = useRef<ActiveStream | null>(null);
  const taskMessagesRef = useRef(new Map<string, { sessionId: string; shown: Set<string> }>());
  const cancelRequestIdsRef = useRef(new Map<string, string>());

  const bindResearchRun = useCallback((binding: ResearchRunBinding) => {
    const { runId, sessionId, messageId, afterSequence } = binding;
    const pollingOwner = `research-run:${runId}`;
    const store = useChatStore.getState();
    let paused = false;
    store.setMessageStreaming(sessionId, messageId, true);
    useTaskStore.getState().startPolling(pollingOwner, { type: 'session', sessionId });
    durableEvents.start(runId, {
      onEvent: async (event) => {
        applyAgentRunEvent(sessionId, messageId, event);
        if (
          event.status === 'waiting_for_data'
          || event.status === 'waiting_for_approval'
          || event.status === 'needs_review'
        ) {
          if (useChatStore.getState().activeSessionId !== sessionId) return;
          await loadTasks(sessionId);
          if (useChatStore.getState().activeSessionId !== sessionId) return;
          paused = true;
          useTaskStore.getState().stopPolling(pollingOwner);
          return;
        }
        const runStatusEvent = event.type === 'status'
          || event.type === 'final'
          || event.type === 'failed';
        if (!runStatusEvent || !event.status) return;
        if (useChatStore.getState().activeSessionId !== sessionId) return;
        await loadTasks(sessionId);
        if (useChatStore.getState().activeSessionId !== sessionId) return;
        if (
          event.status === 'queued'
          || event.status === 'running'
          || event.status === 'validating'
        ) {
          useTaskStore.getState().startPolling(pollingOwner, { type: 'session', sessionId });
        } else {
          useTaskStore.getState().stopPolling(pollingOwner);
        }
      },
      onCleanup: () => {
        useTaskStore.getState().stopPolling(pollingOwner);
        if (paused) return;
        const current = useChatStore.getState();
        current.finishMessageActivity(sessionId, messageId, 'interrupted');
        current.setMessageStage(sessionId, messageId, null);
        current.setMessageStreaming(sessionId, messageId, false);
        if (current.activeSessionId === sessionId) {
          void loadTasks(sessionId);
        }
      },
    }, afterSequence);
    void loadTasks(sessionId);
  }, [durableEvents, loadTasks]);

  useEffect(() => {
    const unsubscribeTasks = useTaskStore.subscribe((state) => {
      for (const [taskId, tracked] of taskMessagesRef.current) {
        const task = state.tasks.find((item) => item.task_id === taskId);
        if (!task) continue;
        const meta = task.meta as Record<string, unknown> | null;
        const agentMessage = meta?.agent_message;
        if (typeof agentMessage === 'string' && agentMessage && !tracked.shown.has(agentMessage)) {
          tracked.shown.add(agentMessage);
          useChatStore.getState().addMessage(tracked.sessionId, {
            id: createId(),
            role: 'assistant',
            content: agentMessage,
            createdAt: Date.now(),
          });
        }
        if (task.status === 'completed' || task.status === 'failed') {
          taskMessagesRef.current.delete(taskId);
        }
      }
    });
    return () => {
      const active = activeStreamRef.current;
      if (active) {
        useChatStore.getState().finishMessageActivity(active.sessionId, active.messageId, 'interrupted');
        active.controller.abort();
        activeStreamRef.current = null;
      }
      abortRef.current?.abort();
      abortRef.current = null;
      taskMessagesRef.current.clear();
      unsubscribeTasks();
    };
  }, []);

  async function uploadFiles(
    localSessionId: string,
    backendSessionId: string,
    loadingMsgId: string,
    text: string,
    files: FileSet,
  ): Promise<boolean> {
    const store = useChatStore.getState();
    let messageSessionId = localSessionId;
    if (files.replace) {
      store.updateMessage(messageSessionId, loadingMsgId, '正在替换重复数据并重新解析...');
      store.setMessageStreaming(messageSessionId, loadingMsgId, true);
    }

    try {
      const form = new FormData();
      form.append('session_id', backendSessionId);
      form.append('task_type', files.taskType ?? 'file_parsing');
      form.append('message', text);
      if (files.period) form.append('period', files.period);
      if (files.replace) form.append('replace', 'true');
      for (const file of files.files) form.append('files', file);

      const res = await apiFetch('/api/v1/chat/upload/async', { method: 'POST', body: form });
      const data = await res.json().catch(() => ({})) as any;
      const responseSessionId = (data.session_id as string) || backendSessionId;
      if (responseSessionId && responseSessionId !== messageSessionId) {
        store.updateSessionId(messageSessionId, responseSessionId);
        messageSessionId = responseSessionId;
      }

      if (data.duplicate) {
        store.updateMessage(messageSessionId, loadingMsgId, '检测到重复数据，请确认是否替换。');
        store.setMessageStreaming(messageSessionId, loadingMsgId, false);
        options.onDuplicate?.({
          period: data.period,
          existing_sources: data.existing_sources,
          onConfirm: () => uploadFiles(
            messageSessionId,
            responseSessionId || messageSessionId,
            loadingMsgId,
            text,
            { ...files, replace: true },
          ),
        });
        return true;
      }
      if (!res.ok || data.error) {
        const errText = data.message || data.detail || data.error || '未知错误';
        const prefix = res.status === 503 ? '' : '上传失败：';
        store.updateMessage(messageSessionId, loadingMsgId, `${prefix}${errText}`);
        store.setMessageStreaming(messageSessionId, loadingMsgId, false);
        return false;
      }

      store.updateMessage(messageSessionId, loadingMsgId, '文件已上传，正在后台解析...');
      store.setMessageStreaming(messageSessionId, loadingMsgId, false);

      const taskId = data.task_id as string;
      if (taskId) {
        store.updateMessageTaskId(messageSessionId, loadingMsgId, taskId);
        taskMessagesRef.current.set(taskId, { sessionId: messageSessionId, shown: new Set() });
      }
      void loadTasks(messageSessionId);
      return true;
    } catch (error) {
      store.updateMessage(messageSessionId, loadingMsgId, `上传失败：${(error as Error).message}`);
      store.setMessageStreaming(messageSessionId, loadingMsgId, false);
      return false;
    }
  }

  async function sendMessage(text: string, files?: FileSet, interaction?: ChatInteraction): Promise<SendMessageResult> {
    const store = useChatStore.getState();
    const { activeSessionId, createSession } = store;
    const localSessionId = activeSessionId ?? createSession();

    const activeSession = useChatStore.getState().sessions.find((s) => s.id === localSessionId);
    if (activeSession?.conversationMode === 'agui' && !files?.files.length) {
      return agui.sendMessage(text, interaction);
    }
    const backendSessionId = activeSession?.pending ? '' : localSessionId;

    const userContent = files?.files.length
      ? `${text}${files.files.map((f) => `\n📎 ${f.name}`).join('')}`
      : text;
    const userMsg: Message = { id: createId(), role: 'user', content: userContent, createdAt: Date.now() };
    store.addMessage(localSessionId, userMsg);
    if (store.sessions.find((s) => s.id === localSessionId)?.messages.length === 1) {
      store.updateSessionTitle(localSessionId, text.slice(0, 20));
    }

    // 有文件 → 走异步任务路径
    if (files?.files.length) {
      // 先加一条 loading 占位消息
      const loadingMsgId = createId();
      store.addMessage(localSessionId, {
        id: loadingMsgId,
        role: 'assistant',
        content: '正在上传并解析文件...',
        createdAt: Date.now(),
        streaming: true,
      });

      return uploadFiles(localSessionId, backendSessionId, loadingMsgId, text, files);
    }

    // 无文件 → SSE 路径
    const assistantMsgId = createId();
    const assistantMsg: Message = { id: assistantMsgId, role: 'assistant', content: '', createdAt: Date.now(), streaming: true };
    store.addMessage(localSessionId, assistantMsg);

    const previousStream = activeStreamRef.current;
    if (previousStream) {
      store.finishMessageActivity(previousStream.sessionId, previousStream.messageId, 'interrupted');
      previousStream.controller.abort();
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    activeStreamRef.current = { controller, sessionId: localSessionId, messageId: assistantMsgId };
    let resolvedSessionId = localSessionId;
    let hasVisibleText = false;
    let hasPublicActivity = false;
    let streamCompleted = false;
    let terminalFailure = false;
    let businessTerminalStatus: Exclude<AgentActivityStatus, 'running'> | null = null;
    let backgroundRun = false;
    let pendingAssistantText = '';
    let textFlushFrame: number | null = null;

    const commitAssistantText = () => {
      if (!pendingAssistantText) return;
      const chunk = pendingAssistantText;
      pendingAssistantText = '';
      useChatStore.getState().appendAssistantChunk(resolvedSessionId, assistantMsgId, chunk);
    };
    const flushAssistantText = () => {
      if (textFlushFrame !== null) {
        cancelAnimationFrame(textFlushFrame);
        textFlushFrame = null;
      }
      commitAssistantText();
    };
    const enqueueAssistantText = (chunk: string) => {
      pendingAssistantText += chunk;
      if (textFlushFrame !== null) return;
      textFlushFrame = requestAnimationFrame(() => {
        textFlushFrame = null;
        commitAssistantText();
      });
    };

    try {
      const response = await _fetchSSE(text, backendSessionId, controller.signal, interaction);
      if (!response.ok || !response.body) {
        const errData = await response.json().catch(() => ({})) as any;
        store.appendAssistantChunk(localSessionId, assistantMsgId, errData.message || '请求失败，请重试');
        store.setMessageStreaming(localSessionId, assistantMsgId, false);
        return false;
      }

      let turnCategory = '';

      streamLoop: for await (const raw of readSseData(response.body, controller.signal)) {
          if (raw === '[DONE]') {
            streamCompleted = true;
            break streamLoop;
          }

          // 所有内容都是 JSON：字符串 = 流式 token，对象 = 控制消息
          let text: string | null = null;
          try {
            const parsed = JSON.parse(raw);
            if (typeof parsed === 'string') {
              text = parsed;
            } else {
              const type = (parsed as Record<string, unknown>).type as string | undefined;
              if (type === 'text') {
                text = (parsed as Record<string, unknown>).content as string;
              } else if (type === 'meta') {
                const newSessionId = parsed.session_id as string;
                if (newSessionId && newSessionId !== resolvedSessionId) {
                  store.updateSessionId(resolvedSessionId, newSessionId);
                  resolvedSessionId = newSessionId;
                  if (activeStreamRef.current?.controller === controller) {
                    activeStreamRef.current.sessionId = newSessionId;
                  }
                }
                turnCategory = (parsed.category as string) || '';
                if (Object.prototype.hasOwnProperty.call(parsed, 'agent_response')) {
                  const agentResponse = parseAgentResponsePayload(parsed.agent_response);
                  if (agentResponse) {
                    store.setMessageAgentResponse(resolvedSessionId, assistantMsgId, agentResponse);
                    businessTerminalStatus = agentResponseActivityStatus(agentResponse.result_status);
                  } else {
                    businessTerminalStatus = 'failed';
                  }
                }
                const agentActivity = parseAgentActivity(parsed.agent_activity);
                if (agentActivity) {
                  hasPublicActivity = true;
                  store.setMessageActivity(resolvedSessionId, assistantMsgId, agentActivity);
                }
                const runId = parsed.background === true && typeof parsed.run_id === 'string'
                  ? parsed.run_id
                  : null;
                if (runId) {
                  backgroundRun = true;
                  store.updateMessageTaskId(resolvedSessionId, assistantMsgId, runId);
                  bindResearchRun({
                    runId,
                    sessionId: resolvedSessionId,
                    messageId: assistantMsgId,
                    afterSequence: 0,
                  });
                }
              } else if (type === 'stage') {
                const activityStep = parsePublicAgentActivityStep(parsed);
                if (activityStep) {
                  hasPublicActivity = true;
                  store.upsertMessageActivityStep(resolvedSessionId, assistantMsgId, activityStep);
                } else {
                  const stage: MessageStage = {
                    code: typeof parsed.code === 'string' ? parsed.code : 'processing',
                    label: typeof parsed.label === 'string' ? parsed.label : '正在处理',
                    detail: typeof parsed.detail === 'string' ? parsed.detail : undefined,
                    status: parsed.status === 'completed' || parsed.status === 'failed' ? parsed.status : 'running',
                  };
                  store.setMessageStage(resolvedSessionId, assistantMsgId, stage);
                }
              } else if (type === 'error') {
                const errorMessage = typeof parsed.message === 'string'
                  ? parsed.message
                  : '系统处理请求时出错了，请稍后再试。';
                flushAssistantText();
                useChatStore.getState().appendAssistantChunk(resolvedSessionId, assistantMsgId, errorMessage);
                terminalFailure = true;
                store.finishMessageActivity(resolvedSessionId, assistantMsgId, 'failed');
                break streamLoop;
              } else if (type === 'tool_call') {
                if (!hasPublicActivity) store.addMessage(resolvedSessionId, {
                  id: createId(),
                  role: 'tool_call',
                  content: '',
                  createdAt: Date.now(),
                  toolCall: {
                    name: (parsed.name as string) ?? '工具调用',
                    description: (parsed.description as string) ?? '',
                    status: 'loading',
                  },
                });
              } else if (type === 'approval_request') {
                store.setPendingApproval({
                  action: (parsed.action as string) ?? '',
                  description: (parsed.description as string) ?? '',
                  turnId: (parsed.turn_id as string) ?? '',
                });
              }
            }
          } catch {
            text = raw; // 非 JSON 兼容旧格式
          }

          if (text !== null) {
            if (!hasVisibleText) {
              hasVisibleText = true;
              if (!hasPublicActivity) store.setMessageStage(resolvedSessionId, assistantMsgId, null);
            }
            enqueueAssistantText(text);
          }
      }
      flushAssistantText();
      if (!backgroundRun && hasPublicActivity && !terminalFailure) {
        store.finishMessageActivity(
          resolvedSessionId,
          assistantMsgId,
          streamCompleted ? (businessTerminalStatus ?? 'completed') : 'interrupted',
        );
      }
      // 业务查询完成后，拉取本会话「查询依据」+「待补知识建议」挂到本条回复。
      if (!backgroundRun && !terminalFailure && shouldLoadQueryEvidence(turnCategory)) {
        try {
          const ev = await getQueryEvidence(resolvedSessionId);
          if (ev.evidence || ev.knowledge_suggestion || ev.export || ev.knowledge_context) {
            store.setMessageEvidence(
              resolvedSessionId,
              assistantMsgId,
              ev.evidence,
              ev.knowledge_suggestion,
              ev.export,
              ev.knowledge_context ?? null,
            );
          }
        } catch {
          // 查询依据为辅助信息，拉取失败不影响主回复
        }
      }
      return !terminalFailure && businessTerminalStatus !== 'failed';
    } catch (err) {
      flushAssistantText();
      store.finishMessageActivity(resolvedSessionId, assistantMsgId, 'interrupted');
      if ((err as Error).name === 'AbortError') return null;
      if (!backgroundRun) {
        useChatStore.getState().appendAssistantChunk(resolvedSessionId, assistantMsgId, '\n\n[请求失败，请重试]');
      }
      return false;
    } finally {
      flushAssistantText();
      if (!backgroundRun) {
        if (!hasPublicActivity) store.setMessageStage(resolvedSessionId, assistantMsgId, null);
        store.setMessageStreaming(resolvedSessionId, assistantMsgId, false);
      }
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      if (activeStreamRef.current?.controller === controller) {
        activeStreamRef.current = null;
      }
    }
  }

  async function approveAction(action: string) {
    const store = useChatStore.getState();
    store.setPendingApproval(null);
    await sendMessage(`同意执行: ${action}`);
  }

  async function resumeResearchRun(task: TaskRecord, result: AgentRunCommandResult) {
    const store = useChatStore.getState();
    const sessionId = store.activeSessionId;
    const session = sessionId ? store.sessions.find((item) => item.id === sessionId) : undefined;
    const message = session?.messages.find((item) => item.role === 'assistant' && item.taskId === task.task_id);
    if (!sessionId || !message) return;
    await loadTasks(sessionId);
    if (useChatStore.getState().activeSessionId !== sessionId) return;
    const label = TASK_RUN_STATUS_LABELS[result.run_status];
    applyAgentRunEvent(sessionId, message.id, {
      sequence: result.event_cursor,
      type: 'status',
      stage: result.run_status,
      label,
      status: result.run_status,
    });
    store.setMessageStreaming(sessionId, message.id, true);
    bindResearchRun({
      runId: task.task_id,
      sessionId,
      messageId: message.id,
      afterSequence: result.event_cursor,
    });
  }

  async function cancelResearchRun(task: TaskRecord) {
    const store = useChatStore.getState();
    const sessionId = store.activeSessionId;
    const session = sessionId ? store.sessions.find((item) => item.id === sessionId) : undefined;
    const message = session?.messages.find((item) => item.role === 'assistant' && item.taskId === task.task_id);
    if (!sessionId || !message) return;
    const requestId = cancelRequestIdsRef.current.get(task.task_id) ?? createId();
    cancelRequestIdsRef.current.set(task.task_id, requestId);
    await cancelAgentRun(task.task_id, requestId);
    cancelRequestIdsRef.current.delete(task.task_id);
    await loadTasks(sessionId);
    durableEvents.cancel(task.task_id);
    useTaskStore.getState().stopPolling(`research-run:${task.task_id}`);
    store.finishMessageActivity(sessionId, message.id, 'cancelled');
    store.setMessageStage(sessionId, message.id, null);
    store.setMessageStreaming(sessionId, message.id, false);
  }

  function cancel() {
    const active = activeStreamRef.current;
    if (active) {
      useChatStore.getState().finishMessageActivity(active.sessionId, active.messageId, 'cancelled');
    }
    abortRef.current?.abort();
    durableEvents.cancel();
  }

  return { sendMessage, approveAction, cancel, resumeResearchRun, cancelResearchRun,
    reconnectAguiRun: agui.reconnect, cancelAguiRun: agui.cancel,
    decideAguiApproval: agui.decideApproval, canReconnectAguiRun: agui.canReconnect };
}

function agentResponseActivityStatus(
  status: AgentResponsePayload['result_status'],
): Exclude<AgentActivityStatus, 'running'> {
  if (status === 'ok') return 'completed';
  return status;
}

function applyAgentRunEvent(sessionId: string, messageId: string, event: AgentRunPublicEvent) {
  const store = useChatStore.getState();
  if (event.text) {
    store.setMessageStage(sessionId, messageId, null);
    store.appendAssistantChunk(sessionId, messageId, event.text);
  }
  if (event.status || event.stage || event.label) {
    const terminal = event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled';
    const activityStatus: AgentActivityStatus = event.status === 'failed'
      ? 'failed'
      : event.status === 'cancelled'
        ? 'cancelled'
        : event.status === 'completed'
          ? 'completed'
          : 'running';
    const activityStep: AgentActivityStep = {
      step_id: `research:${event.stage ?? event.status ?? event.type}`.slice(0, 64),
      label: (event.status ? TASK_RUN_STATUS_LABELS[event.status] : event.label ?? '正在研究').slice(0, 24),
      ...(event.detail ? { detail: event.detail.slice(0, 60) } : {}),
      status: activityStatus,
      elapsed_ms: 0,
      sequence: Number.isSafeInteger(event.sequence) && event.sequence >= 0 ? event.sequence : 0,
    };
    store.upsertMessageActivityStep(sessionId, messageId, activityStep);
    store.setMessageStage(sessionId, messageId, {
      code: event.stage ?? event.status ?? event.type,
      label: event.status ? TASK_RUN_STATUS_LABELS[event.status] : event.label ?? '正在研究',
      detail: event.detail,
      status: event.status === 'failed' ? 'failed' : terminal ? 'completed' : 'running',
    });
    if (terminal) store.finishMessageActivity(sessionId, messageId, activityStatus as Exclude<AgentActivityStatus, 'running'>);
  }
}

function shouldLoadQueryEvidence(category: string): boolean {
  return Boolean(category) && category !== 'chat' && category !== 'off_topic';
}

async function _fetchSSE(
  message: string,
  sessionId: string,
  signal: AbortSignal,
  interaction?: ChatInteraction,
): Promise<Response> {
  return apiFetch('/api/v1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, session_id: sessionId, ...(interaction ? { interaction } : {}) }),
    signal,
  });
}
