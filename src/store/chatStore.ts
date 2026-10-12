import { notification } from 'antd';
import { create } from 'zustand';
import { apiFetch } from '../api/client';
import { finishAgentActivity, isQuestionnairePart, mergeAgentActivityStep, parseAgentActivity, parseAgentResponsePayload, type AgentActivity, type AgentActivityStatus, type AgentActivityStep, type AgentResponsePayload, type ApprovalRequest, type KnowledgeContext, type KnowledgeSuggestion, type Message, type MessageStage, type QueryEvidence, type QueryExportInfo, type Session, type ToolCallStatus } from '../types';
import { createId } from '../utils/id';
import { parseBeijingTime } from '../utils/time';
import { registerSessionCleanup } from '../api/sessionLifecycle';
import { isAguiEnabled, type AguiMessageState, type ConversationMode } from '../types/agui';

type ConnectorMessageMetadata = {
  agent_response?: unknown;
  agent_activity?: unknown;
  delivery_status?: unknown;
  execution_path?: unknown;
  failure_detail?: unknown;
  retryable?: unknown;
  run_id?: unknown;
  connector_query?: {
    evidence?: QueryEvidence | null;
    knowledge_suggestion?: KnowledgeSuggestion | null;
    export?: QueryExportInfo | null;
    knowledge_context?: KnowledgeContext | null;
  };
};

interface ChatState {
  sessions: Session[];
  activeSessionId: string | null;
  loadingHistory: boolean;
  pendingApproval: ApprovalRequest | null;

  // 会话操作
  createSession: () => string;
  setConversationMode: (sessionId: string, mode: ConversationMode) => void;
  setMessageAgui: (sessionId: string, messageId: string, state: AguiMessageState) => void;
  setActiveSession: (id: string) => void;
  loadSessionHistory: (sessionId: string) => Promise<void>;
  fetchUserSessions: () => Promise<void>;
  resetToNewSession: () => void;
  deleteSession: (sessionId: string) => Promise<void>;

  // 消息操作
  addMessage: (sessionId: string, msg: Message) => void;
  appendAssistantChunk: (sessionId: string, msgId: string, chunk: string) => void;
  setMessageStreaming: (sessionId: string, msgId: string, streaming: boolean) => void;
  setMessageStage: (sessionId: string, msgId: string, stage: MessageStage | null) => void;
  upsertMessageActivityStep: (sessionId: string, msgId: string, step: AgentActivityStep) => void;
  setMessageActivity: (sessionId: string, msgId: string, activity: AgentActivity) => void;
  finishMessageActivity: (sessionId: string, msgId: string, status: Exclude<AgentActivityStatus, 'running'>) => void;
  updateMessage: (sessionId: string, msgId: string, content: string) => void;
  updateMessageTaskId: (sessionId: string, msgId: string, taskId: string) => void;
  setMessageAgentResponse: (sessionId: string, msgId: string, payload: AgentResponsePayload) => void;
  updateToolCall: (sessionId: string, msgId: string, status: ToolCallStatus) => void;
  setMessageEvidence: (sessionId: string, msgId: string, evidence: QueryEvidence | null, knowledgeSuggestion: KnowledgeSuggestion | null, queryExport?: QueryExportInfo | null, knowledgeContext?: KnowledgeContext | null) => void;
  deleteMessage: (sessionId: string, msgId: string) => void;
  deleteMessagePair: (sessionId: string, msgId: string) => void;
  setPendingApproval: (req: ApprovalRequest | null) => void;
  updateSessionTitle: (sessionId: string, title: string) => void;
  updateSessionId: (oldId: string, newId: string) => void;
  reset: () => void;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  loadingHistory: false,
  pendingApproval: null,

  setConversationMode: (sessionId, mode) => {
    if (mode === 'agui' && !isAguiEnabled()) return;
    set((state) => ({ sessions: state.sessions.map((session) => (
      session.id === sessionId && session.pending && session.messages.length === 0
        ? { ...session, conversationMode: mode } : session
    )) }));
  },

  setMessageAgui: (sessionId, messageId, agui) => {
    if (get().activeSessionId === sessionId) localStorage.setItem('activeSessionId', sessionId);
    set((state) => ({
      sessions: state.sessions.map((session) => session.id === sessionId ? {
        ...session,
        pending: false,
        loaded: true,
        messages: session.messages.map((message) => message.id === messageId ? { ...message, agui } : message),
      } : session),
    }));
  },

