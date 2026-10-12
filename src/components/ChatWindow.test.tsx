import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useTaskStore } from '../store/taskStore';
import type { Message } from '../types';
import type { TaskRecord } from '../types/task';

const componentMocks = vi.hoisted(() => ({
  messageBubbleRender: vi.fn(),
  sendMessage: vi.fn(),
  resumeResearchRun: vi.fn(),
  cancelResearchRun: vi.fn(),
  reconnectAguiRun: vi.fn(),
  cancelAguiRun: vi.fn(),
  canReconnectAguiRun: vi.fn(() => true),
  decideAguiApproval: vi.fn(),
  taskCardProps: vi.fn(),
  notificationSuccess: vi.fn(),
  notificationError: vi.fn(),
}));

vi.mock('antd', async () => {
  const actual = await vi.importActual<typeof import('antd')>('antd');
  return {
    ...actual,
    notification: {
      success: componentMocks.notificationSuccess,
      error: componentMocks.notificationError,
      useNotification: () => [{ error: componentMocks.notificationError }, null],
    },
  };
});

vi.mock('../hooks/useAgentChat', () => ({
  useAgentChat: () => ({
    sendMessage: componentMocks.sendMessage,
    approveAction: vi.fn(),
    resumeResearchRun: componentMocks.resumeResearchRun,
    cancelResearchRun: componentMocks.cancelResearchRun,
    reconnectAguiRun: componentMocks.reconnectAguiRun,
    cancelAguiRun: componentMocks.cancelAguiRun,
    decideAguiApproval: componentMocks.decideAguiApproval,
    canReconnectAguiRun: componentMocks.canReconnectAguiRun,
  }),
}));
vi.mock('./MessageBubble', () => ({
  MessageBubble: ({ message, structuredContent, loadingAction }: { message: Message; structuredContent?: React.ReactNode; loadingAction?: React.ReactNode }) => {
    componentMocks.messageBubbleRender(message.id);
    return <div data-testid={`message-${message.id}`}>{message.content}{structuredContent}{loadingAction}</div>;
  },
}));
vi.mock('./TaskCard', () => ({
  TaskCard: (props: {
    task: TaskRecord;
    onResearchResume?: unknown;
    onResearchCancel?: unknown;
    researchCancelling?: boolean;
  }) => {
    componentMocks.taskCardProps(props);
    return (
      <div data-testid="task-card">
        <button type="button" disabled={props.researchCancelling} onClick={() => (props.onResearchResume as (task: TaskRecord, result: { event_cursor: number }) => void)?.(props.task, { event_cursor: 4 })}>恢复</button>
        <button type="button" disabled={props.researchCancelling} onClick={() => (props.onResearchCancel as (task: TaskRecord) => void)?.(props.task)}>取消研究</button>
      </div>
    );
  },
}));
vi.mock('./QueryEvidencePanel', () => ({
  QueryEvidencePanel: ({ question }: { question: string }) => <div data-testid="query-question">{question}</div>,
}));

import { ChatWindow, IntentClarificationButtons, clarificationOptions } from './ChatWindow';

describe('clarificationOptions', () => {
  it('extracts low confidence intent options from assistant text', () => {
    expect(clarificationOptions([
      '需要先确认你想查哪类数据：',
      '1. 产品销量分析：看产品销量和销售结构',
      '   例：本月畅销产品 / 昨天滞销产品',
      '2. 平台账单数据：查平台应收实收',
      '',
      '原因：销售分析可能是财务或经营分析',
      '请回复选项编号，或直接说明要看哪一种。',
    ].join('\n'))).toEqual([
      {
        value: '1',
        title: '产品销量分析',
        detail: '看产品销量和销售结构',
        examples: ['本月畅销产品', '昨天滞销产品'],
      },
      {
        value: '2',
        title: '平台账单数据',
        detail: '查平台应收实收',
        examples: [],
      },
    ]);
  });

  it('ignores ordinary assistant text', () => {
    expect(clarificationOptions('这是普通回答\n1. 不是澄清选项')).toEqual([]);
  });

  it('sends the option number when clicking an intent clarification option', async () => {
    const sent: string[] = [];
    render(
      <IntentClarificationButtons
        content={[
          '需要先确认你想查哪类数据：',
          '1. 经营分析：看整体/各门店营收',
          '2. 财务报表：必须有账期和表类型',
        ].join('\n')}
        onChoose={(value) => sent.push(value)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '选择财务报表' }));

    expect(sent).toEqual(['2']);
  });
});

