import { apiFetch, apiStreamFetch } from './client';
import { readSseData } from './sse';
import { aguiRecord, type AguiEvent, type AguiRunInput } from '../types/agui';
import type { ClarificationAnswer } from '../types';

export interface AguiClarificationInput {
  threadId: string;
  runId: string;
  requestId: string;
  clarificationId: string;
  answers: Record<string, ClarificationAnswer>;
}

export class AguiClarificationError extends Error {
  constructor(message: string, readonly code: string, readonly status: string, readonly httpStatus: number) {
    super(message);
    this.name = 'AguiClarificationError';
  }
}

export async function fetchAguiRunResult(input: AguiRunInput, signal: AbortSignal): Promise<string> {
  const response = await apiFetch('/api/v1/agui/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(input),
    signal,
  });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('无法读取本轮完整回复。');
  }
  const result = aguiRecord(await response.json());
  if (result?.threadId !== input.threadId || result.runId !== input.runId
    || result.status !== 'completed' || typeof result.content !== 'string') {
    throw new Error('本轮完整回复与当前任务不匹配。');
  }
  return result.content;
}

export function streamAguiRun(
  input: AguiRunInput,
  signal: AbortSignal,
  lastEventId?: string,
  onSessionId?: (sessionId: string) => void,
): AsyncGenerator<AguiEvent> {
  return streamAguiEvents('/api/v1/agui/runs', input, input, signal, lastEventId, onSessionId);
}

export function streamAguiClarification(
  input: AguiClarificationInput,
  signal: AbortSignal,
  lastEventId?: string,
  onSessionId?: (sessionId: string) => void,
): AsyncGenerator<AguiEvent> {
  const { runId, ...body } = input;
  return streamAguiEvents(`/api/v1/agui/runs/${encodeURIComponent(runId)}/clarification`, body, input, signal, lastEventId, onSessionId, true);
}

async function* streamAguiEvents(
  endpoint: string,
  body: object,
  input: Pick<AguiRunInput, 'threadId' | 'runId'>,
  signal: AbortSignal,
  lastEventId?: string,
  onSessionId?: (sessionId: string) => void,
  clarification = false,
): AsyncGenerator<AguiEvent> {
  const stream = await apiStreamFetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  try {
    const { response } = stream;
    if (!response.ok) {
      const payload = response.headers.get('content-type')?.includes('application/json')
        ? aguiRecord(await response.json().catch(() => null)) : null;
      const detail = typeof payload?.detail === 'string' ? payload.detail.slice(0, 240) : '';
      if (clarification) {
        const structured = aguiRecord(payload?.detail);
        throw new AguiClarificationError(
          typeof structured?.message === 'string' ? structured.message.slice(0, 240) : detail || '问卷提交失败，请稍后重试。',
          typeof structured?.code === 'string' ? structured.code : 'clarification_http_error',
          typeof structured?.status === 'string' ? structured.status : '', response.status,
        );
      }
      if (response.status === 403) throw new Error(detail || '无权访问当前工作空间，请切换到有权限的空间。');
      throw new Error(detail || `新对话请求失败（HTTP ${response.status}），请稍后重试。`);
    }
    if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
      throw new Error('新对话接口未返回事件流，请确认接口已同步。');
    }
    const sessionId = response.headers.get('x-agui-session-id');
    if (sessionId) onSessionId?.(sessionId);
    for await (const raw of readSseData(response.body, stream.signal)) {
      if (stream.signal.aborted) break;
      let event: Record<string, unknown> | null;
      try { event = aguiRecord(JSON.parse(raw)); } catch { event = null; }
      const cursor = typeof event?.eventId === 'string' ? event.eventId.split(':') : [];
      if (!event || typeof event.type !== 'string'
        || event.runId !== input.runId || event.threadId !== input.threadId
        || !Number.isSafeInteger(event.sequence) || Number(event.sequence) < 0
        || cursor.length !== 3 || cursor[0] !== input.runId
        || cursor[1] !== String(event.sequence) || !/^\d+$/.test(cursor[2])
        || !Number.isSafeInteger(Number(cursor[2]))) {
        throw new Error('收到无法识别的新对话事件，已暂停接收。');
      }
      yield event as AguiEvent;
      if (event.type === 'RUN_FINISHED' || event.type === 'RUN_ERROR') break;
    }
  } finally {
    if (stream.response.body && !stream.response.body.locked) await stream.response.body.cancel().catch(() => undefined);
    stream.release();
  }
}