  // 新建空白会话（不加入侧边栏，pending 状态不展示）
  createSession: () => {
    const id = createId();
    const session: Session = {
      id,
      title: '新对话',
      messages: [],
      createdAt: Date.now(),
      pending: true,
      conversationMode: isAguiEnabled() ? 'agui' : 'legacy',
    };
    set((s) => ({
      sessions: [session, ...s.sessions],
      activeSessionId: id,
    }));
    return id;
  },

  // 新建对话：先清掉旧的 pending，再创建一个新的
  resetToNewSession: () => {
    const id = createId();
    const session: Session = {
      id,
      title: '新对话',
      messages: [],
      createdAt: Date.now(),
      pending: true,
      conversationMode: isAguiEnabled() ? 'agui' : 'legacy',
    };
    set((s) => ({
      sessions: [session, ...s.sessions.filter((sess) => !sess.pending)],
      activeSessionId: id,
    }));
  },

  // 从后端拉取用户的所有历史会话列表（仅元数据，不含消息）
  fetchUserSessions: async () => {
    try {
      const res = await apiFetch('/api/v1/sessions');
      if (!res.ok) return;
      const data = await res.json() as Array<{
        session_id: string;
        title: string;
        created_at: string;
        updated_at: string;
      }>;

      const remoteSessions: Session[] = data.map((item) => ({
        id: item.session_id,
        title: item.title,
        messages: [],
        createdAt: parseBeijingTime(item.created_at),
        loaded: false,
        conversationMode: isAguiEnabled() ? 'agui' : 'legacy',
      }));

      // 恢复上次活跃会话，否则由 resetToNewSession 创建新会话
      const savedId = localStorage.getItem('activeSessionId');
      const restored = savedId ? remoteSessions.find((s) => s.id === savedId) : null;
      if (restored) {
        set({ sessions: remoteSessions, activeSessionId: restored.id });
        get().loadSessionHistory(restored.id);
      } else {
        set({ sessions: remoteSessions });
      }
    } catch {
      // 网络异常静默忽略
    }
  },

  deleteSession: async (sessionId) => {
    const before = get();
    const deletedIndex = before.sessions.findIndex((session) => session.id === sessionId);
    if (deletedIndex < 0) return;
    const deletedSession = before.sessions[deletedIndex];
    const previousActive = before.activeSessionId;
    const remaining = before.sessions.filter((session) => session.id !== sessionId);
    const optimisticActive = previousActive === sessionId
      ? (remaining.find((session) => !session.pending)?.id ?? remaining[0]?.id ?? null)
      : previousActive;
    set({ sessions: remaining, activeSessionId: optimisticActive });

    try {
      const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      if (!response.ok) throw new Error('delete_session_failed');
    } catch {
      set((state) => {
        if (state.sessions.some((session) => session.id === sessionId)) return {};
        const sessions = state.sessions.slice();
        sessions.splice(Math.min(deletedIndex, sessions.length), 0, deletedSession);
        return {
          sessions,
          activeSessionId: previousActive === sessionId && state.activeSessionId === optimisticActive
            ? sessionId
            : state.activeSessionId,
        };
      });
      notification.error({
        message: '删除会话失败',
        description: '服务器未确认删除，已恢复本地会话。',
        duration: 5,
      });
    }
  },

  // 切换到历史会话时懒加载消息
  setActiveSession: (id) => {
    set({ activeSessionId: id });
    const sess = get().sessions.find((s) => s.id === id);
    localStorage.setItem('activeSessionId', id);
    if (sess && !sess.pending && !sess.loaded && sess.messages.length === 0) {
      get().loadSessionHistory(id);
    }
  },

