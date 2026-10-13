import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as XLSX from 'xlsx-js-style';

import { MessageBubble } from './MessageBubble';
import { useChatStore } from '../store/chatStore';
import type { Message } from '../types';

vi.mock('xlsx-js-style', () => ({
  utils: {
    aoa_to_sheet: vi.fn((rows: string[][]) => ({ rows })),
    book_new: vi.fn(() => ({})),
    book_append_sheet: vi.fn(),
  },
  writeFile: vi.fn(),
}));

describe('MessageBubble table rendering', () => {
  beforeAll(() => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    Object.defineProperty(window, 'getComputedStyle', {
      writable: true,
      value: vi.fn(() => ({
        getPropertyValue: vi.fn(() => ''),
        width: '0px',
        height: '0px',
        overflow: 'hidden',
        overflowX: 'hidden',
        overflowY: 'hidden',
      })),
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(() => Promise.resolve()) },
    });
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: [],
      activeSessionId: null,
      loadingHistory: false,
      pendingApproval: null,
    });
  });

  const message: Message = {
    id: 'assistant-1',
    role: 'assistant',
    content: [
      '**经营分析报告**',
      '',
      '门店表现',
      '',
      '| 门店 | 净实收 |',
      '| --- | ---: |',
      '| 茅坡店 | ¥77,851.45 |',
      '',
      '产品结构',
      '',
      '| 产品 | 销量 |',
      '| --- | ---: |',
      '| 招牌擀面皮 | 9219 |',
    ].join('\n'),
  };

  it('downloads only the table attached to the clicked table toolbar', async () => {
    render(<MessageBubble message={message} sessionId="session-1" />);

    const downloadButtons = screen.getAllByTitle('下载表格');
    expect(downloadButtons).toHaveLength(2);

    fireEvent.click(downloadButtons[1]);

    await waitFor(() => expect(XLSX.utils.aoa_to_sheet).toHaveBeenCalledWith([
        ['产品', '销量'],
        ['招牌擀面皮', '9219'],
      ]));
    expect(XLSX.writeFile).toHaveBeenCalledTimes(1);
  });

  it('opens fullscreen for only the clicked table', () => {
    render(<MessageBubble message={message} sessionId="session-1" />);

    const fullscreenButtons = screen.getAllByTitle('全屏展示');
    expect(fullscreenButtons).toHaveLength(2);

    fireEvent.click(fullscreenButtons[1]);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('招牌擀面皮')).toBeTruthy();
    expect(within(dialog).queryByText('茅坡店')).toBeNull();
  });

  it('keeps copy and delete actions wired through AntD buttons', async () => {
    const userMessage: Message = {
      id: 'user-1',
      role: 'user',
      content: '昨天产品销量',
    };
    useChatStore.setState({
      sessions: [{ id: 'session-1', title: '测试会话', messages: [userMessage, message], createdAt: Date.now() }],
      activeSessionId: 'session-1',
    });

    render(<MessageBubble message={message} sessionId="session-1" />);

    fireEvent.click(screen.getByTitle('复制内容'));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(message.content);
    expect(await screen.findByText('已复制')).toBeTruthy();

    fireEvent.click(screen.getByTitle('删除问答'));
    expect(useChatStore.getState().sessions[0].messages).toEqual([]);
  });

  it('keeps a completed activity disclosure above the final answer without hiding the answer', () => {
    const activityMessage: Message = {
      id: 'assistant-activity',
      role: 'assistant',
      content: '最终经营结论',
      activity: {
        version: 'v1', status: 'completed', label: '分析活动已完成', elapsed_ms: 1800,
        steps: [{ step_id: 'load', label: '读取经营数据', status: 'completed', elapsed_ms: 1800, sequence: 1 }],
        scope: [], sources: [],
      },
    };

    render(<MessageBubble message={activityMessage} sessionId="session-1" />);

    const answer = screen.getByText('最终经营结论');
    const disclosure = screen.getByRole('button', { name: /已完成 1 项分析活动/ });
    expect(disclosure.getAttribute('aria-expanded')).toBe('false');
    expect(answer).toBeTruthy();

    fireEvent.click(disclosure);

    expect(disclosure.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('读取经营数据')).toBeTruthy();
    expect(screen.getByText('最终经营结论')).toBe(answer);
  });

  it('keeps the legacy stage loading fallback when public activity is absent', () => {
    render(<MessageBubble message={{
      id: 'assistant-legacy', role: 'assistant', content: '', streaming: true,
      stage: { code: 'legacy', label: '旧阶段仍在处理', status: 'running' },
    }} sessionId="session-1" />);

    expect(screen.getByText('旧阶段仍在处理')).toBeTruthy();
  });

  it('shows one compact AG-UI loading state and delays the specific stage', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<MessageBubble message={{
        id: 'assistant-agui', role: 'assistant', content: '', streaming: true,
        stage: { code: 'query', label: '正在查询经营数据', status: 'running' },
        agui: { runId: 'run-1', status: 'connecting', detail: '正在连接' },
      }} sessionId="session-1" loadingAction={<button type="button">停止</button>} />);

      expect(screen.getByRole('status').textContent).toBe('分析中');
      expect(screen.queryByText(/正在连接/)).toBeNull();
      expect(screen.queryByText(/正在查询经营数据/)).toBeNull();
      expect(container.querySelectorAll('.animate-bounce')).toHaveLength(0);
      expect(container.querySelectorAll('[class*="animate-spin"]')).toHaveLength(1);
      expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();

      act(() => { vi.advanceTimersByTime(3000); });
      expect(screen.getByRole('status').textContent).toContain('正在查询经营数据');
    } finally {
      vi.useRealTimers();
    }
  });

  it('suppresses the legacy loading bubble for a streaming public activity, including research activity', () => {
    render(<MessageBubble message={{
      id: 'assistant-research', role: 'assistant', content: '', streaming: true,
      activity: {
        version: 'v1', status: 'running', label: '正在研究', elapsed_ms: 100,
        steps: [{ step_id: 'research:running', label: '正在研究', status: 'running', elapsed_ms: 100, sequence: 1 }],
        scope: [], sources: [],
      },
    }} sessionId="session-1" />);

    expect(screen.getByRole('button', { name: /正在研究/ })).toBeTruthy();
    expect(screen.queryByText('分析中')).toBeNull();
  });

  it('does not render an empty assistant shell when the parent owns the transport status', () => {
    const { container } = render(<MessageBubble message={{
      id: 'assistant-empty',
      role: 'assistant',
      content: '',
      streaming: false,
      agui: { runId: 'run-empty', status: 'failed', detail: 'graph_failed' },
    }} sessionId="session-1" />);

    expect(container.firstChild).toBeNull();
  });

  it('keeps activity and structured response as ordered siblings before message actions', () => {
    const activityMessage: Message = {
      id: 'assistant-structured', role: 'assistant', content: '兼容文字', createdAt: 1,
      activity: {
        version: 'v1', status: 'completed', label: '分析活动已完成', elapsed_ms: 200,
        steps: [{ step_id: 'load', label: '读取经营数据', status: 'completed', elapsed_ms: 200, sequence: 1 }],
        scope: [], sources: [],
      },
      agentResponse: {
        version: 1, domain: 'analytics', task: 'sales_summary', result_status: 'ok',
        result_id: 'result-1', source_turn_id: 'turn-1', parts: [],
      },
    };

    render(<MessageBubble
      message={activityMessage}
      sessionId="session-1"
      hideStructuredContent
      structuredContent={<section data-testid="structured-response">结构化回答</section>}
    />);

    const activity = screen.getByRole('button', { name: /已完成 1 项分析活动/ }).closest('section');
    const response = screen.getByTestId('structured-response');
    const copy = screen.getByTitle('复制内容');
    expect(activity?.parentElement).toBe(response.parentElement);
    expect((activity?.compareDocumentPosition(response) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(response.compareDocumentPosition(copy) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(activity?.parentElement?.className).toContain('gap-2');
  });

  describe('AG-UI typewriter presentation', () => {
    let frames: Map<number, FrameRequestCallback>;
    let time: number;
    let frameId: number;
    const running: Message = {
      id: 'animated', role: 'assistant', content: '', createdAt: 0, streaming: true,
      agui: { runId: 'run-1', status: 'running' },
    };
    const tick = (ms = 32) => act(() => {
      time += ms;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(time));
    });
    beforeEach(() => {
      time = 0;
      frameId = 0;
      frames = new Map();
      vi.spyOn(performance, 'now').mockImplementation(() => time);
      vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
      vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
    });
    afterEach(() => {
      cleanup();
      vi.mocked(performance.now).mockRestore();
      vi.mocked(window.requestAnimationFrame).mockRestore();
      vi.mocked(window.cancelAnimationFrame).mockRestore();
    });

    it('animates only display text, separates run completion, and copies the full source', async () => {
      const { container, rerender } = render(<MessageBubble message={running} sessionId="s" animateText />);
      const received = { ...running, content: '**经营分析**\n\n普通文字。'.repeat(4) };
      rerender(<MessageBubble message={received} sessionId="s" animateText />);
      expect(container.querySelector('.markdown-body')?.textContent).toBe('');
      tick();
      expect(container.querySelector('.markdown-body')?.textContent?.length).toBeGreaterThan(0);
      const completed: Message = { ...received, streaming: false, agui: { runId: 'run-1', status: 'completed' } };
      rerender(<MessageBubble message={completed} sessionId="s" animateText />);
      expect(screen.getByText('回答已生成，正在显示')).toBeTruthy();
      expect(screen.queryByTitle('复制内容')).toBeNull();
      expect(container.querySelector('.markdown-body')?.closest('[aria-live="off"]')).not.toBeNull();
      expect(screen.queryByRole('button', { name: '直接显示全部' })).toBeNull();
      for (let i = 0; i < 40; i++) tick();
      expect(screen.queryByText('回复已完整显示')).toBeNull();
      expect(container.querySelectorAll('.markdown-body strong')).toHaveLength(4);
      fireEvent.click(screen.getByTitle('复制内容'));
      await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(received.content));
      expect(frames.size).toBe(0);
    });

    it('keeps long completed answers collapsible', () => {
      const content = '**经营分析**\n\n普通文字。'.repeat(200);
      const completed: Message = {
        ...running, content, streaming: false, agui: { runId: 'run-1', status: 'completed' },
      };
      const { container } = render(<MessageBubble message={completed} sessionId="s" />);
      expect(container.querySelector('.max-h-72')).not.toBeNull();
      fireEvent.click(screen.getByRole('button', { name: '展开全文' }));
      expect(container.querySelector('.max-h-72')).toBeNull();
      expect(container.querySelectorAll('.markdown-body strong')).toHaveLength(200);
    });

    it.each(['failed', 'cancelled', 'interrupted', 'disconnected', 'waiting_for_approval'] as const)(
      'flushes immediately on %s without pretending the task is still running', (status) => {
        const { rerender } = render(<MessageBubble message={running} sessionId="s" animateText />);
        const received = { ...running, content: '已经完整收到的回复' };
        rerender(<MessageBubble message={received} sessionId="s" animateText />);
        expect(screen.getByText('正在显示回复')).toBeTruthy();
        rerender(<MessageBubble message={{ ...received, streaming: false, agui: { runId: 'run-1', status } }} sessionId="s" animateText />);
        expect(screen.getByText(received.content)).toBeTruthy();
        expect(screen.queryByRole('button', { name: '直接显示全部' })).toBeNull();
        expect(frames.size).toBe(0);
      },
    );

    it('reveals a streamed sales table progressively and finishes the table after the run ends', () => {
      const { rerender } = render(<MessageBubble message={running} sessionId="s" animateText />);
      const firstChunk = '**9 月销售数据**\n\n| 日期 | 净实收 |\n| --- | ---: |\n| 9月1日 | ¥100.00 |';
      const fullText = `${firstChunk}\n| 9月2日 | ¥200.00 |`;
      rerender(<MessageBubble message={{ ...running, content: firstChunk }} sessionId="s" animateText />);
      expect(screen.getByText('正在显示回复')).toBeTruthy();
      tick();
      rerender(<MessageBubble message={{ ...running, content: fullText }} sessionId="s" animateText />);
      expect(screen.queryByText('9月2日')).toBeNull();
      rerender(<MessageBubble message={{ ...running, content: fullText, streaming: false, agui: { runId: 'run-1', status: 'completed' } }} sessionId="s" animateText />);
      expect(screen.queryByText('9月2日')).toBeNull();
      for (let i = 0; i < 60; i++) tick();
      expect(screen.getByText('9月2日')).toBeTruthy();
      expect(screen.getByTitle('下载表格')).toBeTruthy();
      expect(frames.size).toBe(0);
    });

    it.each([
      '```ts\nconst n = 1;\n```',
      '<p>完整正文</p><script>alert(1)</script>',
    ])('bypasses animation for complex Markdown and retains sanitization: %s', (content) => {
      const { container, rerender } = render(<MessageBubble message={running} sessionId="s" animateText />);
      rerender(<MessageBubble message={{ ...running, content }} sessionId="s" animateText />);
      expect(container.querySelector('.markdown-body')?.textContent?.length).toBeGreaterThan(0);
      expect(container.querySelector('script')).toBeNull();
      expect(screen.queryByRole('button', { name: '直接显示全部' })).toBeNull();
      expect(frames.size).toBe(0);
    });

    it('shows structured results immediately and does not animate standard mode', () => {
      const { rerender } = render(<MessageBubble message={running} sessionId="s" animateText />);
      rerender(<MessageBubble message={{ ...running, content: '接收完的内容' }} sessionId="s" animateText />);
      expect(screen.getByText('正在显示回复')).toBeTruthy();
      const response = {
        version: 1, domain: 'analytics', task: 'summary', result_status: 'ok',
        result_id: 'result-1', source_turn_id: 'turn-1', parts: [],
      } as NonNullable<Message['agentResponse']>;
      rerender(<MessageBubble message={{ ...running, content: '接收完的内容', agentResponse: response }} sessionId="s" animateText structuredContent={<div>结构化结果</div>} />);
      expect(screen.getByText('接收完的内容')).toBeTruthy();
      expect(screen.getByText('结构化结果')).toBeTruthy();
      expect(frames.size).toBe(0);
      rerender(<MessageBubble message={{ ...running, agui: undefined, content: '标准模式直接显示' }} sessionId="s" />);
      expect(screen.getByText('标准模式直接显示')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '直接显示全部' })).toBeNull();
    });
  });

  it('allows safe markdown but removes hostile tags, attributes, and URL protocols', () => {
    const scriptCall = 'alert' + '(1)';
    const hostileMessage: Message = {
      id: 'assistant-hostile',
      role: 'assistant',
      content: [
        '[安全链接](https://safe.example/report)',
        '[相对链接](/reports/1)',
        `<p id="tracking" class="remote" style="background:url(https://evil.example/pixel)" onclick="${scriptCall}">安全正文</p>`,
        `<form action="https://evil.example/steal"><input name="secret"><button formaction="javascript:${scriptCall}">提交</button></form>`,
        `<a href="java&#x09;script:${scriptCall}">混淆脚本</a>`,
        `<a href="data:text/html,&lt;script&gt;${scriptCall}&lt;/script&gt;">HTML 数据</a>`,
        `<a href="data:image/svg+xml,&lt;svg onload=${scriptCall}&gt;">SVG 数据</a>`,
        `<img src="https://evil.example/pixel" onerror="${scriptCall}">`,
        '<video src="https://evil.example/movie" poster="https://evil.example/poster"></video>',
        `<svg><a xlink:href="javascript:${scriptCall}">SVG 链接</a></svg>`,
      ].join('\n\n'),
    };

    const { container } = render(<MessageBubble message={hostileMessage} sessionId="session-1" />);
    const markdown = container.querySelector('.markdown-body');
    expect(markdown).not.toBeNull();

    expect(markdown?.querySelector('a[href="https://safe.example/report"]')).not.toBeNull();
    expect(markdown?.querySelector('a[href="/reports/1"]')).not.toBeNull();
    expect(markdown?.querySelector('form, input, button, img, video, svg')).toBeNull();
    expect(markdown?.querySelector('[style], [action], [formaction], [src], [srcdoc], [onerror], [onclick]')).toBeNull();
    expect(markdown?.querySelector('[id], [class], [data-tracking]')).toBeNull();

    for (const link of Array.from(markdown?.querySelectorAll('a') ?? [])) {
      const href = link.getAttribute('href') ?? '';
      expect(href.toLowerCase()).not.toMatch(/^(?:javascript|data):/);
      expect(href.replace(/[\u0000-\u0020\u007f]/g, '').toLowerCase()).not.toMatch(/^javascript:/);
    }
  });
});
