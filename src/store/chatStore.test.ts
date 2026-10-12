// @vitest-environment jsdom

import { waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAgentActivity, parseAgentResponsePayload, type Session } from '../types';

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  notificationError: vi.fn(),
}));

vi.mock('../api/client', () => ({ apiFetch: mocks.apiFetch }));
vi.mock('antd', () => ({ notification: { error: mocks.notificationError } }));

import { useChatStore } from './chatStore';

function questionnairePayload(partOverrides: Record<string, unknown> = {}) {
  return {
    version: 1, domain: 'analytics', task: 'sales_summary', result_status: 'needs_confirmation',
    result_id: 'result-1', source_turn_id: 'turn-1',
    parts: [{
      kind: 'questionnaire', clarification_id: 'clarify-1', run_id: 'run-1', status: 'pending',
      expires_at: '2026-10-11T12:00:00',
      questions: [{ id: 'scope', header: '范围', question: '统计哪些门店？', allow_free_text: true, options: [
        { id: 'all', label: '全部门店', description: '已授权门店', recommended: true },
        { id: 'one', label: '指定门店' },
      ] }],
      ...partOverrides,
    }],
  };
}

function sessions(): Session[] {
  return [
    {
      id: 'session-1',
      title: '待删除会话',
      createdAt: 1,
      messages: [
        { id: 'user-1', role: 'user', content: '问题', createdAt: 1 },
        { id: 'assistant-1', role: 'assistant', content: '回答', createdAt: 2 },
        { id: 'user-2', role: 'user', content: '保留', createdAt: 3 },
      ],
    },
    { id: 'session-2', title: '其他会话', createdAt: 2, messages: [] },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({ sessions: sessions(), activeSessionId: 'session-1' });
});

