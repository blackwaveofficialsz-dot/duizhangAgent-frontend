import { useEffect, useRef } from 'react';
import { notification } from 'antd';
import { AguiClarificationError, fetchAguiRunResult, streamAguiRun, streamAguiClarification, type AguiClarificationInput } from '../api/agui';
import { approveAgentRun, cancelAgentRun, type AgentRunApprovalDecision } from '../api/agentRuns';
import { registerSessionCleanup } from '../api/sessionLifecycle';
import { useChatStore } from '../store/chatStore';
import { isQuestionnairePart, parseAgentActivity, parseAgentResponsePayload, type ChatInteraction } from '../types';
import { aguiRecord, isAguiEnabled, isAguiUnresolved, type AguiApproval, type AguiEvent, type AguiRunInput, type AguiStatus } from '../types/agui';
import { createId } from '../utils/id';
import { parseBeijingTime } from '../utils/time';

interface RunContext {
  input: AguiRunInput;
  canonicalSessionId?: string;
  messageId: string;
  seen: Set<string>;
  lastEventId?: string;
  textMessageId?: string;
  controller?: AbortController;
  cancelRequestId?: string;
  cancelling?: boolean;
  approval?: AguiApproval;
  approvalRequestIds?: Partial<Record<AgentRunApprovalDecision, string>>;
  decidingApproval?: boolean;
  clarification?: AguiClarificationInput;
  questionnaireMessageId?: string;
}