  loadSessionHistory: async (sessionId) => {
    set({ loadingHistory: true });
    try {
      const res = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const data = await res.json() as {
        session_id: string;
        title: string;
        messages: Array<{
          id: string;
          role: string;
          content: string;
          created_at: string;
          task_id?: string;
          metadata?: ConnectorMessageMetadata | null;
        }>;
      };

      const messages: Message[] = data.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
          const connectorQuery = m.metadata?.connector_query;
          const runId = typeof m.metadata?.run_id === 'string' ? m.metadata.run_id : m.task_id;
          const deliveryStatus = m.metadata?.delivery_status;
          const agentResponse = parseAgentResponsePayload(m.metadata?.agent_response) ?? undefined;
          let agui: AguiMessageState | undefined = m.role === 'assistant'
            && (m.metadata?.execution_path === 'general_graph' || m.metadata?.execution_path === 'bounded_react' || m.metadata?.execution_path === 'deterministic_graph')
            && (deliveryStatus === 'completed' || deliveryStatus === 'failed' || deliveryStatus === 'cancelled')
            && typeof runId === 'string'
            ? {
                runId,
                status: deliveryStatus,
                ...(typeof m.metadata.failure_detail === 'string' && m.metadata.failure_detail.trim()
                  ? { detail: m.metadata.failure_detail.trim() }
                  : {}),
                retryable: m.metadata.retryable === true,
              }
            : undefined;
          const questionnaire = agentResponse?.parts.find(isQuestionnairePart);
          if (!agui && m.role === 'assistant' && questionnaire
            && (m.metadata?.run_id === undefined || m.metadata.run_id === questionnaire.run_id)) {
            agui = {
              runId: questionnaire.run_id,
              status: questionnaire.status === 'answered' ? 'completed'
                : questionnaire.status === 'cancelled' ? 'cancelled' : 'interrupted',
            };
          }
          return {
            id: m.id,
            role: m.role as 'user' | 'assistant',
            content: m.content,
            createdAt: parseBeijingTime(m.created_at),
            taskId: m.task_id ?? undefined,
            agui,
            agentResponse,
            activity: m.role === 'assistant' ? parseAgentActivity(m.metadata?.agent_activity) ?? undefined : undefined,
            evidence: connectorQuery?.evidence ?? undefined,
            knowledgeSuggestion: connectorQuery?.knowledge_suggestion ?? undefined,
            queryExport: connectorQuery?.export ?? undefined,
            knowledgeContext: connectorQuery?.knowledge_context ?? undefined,
          };
        });

