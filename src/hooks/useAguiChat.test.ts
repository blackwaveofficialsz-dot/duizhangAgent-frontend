import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiStreamFetch } from '../api/client';
import { notification } from 'antd';
import { clearSessionState } from '../api/sessionLifecycle';
import { useAuthStore } from '../store/authStore';
import { useChatStore } from '../store/chatStore';
import { useAgentChat } from './useAgentChat';
import type { AguiRunInput } from '../types/agui';
import type { AgentResponsePayload } from '../types';

vi.mock('../api/client', () => ({ apiFetch: vi.fn(), apiStreamFetch: vi.fn() }));
vi.mock('antd', () => ({ notification: { error: vi.fn(), info: vi.fn(), success: vi.fn() } }));

const assistant = () => {
  const messages = useChatStore.getState().sessions.find((s) => s.id === 'thread-1')!.messages.filter((m) => m.role === 'assistant');
  return messages[messages.length - 1];
};
const inputAt = (index = 0) => JSON.parse(vi.mocked(apiStreamFetch).mock.calls[index][1]!.body as string) as AguiRunInput;
const frame = (input: AguiRunInput, ordinal: number, type: string, data: Record<string, unknown> = {}) => `data: ${JSON.stringify({
  type, runId: input.runId, threadId: input.threadId, eventId: `${input.runId}:1:${ordinal}`,
  sequence: 1, createdAt: '2026-09-21T10:00:00+08:00', ...data,
})}\r\n\r\n`;
const textFrames = (input: AguiRunInput) => frame(input, 0, 'RUN_STARTED')
  + frame(input, 1, 'TEXT_MESSAGE_START', { messageId: 'text-1', role: 'assistant' })
  + frame(input, 2, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '你好' });

function mockStream(events: (input: AguiRunInput) => string, hold = false, sessionId?: string, runId?: string) {
  let channel: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn();
  const release = vi.fn();
  let body: ReadableStream<Uint8Array>;
  vi.mocked(apiStreamFetch).mockImplementationOnce(async (_url, options) => {
    const input = JSON.parse(options!.body as string) as AguiRunInput;
    if (runId) input.runId = runId;
    body = new ReadableStream<Uint8Array>({
      start(controller) {
        channel = controller;
        controller.enqueue(new TextEncoder().encode(events(input)));
        if (!hold) controller.close();
      }, cancel,
    });
    return { response: new Response(body, { headers: {
      'Content-Type': 'text/event-stream',
      ...(sessionId ? { 'X-AGUI-Session-ID': sessionId } : {}),
    } }), signal: options!.signal as AbortSignal, release };
  });
  return { cancel, release, emit: (events: string) => channel.enqueue(new TextEncoder().encode(events)), locked: () => body.locked };
}

const questionnaire = (runId = 'run-original', status = 'pending') => ({
  version: 1, domain: 'platform', task: 'clarification', result_status: 'needs_confirmation',
  result_id: 'result-questionnaire', source_turn_id: 'turn-original', parts: [{
    kind: 'questionnaire', clarification_id: 'clarification-1', run_id: runId,
    questions: [{ id: 'scope', header: '数据范围', question: '查看哪类订单？', options: [
      { id: 'sales', label: '经营订单', recommended: true }, { id: 'refunds', label: '退款订单' },
    ], allow_free_text: true }], status, expires_at: '2099-10-11T10:00:00+08:00',
    ...(status === 'answered' ? { answers: { scope: { option_id: 'sales' } } } : {}),
  }],
}) as unknown as AgentResponsePayload;

function restoreQuestionnaire() {
  useChatStore.setState({ sessions: [{
    id: 'thread-1', title: '订单分析', createdAt: 0, conversationMode: 'agui', messages: [
      { id: 'user-original', role: 'user', content: '给我上周订单', createdAt: 0 },
      { id: 'question-card', role: 'assistant', content: '请确认范围', createdAt: 1,
        agentResponse: questionnaire(), agui: { runId: 'run-original', status: 'interrupted' } },
    ],
  }] });
}