// 未结束请求只保留在当前页面；刷新后从会话历史恢复，页面内断线使用事件游标续传。
export function useAguiChat() {
  const runs = useRef(new Map<string, RunContext>());
  const messageFor = (run: RunContext) => useChatStore.getState().sessions
    .find((session) => session.id === run.input.threadId)?.messages.find((message) => message.id === run.messageId);

  function setStatus(run: RunContext, status: AguiStatus, detail?: string, retryable?: boolean) {
    if (!messageFor(run)) return;
    useChatStore.getState().setMessageAgui(run.input.threadId, run.messageId, {
      runId: run.input.runId,
      status,
      ...(detail ? { detail } : {}),
      ...(retryable !== undefined ? { retryable } : {}),
      ...(run.approval ? { approval: run.approval } : {}),
    });
  }

  function setQuestionnaireStatus(run: RunContext, status: 'expired' | 'cancelled') {
    const store = useChatStore.getState();
    const session = store.sessions.find((item) => item.id === run.input.threadId);
    for (const message of session?.messages ?? []) {
      const response = message.agentResponse;
      if (!response?.parts.some((part) => isQuestionnairePart(part) && part.run_id === run.input.runId && part.status === 'pending')) continue;
      store.setMessageAgentResponse(session!.id, message.id, {
        ...response, parts: response.parts.map((part) => isQuestionnairePart(part)
          && part.run_id === run.input.runId && part.status === 'pending' ? { ...part, status } : part),
      });
    }
  }

  function finish(run: RunContext, status: AguiStatus, detail?: string, retryable?: boolean, finishQuestionnaire = true) {
    const store = useChatStore.getState();
    setStatus(run, status, detail, retryable);
    store.setMessageStreaming(run.input.threadId, run.messageId, false);
    store.setMessageStage(run.input.threadId, run.messageId, null);
    const resultStatus = messageFor(run)?.agentResponse?.result_status;
    store.finishMessageActivity(run.input.threadId, run.messageId,
      status === 'completed' ? (resultStatus && resultStatus !== 'ok' ? resultStatus : 'completed')
        : status === 'failed' || status === 'cancelled' ? status : 'interrupted');
    if (status === 'cancelled') setQuestionnaireStatus(run, 'cancelled');
    if (finishQuestionnaire && run.questionnaireMessageId && !isAguiUnresolved(status)) {
      const original = store.sessions.find((session) => session.id === run.input.threadId)?.messages
        .find((message) => message.id === run.questionnaireMessageId);
      if (original?.agui && original.agui.status !== 'completed') {
        store.setMessageAgui(run.input.threadId, original.id, { ...original.agui, status });
      }
    }
  }

  useEffect(() => {
    const detach = (run: RunContext) => {
      if (!run.controller) return;
      run.controller.abort();
      finish(run, 'disconnected');
    };
    const clear = () => {
      for (const run of runs.current.values()) detach(run);
      runs.current.clear();
    };
    const unregister = registerSessionCleanup(clear);
    const unsubscribe = useChatStore.subscribe((state, previous) => {
      for (const [id, run] of runs.current) {
        if (!state.sessions.some((session) => session.id === run.input.threadId)) {
          runs.current.delete(id);
          run.controller?.abort();
        } else if (state.activeSessionId !== previous.activeSessionId && run.input.threadId !== state.activeSessionId) {
          detach(run); // 离开页面只断开订阅，不能取消服务端任务。
        }
      }
    });
    return () => { unregister(); unsubscribe(); clear(); };
  }, []);

  function apply(run: RunContext, event: AguiEvent): boolean {
    const store = useChatStore.getState();
    const { threadId } = run.input;
    const messageId = run.messageId;
    switch (event.type) {
      case 'RUN_STARTED':
        setStatus(run, 'running');
        break;
      case 'TEXT_MESSAGE_START':
        if (typeof event.messageId !== 'string' || event.role !== 'assistant') throw new Error('回复消息格式不匹配。');
        if (run.textMessageId && run.textMessageId !== event.messageId && messageFor(run)?.content) {
          store.appendAssistantChunk(threadId, messageId, '\n\n');
        }
        run.textMessageId = event.messageId;
        break;
      case 'TEXT_MESSAGE_CONTENT':
        if (event.messageId !== run.textMessageId || typeof event.delta !== 'string') throw new Error('回复片段无法关联到当前消息。');
        store.appendAssistantChunk(threadId, messageId, event.delta);
        setStatus(run, 'running');
        break;
      case 'TEXT_MESSAGE_END':
        // 文本结束不等于业务完成，仍等待 RUN_FINISHED / RUN_ERROR。
        break;
      case 'TOOL_CALL_START':
      case 'TOOL_CALL_END':
      case 'TOOL_CALL_RESULT': {
        if (typeof event.toolCallId !== 'string' || !event.toolCallId) throw new Error('工具事件缺少关联标识。');
        let result: Record<string, unknown> | null = null;
        if (event.type === 'TOOL_CALL_RESULT' && typeof event.content === 'string') {
          try { result = aguiRecord(JSON.parse(event.content)); } catch { /* 不展示未验证的工具原文。 */ }
        }
        store.upsertMessageActivityStep(threadId, messageId, {
          step_id: `agui:${event.toolCallId}`.slice(0, 64),
          label: typeof result?.label === 'string' && result.label.trim() ? result.label.slice(0, 24) : '工具处理',
          ...(typeof result?.label === 'string' ? { detail: result.label.slice(0, 60) } : {}),
          status: event.type === 'TOOL_CALL_START' ? 'running' : result?.status === 'failed' ? 'failed' : 'completed',
          elapsed_ms: 0, sequence: event.sequence,
        });
        break;
      }
      case 'TOOL_CALL_ARGS':
        // 参数不执行、不授权；增量/整串语义待后端冻结。
        break;
      case 'STATE_SNAPSHOT': {
        const snapshot = aguiRecord(event.snapshot);
        const response = parseAgentResponsePayload(snapshot?.agent_response);
        if (response) {
          const answered = response.parts.filter((part) => isQuestionnairePart(part)
            && part.status === 'answered' && part.run_id === run.input.runId
            && part.clarification_id === run.clarification?.clarificationId);
          const original = store.sessions.find((session) => session.id === threadId)?.messages
            .find((message) => message.id === run.questionnaireMessageId);
          if (answered.length && original?.agentResponse) {
            store.setMessageAgentResponse(threadId, original.id, {
              ...original.agentResponse,
              parts: original.agentResponse.parts.map((part) => answered.find((answer) =>
                isQuestionnairePart(part) && isQuestionnairePart(answer)
                && part.run_id === answer.run_id && part.clarification_id === answer.clarification_id) ?? part),
            });
            if (original.agui) store.setMessageAgui(threadId, original.id, { ...original.agui, status: 'completed' });
            setStatus(run, 'running');
          }
          const parts = response.parts.filter((part) => !answered.includes(part));
          if (!answered.length || parts.length || response.content) {
            store.setMessageAgentResponse(threadId, messageId, { ...response, parts });
          }
        }
        const activity = parseAgentActivity(snapshot?.agent_activity);
        if (activity) store.setMessageActivity(threadId, messageId, activity);
        const approval = aguiRecord(snapshot?.approval);
        if (approval
          && typeof approval.approval_id === 'string'
          && typeof approval.tool_label === 'string'
          && typeof approval.message === 'string'
          && typeof approval.expires_at === 'string') {
          run.approval = {
            id: approval.approval_id.slice(0, 100),
            toolLabel: approval.tool_label.slice(0, 100),
            message: approval.message.slice(0, 240),
            expiresAt: approval.expires_at,
          };
          setStatus(run, 'waiting_for_approval', run.approval.message);
        }
        break;
      }
      case 'RUN_ERROR':
        finish(run, 'failed', typeof event.message === 'string' ? event.message.slice(0, 240) : '服务端处理失败', event.retryable === true);
        return true;
      case 'RUN_FINISHED': {
        const outcome = aguiRecord(event.outcome);
        const result = aguiRecord(event.result);
        const status: AguiStatus = result?.status === 'cancelled' ? 'cancelled'
          : run.approval ? 'waiting_for_approval'
            : outcome && outcome.type !== 'success' ? 'interrupted'
              : messageFor(run)?.agentResponse?.result_status === 'failed' ? 'failed' : 'completed';
        finish(run, status, run.approval?.message);
        return true;
      }
    }
    return false;
  }

  async function consume(run: RunContext): Promise<boolean | null> {
    if (run.controller) return null;
    const controller = new AbortController();
    run.controller = controller;
    const store = useChatStore.getState();
    store.setMessageStreaming(run.input.threadId, run.messageId, true);
    const activity = messageFor(run)?.activity;
    if (activity?.status === 'interrupted') {
      store.setMessageActivity(run.input.threadId, run.messageId, { ...activity, status: 'running', label: '正在恢复任务' });
    }
    setStatus(run, 'connecting');
    let terminal = false;
    try {
      const onSessionId = (id: string) => { run.canonicalSessionId = id; };
      const stream = run.clarification
        ? streamAguiClarification(run.clarification, controller.signal, run.lastEventId, onSessionId)
        : streamAguiRun(run.input, controller.signal, run.lastEventId, onSessionId);
      for await (const event of stream) {
        if (controller.signal.aborted || runs.current.get(run.input.runId) !== run) break;
        if (run.seen.has(event.eventId)) continue;
        terminal = apply(run, event);
        // 先更新界面，再提交精确游标；同一 sequence 的不同 ordinal 都必须消费。
        run.seen.add(event.eventId);
        run.lastEventId = event.eventId;
        if (terminal) break;
      }
      if (!terminal && !controller.signal.aborted) throw new Error('连接中断，尚未收到本轮结束事件。可重连原任务，请勿重复提交。');
      if (terminal && !run.clarification && messageFor(run)?.agui?.status === 'completed') {
        try {
          const content = await fetchAguiRunResult(run.input, controller.signal);
          if (!controller.signal.aborted && runs.current.get(run.input.runId) === run && messageFor(run)?.content !== content) {
            store.updateMessage(run.input.threadId, run.messageId, content);
          }
        } catch {
          if (!controller.signal.aborted && !messageFor(run)?.content
            && useChatStore.getState().activeSessionId === run.input.threadId) {
            notification.error({ message: '完整回复读取失败', description: '事件流回复已保留，请稍后重试。', duration: 5, closable: true });
          }
        }
      }
      if (terminal && messageFor(run)?.agui?.status === 'failed' && useChatStore.getState().activeSessionId === run.input.threadId) {
        notification.error({ message: '新对话处理失败', description: messageFor(run)?.agui?.detail, duration: 5, closable: true });
      }
      return controller.signal.aborted ? null : messageFor(run)?.agui?.status !== 'failed';
    } catch (error) {
      if (controller.signal.aborted) return null;
      const detail = error instanceof Error ? error.message : '接收回复失败，请稍后重连。';
      if (error instanceof AguiClarificationError && error.httpStatus < 500 && error.httpStatus !== 429) {
        const ended = ['clarification_expired', 'clarification_cancelled', 'clarification_run_failed'].includes(error.code)
          || error.httpStatus === 404;
        if (error.code === 'clarification_expired') setQuestionnaireStatus(run, 'expired');
        finish(run, error.code === 'clarification_cancelled' ? 'cancelled' : 'failed', detail, false, ended);
        if (useChatStore.getState().activeSessionId === run.input.threadId) {
          notification.error({ title: '问卷提交失败', description: detail, duration: 5, closable: true });
        }
        return false;
      }
      finish(run, 'disconnected', detail);
      if (useChatStore.getState().activeSessionId === run.input.threadId) {
        notification.error({ message: '新对话接收中断', description: detail, duration: 5, closable: true });
      }
      return false;
    } finally {
      if (!terminal && messageFor(run)?.streaming) finish(run, 'disconnected');
      controller.abort();
      run.controller = undefined;
      const status = messageFor(run)?.agui?.status;
      if (status && !isAguiUnresolved(status)) runs.current.delete(run.input.runId);
      if (terminal && run.canonicalSessionId && run.canonicalSessionId !== run.input.threadId) {
        useChatStore.getState().updateSessionId(run.input.threadId, run.canonicalSessionId);
        run.input = { ...run.input, threadId: run.canonicalSessionId };
        if (run.clarification) run.clarification = { ...run.clarification, threadId: run.canonicalSessionId };
      }
    }
  }

  async function sendMessage(text: string, interaction?: ChatInteraction): Promise<boolean | null> {
    if (interaction?.kind === 'clarification_answer') return answerQuestionnaire(interaction);
    if (!isAguiEnabled() || !text.trim()) return false;
    const store = useChatStore.getState();
    const session = store.sessions.find((item) => item.id === store.activeSessionId);
    if (!session || session.conversationMode !== 'agui'
      || session.messages.some((message) => message.agui && isAguiUnresolved(message.agui.status))) return false;
    const runId = createId();
    const userMessageId = createId();
    const messageId = createId();
    const run: RunContext = {
      input: {
        threadId: session.id, runId, parentRunId: null, state: {},
        messages: [{ id: userMessageId, role: 'user', content: text }],
        tools: [], context: [], forwardedProps: interaction ? { interaction } : {},
      },
      messageId, seen: new Set(),
    };
    runs.current.set(runId, run);
    store.addMessage(session.id, { id: userMessageId, role: 'user', content: text, createdAt: Date.now() });
    store.addMessage(session.id, { id: messageId, role: 'assistant', content: '', streaming: true, createdAt: Date.now() });
    if (!session.messages.length) store.updateSessionTitle(session.id, text.slice(0, 30));
    return consume(run);
  }

  async function answerQuestionnaire(interaction: Extract<ChatInteraction, { kind: 'clarification_answer' }>): Promise<boolean | null> {
    if (!isAguiEnabled()) return false;
    const store = useChatStore.getState();
    const session = store.sessions.find((item) => item.id === store.activeSessionId);
    if (!session || session.conversationMode !== 'agui') return false;
    const original = session.messages.find((message) => message.agentResponse?.source_turn_id === interaction.source_turn_id
      && message.agentResponse.parts.some((part) => isQuestionnairePart(part)
        && part.run_id === interaction.run_id && part.clarification_id === interaction.clarification_id
        && part.status === 'pending' && parseBeijingTime(part.expires_at) > Date.now()));
    const previous = runs.current.get(interaction.run_id);
    if (!original || previous?.controller || previous?.cancelling
      || session.messages.some((message) => message.id !== original.id && message.agui && isAguiUnresolved(message.agui.status))) return false;
    const part = original.agentResponse!.parts.find((item) => isQuestionnairePart(item)
      && item.run_id === interaction.run_id && item.clarification_id === interaction.clarification_id)!;
    if (!parseAgentResponsePayload({
      ...original.agentResponse, parts: [{ ...part, status: 'answered', answers: interaction.answers }],
    })) return false;
    const messageId = createId();
    const run: RunContext = {
      input: previous?.input ?? {
        threadId: session.id, runId: interaction.run_id, parentRunId: null, state: {}, messages: [],
        tools: [], context: [], forwardedProps: {},
      },
      messageId, seen: previous?.seen ?? new Set(), lastEventId: previous?.lastEventId,
      questionnaireMessageId: original.id,
      clarification: {
        threadId: session.id, runId: interaction.run_id, requestId: createId(),
        clarificationId: interaction.clarification_id, answers: interaction.answers,
      },
    };
    runs.current.set(interaction.run_id, run);
    store.addMessage(session.id, { id: messageId, role: 'assistant', content: '', streaming: true, createdAt: Date.now() });
    return consume(run);
  }

  function restorableQuestionnaire(runId: string) {
    const store = useChatStore.getState();
    const session = store.sessions.find((item) => item.id === store.activeSessionId && item.conversationMode === 'agui');
    for (const original of session?.messages ?? []) {
      if (original.role !== 'assistant' || original.agui?.runId !== runId) continue;
      const part = original.agentResponse?.parts.filter(isQuestionnairePart).find((item) => item.run_id === runId
        && (item.status === 'pending' || item.status === 'expired'
          || (item.status === 'answered' && original.agui?.status === 'disconnected')));
      if (part) return { session: session!, original, part };
    }
  }

  function restoreRun(runId: string): RunContext | undefined {
    const restored = restorableQuestionnaire(runId);
    if (!restored) return;
    const { session, original, part } = restored;
    const run: RunContext = {
      input: { threadId: session.id, runId, parentRunId: null, state: {}, messages: [], tools: [], context: [], forwardedProps: {} },
      messageId: original.id, seen: new Set(), questionnaireMessageId: original.id,
      ...(part.status === 'answered' && part.answers ? {
        clarification: { threadId: session.id, runId, requestId: createId(),
          clarificationId: part.clarification_id, answers: part.answers },
      } : {}),
    };
    runs.current.set(runId, run);
    return run;
  }

  function reconnect(runId: string) {
    const run = runs.current.get(runId)
      ?? (restorableQuestionnaire(runId)?.part.status === 'answered' ? restoreRun(runId) : undefined);
    if (!run || run.cancelling || messageFor(run)?.agui?.status !== 'disconnected'
      || useChatStore.getState().activeSessionId !== run.input.threadId) return Promise.resolve(false);
    if (run.clarification && run.messageId === run.questionnaireMessageId) {
      run.messageId = createId();
      useChatStore.getState().addMessage(run.input.threadId, {
        id: run.messageId, role: 'assistant', content: '', streaming: true, createdAt: Date.now(),
      });
    }
    return consume(run);
  }

  async function cancel(runId: string) {
    const run = runs.current.get(runId) ?? restoreRun(runId);
    if (!run || run.cancelling) return;
    run.cancelling = true;
    run.cancelRequestId ??= createId();
    try {
      const result = await cancelAgentRun(runId, run.cancelRequestId);
      if (result.run_id !== runId) throw new Error('取消结果与当前任务不匹配。');
      if (runs.current.get(runId) !== run) return;
      if (!['cancelled', 'completed', 'failed'].includes(result.run_status)) {
        throw new Error('服务端尚未确认任务停止，请稍后重试或重连查看状态。');
      }
      run.controller?.abort();
      finish(run, result.run_status as 'cancelled' | 'completed' | 'failed');
      runs.current.delete(runId);
    } finally {
      run.cancelling = false;
    }
  }

  async function decideApproval(runId: string, decision: AgentRunApprovalDecision): Promise<boolean> {
    const run = runs.current.get(runId);
    if (!run || run.decidingApproval || run.controller || !run.approval
      || messageFor(run)?.agui?.status !== 'waiting_for_approval'
      || useChatStore.getState().activeSessionId !== run.input.threadId) return false;
    run.decidingApproval = true;
    run.approvalRequestIds ??= {};
    run.approvalRequestIds[decision] ??= createId();
    try {
      const result = await approveAgentRun(runId, run.approvalRequestIds[decision]!, decision);
      if (result.run_id !== runId) throw new Error('审批结果与当前任务不匹配。');
      if (runs.current.get(runId) !== run) return false;
      run.approval = undefined;
      if (result.run_status === 'completed' || result.run_status === 'failed' || result.run_status === 'cancelled') {
        finish(run, result.run_status);
        runs.current.delete(runId);
        return true;
      }
      return (await consume(run)) !== false;
    } finally {
      run.decidingApproval = false;
    }
  }

  return { sendMessage, reconnect, cancel, decideApproval,
    canReconnect: (runId: string) => runs.current.has(runId) || restorableQuestionnaire(runId)?.part.status === 'answered' };
}