describe('chatStore optimistic deletion', () => {
  it('restores pending and answered questionnaires from history metadata', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    const pending = questionnairePayload();
    const answered = questionnairePayload({ status: 'answered', answers: { scope: { option_id: 'all' } } });
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
      session_id: 'session-1', title: '历史会话', messages: [
        { id: 'pending', role: 'assistant', content: '请确认范围', created_at: '2026-10-11T10:00:00+08:00', metadata: { agent_response: pending } },
        { id: 'answered', role: 'assistant', content: '已确认范围', created_at: '2026-10-11T10:01:00+08:00', metadata: { agent_response: answered } },
      ],
    }) });
    await useChatStore.getState().loadSessionHistory('session-1');
    expect(useChatStore.getState().sessions[0].messages.map((message) => message.agentResponse)).toEqual([pending, answered]);
    expect(useChatStore.getState().sessions[0].messages.map((message) => message.agui)).toEqual([
      { runId: 'run-1', status: 'interrupted' }, { runId: 'run-1', status: 'disconnected' },
    ]);
  });

  it.each(['completed', 'failed', 'cancelled', 'pending', 'answered'])(
    'only restores the latest answered card when a later same-run record is %s', async (laterStatus) => {
      useChatStore.setState({ sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }] });
      const answered = questionnairePayload({ status: 'answered', answers: { scope: { option_id: 'all' } } });
      const laterMetadata = ['pending', 'answered'].includes(laterStatus)
        ? { agent_response: questionnairePayload({
          clarification_id: 'clarify-2', status: laterStatus,
          ...(laterStatus === 'answered' ? { answers: { scope: { option_id: 'one' } } } : {}),
        }) }
        : { run_id: 'run-1', execution_path: 'general_graph', delivery_status: laterStatus };
      mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
        session_id: 'session-1', title: '历史会话', messages: [
          { id: 'answered', role: 'assistant', content: '已确认范围', created_at: '2026-10-11T10:00:00+08:00',
            metadata: { run_id: 'run-1', execution_path: 'general_graph', delivery_status: 'completed', agent_response: answered } },
          { id: 'later', role: 'assistant', content: '后续结果', created_at: '2026-10-11T10:01:00+08:00', metadata: laterMetadata },
        ],
      }) });

      await useChatStore.getState().loadSessionHistory('session-1');

      const messages = useChatStore.getState().sessions[0].messages;
      expect(messages[0].agui?.status).toBe('completed');
      expect(messages[0].agentResponse?.parts[0]).toMatchObject({ status: 'answered' });
      expect(messages[1].agui?.status).toBe(laterStatus === 'pending' ? 'interrupted'
        : laterStatus === 'answered' ? 'disconnected' : laterStatus);
    },
  );

  it.each([
    ['expired', 'interrupted'], ['cancelled', 'cancelled'],
  ])('restores an assistant %s questionnaire as %s without execution metadata', async (status, expected) => {
    useChatStore.setState({ sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }] });
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
      session_id: 'session-1', title: '历史会话', messages: [{
        id: 'questionnaire', role: 'assistant', content: '范围确认', created_at: '2026-10-11T10:00:00+08:00',
        metadata: { agent_response: questionnairePayload({ status }) },
      }],
    }) });
    await useChatStore.getState().loadSessionHistory('session-1');
    expect(useChatStore.getState().sessions[0].messages[0].agui).toEqual({ runId: 'run-1', status: expected });
  });

  it('preserves terminal delivery status and does not derive questionnaire runs from mismatched or user metadata', async () => {
    useChatStore.setState({ sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }] });
    const agentResponse = questionnairePayload();
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
      session_id: 'session-1', title: '历史会话', messages: [
        { id: 'failed', role: 'assistant', content: '失败', created_at: '2026-10-11T10:00:00+08:00',
          metadata: { run_id: 'run-1', execution_path: 'general_graph', delivery_status: 'failed', agent_response: agentResponse } },
        { id: 'mismatched', role: 'assistant', content: '无效关联', created_at: '2026-10-11T10:00:00+08:00',
          metadata: { run_id: 'another-run', agent_response: agentResponse } },
        { id: 'user', role: 'user', content: '用户消息', created_at: '2026-10-11T10:00:00+08:00',
          metadata: { agent_response: agentResponse } },
      ],
    }) });
    await useChatStore.getState().loadSessionHistory('session-1');
    expect(useChatStore.getState().sessions[0].messages.map((message) => message.agui)).toEqual([
      { runId: 'run-1', status: 'failed', retryable: false }, undefined, undefined,
    ]);
  });

  it.each(['cancelled', 'failed'])('keeps accepted answers read-only and preserves a %s run after refresh', async (deliveryStatus) => {
    useChatStore.setState({ sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }] });
    const accepted = questionnairePayload({ status: 'answered', answers: { scope: { option_id: 'all' } } });
    mocks.apiFetch.mockResolvedValueOnce({ ok: true, json: vi.fn().mockResolvedValue({
      session_id: 'session-1', title: '历史会话', messages: [{
        id: 'accepted', role: 'assistant', content: '已确认范围', created_at: '2026-10-11T10:00:00+08:00',
        metadata: { run_id: 'run-1', execution_path: 'general_graph', delivery_status: deliveryStatus, agent_response: accepted },
      }],
    }) });

    await useChatStore.getState().loadSessionHistory('session-1');

    const message = useChatStore.getState().sessions[0].messages[0];
    expect(message.agui).toEqual({ runId: 'run-1', status: deliveryStatus, retryable: false });
    expect(message.agentResponse).toEqual(accepted);
    expect(message.agentResponse?.parts[0]).toMatchObject({ status: 'answered', answers: { scope: { option_id: 'all' } } });
  });

  it('accepts bounded questionnaire choices and pure text answers in the v1 parser', () => {
    expect(parseAgentResponsePayload(questionnairePayload())).not.toBeNull();
    expect(parseAgentResponsePayload(questionnairePayload({ status: 'answered', answers: { scope: { option_id: 'all' } } }))).not.toBeNull();
    expect(parseAgentResponsePayload(questionnairePayload({
      questions: [{ id: 'note', header: '说明', question: '补充要求', options: [] }],
      status: 'answered', answers: { note: { text: '按小时展示' } },
    }))).not.toBeNull();
    expect(parseAgentResponsePayload({ ...questionnairePayload(), parts: [{ kind: 'future_kind' }] })).not.toBeNull();
  });

  it('rejects malformed, oversized, or ambiguous questionnaire questions', () => {
    const question = { id: 'scope', header: '范围', question: '统计哪些门店？', options: [
      { id: 'all', label: '全部门店' }, { id: 'one', label: '指定门店' },
    ] };
    for (const part of [
      { clarification_id: '' }, { run_id: '' }, { status: 'unknown' }, { expires_at: 'not-a-date' },
      { questions: [] }, { questions: Array.from({ length: 4 }, (_, index) => ({ ...question, id: String(index) })) },
      { questions: [question, question] }, { questions: [{ ...question, header: '' }] },
      { questions: [{ ...question, question: '' }] }, { questions: [{ ...question, allow_free_text: 'yes' }] },
      { questions: [{ ...question, options: [question.options[0]] }] },
      { questions: [{ ...question, options: Array.from({ length: 4 }, (_, index) => ({ id: String(index), label: '门店' })) }] },
      { questions: [{ ...question, options: [question.options[0], question.options[0]] }] },
      { questions: [{ ...question, options: [{ id: '', label: '门店' }, question.options[1]] }] },
      { questions: [{ ...question, options: [{ id: 'all', label: '全部门店', recommended: 'yes' }, question.options[1]] }] },
    ]) {
      expect(parseAgentResponsePayload(questionnairePayload(part)), JSON.stringify(part)).toBeNull();
    }
  });

  it('rejects incomplete or unauthorized questionnaire answers', () => {
    for (const answers of [
      undefined, {}, { scope: {} }, { scope: { option_id: 'unknown' } }, { scope: { text: ' ' } },
      { wrong: { text: '其他问题' } }, { scope: { option_id: 'all', text: '混合答案' } },
      { scope: { option_id: 'all', unexpected: 'payload' } },
    ]) {
      expect(parseAgentResponsePayload(questionnairePayload({ status: 'answered', answers }))).toBeNull();
    }
    expect(parseAgentResponsePayload(questionnairePayload({
      questions: [{ id: 'scope', header: '范围', question: '统计哪些门店？', options: [
        { id: 'all', label: '全部门店' }, { id: 'one', label: '指定门店' },
      ] }],
      status: 'answered', answers: { scope: { text: '未经允许的自由输入' } },
    }))).toBeNull();
  });
  it('rolls back a session and reports an HTTP deletion failure', async () => {
    mocks.apiFetch.mockResolvedValueOnce({ ok: false });

    const deletion = useChatStore.getState().deleteSession('session-1');
    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual(['session-2']);
    expect(useChatStore.getState().activeSessionId).toBe('session-2');

    await deletion;

    expect(useChatStore.getState().sessions.map((session) => session.id)).toEqual(['session-1', 'session-2']);
    expect(useChatStore.getState().activeSessionId).toBe('session-1');
    expect(mocks.notificationError).toHaveBeenCalledWith(expect.objectContaining({
      message: '删除会话失败',
      description: expect.stringContaining('已恢复'),
    }));
  });

  it('rolls back a deleted message pair and reports a network failure', async () => {
    mocks.apiFetch.mockRejectedValueOnce(new Error('offline'));

    useChatStore.getState().deleteMessagePair('session-1', 'assistant-1');
    expect(useChatStore.getState().sessions[0].messages.map((message) => message.id)).toEqual(['user-2']);

    await waitFor(() => {
      expect(useChatStore.getState().sessions[0].messages.map((message) => message.id)).toEqual([
        'user-1',
        'assistant-1',
        'user-2',
      ]);
    });
    expect(mocks.notificationError).toHaveBeenCalledWith(expect.objectContaining({
      message: '删除消息失败',
      description: expect.stringContaining('已恢复'),
    }));
  });
});