describe('ChatWindow streaming performance', () => {
  const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo');
  const userMessage: Message = {
    id: 'user-1',
    role: 'user',
    content: '最近营收如何？',
    createdAt: 1,
  };
  const assistantMessage: Message = {
    id: 'assistant-1',
    role: 'assistant',
    content: '正在回答',
    createdAt: 2,
    streaming: true,
    taskId: 'task-1',
    evidence: {} as never,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    componentMocks.sendMessage.mockResolvedValue(true);
    componentMocks.decideAguiApproval.mockResolvedValue(true);
    componentMocks.canReconnectAguiRun.mockReturnValue(true);
    vi.spyOn(useTaskStore.getState(), 'startPolling').mockImplementation(() => undefined);
    vi.spyOn(useTaskStore.getState(), 'stopPolling').mockImplementation(() => undefined);
    useAuthStore.setState({ role: 'member', workspaceType: 'tenant' });
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        messages: [userMessage, assistantMessage],
        createdAt: 0,
      }],
      activeSessionId: 'session-1',
      loadingHistory: false,
      pendingApproval: null,
    });
    useTaskStore.setState({
      tasks: [{ task_id: 'task-1', session_id: 'session-1', status: 'running' } as never],
      loading: false,
      selectedTaskId: 'task-1',
    });
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    } else {
      delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
    if (originalScrollTo) {
      Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo);
    } else {
      delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
    }
  });

  it('does not rerender messages for unrelated chat state', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    render(<ChatWindow />);
    componentMocks.messageBubbleRender.mockClear();

    act(() => {
      useChatStore.setState({
        pendingApproval: { action: 'noop', description: 'noop', turnId: 'turn-1' },
      });
    });

    expect(componentMocks.messageBubbleRender).not.toHaveBeenCalled();
  });

  it('uses AG-UI for fresh conversations without exposing an experimental selector', () => {
    vi.stubEnv('VITE_AGUI_CHAT_ENABLED', 'true');
    act(() => { useChatStore.getState().resetToNewSession(); });
    render(<ChatWindow />);
    expect(screen.queryByRole('group', { name: '对话模式' })).toBeNull();
    expect(useChatStore.getState().sessions[0].conversationMode).toBe('agui');
    expect(screen.getByRole('button', { name: '上传账单文件' })).toBeTruthy();
    expect(screen.queryByText(/实验模式/)).toBeNull();
    expect(useTaskStore.getState().startPolling).toHaveBeenCalledWith('chat-window', expect.objectContaining({ sessionId: expect.any(String) }));
  });

  it('keeps an explicit rollback switch for fresh conversations', () => {
    vi.stubEnv('VITE_AGUI_CHAT_ENABLED', 'false');
    act(() => { useChatStore.getState().resetToNewSession(); });
    render(<ChatWindow />);
    expect(useChatStore.getState().sessions[0].conversationMode).toBe('legacy');
    expect(screen.queryByRole('group', { name: '对话模式' })).toBeNull();
  });

  it('keeps keyboard focus when the first send moves the composer to the bottom', async () => {
    useChatStore.setState({ sessions: [{
      id: 'session-1', title: '新对话', createdAt: 0, conversationMode: 'agui', messages: [],
    }] });
    componentMocks.sendMessage.mockImplementationOnce(async (text: string) => {
      const store = useChatStore.getState();
      store.addMessage('session-1', { ...userMessage, content: text });
      store.addMessage('session-1', { ...assistantMessage, streaming: false, taskId: undefined });
      return true;
    });
    render(<ChatWindow />);
    const input = screen.getByRole('textbox', { name: '对话输入' });
    act(() => { input.focus(); });
    fireEvent.change(input, { target: { value: '第一个问题' } });

    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });

    const nextInput = screen.getByRole('textbox', { name: '对话输入' });
    expect(document.activeElement).toBe(nextInput);
    fireEvent.change(nextInput, { target: { value: '第二个问题' } });
    expect(nextInput).toHaveProperty('value', '第二个问题');
    expect(screen.getByRole('button', { name: '发送消息' })).toHaveProperty('disabled', false);
  });

  it('restores composer focus after clicking send so the next question can be typed', async () => {
    let finishSend!: () => void;
    componentMocks.sendMessage.mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      finishSend = () => resolve(true);
    }));
    render(<ChatWindow />);
    const input = screen.getByRole('textbox', { name: '对话输入' });
    fireEvent.change(input, { target: { value: '第二个问题' } });
    const send = screen.getByRole('button', { name: '发送消息' });
    act(() => { send.focus(); });
    await act(async () => { fireEvent.click(send); });
    expect(send).toHaveProperty('disabled', true);

    await act(async () => { finishSend(); });

    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: '第三个问题' } });
    expect(input).toHaveProperty('value', '第三个问题');
    expect(send).toHaveProperty('disabled', false);
  });

  it('focuses the composer when switching to another existing conversation', () => {
    useChatStore.setState((state) => ({ sessions: [...state.sessions, {
      id: 'session-2', title: '另一会话', createdAt: 3, messages: [
        { ...userMessage, id: 'user-2' }, { ...assistantMessage, id: 'assistant-2', streaming: false },
      ],
    }] }));
    render(<ChatWindow />);
    act(() => { screen.getByRole('textbox', { name: '对话输入' }).blur(); });

    act(() => { useChatStore.setState({ activeSessionId: 'session-2' }); });

    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: '对话输入' }));
  });

  it('keeps active AG-UI progress compact and exposes stop as a secondary action', async () => {
    act(() => { useChatStore.setState({ sessions: [{
      id: 'session-1', title: '分析会话', createdAt: 0, conversationMode: 'agui', messages: [userMessage, {
        ...assistantMessage,
        taskId: undefined,
        content: '',
        agui: { runId: 'agui-running', status: 'connecting', detail: '正在连接' },
      }],
    }] }); });

    render(<ChatWindow />);

    expect(screen.queryByText('正在连接')).toBeNull();
    expect(screen.queryByText('正在处理')).toBeNull();
    const stop = screen.getByRole('button', { name: '停止本轮' });
    expect(stop.textContent).toContain('停止');
    await act(async () => { fireEvent.click(stop); });
    expect(componentMocks.cancelAguiRun).toHaveBeenCalledWith('agui-running');
  });

  it('shows disconnected-run recovery without enabling duplicate sends', async () => {
    act(() => { useChatStore.setState({ sessions: [{
      id: 'session-1', title: '实验会话', createdAt: 0, conversationMode: 'agui', messages: [userMessage, {
        ...assistantMessage, taskId: undefined, streaming: false, agui: { runId: 'agui-1', status: 'disconnected' },
      }],
    }] }); });
    render(<ChatWindow />);
    expect(screen.getByText('连接已断开，任务状态未确认')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '对话输入' }), { target: { value: '再问一次' } });
    expect((screen.getByRole('button', { name: '发送消息' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(screen.getByRole('textbox', { name: '对话输入' }), { key: 'Enter' });
    expect(componentMocks.sendMessage).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重连原任务' }));
    expect(componentMocks.reconnectAguiRun).toHaveBeenCalledWith('agui-1');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '停止本轮' })); });
    expect(componentMocks.cancelAguiRun).toHaveBeenCalledWith('agui-1');
    expect(componentMocks.notificationSuccess).toHaveBeenCalledWith(expect.objectContaining({ duration: 5, closable: true }));
  });

  it('shows a full-width failed-run recovery and retries the originating prompt', async () => {
    act(() => { useChatStore.setState({ sessions: [{
      id: 'session-1', title: '失败会话', createdAt: 0, conversationMode: 'agui', messages: [{
        ...userMessage,
        taskId: 'agui-failed',
      }, {
        ...assistantMessage,
        taskId: 'agui-failed',
        content: '',
        streaming: false,
        agui: { runId: 'agui-failed', status: 'failed', detail: '模型服务暂时未响应', retryable: true },
      }],
    }] }); });
    act(() => { useTaskStore.setState({
      tasks: [{ task_id: 'agui-failed', task_type: 'general_graph', session_id: 'session-1', status: 'failed' } as never],
    }); });
    render(<ChatWindow />);

    const failureStatus = screen.getByRole('status').parentElement?.parentElement?.parentElement;
    expect(failureStatus?.className).toContain('w-[calc(100%_-_2.5rem)]');
    expect(screen.getByText('分析服务未能完成本次请求。你可以重新生成，或稍后再试。')).toBeTruthy();
    expect(screen.getByText('查看错误详情')).toBeTruthy();
    expect(screen.queryByTestId('task-card')).toBeNull();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重新生成' })); });
    expect(componentMocks.sendMessage).toHaveBeenCalledWith('最近营收如何？', undefined);
  });

  it('does not offer retry for a deterministic AG-UI failure', () => {
    act(() => { useChatStore.setState({ sessions: [{
      id: 'session-1', title: '失败会话', createdAt: 0, conversationMode: 'agui', messages: [userMessage, {
        ...assistantMessage, content: '', streaming: false,
        agui: { runId: 'agui-invalid', status: 'failed', detail: '请修改查询条件', retryable: false },
      }],
    }] }); });

    render(<ChatWindow />);

    expect(screen.getByText('请修改查询条件后重新提问。')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '重新生成' })).toBeNull();
  });

  it('confirms an AG-UI approval before resuming the same run', async () => {
    act(() => { useChatStore.setState({ sessions: [{
      id: 'session-1', title: '审批会话', createdAt: 0, conversationMode: 'agui', messages: [userMessage, {
        ...assistantMessage,
        taskId: undefined,
        streaming: false,
        agui: {
          runId: 'agui-approval-1',
          status: 'waiting_for_approval',
          approval: {
            id: 'approval-1',
            toolLabel: '同步经营数据',
            message: 'Agent 请求同步经营数据',
            expiresAt: '2026-09-22T15:00:00+08:00',
          },
        },
      }],
    }] }); });
    render(<ChatWindow />);

    fireEvent.click(screen.getByRole('button', { name: '同意执行' }));
    expect(screen.getByText('确认允许 Agent 执行“同步经营数据”吗？')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认执行' })); });

    expect(componentMocks.decideAguiApproval).toHaveBeenCalledWith('agui-approval-1', 'approve');
    expect(componentMocks.notificationSuccess).toHaveBeenCalledWith({
      message: '已同意执行',
      duration: 5,
      closable: true,
    });
  });

  it('keeps personal chat focused on restaurant operations without tenant tools', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useAuthStore.setState({ role: 'personal', workspaceType: 'personal', tenantId: null });
    useChatStore.setState({
      sessions: [{ id: 'personal-session', title: '个人对话', messages: [], createdAt: 1 }],
      activeSessionId: 'personal-session',
    });

    render(<ChatWindow />);

    expect(screen.getByPlaceholderText('咨询餐饮经营问题')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '上传账单文件' })).toBeNull();
    expect(useTaskStore.getState().startPolling).not.toHaveBeenCalled();
  });

  it('uses prebuilt task and previous-question indexes without per-message scans', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const messages = [userMessage, assistantMessage];
    const tasks = [{ task_id: 'task-1', session_id: 'session-1', status: 'running' } as never];
    Object.defineProperty(messages, 'slice', {
      configurable: true,
      value: () => { throw new Error('messages.slice must not be used during render'); },
    });
    Object.defineProperty(tasks, 'filter', {
      configurable: true,
      value: () => { throw new Error('tasks.filter must not be used during render'); },
    });
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '测试会话', messages, createdAt: 0 }],
    });
    useTaskStore.setState({ tasks });

    expect(() => render(<ChatWindow />)).not.toThrow();
    expect(screen.getByTestId('task-card')).toBeTruthy();
    expect(screen.getByTestId('query-question').textContent).toBe('最近营收如何？');
  });

  it.each(['general_graph', 'analytics_react', 'deterministic_graph'])(
    'hides %s conversation task cards from the chat transcript',
    (taskType) => {
      useTaskStore.setState({
        tasks: [{ task_id: 'task-1', task_type: taskType, session_id: 'session-1', status: 'completed' } as never],
      });

      render(<ChatWindow />);

      expect(screen.queryByTestId('task-card')).toBeNull();
      expect(screen.getByTestId('message-assistant-1')).toBeTruthy();
    },
  );

  it('keeps auto-scroll inside the message list for stream batches and new messages', () => {
    const scrollIntoView = vi.fn();
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    render(<ChatWindow />);
    const messageList = screen.getByRole('log', { name: '对话消息' });
    expect(messageList.classList.contains('overscroll-contain')).toBe(true);
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
    scrollTo.mockClear();
    scrollIntoView.mockClear();

    act(() => {
      useChatStore.getState().appendAssistantChunk('session-1', 'assistant-1', '，请稍候');
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));

    scrollTo.mockClear();
    scrollIntoView.mockClear();
    act(() => {
      useChatStore.getState().addMessage('session-1', {
        id: 'assistant-2', role: 'assistant', content: '完成', createdAt: 3,
      });
    });
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'auto' }));
  });

  it('does not pull readers down until they choose to return to the latest message', () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    render(<ChatWindow />);
    const list = screen.getByRole('log', { name: '对话消息' });
    Object.defineProperties(list, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 700 },
    });
    fireEvent.scroll(list);
    scrollTo.mockClear();
    act(() => useChatStore.getState().appendAssistantChunk('session-1', 'assistant-1', '新增片段'));
    expect(scrollTo).not.toHaveBeenCalled();
    const jumpButton = screen.getByRole('button', { name: '下滑到最底部' });
    expect(jumpButton.className).toContain('chat-jump-latest');
    fireEvent.click(jumpButton);
    expect(scrollTo).toHaveBeenCalledWith({ top: 2000, behavior: 'auto' });
    expect(screen.queryByRole('button', { name: '下滑到最底部' })).toBeNull();
    scrollTo.mockClear();
    act(() => useChatStore.getState().appendAssistantChunk('session-1', 'assistant-1', '继续接收'));
    expect(scrollTo).toHaveBeenCalled();
  });

  it('follows typewriter height changes, respects scrolling up, and cleans up observers', () => {
    let onResize: () => void = () => undefined;
    const disconnect = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { onResize = callback; }
      observe() {}
      disconnect = disconnect;
    });
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const { unmount } = render(<ChatWindow />);
    scrollTo.mockClear();
    act(() => onResize());
    expect(scrollTo).toHaveBeenCalled();
    const list = screen.getByRole('log', { name: '对话消息' });
    Object.defineProperties(list, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    fireEvent.scroll(list);
    scrollTo.mockClear();
    act(() => onResize());
    expect(scrollTo).not.toHaveBeenCalled();
    unmount();
    expect(disconnect).toHaveBeenCalled();
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('renders structured response parts while retaining the assistant markdown fallback', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{
          id: 'assistant-structured',
          role: 'assistant',
          content: '这是兼容旧客户端的文字说明。',
          createdAt: 3,
          agentResponse: {
            version: 1,
            domain: 'analytics',
            task: 'sales_summary',
            result_status: 'ok',
            result_id: 'result-structured',
            source_turn_id: 'turn-structured',
            parts: [{
              kind: 'summary',
              metrics: [{ key: 'revenue', label: '结构化实收', value: '1234.50', unit: 'CNY' }],
            }],
          },
        }],
      }],
    });

    render(<ChatWindow />);

    expect(screen.getByText('结构化实收')).toBeTruthy();
    expect(screen.getByText('¥1,234.50')).toBeTruthy();
    expect(screen.getByText('这是兼容旧客户端的文字说明。')).toBeTruthy();
  });

  it('reveals a live structured insight but shows restored history directly', () => {
    const insight = {
      version: 1 as const,
      domain: 'analytics', task: 'analytics', result_status: 'ok' as const,
      result_id: 'result-1', source_turn_id: 'turn-1',
      parts: [{ kind: 'insights', items: [{ statement_type: 'fact' as const, text: '营收下降。', evidence_refs: ['daily'] }] }],
    };
    useChatStore.setState({ sessions: [{
      id: 'session-1', title: '分析会话', createdAt: 0, conversationMode: 'agui',
      messages: [{ id: 'assistant-live', role: 'assistant', content: '营收下降。', createdAt: 2,
        streaming: true, agui: { runId: 'run-live', status: 'running' }, agentResponse: insight }],
    }] });
    const { container } = render(<ChatWindow />);
    expect(container.querySelectorAll('.agui-insight-reveal')).toHaveLength(1);

    act(() => useChatStore.setState({ sessions: [{
      id: 'session-1', title: '分析会话', createdAt: 0, conversationMode: 'agui',
      messages: [{ id: 'assistant-live', role: 'assistant', content: '营收下降。', createdAt: 2,
        streaming: false, agui: { runId: 'run-live', status: 'completed' }, agentResponse: insight }],
    }] }));
    expect(container.querySelectorAll('.agui-insight-reveal')).toHaveLength(1);

    act(() => useChatStore.setState({
      activeSessionId: 'session-history',
      sessions: [{ id: 'session-history', title: '历史会话', createdAt: 0, conversationMode: 'agui',
        messages: [{ id: 'assistant-history', role: 'assistant', content: '营收下降。', createdAt: 1,
          streaming: false, agui: { runId: 'run-history', status: 'completed' }, agentResponse: insight }] }],
    }));
    expect(container.querySelectorAll('.agui-insight-reveal')).toHaveLength(0);
  });

  it('hides same-turn tool cards behind public activity while preserving legacy cards', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    const publicAssistant: Message = {
      id: 'assistant-public', role: 'assistant', content: '公开活动回答',
      activity: {
        version: 'v1', status: 'completed', label: '分析活动已完成', elapsed_ms: 100,
        steps: [{ step_id: 'load', label: '读取经营数据', status: 'completed', elapsed_ms: 100, sequence: 1 }],
        scope: [], sources: [],
      },
    };
    useChatStore.setState({
      sessions: [{
        id: 'session-1', title: '测试会话', createdAt: 0,
        messages: [
          publicAssistant,
          { id: 'tool-public', role: 'tool_call', content: '', toolCall: { name: '重复工具', description: '', status: 'completed' } },
          { id: 'user-legacy', role: 'user', content: '旧协议问题' },
          { id: 'assistant-legacy', role: 'assistant', content: '旧协议回答' },
          { id: 'tool-legacy', role: 'tool_call', content: '', toolCall: { name: '旧协议工具', description: '', status: 'completed' } },
        ],
      }],
      activeSessionId: 'session-1',
    });

    render(<ChatWindow />);

    expect(screen.queryByText('重复工具')).toBeNull();
    expect(screen.getByText('旧协议工具')).toBeTruthy();
  });

  it('sends a prompt action through the current useAgentChat session', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '销售汇总',
          agentResponse: {
            version: 1,
            domain: 'analytics',
            task: 'sales_summary',
            result_status: 'ok',
            result_id: 'result-1',
            source_turn_id: 'turn-1',
            parts: [],
            actions: [{
              action_id: 'compare_previous',
              kind: 'prompt',
              label: '对比上一周期',
              source_turn_id: 'turn-1',
              params: { message: '对比该门店上一周期的经营数据' },
            }],
          },
        }],
      }],
      activeSessionId: 'session-1',
    });

    render(<ChatWindow />);

    fireEvent.click(screen.getByRole('button', { name: '对比上一周期' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(componentMocks.sendMessage).toHaveBeenCalledWith('对比该门店上一周期的经营数据');
    expect(useChatStore.getState().activeSessionId).toBe('session-1');
  });

  it('sends a structured clarification action without using the legacy text parser', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{
          id: 'assistant-clarification',
          role: 'assistant',
          content: '任意降级文字',
          agentResponse: {
            version: 1,
            domain: 'analytics',
            task: 'sales_summary',
            result_status: 'partial',
            result_id: 'result-1',
            source_turn_id: 'turn-1',
            parts: [{ kind: 'clarification', message: '任意降级文字' }],
            actions: [{
              action_id: 'sales',
              kind: 'clarify',
              label: '查看经营销售数据',
              source_turn_id: 'turn-1',
              params: { candidate_id: 'analytics:sales_summary', message: '查看经营销售数据' },
            }],
          },
        }],
      }],
      activeSessionId: 'session-1',
    });

    render(<ChatWindow />);
    fireEvent.click(screen.getByRole('button', { name: '查看经营销售数据' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(componentMocks.sendMessage).toHaveBeenCalledWith('查看经营销售数据', undefined, {
      kind: 'clarification_choice',
      source_turn_id: 'turn-1',
      candidate_id: 'analytics:sales_summary',
    });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('skips reconnect eligibility scans for %s historical runs', (status) => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '历史会话', createdAt: 0, conversationMode: 'agui', messages: [{
        id: 'assistant-history', role: 'assistant', content: '历史回复', agui: { runId: 'run-history', status },
      }] }], activeSessionId: 'session-1',
    });

    render(<ChatWindow />);

    expect(componentMocks.canReconnectAguiRun).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '重连原任务' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停止本轮' })).toBeNull();
  });

  it('keeps disconnected historical runs reconnectable after checking eligibility', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '历史会话', createdAt: 0, conversationMode: 'agui', messages: [{
        id: 'assistant-history', role: 'assistant', content: '历史回复', agui: { runId: 'run-history', status: 'disconnected' },
      }] }], activeSessionId: 'session-1',
    });

    render(<ChatWindow />);

    expect(componentMocks.canReconnectAguiRun).toHaveBeenCalledWith('run-history');
    expect(screen.getByRole('button', { name: '重连原任务' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重连原任务' }));
    expect(componentMocks.reconnectAguiRun).toHaveBeenCalledWith('run-history');
  });

  it('submits an interrupted questionnaire through the original-run interaction', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '订单分析', createdAt: 0, conversationMode: 'agui', messages: [{
        id: 'assistant-questionnaire', role: 'assistant', content: '请确认范围',
        agui: { runId: 'run-1', status: 'interrupted' }, agentResponse: {
          version: 1, domain: 'platform', task: 'clarification', result_status: 'needs_confirmation',
          result_id: 'result-1', source_turn_id: 'turn-1', parts: [{
            kind: 'questionnaire', clarification_id: 'clarification-1', run_id: 'run-1', status: 'pending',
            expires_at: '2099-10-11T10:00:00+08:00', questions: [{
              id: 'scope', header: '数据范围', question: '查看哪类订单？', options: [
                { id: 'sales', label: '经营订单', recommended: true }, { id: 'refunds', label: '退款订单' },
              ],
            }],
          }],
        },
      }] }], activeSessionId: 'session-1',
    });
    componentMocks.canReconnectAguiRun.mockReturnValue(false);
    render(<ChatWindow />);
    expect(screen.getByRole('button', { name: '停止本轮' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /经营订单/ }));
    fireEvent.click(screen.getByRole('button', { name: '提交答案' }));
    await act(async () => { await Promise.resolve(); });
    expect(componentMocks.sendMessage).toHaveBeenCalledWith('', undefined, {
      kind: 'clarification_answer', source_turn_id: 'turn-1', run_id: 'run-1', clarification_id: 'clarification-1',
      answers: { scope: { option_id: 'sales' } },
    });
  });

  it('uses legacy clarification buttons only when structured response metadata is absent', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{
          id: 'assistant-structured',
          role: 'assistant',
          content: '需要先确认你想查哪类数据：\\n1. 不应显示：结构化消息',
          agentResponse: {
            version: 1,
            domain: 'analytics',
            task: 'sales_summary',
            result_status: 'partial',
            result_id: 'result-1',
            source_turn_id: 'turn-1',
            parts: [{ kind: 'clarification', message: '任意降级文字' }],
            actions: [],
          },
        }],
      }],
      activeSessionId: 'session-1',
    });

    render(<ChatWindow />);

    expect(screen.queryByRole('button', { name: '选择不应显示' })).toBeNull();
  });

  it('shows the follow-up failure notification when the current session sender returns false', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    componentMocks.sendMessage.mockResolvedValue(false);
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '销售汇总',
          agentResponse: {
            version: 1,
            domain: 'analytics',
            task: 'sales_summary',
            result_status: 'ok',
            result_id: 'result-1',
            source_turn_id: 'turn-1',
            parts: [],
            actions: [{
              action_id: 'compare_previous',
              kind: 'prompt',
              label: '对比上一周期',
              source_turn_id: 'turn-1',
              params: { message: '对比该门店上一周期的经营数据' },
            }],
          },
        }],
      }],
      activeSessionId: 'session-1',
    });

    render(<ChatWindow />);
    fireEvent.click(screen.getByRole('button', { name: '对比上一周期' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(componentMocks.notificationError).toHaveBeenCalledWith({
      title: '发送后续问题失败',
      duration: 5,
      closable: true,
    });
  });

  it('disables prompt actions while the current response is streaming', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '销售汇总',
          streaming: true,
          agentResponse: {
            version: 1,
            domain: 'analytics',
            task: 'sales_summary',
            result_status: 'ok',
            result_id: 'result-1',
            source_turn_id: 'turn-1',
            parts: [],
            actions: [{
              action_id: 'compare_previous',
              kind: 'prompt',
              label: '对比上一周期',
              source_turn_id: 'turn-1',
              params: { message: '对比该门店上一周期的经营数据' },
            }],
          },
        }],
      }],
      activeSessionId: 'session-1',
    });

    render(<ChatWindow />);

    const button = screen.getByRole('button', { name: '对比上一周期' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.click(button);
    expect(componentMocks.sendMessage).not.toHaveBeenCalled();
  });

  it('confirms a matching research cancellation before calling the chat hook', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    componentMocks.cancelResearchRun.mockResolvedValue(undefined);
    useTaskStore.setState({
      tasks: [{
        task_id: 'task-1', session_id: 'session-1', task_type: 'research', status: 'running',
        meta: { run_status: 'waiting_for_data' },
      } as never],
    });
    render(<ChatWindow />);

    fireEvent.click(screen.getByRole('button', { name: '取消研究' }));

    expect(screen.getByText('取消经营研究')).toBeTruthy();
    expect(componentMocks.cancelResearchRun).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '确认取消' }));
      await Promise.resolve();
    });
    expect(componentMocks.cancelResearchRun).toHaveBeenCalledTimes(1);
    expect(componentMocks.cancelResearchRun).toHaveBeenCalledWith(expect.objectContaining({ task_id: 'task-1' }));
  });

  it('submits research cancellation once while the command is pending', async () => {
    let resolveCancel: (() => void) | undefined;
    componentMocks.cancelResearchRun.mockReturnValue(new Promise<void>((resolve) => {
      resolveCancel = resolve;
    }));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    render(<ChatWindow />);

    fireEvent.click(screen.getByRole('button', { name: '取消研究' }));
    const confirm = screen.getByRole('button', { name: '确认取消' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);

    expect(componentMocks.cancelResearchRun).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveCancel?.();
      await Promise.resolve();
    });
  });

  it('disables matching research controls while cancellation is pending', () => {
    componentMocks.cancelResearchRun.mockReturnValue(new Promise<void>(() => undefined));
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    render(<ChatWindow />);

    fireEvent.click(screen.getByRole('button', { name: '取消研究' }));
    fireEvent.click(screen.getByRole('button', { name: '确认取消' }));

    expect(screen.getByRole('button', { name: '恢复' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: '取消研究' })).toHaveProperty('disabled', true);
  });

  it('passes resume only to the assistant message matched to the active session task', () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
    useTaskStore.setState({
      tasks: [
        { task_id: 'task-1', session_id: 'session-1', task_type: 'research', status: 'running' } as never,
        { task_id: 'task-other', session_id: 'session-2', task_type: 'research', status: 'running' } as never,
      ],
    });
    render(<ChatWindow />);

    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    expect(componentMocks.resumeResearchRun).toHaveBeenCalledWith(
      expect.objectContaining({ task_id: 'task-1' }),
      { event_cursor: 4 },
    );
    expect(componentMocks.resumeResearchRun).not.toHaveBeenCalledWith(
      expect.objectContaining({ task_id: 'task-other' }),
      expect.anything(),
    );
  });
});
