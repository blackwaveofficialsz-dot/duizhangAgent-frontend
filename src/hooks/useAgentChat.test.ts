/* @vitest-environment jsdom */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch, apiStreamFetch } from '../api/client';
import { getQueryEvidence } from '../api/connectors';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useTaskStore } from '../store/taskStore';
import type { TaskRecord } from '../types/task';
import { useAgentChat } from './useAgentChat';

vi.mock('../api/client', () => ({ apiFetch: vi.fn(), apiStreamFetch: vi.fn() }));
vi.mock('../api/connectors', () => ({ getQueryEvidence: vi.fn() }));

function researchTask(sessionId = 'session-1'): TaskRecord {
  return {
    id: 'task-row-1',
    tenant_id: 'tenant-1',
    user_id: 'user-1',
    session_id: sessionId,
    task_type: 'research',
    status: 'running',
    task_id: 'run-1',
    celery_task_id: null,
    meta: { run_status: 'waiting_for_data' },
    created_at: '2026-08-12T10:00:00+08:00',
    updated_at: '2026-08-12T10:00:00+08:00',
  };
}

function agentRunResponse(status: 'queued' | 'cancelled', eventCursor: number) {
  return {
    ok: true,
    json: vi.fn(async () => ({
      accepted: true,
      run_id: 'run-1',
      run_status: status,
      task_status: status === 'cancelled' ? 'cancelled' : 'pending',
      event_cursor: eventCursor,
    })),
  } as unknown as Response;
}