describe('chatStore structured agent responses', () => {
  it('restores a persisted AG-UI failure from history metadata', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '失败历史', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1',
        title: '失败历史',
        messages: [{
          id: 'assistant-failed', role: 'assistant', content: '', task_id: 'run-1',
          created_at: '2026-09-23T01:00:00+08:00',
          metadata: {
            delivery_status: 'failed', execution_path: 'general_graph',
            run_id: 'run-1', failure_detail: '模型服务暂时未响应，请稍后重试。', retryable: true,
          },
        }],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    expect(useChatStore.getState().sessions[0]?.messages[0]).toMatchObject({
      id: 'assistant-failed',
      taskId: 'run-1',
      agui: { runId: 'run-1', status: 'failed', detail: '模型服务暂时未响应，请稍后重试。', retryable: true },
    });
  });

  it('restores a failed deterministic graph turn with its original question', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '花名册查询', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1', title: '花名册查询',
        messages: [
          { id: 'user-1', role: 'user', content: '凤城十二路店有哪些员工', created_at: '2026-09-28T10:00:00+08:00' },
          { id: 'assistant-1', role: 'assistant', content: '', task_id: 'run-hr', created_at: '2026-09-28T10:00:01+08:00',
            metadata: { delivery_status: 'failed', execution_path: 'deterministic_graph', run_id: 'run-hr',
              failure_reason: 'invalid_hr_query', failure_detail: '请修改花名册查询条件后重试。', retryable: false } },
        ],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    expect(messages).toHaveLength(2);
    expect(messages[0]?.content).toBe('凤城十二路店有哪些员工');
    expect(messages[1]?.agui).toEqual({
      runId: 'run-hr', status: 'failed', detail: '请修改花名册查询条件后重试。', retryable: false,
    });
  });

  it('restores a cancelled deterministic graph turn', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '花名册查询', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1', title: '花名册查询',
        messages: [
          { id: 'user-1', role: 'user', content: '查询员工', created_at: '2026-09-28T10:00:00+08:00' },
          { id: 'assistant-1', role: 'assistant', content: '', task_id: 'run-cancelled', created_at: '2026-09-28T10:00:01+08:00',
            metadata: { delivery_status: 'cancelled', execution_path: 'deterministic_graph', run_id: 'run-cancelled' } },
        ],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    expect(useChatStore.getState().sessions[0]?.messages[1]?.agui).toMatchObject({
      runId: 'run-cancelled', status: 'cancelled',
    });
  });

  it('restores a completed bounded ReAct reply as an AG-UI message', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '经营分析历史', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1',
        title: '经营分析历史',
        messages: [{
          id: 'assistant-completed', role: 'assistant', content: '昨日营业数据', task_id: 'run-2',
          created_at: '2026-09-24T10:00:00+08:00',
          metadata: {
            delivery_status: 'completed', execution_path: 'bounded_react', run_id: 'run-2',
          },
        }],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    expect(useChatStore.getState().sessions[0]?.messages[0]).toMatchObject({
      id: 'assistant-completed',
      taskId: 'run-2',
      agui: { runId: 'run-2', status: 'completed' },
    });
  });

  it.each(['completed', 'partial', 'empty', 'unavailable', 'failed'] as const)(
    'parses a bounded %s terminal activity with a server wall-clock total',
    (status) => {
      expect(parseAgentActivity({
        version: 'v1',
        status,
        label: `terminal-${status}`,
        elapsed_ms: 50,
        total_duration_ms: 175,
        steps: [{ step_id: 'load', label: '读取业务数据', status: 'completed', elapsed_ms: 50 }],
        scope: ['全部直营店'],
        sources: ['经营销售快照'],
      })).toMatchObject({ status, elapsed_ms: 50, total_duration_ms: 175 });
    },
  );

  it('installs a terminal server activity and never lets client completion overwrite it', () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', title: '活动会话', createdAt: 0,
        messages: [{ id: 'assistant-activity', role: 'assistant', content: '' }],
      }],
      activeSessionId: 'session-1',
    });
    const terminal = parseAgentActivity({
      version: 'v1', status: 'partial', label: '分析结果不完整', elapsed_ms: 50,
      total_duration_ms: 175,
      steps: [{ step_id: 'load', label: '读取业务数据', status: 'completed', elapsed_ms: 50 }],
      scope: ['凤八店'], sources: ['经营销售快照'],
    });

    const store = useChatStore.getState() as typeof useChatStore.getState extends () => infer State
      ? State & { setMessageActivity?: (sessionId: string, messageId: string, activity: NonNullable<typeof terminal>) => void }
      : never;
    expect(typeof store.setMessageActivity).toBe('function');
    store.setMessageActivity?.('session-1', 'assistant-activity', terminal!);
    useChatStore.getState().finishMessageActivity('session-1', 'assistant-activity', 'completed');

    expect(useChatStore.getState().sessions[0]?.messages[0]?.activity).toEqual(terminal);
  });

  it('restores only validated v1 activity summaries from history metadata', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1',
        title: '历史会话',
        messages: [
          {
            id: 'valid', role: 'assistant', content: '有效摘要', created_at: '2026-08-18T10:00:00+08:00',
            metadata: {
              agent_activity: {
                version: 'v1', status: 'completed', label: '已完成 1 项分析活动', elapsed_ms: 1800,
                steps: [{ step_id: 'load_data', label: '读取经营数据', status: 'completed', elapsed_ms: 1800, secret: 'drop-me' }],
                scope: ['凤八店'], sources: ['销售日快照'], secret: 'drop-me',
              },
            },
          },
          {
            id: 'invalid-version', role: 'assistant', content: '版本非法', created_at: '2026-08-18T10:01:00+08:00',
            metadata: { agent_activity: { version: 'v2', status: 'completed', label: '非法', elapsed_ms: 1, steps: [], scope: [], sources: [] } },
          },
          {
            id: 'invalid-steps', role: 'assistant', content: '步骤非法', created_at: '2026-08-18T10:02:00+08:00',
            metadata: {
              agent_activity: {
                version: 'v1', status: 'completed', label: '非法', elapsed_ms: 1,
                steps: [{ step_id: '', label: '空 ID', status: 'completed', elapsed_ms: -1 }], scope: [], sources: [],
              },
            },
          },
          {
            id: 'user-metadata', role: 'user', content: '用户问题', created_at: '2026-08-18T10:03:00+08:00',
            metadata: {
              agent_activity: {
                version: 'v1', status: 'completed', label: '不应附到用户消息', elapsed_ms: 1,
                steps: [], scope: [], sources: [],
              },
            },
          },
        ],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    expect(messages[0]?.activity).toEqual({
      version: 'v1', status: 'completed', label: '已完成 1 项分析活动', elapsed_ms: 1800,
      steps: [{ step_id: 'load_data', label: '读取经营数据', status: 'completed', elapsed_ms: 1800, sequence: 1 }],
      scope: ['凤八店'], sources: ['销售日快照'],
    });
    expect(messages[1]?.activity).toBeUndefined();
    expect(messages[2]?.activity).toBeUndefined();
    expect(messages[3]?.activity).toBeUndefined();
    expect(messages.map((message) => message.content)).toEqual(['有效摘要', '版本非法', '步骤非法', '用户问题']);
  });

  it('keeps a step label and sequence stable across heartbeat updates', () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1', title: '活动会话', createdAt: 0,
        messages: [{ id: 'assistant-activity', role: 'assistant', content: '' }],
      }],
      activeSessionId: 'session-1',
    });

    useChatStore.getState().upsertMessageActivityStep('session-1', 'assistant-activity', {
      step_id: 'load', label: '读取经营数据', detail: '第一批', status: 'running', elapsed_ms: 100, sequence: 2,
    });
    useChatStore.getState().upsertMessageActivityStep('session-1', 'assistant-activity', {
      step_id: 'load', label: '不应覆盖标题', detail: '第二批', status: 'completed', elapsed_ms: 200, sequence: 9,
    });

    expect(useChatStore.getState().sessions[0]?.messages[0]?.activity?.steps).toEqual([
      expect.objectContaining({ step_id: 'load', label: '读取经营数据', detail: '第二批', status: 'completed', elapsed_ms: 200, sequence: 2 }),
    ]);
  });

  it('loads agent response history without discarding connector evidence', async () => {
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '历史会话',
        messages: [],
        createdAt: 0,
        loaded: false,
      }],
      activeSessionId: 'session-1',
    });
    const agentResponse = {
      version: 1 as const,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok' as const,
      result_id: 'result-1',
      source_turn_id: 'turn-1',
      parts: [
        { kind: 'insights', title: '经营结论', items: [{ statement_type: 'fact', text: '收入稳定。', evidence_refs: ['sales:today'] }] },
        { kind: 'notice', message: '数据已核验。', severity: 'info', code: 'verified' },
      ],
      actions: [{ action_id: 'compare', kind: 'prompt', label: '对比上一周期', source_turn_id: 'turn-1', params: { message: '对比上一周期经营数据' } }],
    };
    const evidence = {
      dataset_ids: ['orders'],
      dataset_name: '订单',
      date_range: { from: '2026-08-01', to: '2026-08-01' },
      scope: 'all',
      fields: [],
      filters: [],
      group_by: [],
      metrics: [],
      knowledge_entries: [],
      row_counts: {
        all: 1,
        date_filtered: 1,
        field_filtered: 1,
        scope_filtered: 1,
        returned: 1,
        truncated: false,
      },
      warnings: [],
    };
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1',
        title: '历史会话',
        messages: [{
          id: 'assistant-1',
          role: 'assistant',
          content: '销售汇总',
          created_at: '2026-08-18T10:00:00+08:00',
          metadata: {
            connector_query: { evidence },
            agent_response: agentResponse,
          },
        }],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    const message = useChatStore.getState().sessions[0]?.messages[0];
    expect(message?.agentResponse).toEqual(agentResponse);
    expect(message?.agentResponse?.parts.map((part) => part.kind)).toEqual(['insights', 'notice']);
    expect(message?.agentResponse?.actions?.[0]?.kind).toBe('prompt');
    expect(message?.evidence).toEqual(evidence);
  });

  it('ignores invalid history responses without discarding their connector evidence or text', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    const evidence = {
      dataset_ids: [], dataset_name: '订单', date_range: { from: null, to: null }, scope: 'all',
      fields: [], filters: [], group_by: [], metrics: [], knowledge_entries: [],
      row_counts: { all: 1, date_filtered: 1, field_filtered: 1, scope_filtered: 1, returned: 1, truncated: false }, warnings: [],
    };
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1', title: '历史会话',
        messages: [
          { id: 'v2', role: 'assistant', content: '版本回退', created_at: '2026-08-18T10:00:00+08:00', metadata: { connector_query: { evidence }, agent_response: { version: 2 } } },
          { id: 'missing', role: 'assistant', content: '字段回退', created_at: '2026-08-18T10:01:00+08:00', metadata: { connector_query: { evidence }, agent_response: { version: 1, parts: [] } } },
          { id: 'part', role: 'assistant', content: '分段回退', created_at: '2026-08-18T10:02:00+08:00', metadata: { connector_query: { evidence }, agent_response: { version: 1, domain: 'analytics', task: 'sales_summary', result_status: 'ok', result_id: 'result-1', source_turn_id: 'turn-1', parts: [{}] } } },
        ],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    const messages = useChatStore.getState().sessions[0]?.messages ?? [];
    expect(messages.map((message) => message.agentResponse)).toEqual([undefined, undefined, undefined]);
    expect(messages.map((message) => message.content)).toEqual(['版本回退', '字段回退', '分段回退']);
    expect(messages.map((message) => message.evidence)).toEqual([evidence, evidence, evidence]);
  });

  it('ignores oversized history previews without discarding connector evidence or text', async () => {
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '历史会话', messages: [], createdAt: 0, loaded: false }],
      activeSessionId: 'session-1',
    });
    const evidence = {
      dataset_ids: [], dataset_name: '订单', date_range: { from: null, to: null }, scope: 'all',
      fields: [], filters: [], group_by: [], metrics: [], knowledge_entries: [],
      row_counts: { all: 1, date_filtered: 1, field_filtered: 1, scope_filtered: 1, returned: 1, truncated: false }, warnings: [],
    };
    mocks.apiFetch.mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        session_id: 'session-1', title: '历史会话',
        messages: [{
          id: 'oversized', role: 'assistant', content: '明细回退', created_at: '2026-08-18T10:00:00+08:00',
          metadata: {
            connector_query: { evidence },
            agent_response: {
              version: 1, domain: 'analytics', task: 'sales_summary', result_status: 'ok', result_id: 'result-1', source_turn_id: 'turn-1',
              parts: [{ kind: 'table', preview_rows: Array.from({ length: 51 }, (_, index) => ({ row: index })) }],
            },
          },
        }],
      }),
    });

    await useChatStore.getState().loadSessionHistory('session-1');

    const message = useChatStore.getState().sessions[0]?.messages[0];
    expect(message?.content).toBe('明细回退');
    expect(message?.agentResponse).toBeUndefined();
    expect(message?.evidence).toEqual(evidence);
  });

  it('rejects missing fields and malformed part shapes in the shared parser', () => {
    expect(parseAgentResponsePayload({ version: 1, parts: [] })).toBeNull();
    expect(parseAgentResponsePayload({
      version: 1, domain: 'analytics', task: 'sales_summary', result_status: 'ok', result_id: 'result-1', source_turn_id: 'turn-1',
      parts: [{ kind: '', metrics: [{}] }],
    })).toBeNull();
  });

  it('rejects malformed optional part fields and actions in the shared parser', () => {
    const payload = {
      version: 1,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok',
      result_id: 'result-1',
      source_turn_id: 'turn-1',
    };

    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'summary', metrics: [{}] }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'table', columns: [{}] }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'table', preview_rows: ['not-an-object'] }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'summary', title: 1 }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'summary', message: false }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'table', table_id: {} }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'table', row_count: -1 }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [{ kind: 'table', row_count: '1' }] })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload, parts: [], actions: [{}] })).toBeNull();
  });

  it('accepts validated insights, notices, prompt actions, and clarification actions in the shared parser', () => {
    const payload = {
      version: 1,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok',
      result_id: 'result-1',
      source_turn_id: 'turn-1',
    };

    expect(parseAgentResponsePayload({ ...payload,
      parts: [{ kind: 'notice', message: '缺数据', severity: 'warning', code: 'missing_dates' }],
      actions: [
        { action_id: 'compare', kind: 'prompt', label: '对比上期', source_turn_id: 'turn-1', params: { message: '对比上一周期' } },
        { action_id: 'sales', kind: 'clarify', label: '查看经营销售数据', source_turn_id: 'turn-1', params: { candidate_id: 'analytics:sales_summary', message: '查看经营销售数据' } },
      ],
    })).not.toBeNull();
  });

  it('rejects invalid v1 insight, notice, and prompt shapes in the shared parser', () => {
    const payload = {
      version: 1,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok',
      result_id: 'result-1',
      source_turn_id: 'turn-1',
    };

    expect(parseAgentResponsePayload({ ...payload,
      parts: [{ kind: 'insights', items: [{ statement_type: 'cause', text: '确定由天气导致', evidence_refs: [] }] }],
    })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload,
      parts: [{ kind: 'summary', metrics: Array.from({ length: 7 }, (_, index) => ({ key: String(index), value: '1' })) }],
    })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload,
      parts: [{ kind: 'notice', message: '缺数据', severity: 'fatal', code: 'missing_dates' }],
    })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload,
      parts: [], actions: [{ action_id: 'compare', kind: 'prompt', label: '对比上期', source_turn_id: 'turn-1', params: { message: '' } }],
    })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload,
      parts: [], actions: Array.from({ length: 4 }, (_, index) => ({ action_id: String(index), kind: 'prompt', label: '追问', source_turn_id: 'turn-1', params: { message: '查看经营数据' } })) },
    )).toBeNull();
    expect(parseAgentResponsePayload({ ...payload,
      parts: [], actions: [{ action_id: 'compare', kind: 'prompt', label: '对比上期', source_turn_id: 'turn-other', params: { message: '对比上一周期' } }],
    })).toBeNull();
    expect(parseAgentResponsePayload({ ...payload,
      parts: [{ kind: 'clarification', message: '任意降级文字' }],
      actions: [{ action_id: 'sales', kind: 'clarify', label: '查看经营销售数据', source_turn_id: 'turn-other', params: { candidate_id: 'analytics:sales_summary', message: '查看经营销售数据' } }],
    })).toBeNull();
    for (const params of [
      { candidate_id: '', message: '查看经营销售数据' },
      { candidate_id: 'analytics:sales_summary', message: '' },
      { candidate_id: 'analytics:sales_summary', message: '查看经营销售数据', extra: 'unexpected' },
    ]) {
      expect(parseAgentResponsePayload({ ...payload,
        parts: [{ kind: 'clarification', message: '任意降级文字' }],
        actions: [{ action_id: 'sales', kind: 'clarify', label: '查看经营销售数据', source_turn_id: 'turn-1', params }],
      })).toBeNull();
    }
    for (const sourceTurnId of ['', '   ']) {
      expect(parseAgentResponsePayload({ ...payload,
        source_turn_id: sourceTurnId,
        parts: [], actions: [{ action_id: 'compare', kind: 'prompt', label: '对比上期', source_turn_id: sourceTurnId, params: { message: '对比上一周期' } }],
      })).toBeNull();
    }
    for (const params of [
      { message: '对比上一周期', url: 'https://unsafe.example' },
      { message: '对比上一周期', command: 'unsafe' },
      { message: '对比上一周期', href: 'https://unsafe.example' },
      { message: '对比上一周期', method: 'POST' },
      { message: '对比上一周期', payload: 'unsafe' },
      { message: '对比上一周期', tool: 'unsafe' },
      { message: '对比上一周期', unexpected: 'unsafe' },
    ]) {
      expect(parseAgentResponsePayload({ ...payload,
        parts: [], actions: [{ action_id: 'compare', kind: 'prompt', label: '对比上期', source_turn_id: 'turn-1', params }],
      })).toBeNull();
    }
  });

  it('sets an agent response without overwriting existing evidence', () => {
    const agentResponse = {
      version: 1 as const,
      domain: 'analytics',
      task: 'sales_summary',
      result_status: 'ok' as const,
      result_id: 'result-1',
      source_turn_id: 'turn-1',
      parts: [],
    };
    const evidence = sessions()[0].messages[1];
    useChatStore.setState({
      sessions: [{
        id: 'session-1',
        title: '测试会话',
        createdAt: 0,
        messages: [{ ...evidence, evidence: {
          dataset_ids: [], dataset_name: '订单', date_range: { from: null, to: null }, scope: 'all',
          fields: [], filters: [], group_by: [], metrics: [], knowledge_entries: [],
          row_counts: { all: 0, date_filtered: 0, field_filtered: 0, scope_filtered: 0, returned: 0, truncated: false }, warnings: [],
        } }],
      }],
    });

    useChatStore.getState().setMessageAgentResponse('session-1', 'assistant-1', agentResponse);

    const message = useChatStore.getState().sessions[0]?.messages[0];
    expect(message?.agentResponse).toEqual(agentResponse);
    expect(message?.evidence?.dataset_name).toBe('订单');
  });

  it('updates only the matching session and message when IDs overlap', () => {
    const agentResponse = {
      version: 1 as const, domain: 'analytics', task: 'sales_summary', result_status: 'ok' as const,
      result_id: 'result-1', source_turn_id: 'turn-1', parts: [],
    };
    useChatStore.setState({
      sessions: [
        { id: 'session-1', title: '会话一', createdAt: 0, messages: [{ id: 'assistant-1', role: 'assistant', content: '一' }] },
        { id: 'session-2', title: '会话二', createdAt: 0, messages: [{ id: 'assistant-1', role: 'assistant', content: '二' }] },
      ],
    });

    useChatStore.getState().setMessageAgentResponse('session-1', 'assistant-1', agentResponse);

    expect(useChatStore.getState().sessions[0]?.messages[0]?.agentResponse).toEqual(agentResponse);
    expect(useChatStore.getState().sessions[1]?.messages[0]?.agentResponse).toBeUndefined();
  });
});