      const laterRunRecords = new Set<string>();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'assistant' || !message.agui) continue;
        const { runId } = message.agui;
        const accepted = message.agentResponse?.parts.some((part) => isQuestionnairePart(part)
          && part.run_id === runId && part.status === 'answered');
        if (accepted && message.agui.status === 'completed' && !laterRunRecords.has(runId)) {
          messages[index] = { ...message, agui: { ...message.agui, status: 'disconnected' } };
        }
        laterRunRecords.add(runId);
      }

      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId
            ? { ...sess, title: data.title, messages, loaded: true }
            : sess
        ),
      }));
    } catch {
      // 静默忽略
    } finally {
      set({ loadingHistory: false });
    }
  },

  addMessage: (sessionId, msg) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: [...sess.messages, msg] }
          : sess
      ),
    })),

  appendAssistantChunk: (sessionId, msgId, chunk) =>
    set((s) => {
      const sessionIndex = s.sessions.findIndex((session) => session.id === sessionId);
      if (sessionIndex < 0) return s;
      const session = s.sessions[sessionIndex];
      const messageIndex = session.messages.findIndex((message) => message.id === msgId);
      if (messageIndex < 0) return s;

      const messages = session.messages.slice();
      messages[messageIndex] = {
        ...messages[messageIndex],
        content: messages[messageIndex].content + chunk,
      };
      const sessions = s.sessions.slice();
      sessions[sessionIndex] = { ...session, messages };
      return { sessions };
    }),

  setMessageStreaming: (sessionId, msgId, streaming) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId ? { ...m, streaming } : m
              ),
            }
          : sess
      ),
    })),

  setMessageStage: (sessionId, msgId, stage) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId ? { ...m, stage } : m
              ),
            }
          : sess
      ),
    })),

  upsertMessageActivityStep: (sessionId, msgId, step) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((message) =>
                message.id === msgId
                  ? { ...message, activity: mergeAgentActivityStep(message.activity, step) }
                  : message
              ),
            }
          : sess
      ),
    })),

  setMessageActivity: (sessionId, msgId, activity) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((message) =>
                message.id === msgId ? { ...message, activity } : message
              ),
            }
          : sess
      ),
    })),

  finishMessageActivity: (sessionId, msgId, status) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((message) =>
                message.id === msgId
                  ? { ...message, activity: finishAgentActivity(message.activity, status) }
                  : message
              ),
            }
          : sess
      ),
    })),

  updateMessage: (sessionId, msgId, content) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId ? { ...m, content } : m
              ),
            }
          : sess
      ),
    })),

  updateMessageTaskId: (sessionId, msgId, taskId) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId ? { ...m, taskId } : m
              ),
            }
          : sess
      ),
    })),

  setMessageAgentResponse: (sessionId, msgId, agentResponse) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId ? { ...m, agentResponse } : m
              ),
            }
          : sess
      ),
    })),

  updateToolCall: (sessionId, msgId, status) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId && m.toolCall
                  ? { ...m, toolCall: { ...m.toolCall, status } }
                  : m
              ),
            }
          : sess
      ),
    })),

  setMessageEvidence: (sessionId, msgId, evidence, knowledgeSuggestion, queryExport = null, knowledgeContext = null) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? {
              ...sess,
              messages: sess.messages.map((m) =>
                m.id === msgId ? { ...m, evidence, knowledgeSuggestion, queryExport, knowledgeContext } : m
              ),
            }
          : sess
      ),
    })),

  setPendingApproval: (req) => set({ pendingApproval: req }),

  deleteMessage: (sessionId, msgId) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: sess.messages.filter((m) => m.id !== msgId) }
          : sess
      ),
    })),

  deleteMessagePair: (sessionId, msgId) => {
    // 先算出要删的 id 列表
    const msgs = get().sessions.find((s) => s.id === sessionId)?.messages ?? [];
    const idx = msgs.findIndex((m) => m.id === msgId);
    if (idx === -1) return;
    const target = msgs[idx];
    const toRemove: string[] = [msgId];
    if (target.role === 'user') {
      const next = msgs[idx + 1];
      if (next?.role === 'assistant') toRemove.push(next.id);
    } else {
      const prev = msgs[idx - 1];
      if (prev?.role === 'user') toRemove.push(prev.id);
    }
    const toRemoveSet = new Set(toRemove);
    const removedMessages = msgs
      .map((message, index) => ({ message, index }))
      .filter(({ message }) => toRemoveSet.has(message.id));

    // 乐观更新本地
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, messages: sess.messages.filter((m) => !toRemoveSet.has(m.id)) }
          : sess
      ),
    }));

    // 同步后端
    void apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_ids: toRemove }),
    }).then((response) => {
      if (!response.ok) throw new Error('delete_messages_failed');
    }).catch(() => {
      set((state) => ({
        sessions: state.sessions.map((session) => {
          if (session.id !== sessionId) return session;
          const messages = session.messages.slice();
          for (const { message, index } of removedMessages) {
            if (!messages.some((current) => current.id === message.id)) {
              messages.splice(Math.min(index, messages.length), 0, message);
            }
          }
          return { ...session, messages };
        }),
      }));
      notification.error({
        message: '删除消息失败',
        description: '服务器未确认删除，已恢复本地消息。',
        duration: 5,
      });
    });
  },

  updateSessionTitle: (sessionId, title) =>
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId ? { ...sess, title } : sess
      ),
    })),

  updateSessionId: (oldId, newId) =>
    set((s) => {
      const activeSessionId = s.activeSessionId === oldId ? newId : s.activeSessionId;
      // 持久化真实会话 id，使刷新后能恢复到当前会话（pending 的临时 id 不写入）
      if (activeSessionId === newId) {
        localStorage.setItem('activeSessionId', newId);
      }
      return {
        sessions: s.sessions.map((sess) =>
          sess.id === oldId ? { ...sess, id: newId, pending: false, loaded: true } : sess
        ),
        activeSessionId,
      };
    }),

  reset: () => {
    localStorage.removeItem('activeSessionId');
    set({
      sessions: [],
      activeSessionId: null,
      loadingHistory: false,
      pendingApproval: null,
    });
  },
}));

registerSessionCleanup(() => useChatStore.getState().reset());