describe('useAgentChat stage lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({ workspaceType: 'tenant', tenantId: 'tenant-1', activeWorkspaceId: 'tenant-1' });
    useChatStore.setState({
      activeSessionId: 'session-1',
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        messages: [],
        createdAt: 0,
        pending: false,
      }],
      pendingApproval: null,
      loadingHistory: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('returns false after a network failure while keeping the existing fallback message', async () => {
    vi.mocked(apiFetch).mockRejectedValue(new Error('network failed'));
    const { result } = renderHook(() => useAgentChat());
    let sendResult: unknown;

    await act(async () => {
      sendResult = await result.current.sendMessage('查询经营数据');
    });

    expect(sendResult).toBe(false);
    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    expect(messages[messages.length - 1]?.content).toContain('[请求失败，请重试]');
  });

  it('rejects a questionnaire answer in legacy mode without sending it or adding a user bubble', async () => {
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      expect(await result.current.sendMessage('', undefined, {
        kind: 'clarification_answer', source_turn_id: 'turn-previous', run_id: 'run-previous',
        clarification_id: 'question-previous', answers: { scope: { option_id: 'sales' } },
      })).toBe(false);
    });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(apiStreamFetch).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(0);
  });

  it('treats a terminal SSE failure as final and drops later events', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"stage","code":"querying","label":"读取经营数据","status":"running","step_id":"load_data","elapsed_ms":120,"sequence":1,"visibility":"public"}\n\n'
      + 'data: {"type":"text","content":"部分内容"}\n\n'
      + 'data: {"type":"error","message":"服务暂不可用","code":"agent_failed"}\n\n'
      + 'data: {"type":"text","content":"不应继续"}\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    const cancel = vi.fn(async () => undefined);
    const releaseLock = vi.fn();
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read, cancel, releaseLock }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());
    let sendResult: unknown;

    await act(async () => {
      sendResult = await result.current.sendMessage('查询经营数据');
    });

    expect(sendResult).toBe(false);
    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    expect(messages[messages.length - 1]?.content).toBe('部分内容服务暂不可用');
    expect(messages[messages.length - 1]?.content).not.toContain('不应继续');
    expect(messages[messages.length - 1]?.streaming).toBe(false);
    expect(messages[messages.length - 1]?.activity?.status).toBe('failed');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(releaseLock).toHaveBeenCalledTimes(1);
  });

  it('sends a follow-up prompt through the active server session', async () => {
    const done = new TextEncoder().encode('data: [DONE]\n\n');
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: done }) }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('继续对比上一周期');
    });

    const request = vi.mocked(apiFetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({
      message: '继续对比上一周期',
      session_id: 'session-1',
    });
  });

  it('sends clarification interaction while prompt remains a plain message', async () => {
    const done = new TextEncoder().encode('data: [DONE]\\n\\n');
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: done }) }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('查看经营销售数据', undefined, {
        kind: 'clarification_choice',
        source_turn_id: 'turn-1',
        candidate_id: 'analytics:sales_summary',
      });
    });

    const request = vi.mocked(apiFetch).mock.calls[0][1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      message: '查看经营销售数据',
      interaction: { kind: 'clarification_choice', source_turn_id: 'turn-1' },
    });
  });

  it('keeps public activity through the first token and merges heartbeats by stable step sequence', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"stage","code":"querying","label":"读取经营数据","detail":"第一批","status":"running","step_id":"load_data","elapsed_ms":120,"sequence":2,"visibility":"public"}\n\n'
      + 'data: {"type":"stage","code":"querying","label":"读取经营数据","detail":"第二批","status":"running","step_id":"load_data","elapsed_ms":240,"sequence":9,"visibility":"public"}\n\n'
      + 'data: "首个正文"\n\n'
      + 'data: [DONE]\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as unknown as Response);

    const snapshots: Array<{ content: string; activityStatus: string | null }> = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      const message = state.sessions[0]?.messages.find((item) => item.role === 'assistant');
      if (message) {
        snapshots.push({
          content: message.content,
          activityStatus: message.activity?.status ?? null,
        });
      }
    });
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('查询经营数据');
    });
    unsubscribe();

    const stageIndex = snapshots.findIndex((item) => item.activityStatus === 'running');
    const textIndex = snapshots.findIndex((item) => item.content === '首个正文');
    expect(stageIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(stageIndex);
    expect(snapshots[textIndex].activityStatus).toBe('running');

    const assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
    expect(assistant?.activity?.status).toBe('completed');
    expect(assistant?.activity?.steps).toEqual([
      expect.objectContaining({ step_id: 'load_data', detail: '第二批', elapsed_ms: 240, sequence: 2 }),
    ]);
  });

  it('keeps later public steps active after an earlier step completes until DONE', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"stage","label":"读取经营数据","detail":"第一批","status":"running","step_id":"load","elapsed_ms":120,"sequence":1,"visibility":"public"}\n\n'
      + 'data: {"type":"stage","label":"不应覆盖步骤标题","detail":"读取完成","status":"completed","step_id":"load","elapsed_ms":240,"sequence":9,"visibility":"public"}\n\n'
      + 'data: {"type":"stage","label":"整理经营结论","status":"running","step_id":"summarize","elapsed_ms":80,"sequence":2,"visibility":"public"}\n\n'
      + 'data: {"type":"text","content":"最终回答"}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: bytes }) }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => { await result.current.sendMessage('整理经营结论'); });

    const assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
    expect(assistant?.activity?.status).toBe('completed');
    expect(assistant?.content).toBe('最终回答');
    expect(assistant?.activity?.steps).toEqual([
      expect.objectContaining({ step_id: 'load', label: '读取经营数据', detail: '读取完成', status: 'completed', elapsed_ms: 240, sequence: 1 }),
      expect.objectContaining({ step_id: 'summarize', label: '整理经营结论', status: 'completed', sequence: 2 }),
    ]);
  });

  it.each([
    ['ok', 'completed'],
    ['partial', 'partial'],
    ['empty', 'empty'],
    ['unavailable', 'unavailable'],
    ['failed', 'failed'],
  ] as const)('keeps the %s business terminal after terminal activity meta and DONE', async (resultStatus, activityStatus) => {
    const agentResponse = {
      version: 1,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: resultStatus,
      result_id: `result-${resultStatus}`,
      source_turn_id: 'turn-1',
      parts: [{ kind: 'summary', title: '销售汇总' }],
    };
    const terminalActivity = {
      version: 'v1',
      status: activityStatus,
      label: `terminal-${activityStatus}`,
      elapsed_ms: 50,
      total_duration_ms: 175,
      steps: [{ step_id: 'load', label: '读取业务数据', status: 'completed', elapsed_ms: 50 }],
      scope: ['全部直营店'],
      sources: ['经营销售快照'],
    };
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: 'meta', agent_response: agentResponse })}\n\n`
      + 'data: {"type":"stage","code":"querying","label":"读取业务数据","status":"completed","step_id":"load","elapsed_ms":50,"sequence":1,"visibility":"public"}\n\n'
      + `data: ${JSON.stringify({ type: 'meta', agent_activity: terminalActivity })}\n\n`
      + 'data: {"type":"text","content":"结果"}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: bytes }) }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => { await result.current.sendMessage('查询经营数据'); });

    const assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
    expect(assistant?.activity).toMatchObject({
      status: activityStatus,
      total_duration_ms: 175,
      elapsed_ms: 50,
      scope: ['全部直营店'],
      sources: ['经营销售快照'],
    });
  });

  it.each([
    ['explicit null', null],
    ['valid status with missing contract fields', { result_status: 'ok' }],
    ['unsupported version with a valid status', { version: 2, result_status: 'ok' }],
  ])('fails closed for %s agent_response metadata', async (_case, agentResponse) => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"stage","code":"querying","label":"读取业务数据","status":"completed","step_id":"load","elapsed_ms":10,"sequence":1,"visibility":"public"}\n\n'
      + `data: ${JSON.stringify({ type: 'meta', agent_response: agentResponse })}\n\n`
      + 'data: {"type":"text","content":"兼容正文"}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: bytes }) }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    let succeeded: boolean | null = null;
    await act(async () => { succeeded = await result.current.sendMessage('查询经营数据'); });

    const assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
    expect(succeeded).toBe(false);
    expect(assistant?.agentResponse).toBeUndefined();
    expect(assistant?.activity?.status).toBe('failed');
  });

  it('marks explicit cancellation and unexpected stream completion as distinct activity terminals', async () => {
    let resolveRead: ((value: ReadableStreamReadResult<Uint8Array>) => void) | undefined;
    const cancel = vi.fn(async () => {
      resolveRead?.({ done: true, value: undefined });
    });
    const stage = new TextEncoder().encode(
      'data: {"type":"stage","code":"querying","label":"读取经营数据","status":"running","step_id":"load_data","elapsed_ms":120,"sequence":1,"visibility":"public"}\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: stage })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRead = resolve; }));
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());
    let sending!: Promise<unknown>;

    act(() => { sending = result.current.sendMessage('查询经营数据'); });
    await waitFor(() => {
      const assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
      expect(assistant?.activity?.status).toBe('running');
    });
    act(() => result.current.cancel());
    await act(async () => { await sending; });

    let assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
    expect(assistant?.activity?.status).toBe('cancelled');
    expect(assistant?.streaming).toBe(false);

    useChatStore.setState((state) => ({
      sessions: state.sessions.map((session) => ({ ...session, messages: [] })),
    }));
    const interruptedRead = vi.fn()
      .mockResolvedValueOnce({ done: false, value: stage })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: interruptedRead }) },
    } as unknown as Response);

    await act(async () => { await result.current.sendMessage('再次查询'); });

    assistant = useChatStore.getState().sessions[0]?.messages.find((item) => item.role === 'assistant');
    expect(assistant?.activity?.status).toBe('interrupted');
    expect(assistant?.streaming).toBe(false);
  });

  it('suppresses tool cards only after public activity is present', async () => {
    const publicBytes = new TextEncoder().encode(
      'data: {"type":"stage","code":"querying","label":"读取经营数据","status":"running","step_id":"load_data","elapsed_ms":120,"sequence":1,"visibility":"public"}\n\n'
      + 'data: {"type":"tool_call","name":"查询工具","description":"读取数据"}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: publicBytes }) }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => { await result.current.sendMessage('公开活动'); });
    expect(useChatStore.getState().sessions[0]?.messages.some((message) => message.role === 'tool_call')).toBe(false);

    const legacyBytes = new TextEncoder().encode(
      'data: {"type":"tool_call","name":"旧工具","description":"兼容路径"}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValueOnce({
      ok: true,
      body: { getReader: () => ({ read: vi.fn().mockResolvedValueOnce({ done: false, value: legacyBytes }) }) },
    } as unknown as Response);

    await act(async () => { await result.current.sendMessage('旧协议'); });
    expect(useChatStore.getState().sessions[0]?.messages.some((message) => message.toolCall?.name === '旧工具')).toBe(true);
  });

  it('attaches a valid meta agent response to the current assistant message before DONE', async () => {
    const agentResponse = {
      version: 1 as const,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok' as const,
      result_id: 'result-1',
      source_turn_id: 'turn-1',
      parts: [{ kind: 'summary', title: '销售汇总' }],
    };
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'meta', session_id: 'session-1', agent_response: agentResponse })}\n\n`);
    let resolveDone!: (value: { done: false; value: Uint8Array }) => void;
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveDone = resolve; }));
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    let sending!: Promise<boolean | null>;
    act(() => {
      sending = result.current.sendMessage('查询销售');
    });

    await waitFor(() => {
      const messages = useChatStore.getState().sessions[0]?.messages ?? [];
      expect(messages[messages.length - 1]?.agentResponse).toEqual(agentResponse);
      expect(messages[messages.length - 1]?.streaming).toBe(true);
      expect(read).toHaveBeenCalledTimes(2);
    });
    await act(async () => {
      resolveDone({ done: false, value: new TextEncoder().encode('data: [DONE]\n\n') });
      await sending;
    });
  });

  it('keeps fallback text when meta agent response is not version 1', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-1","agent_response":{"version":2,"domain":"analytics","task":"sales_summary","result_status":"ok","result_id":"result-v2","source_turn_id":"turn-v2","parts":[{"kind":"summary","title":"销售汇总"}]}}\n\n'
      + 'data: {"type":"text","content":"销售汇总"}\n\n'
      + 'data: [DONE]\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('查询销售');
    });

    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    const assistant = messages[messages.length - 1];
    expect(assistant?.content).toBe('销售汇总');
    expect(assistant?.agentResponse).toBeUndefined();
  });

  it('keeps fallback text when meta agent response has a malformed part', async () => {
    const bytes = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-1","agent_response":{"version":1,"domain":"analytics","task":"sales_summary","result_status":"ok","result_id":"result-1","source_turn_id":"turn-1","parts":[{}]}}\n\n'
      + 'data: {"type":"text","content":"销售汇总"}\n\n'
      + 'data: [DONE]\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('查询销售');
    });

    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    const assistant = messages[messages.length - 1];
    expect(assistant?.content).toBe('销售汇总');
    expect(assistant?.agentResponse).toBeUndefined();
  });

  it('keeps fallback text when meta agent response has more than fifty preview rows', async () => {
    const agentResponse = {
      version: 1,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok',
      result_id: 'result-1',
      source_turn_id: 'turn-1',
      parts: [{ kind: 'table', preview_rows: Array.from({ length: 51 }, (_, index) => ({ row: index })) }],
    };
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ type: 'meta', session_id: 'session-1', agent_response: agentResponse })}\n\n`
      + 'data: {"type":"text","content":"销售汇总"}\n\n'
      + 'data: [DONE]\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('查询销售');
    });

    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    const assistant = messages[messages.length - 1];
    expect(assistant?.content).toBe('销售汇总');
    expect(assistant?.agentResponse).toBeUndefined();
  });

  it('reuses the original messages and resolved session when replacing duplicates', async () => {
    useChatStore.setState({
      activeSessionId: 'local-session',
      sessions: [{
        id: 'local-session',
        title: '新对话',
        messages: [],
        createdAt: 0,
        pending: true,
      }],
    });
    vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success',
      allTerminal: false,
    });
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          duplicate: true,
          period: '2026-07',
          existing_sources: [],
          session_id: 'resolved-session',
        }),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({ session_id: 'resolved-session' }),
      } as unknown as Response);

    let confirmReplace: (() => void) | null = null;
    const { result } = renderHook(() => useAgentChat({
      onDuplicate: (info) => { confirmReplace = info.onConfirm; },
    }));

    await act(async () => {
      await result.current.sendMessage('上传账单', { files: [new File(['data'], 'bill.xlsx')] });
    });

    expect(useChatStore.getState().sessions[0].id).toBe('resolved-session');
    expect(confirmReplace).not.toBeNull();

    await act(async () => {
      await confirmReplace?.();
    });

    const session = useChatStore.getState().sessions[0];
    expect(session.messages).toHaveLength(2);
    expect(session.messages.filter(message => message.role === 'user')).toHaveLength(1);
    expect(session.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
    const secondRequest = vi.mocked(apiFetch).mock.calls[1][1] as RequestInit;
    const secondForm = secondRequest.body as FormData;
    expect(secondForm.get('replace')).toBe('true');
    expect(secondForm.get('session_id')).toBe('resolved-session');
  });

  it('delegates task refresh to taskStore without creating a hook interval', async () => {
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success',
      allTerminal: false,
    });
    const setInterval = vi.spyOn(globalThis, 'setInterval').mockReturnValue(1 as never);
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1',
        task_id: 'task-1',
      }),
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('上传账单', { files: [new File(['data'], 'bill.xlsx')] });
    });

    expect(loadTasks).toHaveBeenCalledWith('session-1');
    expect(setInterval).not.toHaveBeenCalled();
  });

  it('does not expose a constant isStreaming API', () => {
    const { result } = renderHook(() => useAgentChat());

    expect(result.current).not.toHaveProperty('isStreaming');
  });

  it('rebinds a resumed research run from the server cursor after refreshing the owning session', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          createdAt: 0,
          taskId: 'run-1',
        }],
        createdAt: 0,
        pending: false,
      }],
    });
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success',
      allTerminal: false,
    });
    vi.mocked(apiFetch).mockResolvedValue(agentRunResponse('queued', 4));
    vi.mocked(apiStreamFetch).mockImplementation(async (_url, options) => ({
      response: {
        ok: true,
        body: { getReader: () => ({
          read: vi.fn(() => new Promise(() => undefined)),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }) },
      } as unknown as Response,
      signal: options?.signal as AbortSignal,
      release: vi.fn(),
    }));
    const startPolling = vi.spyOn(useTaskStore.getState(), 'startPolling');
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.resumeResearchRun(researchTask(), {
        accepted: true,
        run_id: 'run-1',
        run_status: 'queued',
        task_status: 'pending',
        event_cursor: 4,
      });
    });

    expect(loadTasks).toHaveBeenCalledWith('session-1');
    const assistant = useChatStore.getState().sessions[0]?.messages[0];
    expect(assistant?.streaming).toBe(true);
    expect(assistant?.stage?.label).toBe('研究任务排队中');
    expect(vi.mocked(apiStreamFetch)).toHaveBeenCalledWith('/api/v1/agent-runs/events', expect.objectContaining({
      body: JSON.stringify({ run_id: 'run-1', after_sequence: 4 }),
    }));
    expect(startPolling).toHaveBeenCalledWith('research-run:run-1', {
      type: 'session',
      sessionId: 'session-1',
    });
  });

  it('projects known waiting statuses to Chinese labels and refreshes before pausing the stream', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '',
          createdAt: 0,
          taskId: 'run-1',
        }],
        createdAt: 0,
        pending: false,
      }],
    });
    const kickoff = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-1","run_id":"run-1","background":true}\n\n'
      + 'data: [DONE]\n\n',
    );
    let kickoffSent = false;
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({
        read: vi.fn(async () => {
          if (kickoffSent) return { done: true, value: undefined };
          kickoffSent = true;
          return { done: false, value: kickoff };
        }),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      }) },
    } as unknown as Response);
    let durableSent = false;
    vi.mocked(apiStreamFetch).mockResolvedValue({
      response: {
        ok: true,
        body: { getReader: () => ({
          read: vi.fn(async () => {
            if (durableSent) return { done: true, value: undefined };
            durableSent = true;
            return {
              done: false,
              value: new TextEncoder().encode('data: {"run_id":"run-1","sequence":5,"type":"status","data":{"status":"waiting_for_data","label":"waiting_for_data","detail":"请补充流水"},"created_at":"2026-08-12T10:00:00+08:00"}\n\n'),
            };
          }),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }) },
      } as unknown as Response,
      signal: new AbortController().signal,
      release: vi.fn(),
    });
    const stopPolling = vi.spyOn(useTaskStore.getState(), 'stopPolling');
    const messages: Array<{ stage?: { label?: string }; taskId?: string; streaming?: boolean }> = [];
    const unsubscribe = useChatStore.subscribe((state) => {
      const assistants = state.sessions[0]?.messages.filter((message) => message.role === 'assistant') ?? [];
      const assistant = assistants[assistants.length - 1];
      if (assistant) messages.push({
        stage: assistant.stage ?? undefined,
        taskId: assistant.taskId,
        streaming: assistant.streaming,
      });
    });
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('开始经营研究');
    });

    await waitFor(() => {
      expect(vi.mocked(apiStreamFetch)).toHaveBeenCalled();
      expect(messages.some((message) => message.taskId === 'run-1')).toBe(true);
      expect(messages.some((message) => message.stage?.label === '等待补充资料')).toBe(true);
      expect(stopPolling).toHaveBeenCalledWith('research-run:run-1');
    });
    unsubscribe();
  });

  it('refreshes before stopping an approval-request waiting stream', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', title: '测试会话', messages: [{
          id: 'assistant-1', role: 'assistant', content: '', createdAt: 0, taskId: 'run-1',
        }], createdAt: 0, pending: false,
      }],
    });
    let emitApproval!: (value: { done: false; value: Uint8Array }) => void;
    vi.mocked(apiStreamFetch).mockResolvedValue({
      response: {
        ok: true,
        body: { getReader: () => ({
          read: vi.fn(() => new Promise((resolve) => { emitApproval = resolve; })),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }) },
      } as unknown as Response,
      signal: new AbortController().signal,
      release: vi.fn(),
    });
    const order: string[] = [];
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks').mockImplementation(async () => {
      order.push('refresh');
      return { status: 'success', allTerminal: false };
    });
    const stopPolling = vi.spyOn(useTaskStore.getState(), 'stopPolling').mockImplementation((owner) => {
      if (owner === 'research-run:run-1') order.push('stop');
    });
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.resumeResearchRun(researchTask(), {
        accepted: true, run_id: 'run-1', run_status: 'queued', task_status: 'pending', event_cursor: 4,
      });
    });
    await waitFor(() => expect(emitApproval).toBeTypeOf('function'));
    order.length = 0;
    loadTasks.mockClear();
    stopPolling.mockClear();

    await act(async () => {
      emitApproval({
        done: false,
        value: new TextEncoder().encode('data: {"run_id":"run-1","sequence":5,"type":"approval_request","data":{"status":"waiting_for_approval","label":"操作待批准"},"created_at":"2026-08-12T10:00:00+08:00"}\n\n'),
      });
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(useChatStore.getState().sessions[0]?.messages[0]?.stage?.label).toBe('等待审批');
      expect(stopPolling).toHaveBeenCalledWith('research-run:run-1');
    });
    expect(order[0]).toBe('refresh');
    expect(order).toContain('stop');
  });

  it('does not rebind a resumed run when its owning session is no longer active', async () => {
    useChatStore.setState({
      sessions: [
        {
          id: 'session-1', title: '研究会话', messages: [{
            id: 'assistant-1', role: 'assistant', content: '', createdAt: 0, taskId: 'run-1',
          }], createdAt: 0, pending: false,
        },
        { id: 'session-2', title: '当前会话', messages: [], createdAt: 0, pending: false },
      ],
      activeSessionId: 'session-2',
    });
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks');
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.resumeResearchRun(researchTask(), {
        accepted: true,
        run_id: 'run-1',
        run_status: 'queued',
        task_status: 'pending',
        event_cursor: 4,
      });
    });

    expect(loadTasks).not.toHaveBeenCalledWith('session-1');
    expect(useChatStore.getState().sessions[0]?.messages[0]?.streaming).not.toBe(true);
  });

  it('cancels a bound research run and clears its streaming stage after refresh', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', title: '测试会话', messages: [{
          id: 'assistant-1', role: 'assistant', content: '', createdAt: 0,
          taskId: 'run-1', streaming: true, stage: { code: 'waiting_for_data', label: '等待补充资料', status: 'running' },
        }], createdAt: 0, pending: false,
      }],
    });
    vi.mocked(apiFetch).mockResolvedValue(agentRunResponse('cancelled', 6));
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success', allTerminal: true,
    });
    const stopPolling = vi.spyOn(useTaskStore.getState(), 'stopPolling');
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.cancelResearchRun(researchTask());
    });

    expect(loadTasks).toHaveBeenCalledWith('session-1');
    expect(stopPolling).toHaveBeenCalledWith('research-run:run-1');
    const assistant = useChatStore.getState().sessions[0]?.messages[0];
    expect(assistant?.streaming).toBe(false);
    expect(assistant?.stage).toBeNull();
  });

  it('reuses a cancellation request ID after a transport failure', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', title: '测试会话', messages: [{
          id: 'assistant-1', role: 'assistant', content: '', createdAt: 0, taskId: 'run-1',
        }], createdAt: 0, pending: false,
      }],
    });
    vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success', allTerminal: true,
    });
    vi.mocked(apiFetch)
      .mockRejectedValueOnce(new TypeError('response lost'))
      .mockResolvedValueOnce(agentRunResponse('cancelled', 6));
    const { result } = renderHook(() => useAgentChat());

    await expect(result.current.cancelResearchRun(researchTask())).rejects.toThrow('response lost');
    await result.current.cancelResearchRun(researchTask());

    const requestIds = vi.mocked(apiFetch).mock.calls.map(([, request]) => {
      const body = (request as RequestInit).body as string;
      return JSON.parse(body).request_id;
    });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
  });

  it('cleans up the original run after cancellation completes in another session', async () => {
    useChatStore.setState({
      sessions: [
        {
          id: 'session-1', title: '研究会话', messages: [{
            id: 'assistant-1', role: 'assistant', content: '', createdAt: 0,
            taskId: 'run-1', streaming: true,
            stage: { code: 'waiting_for_data', label: '等待补充资料', status: 'running' },
          }], createdAt: 0, pending: false,
        },
        { id: 'session-2', title: '当前会话', messages: [], createdAt: 0, pending: false },
      ],
    });
    let resolveCommand: (value: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockReturnValue(new Promise((resolve) => { resolveCommand = resolve; }));
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success', allTerminal: true,
    });
    const stopPolling = vi.spyOn(useTaskStore.getState(), 'stopPolling');
    const { result } = renderHook(() => useAgentChat());

    let cancellation!: Promise<void>;
    act(() => { cancellation = result.current.cancelResearchRun(researchTask()); });
    useChatStore.setState({ activeSessionId: 'session-2' });
    await act(async () => {
      resolveCommand(agentRunResponse('cancelled', 6));
      await cancellation;
    });

    expect(loadTasks).toHaveBeenCalledWith('session-1');
    expect(stopPolling).toHaveBeenCalledWith('research-run:run-1');
    const original = useChatStore.getState().sessions[0]?.messages[0];
    expect(original?.streaming).toBe(false);
    expect(original?.stage).toBeNull();
    expect(useChatStore.getState().activeSessionId).toBe('session-2');
  });

  it('flushes multiple tokens from one stream read as one store update', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const append = vi.spyOn(useChatStore.getState(), 'appendAssistantChunk');
    const bytes = new TextEncoder().encode(
      'data: "甲"\n\n'
      + 'data: "乙"\n\n'
      + 'data: "丙"\n\n'
      + 'data: [DONE]\n\n',
    );
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: bytes })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read }) },
    } as unknown as Response);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('流式回答');
    });

    expect(append).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledWith('session-1', expect.any(String), '甲乙丙');
    const messages = useChatStore.getState().sessions[0].messages;
    expect(messages[messages.length - 1]?.content).toBe('甲乙丙');
  });

  it('does not subscribe the hook to unrelated chat state', () => {
    let renders = 0;
    renderHook(() => {
      renders += 1;
      return useAgentChat();
    });

    act(() => {
      useChatStore.setState({
        pendingApproval: { action: 'noop', description: 'noop', turnId: 'turn-1' },
      });
    });

    expect(renders).toBe(1);
  });

  it('keeps the assistant message streaming after kickoff DONE until the durable run terminates', async () => {
    const kickoff = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-1","category":"operations","run_id":"run-1","background":true}\n\n'
      + 'data: [DONE]\n\n',
    );
    const kickoffRead = vi.fn()
      .mockResolvedValueOnce({ done: false, value: kickoff })
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({ read: kickoffRead, cancel: vi.fn(async () => undefined), releaseLock: vi.fn() }) },
    } as unknown as Response);

    const progress = new TextEncoder().encode(
      'data: {"run_id":"run-1","sequence":1,"type":"status","data":{"stage":"running","label":"正在研究","detail":"查询公开数据","status":"running"},"created_at":"2026-08-10T10:00:00+08:00"}\n\n',
    );
    const terminal = new TextEncoder().encode(
      'data: {"run_id":"run-1","sequence":2,"type":"final","data":{"status":"completed","text":"公开最终结论","arguments":{"secret":true},"observation":"hidden"},"created_at":"2026-08-10T10:01:00+08:00"}\n\n',
    );
    let resolveNext!: (value: { done: false; value: Uint8Array }) => void;
    const durableRead = vi.fn()
      .mockResolvedValueOnce({ done: false, value: progress })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNext = resolve; }))
      .mockResolvedValueOnce({ done: true, value: undefined });
    vi.mocked(apiStreamFetch).mockImplementation(async (_url, options) => ({
      response: {
        ok: true,
        body: { getReader: () => ({ read: durableRead, cancel: vi.fn(async () => undefined), releaseLock: vi.fn() }) },
      } as unknown as Response,
      signal: options?.signal as AbortSignal,
      release: vi.fn(),
    }));
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      await result.current.sendMessage('研究本月经营情况');
    });
    await waitFor(() => {
      const messages = useChatStore.getState().sessions[0].messages;
      const assistant = messages[messages.length - 1];
      expect(assistant?.taskId).toBe('run-1');
      expect(assistant?.streaming).toBe(true);
      expect(assistant?.stage?.label).toBe('正在研究');
      expect(assistant?.activity?.steps).toEqual([
        expect.objectContaining({ step_id: 'research:running', label: '正在研究' }),
      ]);
    });

    await act(async () => {
      resolveNext({ done: false, value: terminal });
    });
    await waitFor(() => {
      const messages = useChatStore.getState().sessions[0].messages;
      const assistant = messages[messages.length - 1];
      expect(assistant?.content).toBe('公开最终结论');
      expect(assistant?.streaming).toBe(false);
      expect(assistant?.stage).toBeNull();
      expect(assistant?.content).not.toContain('secret');
      expect(assistant?.content).not.toContain('hidden');
    });
    expect(getQueryEvidence).not.toHaveBeenCalled();
  });

  it('keeps an active background run attached during a normal follow-up message', async () => {
    const kickoffBytes = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-1","run_id":"run-1","background":true}\n\n'
      + 'data: [DONE]\n\n',
    );
    const followupBytes = new TextEncoder().encode('data: "收到"\n\ndata: [DONE]\n\n');
    const response = (bytes: Uint8Array) => {
      let sent = false;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: vi.fn(async () => {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            }),
            cancel: vi.fn(async () => undefined),
            releaseLock: vi.fn(),
          }),
        },
      } as unknown as Response;
    };
    vi.mocked(apiFetch)
      .mockResolvedValueOnce(response(kickoffBytes))
      .mockResolvedValueOnce(response(followupBytes));

    const progress = new TextEncoder().encode(
      'data: {"run_id":"run-1","sequence":1,"type":"status","data":{"stage":"running","status":"running"},"created_at":"2026-08-10T10:00:00+08:00"}\n\n',
    );
    let progressSent = false;
    let durableSignal: AbortSignal | undefined;
    vi.mocked(apiStreamFetch).mockImplementation(async (_url, options) => {
      durableSignal = options?.signal as AbortSignal;
      return {
        response: {
          ok: true,
          body: {
            getReader: () => ({
              read: vi.fn(() => {
                if (!progressSent) {
                  progressSent = true;
                  return Promise.resolve({ done: false, value: progress });
                }
                return new Promise(() => undefined);
              }),
              cancel: vi.fn(async () => undefined),
              releaseLock: vi.fn(),
            }),
          },
        } as unknown as Response,
        signal: durableSignal,
        release: vi.fn(),
      };
    });
    const { result, unmount } = renderHook(() => useAgentChat());

    await act(async () => result.current.sendMessage('开始研究'));
    await waitFor(() => expect(durableSignal).toBeDefined());
    await act(async () => result.current.sendMessage('补充说明'));

    expect(durableSignal?.aborted).toBe(false);
    const background = useChatStore.getState().sessions[0].messages
      .find((message) => message.taskId === 'run-1');
    expect(background?.streaming).toBe(true);
    unmount();
  });

  it('does not re-arm a previous session polling scope from a late durable status', async () => {
    const kickoff = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-a","run_id":"run-a","background":true}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: kickoff })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      }) },
      json: vi.fn(async () => []),
    } as unknown as Response);
    let emitStatus!: (value: { done: false; value: Uint8Array }) => void;
    vi.mocked(apiStreamFetch).mockResolvedValue({
      response: {
        ok: true,
        body: { getReader: () => ({
          read: vi.fn(() => new Promise((resolve) => { emitStatus = resolve; })),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }) },
      } as unknown as Response,
      signal: new AbortController().signal,
      release: vi.fn(),
    });
    const { result } = renderHook(() => useAgentChat());

    await act(async () => result.current.sendMessage('开始研究'));
    useTaskStore.getState().stopPolling('research-run:run-a');
    useChatStore.setState({ activeSessionId: 'session-b' });
    vi.mocked(apiFetch).mockClear();

    await act(async () => {
      emitStatus({
        done: false,
        value: new TextEncoder().encode('data: {"run_id":"run-a","sequence":1,"type":"status","data":{"status":"running"},"created_at":"2026-08-10T10:00:00+08:00"}\n\n'),
      });
      await Promise.resolve();
    });

    expect(vi.mocked(apiFetch)).not.toHaveBeenCalledWith('/api/v1/tasks?session_id=session-a');
  });

  it('does not refresh previous session tasks from terminal cleanup after session changes', async () => {
    const loadTasks = vi.spyOn(useTaskStore.getState(), 'loadTasks').mockResolvedValue({
      status: 'success',
      allTerminal: true,
    });
    const kickoff = new TextEncoder().encode(
      'data: {"type":"meta","session_id":"session-a","run_id":"run-a","background":true}\n\n'
      + 'data: [DONE]\n\n',
    );
    vi.mocked(apiFetch).mockResolvedValue({
      ok: true,
      body: { getReader: () => ({
        read: vi.fn()
          .mockResolvedValueOnce({ done: false, value: kickoff })
          .mockResolvedValueOnce({ done: true, value: undefined }),
        cancel: vi.fn(async () => undefined),
        releaseLock: vi.fn(),
      }) },
      json: vi.fn(async () => []),
    } as unknown as Response);
    let emitFinal!: (value: { done: false; value: Uint8Array }) => void;
    vi.mocked(apiStreamFetch).mockResolvedValue({
      response: {
        ok: true,
        body: { getReader: () => ({
          read: vi.fn(() => new Promise((resolve) => { emitFinal = resolve; })),
          cancel: vi.fn(async () => undefined),
          releaseLock: vi.fn(),
        }) },
      } as unknown as Response,
      signal: new AbortController().signal,
      release: vi.fn(),
    });
    const { result } = renderHook(() => useAgentChat());

    await act(async () => result.current.sendMessage('开始研究'));
    useChatStore.setState({ activeSessionId: 'session-b' });
    loadTasks.mockClear();

    await act(async () => {
      emitFinal({
        done: false,
        value: new TextEncoder().encode('data: {"run_id":"run-a","sequence":1,"type":"final","data":{"status":"completed","text":"完成"},"created_at":"2026-08-10T10:00:00+08:00"}\n\n'),
      });
      await Promise.resolve();
    });

    expect(loadTasks).not.toHaveBeenCalledWith('session-a');
  });
});