function restoreAcceptedQuestionnaire(expiresAt = '2099-10-11T10:00:00+08:00') {
  restoreQuestionnaire();
  const accepted = questionnaire('run-original', 'answered');
  useChatStore.getState().setMessageAgentResponse('thread-1', 'question-card', {
    ...accepted, parts: accepted.parts.map((part) => ({ ...part, expires_at: expiresAt })),
  });
  useChatStore.getState().setMessageAgui('thread-1', 'question-card', { runId: 'run-original', status: 'disconnected' });
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('VITE_AGUI_CHAT_ENABLED', 'true');
  useAuthStore.setState({ workspaceType: 'tenant', tenantId: 'tenant-1', activeWorkspaceId: 'tenant-1' });
  useChatStore.setState({ activeSessionId: 'thread-1', pendingApproval: null, sessions: [
    { id: 'thread-1', title: '新对话', messages: [], createdAt: 0, pending: true, conversationMode: 'agui' },
  ] });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('AG-UI opt-in conversation', () => {
  it.each(['2099-10-11T10:00:00+08:00', '2020-10-11T10:00:00+08:00'])(
    'reconnects an accepted answer with expiry %s on the same run after its read-only card', async (expiresAt) => {
    restoreAcceptedQuestionnaire(expiresAt);
    const stream = mockStream((input) => textFrames(input) + frame(input, 3, 'RUN_FINISHED'), false, undefined, 'run-original');
    const { result } = renderHook(() => useAgentChat());
    expect(result.current.canReconnectAguiRun('run-original')).toBe(true);

    await act(async () => {
      expect(await result.current.sendMessage('另一个问题')).toBe(false);
      expect(await result.current.reconnectAguiRun('run-original')).toBe(true);
    });

    expect(apiStreamFetch).toHaveBeenCalledOnce();
    expect(apiStreamFetch).toHaveBeenCalledWith('/api/v1/agui/runs/run-original/clarification', expect.anything());
    expect(JSON.parse(vi.mocked(apiStreamFetch).mock.calls[0][1]!.body as string)).toEqual({
      threadId: 'thread-1', requestId: expect.any(String), clarificationId: 'clarification-1',
      answers: { scope: { option_id: 'sales' } },
    });
    const messages = useChatStore.getState().sessions[0].messages;
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({ content: '请确认范围', agui: { status: 'completed' }, agentResponse: { parts: [{ status: 'answered' }] } });
    expect(messages[2]).toMatchObject({ content: '你好', streaming: false, agui: { runId: 'run-original', status: 'completed' } });
    expect(stream.release).toHaveBeenCalledOnce();
    expect(result.current.canReconnectAguiRun('run-original')).toBe(false);
    },
  );

  it('guards duplicate restored reconnections and reuses the answer request after a network break', async () => {
    restoreAcceptedQuestionnaire();
    const stream = mockStream(textFrames, true, undefined, 'run-original');
    const { result } = renderHook(() => useAgentChat());
    let connecting: Promise<unknown>;
    await act(async () => { connecting = result.current.reconnectAguiRun('run-original'); });
    await act(async () => { expect(await result.current.reconnectAguiRun('run-original')).toBe(false); });
    expect(apiStreamFetch).toHaveBeenCalledOnce();
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(3);
    const firstBody = vi.mocked(apiStreamFetch).mock.calls[0][1]!.body;
    await act(async () => {
      stream.emit('data: invalid-json\n\n');
      expect(await connecting!).toBe(false);
    });
    mockStream((input) => frame(input, 3, 'RUN_FINISHED'), false, undefined, 'run-original');

    await act(async () => { expect(await result.current.reconnectAguiRun('run-original')).toBe(true); });

    expect(vi.mocked(apiStreamFetch).mock.calls[1][1]!.body).toBe(firstBody);
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(3);
    expect(stream.release).toHaveBeenCalledOnce();
  });

  it('cancels a restored accepted run without submitting its answers again', async () => {
    restoreAcceptedQuestionnaire();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      accepted: true, run_id: 'run-original', run_status: 'cancelled', task_status: 'cancelled', event_cursor: 2,
    }), { headers: { 'Content-Type': 'application/json' } }));
    const { result } = renderHook(() => useAgentChat());

    await act(async () => { await result.current.cancelAguiRun('run-original'); });

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/agent-runs/cancel', expect.anything());
    expect(apiStreamFetch).not.toHaveBeenCalled();
    expect(assistant()).toMatchObject({ content: '请确认范围', agui: { status: 'cancelled' }, agentResponse: { parts: [{ status: 'answered' }] } });
    expect(result.current.canReconnectAguiRun('run-original')).toBe(false);
  });

  it('can reconnect after a failed historical cancellation without appending results to the answered card', async () => {
    restoreAcceptedQuestionnaire();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await expect(result.current.cancelAguiRun('run-original')).rejects.toThrow('offline'); });
    mockStream((input) => textFrames(input) + frame(input, 3, 'RUN_FINISHED'), false, undefined, 'run-original');

    await act(async () => { expect(await result.current.reconnectAguiRun('run-original')).toBe(true); });

    const messages = useChatStore.getState().sessions[0].messages;
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toBe('请确认范围');
    expect(messages[2].content).toBe('你好');
  });

  it.each(['cancel', 'unmount'] as const)('releases a restored accepted continuation on %s', async (reason) => {
    restoreAcceptedQuestionnaire();
    const stream = mockStream(textFrames, true, undefined, 'run-original');
    const { result, unmount } = renderHook(() => useAgentChat());
    let connecting: Promise<unknown>;
    await act(async () => { connecting = result.current.reconnectAguiRun('run-original'); });
    await act(async () => {
      if (reason === 'cancel') {
        vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
          accepted: true, run_id: 'run-original', run_status: 'cancelled', task_status: 'cancelled', event_cursor: 2,
        }), { headers: { 'Content-Type': 'application/json' } }));
        await result.current.cancelAguiRun('run-original');
      } else unmount();
      await connecting!;
    });

    expect(assistant()).toMatchObject({ streaming: false, stage: null,
      agui: { status: reason === 'cancel' ? 'cancelled' : 'disconnected' } });
    expect(useChatStore.getState().sessions[0].messages[1].agentResponse?.parts[0]).toMatchObject({ status: 'answered' });
    expect(stream.release).toHaveBeenCalledOnce();
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.locked()).toBe(false);
  });

  it('resumes the original run from a restored questionnaire and updates its card without adding a user bubble', async () => {
    restoreQuestionnaire();
    const stream = mockStream((input) => frame(input, 0, 'STATE_SNAPSHOT', { snapshot: {
      agent_response: questionnaire(input.runId, 'answered'),
    } }) + textFrames(input) + frame(input, 4, 'RUN_FINISHED'), false, undefined, 'run-original');
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      expect(await result.current.sendMessage('', undefined, {
        kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: 'run-original',
        clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
      })).toBe(true);
    });

    expect(apiStreamFetch).toHaveBeenCalledWith('/api/v1/agui/runs/run-original/clarification', expect.anything());
    expect(JSON.parse(vi.mocked(apiStreamFetch).mock.calls[0][1]!.body as string)).toEqual({
      threadId: 'thread-1', requestId: expect.any(String), clarificationId: 'clarification-1',
      answers: { scope: { option_id: 'sales' } },
    });
    const messages = useChatStore.getState().sessions[0].messages;
    expect(messages.filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.find((message) => message.id === 'question-card')).toMatchObject({
      agui: { status: 'completed' }, agentResponse: { parts: [{ status: 'answered', answers: { scope: { option_id: 'sales' } } }] },
    });
    expect(assistant()).toMatchObject({ content: '你好', streaming: false, stage: null, agui: { runId: 'run-original', status: 'completed' } });
    expect(assistant().agentResponse?.parts.some((part) => part.kind === 'questionnaire')).not.toBe(true);
    expect(apiFetch).not.toHaveBeenCalled();
    expect(stream.release).toHaveBeenCalledOnce();
    expect(stream.locked()).toBe(false);
  });

  it('rejects a questionnaire answer for a different source before contacting the server', async () => {
    restoreQuestionnaire();
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      expect(await result.current.sendMessage('', undefined, {
        kind: 'clarification_answer', source_turn_id: 'another-turn', run_id: 'run-original',
        clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
      })).toBe(false);
    });
    expect(apiStreamFetch).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(2);
  });

  it('continues a live questionnaire using its event cursor and then permits the next turn', async () => {
    const initial = mockStream((input) => frame(input, 0, 'RUN_STARTED') + frame(input, 1, 'STATE_SNAPSHOT', {
      snapshot: { agent_response: questionnaire(input.runId) },
    }) + frame(input, 2, 'RUN_FINISHED', { outcome: { type: 'interrupt' } }));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('给我上周订单')).toBe(true); });
    const input = inputAt();
    expect(assistant()).toMatchObject({ streaming: false, agui: { status: 'interrupted' } });
    expect(initial.release).toHaveBeenCalledOnce();
    const continuation = mockStream((scope) => frame(scope, 0, 'STATE_SNAPSHOT', {
      sequence: 2, eventId: `${scope.runId}:2:0`, snapshot: { agent_response: questionnaire(scope.runId, 'answered') },
    }) + frame(scope, 1, 'TEXT_MESSAGE_START', { sequence: 2, eventId: `${scope.runId}:2:1`, messageId: 'text-final', role: 'assistant' })
      + frame(scope, 2, 'TEXT_MESSAGE_CONTENT', { sequence: 2, eventId: `${scope.runId}:2:2`, messageId: 'text-final', delta: '订单结果' })
      + frame(scope, 3, 'RUN_FINISHED', { sequence: 2, eventId: `${scope.runId}:2:3` }), false, undefined, input.runId);
    await act(async () => {
      expect(await result.current.sendMessage('', undefined, {
        kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: input.runId,
        clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
      })).toBe(true);
    });
    expect(apiStreamFetch).toHaveBeenLastCalledWith(`/api/v1/agui/runs/${input.runId}/clarification`, expect.objectContaining({
      headers: expect.objectContaining({ 'Last-Event-ID': `${input.runId}:1:2` }),
    }));
    expect(assistant().content).toBe('订单结果');
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(3);
    expect(continuation.release).toHaveBeenCalledOnce();
    mockStream((scope) => frame(scope, 0, 'RUN_FINISHED'));
    await act(async () => { expect(await result.current.sendMessage('再按门店展示')).toBe(true); });
    expect(inputAt(2).runId).not.toBe(input.runId);
  });

  it.each(['cancel', 'unmount'] as const)('cleans up a questionnaire continuation on %s', async (reason) => {
    restoreQuestionnaire();
    const stream = mockStream((input) => frame(input, 0, 'RUN_STARTED'), true, undefined, 'run-original');
    const { result, unmount } = renderHook(() => useAgentChat());
    let sending: Promise<unknown>;
    await act(async () => { sending = result.current.sendMessage('', undefined, {
      kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: 'run-original',
      clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
    }); });
    await act(async () => {
      if (reason === 'cancel') {
        vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
          accepted: true, run_id: 'run-original', run_status: 'cancelled', task_status: 'cancelled', event_cursor: 2,
        })));
        await result.current.cancelAguiRun('run-original');
      } else unmount();
      await sending!;
    });
    expect(assistant()).toMatchObject({ streaming: false, stage: null, agui: { status: reason === 'cancel' ? 'cancelled' : 'disconnected' } });
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.release).toHaveBeenCalledOnce();
    expect(stream.locked()).toBe(false);
    if (reason === 'unmount') expect(apiFetch).not.toHaveBeenCalled();
  });

  it('cancels a restored questionnaire without resubmitting answers and updates the original card', async () => {
    restoreQuestionnaire();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      accepted: true, run_id: 'run-original', run_status: 'cancelled', task_status: 'cancelled', event_cursor: 2,
    })));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.cancelAguiRun('run-original'); });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/agent-runs/cancel', expect.objectContaining({
      body: expect.stringContaining('"run_id":"run-original"'),
    }));
    expect(apiStreamFetch).not.toHaveBeenCalled();
    expect(assistant()).toMatchObject({ agui: { status: 'cancelled' }, agentResponse: { parts: [{ status: 'cancelled' }] } });
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(2);
  });

  it.each([
    ['clarification_expired', 'expired', 'failed', 'expired'],
    ['clarification_cancelled', 'cancelled', 'cancelled', 'cancelled'],
    ['clarification_run_failed', 'failed', 'failed', 'pending'],
  ] as const)('terminates a rejected questionnaire with %s and preserves its server state', async (code, status, runStatus, cardStatus) => {
    restoreQuestionnaire();
    const release = vi.fn();
    vi.mocked(apiStreamFetch).mockImplementationOnce(async (_url, options) => ({
      response: new Response(JSON.stringify({ detail: { code, message: '问卷已结束', status } }), {
        status: 409, headers: { 'Content-Type': 'application/json' },
      }), signal: options!.signal as AbortSignal, release,
    }));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => {
      expect(await result.current.sendMessage('', undefined, {
        kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: 'run-original',
        clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
      })).toBe(false);
    });
    expect(assistant()).toMatchObject({ streaming: false, stage: null, agui: { status: runStatus, detail: '问卷已结束' } });
    expect(useChatStore.getState().sessions[0].messages[1]).toMatchObject({
      agui: { status: runStatus }, agentResponse: { parts: [{ status: cardStatus }] },
    });
    expect(result.current.canReconnectAguiRun('run-original')).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it('keeps a conflicting questionnaire editable for a corrected submission without reconnecting rejected answers', async () => {
    restoreQuestionnaire();
    vi.mocked(apiStreamFetch).mockImplementationOnce(async (_url, options) => ({
      response: new Response(JSON.stringify({ detail: {
        code: 'clarification_conflict', message: '答案已冲突，请重新选择', status: 'pending',
      } }), { status: 409, headers: { 'Content-Type': 'application/json' } }),
      signal: options!.signal as AbortSignal, release: vi.fn(),
    }));
    const { result } = renderHook(() => useAgentChat());
    const interaction = {
      kind: 'clarification_answer' as const, source_turn_id: 'turn-original', run_id: 'run-original',
      clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
    };
    await act(async () => { expect(await result.current.sendMessage('', undefined, interaction)).toBe(false); });
    expect(assistant().agui?.status).toBe('failed');
    expect(useChatStore.getState().sessions[0].messages[1]).toMatchObject({
      agui: { status: 'interrupted' }, agentResponse: { parts: [{ status: 'pending' }] },
    });
    await act(async () => { expect(await result.current.reconnectAguiRun('run-original')).toBe(false); });
    mockStream((input) => frame(input, 0, 'RUN_FINISHED'), false, undefined, 'run-original');
    await act(async () => { expect(await result.current.sendMessage('', undefined, {
      ...interaction, answers: { scope: { option_id: 'refunds' } },
    })).toBe(true); });
    expect(apiStreamFetch).toHaveBeenCalledTimes(2);
    const requests = vi.mocked(apiStreamFetch).mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(requests[1].requestId).not.toBe(requests[0].requestId);
    expect(requests[1].answers).toEqual({ scope: { option_id: 'refunds' } });
  });

  it('reconnects a disconnected questionnaire using the same answer request and applied cursor', async () => {
    restoreQuestionnaire();
    mockStream(textFrames, false, undefined, 'run-original');
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('', undefined, {
      kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: 'run-original',
      clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
    })).toBe(false); });
    const original = JSON.parse(vi.mocked(apiStreamFetch).mock.calls[0][1]!.body as string);
    mockStream((input) => frame(input, 3, 'STATE_SNAPSHOT', { snapshot: { agent_response: questionnaire(input.runId, 'answered') } })
      + frame(input, 4, 'RUN_FINISHED'), false, undefined, 'run-original');
    await act(async () => { expect(await result.current.reconnectAguiRun('run-original')).toBe(true); });
    expect(apiStreamFetch).toHaveBeenLastCalledWith('/api/v1/agui/runs/run-original/clarification', expect.objectContaining({
      body: JSON.stringify(original), headers: expect.objectContaining({ 'Last-Event-ID': 'run-original:1:2' }),
    }));
    expect(assistant()).toMatchObject({ content: '你好', agui: { status: 'completed' } });
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(3);
  });

  it('submits a live questionnaire through the canonical session returned by the initial stream', async () => {
    mockStream((input) => frame(input, 0, 'STATE_SNAPSHOT', { snapshot: { agent_response: questionnaire(input.runId) } })
      + frame(input, 1, 'RUN_FINISHED', { outcome: { type: 'interrupt' } }), false, 'tenant:tenant-1:thread-1');
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询订单')).toBe(true); });
    const runId = inputAt().runId;
    mockStream((input) => frame(input, 2, 'STATE_SNAPSHOT', { snapshot: { agent_response: questionnaire(input.runId, 'answered') } })
      + frame(input, 3, 'RUN_FINISHED'), false, undefined, runId);
    await act(async () => { expect(await result.current.sendMessage('', undefined, {
      kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: runId,
      clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
    })).toBe(true); });
    expect(JSON.parse(vi.mocked(apiStreamFetch).mock.calls[1][1]!.body as string).threadId).toBe('tenant:tenant-1:thread-1');
    const messages = useChatStore.getState().sessions[0].messages;
    expect(messages[1]).toMatchObject({ agentResponse: { parts: [{ status: 'answered' }] }, agui: { status: 'completed' } });
    expect(messages[2]).toMatchObject({ agui: { status: 'completed' }, streaming: false });
  });

  it('allows a later questionnaire on the same run after the first card has been answered', async () => {
    restoreQuestionnaire();
    const second = {
      ...questionnaire(), result_id: 'result-second', source_turn_id: 'turn-second',
      parts: questionnaire().parts.map((part) => ({ ...part, clarification_id: 'clarification-second' })),
    };
    mockStream((input) => frame(input, 0, 'STATE_SNAPSHOT', { snapshot: { agent_response: questionnaire(input.runId, 'answered') } })
      + frame(input, 1, 'STATE_SNAPSHOT', { snapshot: { agent_response: second } })
      + frame(input, 2, 'RUN_FINISHED', { outcome: { type: 'interrupt' } }), false, undefined, 'run-original');
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('', undefined, {
      kind: 'clarification_answer', source_turn_id: 'turn-original', run_id: 'run-original',
      clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
    })).toBe(true); });
    expect(useChatStore.getState().sessions[0].messages[1].agui?.status).toBe('completed');
    expect(assistant()).toMatchObject({ agentResponse: second, agui: { status: 'interrupted' } });
    mockStream((input) => frame(input, 3, 'STATE_SNAPSHOT', { snapshot: { agent_response: {
      ...second, parts: second.parts.map((part) => ({ ...part, status: 'answered', answers: { scope: { option_id: 'refunds' } } })),
    } } }) + frame(input, 4, 'RUN_FINISHED'), false, undefined, 'run-original');
    await act(async () => { expect(await result.current.sendMessage('', undefined, {
      kind: 'clarification_answer', source_turn_id: 'turn-second', run_id: 'run-original',
      clarification_id: 'clarification-second', answers: { scope: { option_id: 'refunds' } },
    })).toBe(true); });
    expect(useChatStore.getState().sessions[0].messages[2]).toMatchObject({
      agui: { status: 'completed' }, agentResponse: { parts: [{ status: 'answered', answers: { scope: { option_id: 'refunds' } } }] },
    });
    expect(apiStreamFetch).toHaveBeenCalledTimes(2);
  });

  it('guards duplicate questionnaire submissions and clears its continuation stream on a terminal failure', async () => {
    restoreQuestionnaire();
    const stream = mockStream((input) => frame(input, 0, 'RUN_STARTED'), true, undefined, 'run-original');
    const { result } = renderHook(() => useAgentChat());
    const interaction = {
      kind: 'clarification_answer' as const, source_turn_id: 'turn-original', run_id: 'run-original',
      clarification_id: 'clarification-1', answers: { scope: { option_id: 'sales' } },
    };
    let sending: Promise<unknown>;
    await act(async () => { sending = result.current.sendMessage('', undefined, interaction); });
    await act(async () => { expect(await result.current.sendMessage('', undefined, interaction)).toBe(false); });
    expect(apiStreamFetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      stream.emit(frame({ ...inputAt(), runId: 'run-original' }, 1, 'RUN_ERROR', { message: '处理失败' }));
      expect(await sending!).toBe(false);
    });
    expect(assistant()).toMatchObject({ streaming: false, stage: null, agui: { status: 'failed' } });
    expect(stream.release).toHaveBeenCalledOnce();
    expect(stream.locked()).toBe(false);
    expect(result.current.canReconnectAguiRun('run-original')).toBe(false);
  });

  it('uses the same AG-UI endpoint for a personal workspace', async () => {
    useAuthStore.setState({ workspaceType: 'personal', tenantId: undefined, activeWorkspaceId: undefined });
    mockStream((input) => frame(input, 0, 'RUN_STARTED') + frame(input, 1, 'RUN_FINISHED'), false, 'personal:personal-a:thread-1');
    const { result } = renderHook(() => useAgentChat());

    await act(async () => { expect(await result.current.sendMessage('你好')).toBe(true); });

    expect(apiStreamFetch).toHaveBeenCalledWith('/api/v1/agui/runs', expect.anything());
    expect(apiFetch).not.toHaveBeenCalledWith('/api/v1/chat', expect.anything());
    expect(useChatStore.getState().sessions[0]?.id).toBe('personal:personal-a:thread-1');
  });

  it('posts the documented shape, deduplicates full event IDs and keeps legacy transports unused', async () => {
    vi.mocked(apiFetch).mockImplementationOnce(async (_url, options) => {
      const input = JSON.parse(options!.body as string) as AguiRunInput;
      return new Response(JSON.stringify({ threadId: input.threadId, runId: input.runId, status: 'completed', content: '你好，世界' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const stream = mockStream((input) => textFrames(input)
      + frame(input, 2, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '你好' })
      + frame(input, 3, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '，世界' })
      + frame(input, 4, 'TEXT_MESSAGE_END', { messageId: 'text-1' })
      + frame(input, 5, 'RUN_FINISHED'));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询本周销售')).toBe(true); });
    expect(apiStreamFetch).toHaveBeenCalledWith('/api/v1/agui/runs', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    }));
    expect(inputAt()).toEqual({
      threadId: 'thread-1', runId: expect.any(String), parentRunId: null, state: {},
      messages: [{ id: expect.any(String), role: 'user', content: '查询本周销售' }], tools: [], context: [], forwardedProps: {},
    });
    expect(inputAt().runId).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(assistant()).toMatchObject({ content: '你好，世界', streaming: false, stage: null, agui: { status: 'completed' } });
    expect(useChatStore.getState().sessions[0]).toMatchObject({ id: 'thread-1', pending: false, loaded: true });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/agui/runs', expect.objectContaining({
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(inputAt()),
    }));
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(stream.locked()).toBe(false);
  });

  it('sends a clarification choice through AG-UI forwardedProps', async () => {
    mockStream((input) => frame(input, 0, 'RUN_FINISHED'));
    const { result } = renderHook(() => useAgentChat());

    await act(async () => {
      expect(await result.current.sendMessage('查看经营销售数据', undefined, {
        kind: 'clarification_choice',
        source_turn_id: 'turn-previous',
        candidate_id: 'analytics:sales_summary',
      })).toBe(true);
    });

    expect(inputAt().forwardedProps).toEqual({
      interaction: {
        kind: 'clarification_choice',
        source_turn_id: 'turn-previous',
        candidate_id: 'analytics:sales_summary',
      },
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/agui/runs', expect.objectContaining({
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    }));
  });

  it('uses the JSON result to complete missing text without repeating the run', async () => {
    vi.mocked(apiFetch).mockImplementationOnce(async (_url, options) => {
      const input = JSON.parse(options!.body as string) as AguiRunInput;
      return new Response(JSON.stringify({
        threadId: input.threadId, runId: input.runId,
        status: 'completed', content: '你好，世界',
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    mockStream((input) => textFrames(input) + frame(input, 3, 'RUN_FINISHED'));

    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(true); });

    expect(assistant()).toMatchObject({ content: '你好，世界', agui: { status: 'completed' } });
    expect(apiStreamFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the completed streamed answer when JSON retrieval fails', async () => {
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('snapshot unavailable'));
    mockStream((input) => textFrames(input) + frame(input, 3, 'RUN_FINISHED'));

    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(true); });

    expect(assistant()).toMatchObject({ content: '你好', agui: { status: 'completed' } });
    expect(notification.error).not.toHaveBeenCalled();
  });

  it('stops at RUN_ERROR even when later events share the same network chunk', async () => {
    const stream = mockStream((input) => textFrames(input)
      + frame(input, 3, 'RUN_ERROR', { code: 'agent_failed', message: '处理失败' })
      + frame(input, 4, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '不应显示' }), true);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(false); });
    expect(assistant()).toMatchObject({ content: '你好', streaming: false, stage: null, agui: { status: 'failed', detail: '处理失败' } });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(notification.error).toHaveBeenCalledWith(expect.objectContaining({ duration: 5, closable: true }));
  });

  it('keeps the retry decision supplied by RUN_ERROR', async () => {
    mockStream((input) => frame(input, 0, 'RUN_STARTED')
      + frame(input, 1, 'RUN_ERROR', { code: 'model_failed', message: '模型暂时不可用', retryable: true }), true);
    const { result } = renderHook(() => useAgentChat());

    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(false); });

    expect(assistant().agui).toMatchObject({ status: 'failed', retryable: true });
  });

  it('reconnects an incomplete run using the identical request and last applied cursor', async () => {
    mockStream(textFrames);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(false); });
    const original = inputAt();
    expect(assistant().agui?.status).toBe('disconnected');
    await act(async () => { expect(await result.current.sendMessage('重复发送')).toBe(false); });
    mockStream((input) => frame(input, 2, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '你好' })
      + frame(input, 3, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '完成' }) + frame(input, 4, 'RUN_FINISHED'));
    await act(async () => { await result.current.reconnectAguiRun(original.runId); });
    expect(inputAt(1)).toEqual(original);
    expect(apiStreamFetch).toHaveBeenLastCalledWith('/api/v1/agui/runs', expect.objectContaining({
      headers: expect.objectContaining({ 'Last-Event-ID': `${original.runId}:1:2` }),
    }));
    expect(assistant()).toMatchObject({ content: '你好完成', agui: { status: 'completed' } });
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(2);
  });

  it('does not finish at text/tool end and only displays safe tool result fields', async () => {
    const stream = mockStream((input) => textFrames(input)
      + frame(input, 3, 'TEXT_MESSAGE_END', { messageId: 'text-1' })
      + frame(input, 4, 'TOOL_CALL_START', { toolCallId: 'tool-1', toolCallName: 'internal_name' })
      + frame(input, 5, 'TOOL_CALL_ARGS', { toolCallId: 'tool-1', delta: '{"secret":"hidden"}' })
      + frame(input, 6, 'TOOL_CALL_END', { toolCallId: 'tool-1' })
      + frame(input, 7, 'TOOL_CALL_RESULT', { toolCallId: 'tool-1', content: '{"label":"读取经营数据","status":"completed","secret":"hidden"}' }), true);
    const { result } = renderHook(() => useAgentChat());
    let sending: Promise<unknown>;
    await act(async () => { sending = result.current.sendMessage('查询'); });
    expect(assistant().streaming).toBe(true);
    expect(assistant().activity?.steps).toEqual([expect.objectContaining({ detail: '读取经营数据', status: 'completed' })]);
    expect(JSON.stringify(assistant())).not.toContain('hidden');
    await act(async () => { stream.emit(frame(inputAt(), 8, 'RUN_FINISHED')); await sending; });
    expect(assistant().streaming).toBe(false);
  });

  it('keeps an approval interrupt distinct and resumes the same run after a confirmed decision', async () => {
    mockStream((input) => frame(input, 0, 'STATE_SNAPSHOT', { snapshot: { approval: {
      approval_id: 'approval-1', tool_label: '发送通知', message: '确认发送通知吗？', expires_at: '2026-09-21T10:15:00+08:00',
    } } }) + frame(input, 1, 'RUN_FINISHED', { outcome: { type: 'interrupt', interrupts: [] } }));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.sendMessage('查询'); });
    expect(assistant()).toMatchObject({ streaming: false, agui: {
      status: 'waiting_for_approval',
      detail: '确认发送通知吗？',
      approval: { id: 'approval-1', toolLabel: '发送通知' },
    } });
    expect(useChatStore.getState().pendingApproval).toBeNull();
    await act(async () => { expect(await result.current.sendMessage('同意执行')).toBe(false); });
    const run = inputAt();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      accepted: true, run_id: run.runId, run_status: 'queued', task_status: 'queued',
    }), { headers: { 'Content-Type': 'application/json' } }));
    mockStream((input) => frame(input, 2, 'RUN_STARTED') + frame(input, 3, 'RUN_FINISHED'));
    await act(async () => { expect(await result.current.decideAguiApproval(run.runId, 'approve')).toBe(true); });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/agent-runs/approve-action', expect.objectContaining({
      method: 'POST',
      body: expect.stringContaining('"decision":"approve"'),
    }));
    expect(inputAt(1)).toEqual(run);
    expect(apiStreamFetch).toHaveBeenLastCalledWith('/api/v1/agui/runs', expect.objectContaining({
      headers: expect.objectContaining({ 'Last-Event-ID': `${run.runId}:1:1` }),
    }));
    expect(assistant().agui?.status).toBe('completed');
  });

  it.each(['cancelled', 'interrupt'] as const)('does not mislabel a %s terminal outcome as completed', async (kind) => {
    mockStream((input) => frame(input, 0, 'RUN_FINISHED', kind === 'cancelled' ? { result: { status: kind } } : { outcome: { type: kind } }));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.sendMessage('查询'); });
    expect(assistant().agui?.status).toBe(kind === 'cancelled' ? 'cancelled' : 'interrupted');
  });

  it('only marks a run cancelled after server confirmation, reusing request_id after failure', async () => {
    const stream = mockStream(textFrames, true);
    const { result } = renderHook(() => useAgentChat());
    let sending: Promise<unknown>;
    await act(async () => { sending = result.current.sendMessage('查询'); });
    const runId = inputAt().runId;
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('offline'));
    await act(async () => { await expect(result.current.cancelAguiRun(runId)).rejects.toThrow('offline'); });
    expect(assistant().streaming).toBe(true);
    expect(stream.cancel).not.toHaveBeenCalled();
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      accepted: true, run_id: runId, run_status: 'cancelled', task_status: 'cancelled', event_cursor: 2,
    })));
    await act(async () => { await result.current.cancelAguiRun(runId); await sending; });
    const bodies = vi.mocked(apiFetch).mock.calls.map((call) => JSON.parse(call[1]!.body as string));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[0]).toEqual({ run_id: runId, request_id: expect.any(String) });
    expect(assistant()).toMatchObject({ streaming: false, stage: null, agui: { status: 'cancelled' } });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
  });

  it('does not confirm a merely accepted cancellation while the run remains running', async () => {
    mockStream(textFrames);
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.sendMessage('查询'); });
    const runId = inputAt().runId;
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({ accepted: true, run_id: runId, run_status: 'running', task_status: 'running', event_cursor: 2 })));
    await act(async () => { await expect(result.current.cancelAguiRun(runId)).rejects.toThrow('尚未确认'); });
    expect(assistant().agui?.status).toBe('disconnected');
  });

  it.each(['navigation', 'unmount', 'logout'] as const)('cleans up on %s without sending a server cancellation', async (reason) => {
    const stream = mockStream(textFrames, true);
    const { result, unmount } = renderHook(() => useAgentChat());
    let sending: Promise<unknown>;
    await act(async () => { sending = result.current.sendMessage('查询'); });
    await act(async () => {
      if (reason === 'navigation') useChatStore.getState().resetToNewSession();
      else if (reason === 'unmount') unmount();
      else clearSessionState();
      await sending;
    });
    expect(stream.cancel).toHaveBeenCalledTimes(1);
    expect(stream.release).toHaveBeenCalledTimes(1);
    expect(apiFetch).not.toHaveBeenCalled();
    if (reason !== 'logout') expect(assistant()).toMatchObject({ streaming: false, stage: null, agui: { status: 'disconnected' } });
  });

  it('fails closed on mismatched ownership envelopes and never falls back to legacy', async () => {
    mockStream((input) => frame(input, 0, 'RUN_STARTED', { threadId: 'another-tenant-thread' }));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(false); });
    expect(assistant().agui?.status).toBe('disconnected');
    expect(assistant().content).toBe('');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('gates the mode, keeps it fixed after start, and reuses the upload transport for files', async () => {
    const store = useChatStore.getState();
    store.setConversationMode('thread-1', 'legacy');
    vi.stubEnv('VITE_AGUI_CHAT_ENABLED', 'false');
    store.setConversationMode('thread-1', 'agui');
    expect(useChatStore.getState().sessions[0].conversationMode).toBe('legacy');
    vi.stubEnv('VITE_AGUI_CHAT_ENABLED', 'true');
    store.setConversationMode('thread-1', 'agui');
    const { result } = renderHook(() => useAgentChat());
    vi.mocked(apiFetch).mockResolvedValueOnce(new Response(JSON.stringify({
      session_id: 'thread-1', task_id: 'upload-task-1',
    }), { headers: { 'Content-Type': 'application/json' } }));
    await act(async () => { expect(await result.current.sendMessage('文件', { files: [new File(['data'], 'test.csv')] })).toBe(true); });
    expect(apiStreamFetch).not.toHaveBeenCalled();
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/chat/upload/async', expect.objectContaining({ method: 'POST' }));
    mockStream((input) => frame(input, 0, 'RUN_FINISHED'));
    await act(async () => { await result.current.sendMessage('查询'); });
    store.setConversationMode('thread-1', 'legacy');
    expect(useChatStore.getState().sessions[0].conversationMode).toBe('agui');
  });

  it('keeps one thread and creates a new run for a later completed turn', async () => {
    const { result } = renderHook(() => useAgentChat());
    for (const question of ['第一轮', '第二轮']) {
      mockStream((input) => textFrames(input) + frame(input, 3, 'RUN_FINISHED'));
      await act(async () => { await result.current.sendMessage(question); });
    }
    expect(inputAt(1).threadId).toBe(inputAt().threadId);
    expect(inputAt(1).runId).not.toBe(inputAt().runId);
    expect(inputAt(1).messages[0].content).toBe('第二轮');
    expect(useChatStore.getState().sessions[0].messages).toHaveLength(4);
    expect(result.current.canReconnectAguiRun(inputAt().runId)).toBe(false);
  });

  it.each([401, 404, 409, 422, 503])('does not fall back after HTTP %s and releases the failed response', async (status) => {
    const release = vi.fn();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.mocked(apiStreamFetch).mockResolvedValueOnce({
      response: new Response(body, { status }), signal: new AbortController().signal, release,
    });
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { expect(await result.current.sendMessage('查询')).toBe(false); });
    expect(assistant()).toMatchObject({ streaming: false, agui: { status: 'disconnected' } });
    expect(apiFetch).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not commit a malformed text event cursor and retains content on replay', async () => {
    mockStream((input) => textFrames(input) + frame(input, 3, 'TEXT_MESSAGE_CONTENT', { messageId: 'wrong-message', delta: 'wrong' }));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.sendMessage('查询'); });
    mockStream((input) => frame(input, 3, 'TEXT_MESSAGE_CONTENT', { messageId: 'text-1', delta: '重连成功' }) + frame(input, 4, 'RUN_FINISHED'));
    await act(async () => { await result.current.reconnectAguiRun(inputAt().runId); });
    expect(apiStreamFetch).toHaveBeenLastCalledWith('/api/v1/agui/runs', expect.objectContaining({
      headers: expect.objectContaining({ 'Last-Event-ID': `${inputAt().runId}:1:2` }),
    }));
    expect(assistant().content).toBe('你好重连成功');
  });

  it('accepts only validated structured metadata and never renders unknown raw snapshots', async () => {
    const response = {
      version: 1, domain: 'business', task: 'query', result_status: 'ok', result_id: 'result-1',
      source_turn_id: 'turn-1', parts: [{ kind: 'summary', message: '已获得结果' }],
    };
    mockStream((input) => textFrames(input)
      + frame(input, 3, 'STATE_SNAPSHOT', { snapshot: { agent_response: { internal: 'secret' } } })
      + frame(input, 4, 'STATE_SNAPSHOT', { snapshot: { agent_response: response } })
      + frame(input, 5, 'RUN_FINISHED'));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.sendMessage('查询'); });
    expect(assistant().agentResponse).toMatchObject(response);
    expect(JSON.stringify(assistant())).not.toContain('secret');
  });

  it('uses the shared session APIs for AG-UI history and deletion', async () => {
    mockStream((input) => frame(input, 0, 'RUN_FINISHED'));
    const { result } = renderHook(() => useAgentChat());
    await act(async () => { await result.current.sendMessage('查询'); });
    const store = useChatStore.getState();
    vi.mocked(apiFetch).mockResolvedValue(new Response(null, { status: 204 }));
    await act(async () => {
      store.setActiveSession('thread-1');
      store.deleteMessagePair('thread-1', assistant().id);
      await store.deleteSession('thread-1');
    });
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sessions/thread-1/messages', expect.objectContaining({ method: 'DELETE' }));
    expect(apiFetch).toHaveBeenCalledWith('/api/v1/sessions/thread-1', { method: 'DELETE' });
    expect(useChatStore.getState().sessions).toHaveLength(0);
  });
});
