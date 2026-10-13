import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTableTypewriter, useTypewriter } from './useTypewriter';

describe('display-only typewriter', () => {
  let time: number;
  let nextFrame: number;
  let frames: Map<number, FrameRequestCallback>;
  let motion: EventTarget & { matches: boolean };
  const advance = (duration = 32) => act(() => {
    time += duration;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(time));
  });
  const start = (text = '', streaming = true, enabled = true) => renderHook(
    (props) => useTypewriter(props.text, props.enabled, props.streaming),
    { initialProps: { text, streaming, enabled } },
  );
  const startTable = (total = 0, streaming = true, enabled = true) => renderHook(
    (props) => useTableTypewriter(props.total, props.enabled, props.streaming),
    { initialProps: { total, streaming, enabled } },
  );

  beforeEach(() => {
    time = 0;
    nextFrame = 0;
    frames = new Map();
    motion = Object.assign(new EventTarget(), { matches: false });
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.stubGlobal('matchMedia', vi.fn(() => motion));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('receives full text immediately but displays only two graphemes per refresh', () => {
    const source = '真实流式接收与前端轻量打字机。'.repeat(20);
    const { result, rerender } = start();
    rerender({ text: source, streaming: true, enabled: true });
    expect(result.current.text).toBe('');
    expect(result.current.isTyping).toBe(true);
    advance();
    expect(result.current.text.length).toBeGreaterThan(0);
    expect(result.current.text.length).toBeLessThan(source.length);
    const prefix = result.current.text;
    rerender({ text: source + '新片段', streaming: true, enabled: true });
    expect(result.current.text).toBe(prefix);
    for (let i = 0; i < 160; i++) advance();
    expect(result.current.text).toBe(source + '新片段');
    expect(frames.size).toBe(0);
  });

  it('does not turn network latency into a first-frame jump', () => {
    const { result, rerender } = start();
    time = 10_000;
    const text = '收到内容以后开始显示'.repeat(30);
    rerender({ text, streaming: true, enabled: true });
    advance();
    expect(result.current.text.length).toBeGreaterThan(0);
    expect(result.current.text.length).toBeLessThan(text.length);
  });

  it('reveals the first streamed chunk at a gentler pace', () => {
    const { result, rerender } = start();
    rerender({ text: '销售数据'.repeat(8), streaming: true, enabled: true });
    advance(32);
    expect(result.current.text).toBe('销售');
  });

  it('keeps the base pace when the backlog does not require acceleration', () => {
    const { result, rerender } = start();
    const source = '销售数据'.repeat(20);
    rerender({ text: source, streaming: true, enabled: true });
    advance(80);
    expect(result.current.text).toBe('销售');
    rerender({ text: source, streaming: false, enabled: true });
    advance(600);
    expect(result.current.text).toBe('销售数据');
    expect(result.current.isTyping).toBe(true);
  });

  it('accelerates a large streaming backlog to catch up in about five seconds', () => {
    const { result, rerender } = start();
    const text = '经营数据'.repeat(1000);
    rerender({ text, streaming: true, enabled: true });
    advance();
    expect(result.current.text.length).toBeGreaterThan(4);
    for (let i = 0; i < 156; i++) advance();
    expect(result.current.text).toBe(text);
    expect(result.current.isTyping).toBe(false);
  });

  it('finishes any remaining playback within ten seconds after run completion', () => {
    const { result, rerender } = start();
    const text = '很长回答'.repeat(1000);
    rerender({ text, streaming: true, enabled: true });
    advance();
    rerender({ text, streaming: false, enabled: true });
    expect(result.current.isTyping).toBe(true);
    advance(10_000);
    expect(result.current.text).toBe(text);
    expect(result.current.isTyping).toBe(false);
    expect(frames.size).toBe(0);
  });

  it('flushes when interrupted or disabled and resumes only with new text', () => {
    const { result, rerender } = start();
    rerender({ text: '断线前已经收到的内容', streaming: true, enabled: true });
    rerender({ text: '断线前已经收到的内容', streaming: false, enabled: false });
    expect(result.current.text).toBe('断线前已经收到的内容');
    expect(result.current.isTyping).toBe(false);
    expect(frames.size).toBe(0);
    rerender({ text: '断线前已经收到的内容', streaming: true, enabled: true });
    expect(result.current.text).toBe('断线前已经收到的内容');
    rerender({ text: '断线前已经收到的内容，重连新增', streaming: true, enabled: true });
    expect(result.current.text).toBe('断线前已经收到的内容');
    advance(1000);
    advance();
    advance();
    expect(result.current.text).toBe('断线前已经收到的内容，重连新增');
  });

  it('never replays history or already received content on mount', () => {
    const history = start('历史完整回答', false);
    expect(history.result.current.text).toBe('历史完整回答');
    history.rerender({ text: '更新后的历史完整回答', streaming: false, enabled: true });
    expect(history.result.current.text).toBe('更新后的历史完整回答');
    expect(start('切回正在流式的会话').result.current.text).toBe('切回正在流式的会话');
    expect(frames.size).toBe(0);
  });

  it('keeps emoji, combining marks, flags and Chinese on grapheme boundaries', () => {
    const { result, rerender } = start();
    const units = ['中', '👨‍👩‍👧‍👦', 'e\u0301', '🇨🇳', '👍🏽', '文'];
    const text = units.join('');
    const prefixes = units.map((_, index) => units.slice(0, index + 1).join(''));
    rerender({ text, streaming: true, enabled: true });
    for (let i = 0; i < 4; i++) {
      advance();
      expect(prefixes).toContain(result.current.text);
    }
    expect(result.current.text).toBe(text);
  });

  it('flushes when reduced motion is requested and removes listeners', () => {
    const removed = vi.spyOn(motion, 'removeEventListener');
    const { result, rerender, unmount } = start();
    rerender({ text: '减弱动态效果立即完整展示', streaming: true, enabled: true });
    act(() => { motion.matches = true; motion.dispatchEvent(new Event('change')); });
    expect(result.current.text).toBe('减弱动态效果立即完整展示');
    expect(frames.size).toBe(0);
    unmount();
    expect(removed).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('flushes in background and does not replay old text when visible again', () => {
    const { result, rerender } = start();
    rerender({ text: '已经接收的后台内容', streaming: true, enabled: true });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.text).toBe('已经接收的后台内容');
    expect(frames.size).toBe(0);
    rerender({ text: '已经接收的后台内容，继续', streaming: true, enabled: true });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(result.current.text).toBe('已经接收的后台内容，继续');
    expect(frames.size).toBe(0);
  });

  it('clears scheduled frames on unmount', () => {
    const { rerender, unmount } = start();
    rerender({ text: '等待显示', streaming: true, enabled: true });
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
  });

  it('renders oversized answers and non-prefix replacements immediately', () => {
    const { result, rerender } = start();
    rerender({ text: '长'.repeat(20_001), streaming: true, enabled: true });
    expect(result.current.text).toHaveLength(20_001);
    rerender({ text: '服务器替换了内容', streaming: true, enabled: true });
    expect(result.current.text).toBe('服务器替换了内容');
    expect(frames.size).toBe(0);
  });

  it('reveals live structured table rows one by one', () => {
    const { result, rerender } = startTable();
    rerender({ total: 3, streaming: true, enabled: true });
    expect(result.current).toEqual({ count: 0, isTyping: true });
    advance(96);
    expect(result.current).toEqual({ count: 1, isTyping: true });
    advance(96);
    expect(result.current.count).toBe(2);
    advance(96);
    expect(result.current).toEqual({ count: 3, isTyping: false });
  });

  it('does not replay structured table rows from history', () => {
    const history = startTable(10, false, true);
    expect(history.result.current).toEqual({ count: 10, isTyping: false });
    expect(frames.size).toBe(0);
  });

  it('plays newly received completed text without requiring a streamed render', () => {
    const source = '后端瞬间结束，前端仍然继续逐字显示。';
    const { result } = renderHook(() => useTypewriter(source, true, false, true));
    expect(result.current).toEqual({ text: '', isTyping: true });
    advance();
    expect(result.current.text.length).toBeGreaterThan(0);
    expect(result.current.text.length).toBeLessThan(source.length);
    advance(10_000);
    expect(result.current).toEqual({ text: source, isTyping: false });
    expect(frames.size).toBe(0);
  });

  it('plays newly mounted completed rows and clears playback on unmount', () => {
    const { result, unmount } = renderHook(() => useTableTypewriter(3, true, false, true));
    expect(result.current).toEqual({ count: 0, isTyping: true });
    advance(160);
    expect(result.current).toEqual({ count: 1, isTyping: true });
    unmount();
    expect(frames.size).toBe(0);
  });

  it.each(['reduced motion', 'hidden tab'])('shows fresh completed content directly for %s without replaying later', (reason) => {
    if (reason === 'reduced motion') motion.matches = true;
    else vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const text = renderHook(() => useTypewriter('完整已收到文本', true, false, true));
    const rows = renderHook(() => useTableTypewriter(3, true, false, true));
    expect(text.result.current).toEqual({ text: '完整已收到文本', isTyping: false });
    expect(rows.result.current).toEqual({ count: 3, isTyping: false });
    expect(frames.size).toBe(0);
    act(() => {
      motion.matches = false;
      motion.dispatchEvent(new Event('change'));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(text.result.current.text).toBe('完整已收到文本');
    expect(rows.result.current.count).toBe(3);
    expect(frames.size).toBe(0);
  });

  it('releases completed playback listeners and restores them only for new content', () => {
    const addedMotion = vi.spyOn(motion, 'addEventListener');
    const removedMotion = vi.spyOn(motion, 'removeEventListener');
    const addedDocument = vi.spyOn(document, 'addEventListener');
    const removedDocument = vi.spyOn(document, 'removeEventListener');
    const visibilityCalls = (calls: unknown[][]) => calls.filter(call => call[0] === 'visibilitychange').length;
    const { result, rerender } = renderHook(({ text, total }) => ({
      text: useTypewriter(text, true, false, true),
      rows: useTableTypewriter(total, true, false, true),
    }), { initialProps: { text: '已收到内容', total: 3 } });
    advance(10_000);
    expect(result.current.text).toEqual({ text: '已收到内容', isTyping: false });
    expect(result.current.rows).toEqual({ count: 3, isTyping: false });
    expect(frames.size).toBe(0);
    expect(removedMotion.mock.calls.length).toBe(addedMotion.mock.calls.length);
    expect(visibilityCalls(removedDocument.mock.calls)).toBe(visibilityCalls(addedDocument.mock.calls));

    rerender({ text: '已收到内容，新增内容仍逐字显示', total: 5 });
    expect(result.current.text.isTyping).toBe(true);
    expect(result.current.rows).toEqual({ count: 3, isTyping: true });
    const registrations = addedMotion.mock.calls.length;
    advance();
    expect(addedMotion.mock.calls.length).toBe(registrations);
    expect(result.current.text.text).not.toBe('已收到内容，新增内容仍逐字显示');
    advance(10_000);
    expect(result.current.text.isTyping).toBe(false);
    expect(result.current.rows).toEqual({ count: 5, isTyping: false });
    expect(removedMotion.mock.calls.length).toBe(addedMotion.mock.calls.length);
    expect(visibilityCalls(removedDocument.mock.calls)).toBe(visibilityCalls(addedDocument.mock.calls));
    expect(frames.size).toBe(0);
  });

  it.each([
    ['text', 'reduced motion'], ['table', 'reduced motion'],
    ['text', 'hidden tab'], ['table', 'hidden tab'],
  ])('resumes %s playback after %s flushed and removed its listeners', (kind, environment) => {
    const addedMotion = vi.spyOn(motion, 'addEventListener');
    const removedMotion = vi.spyOn(motion, 'removeEventListener');
    const addedDocument = vi.spyOn(document, 'addEventListener');
    const removedDocument = vi.spyOn(document, 'removeEventListener');
    const expectNoListeners = () => {
      expect(removedMotion.mock.calls.length).toBe(addedMotion.mock.calls.length);
      expect(removedDocument.mock.calls.filter(call => call[0] === 'visibilitychange').length)
        .toBe(addedDocument.mock.calls.filter(call => call[0] === 'visibilitychange').length);
    };
    const { result, rerender, unmount } = renderHook(({ text, total }) => ({
      text: useTypewriter(text, true, false, true),
      rows: useTableTypewriter(total, true, false, true),
    }), { initialProps: { text: '先收到的完整内容', total: 3 } });
    act(() => {
      if (environment === 'reduced motion') {
        motion.matches = true;
        motion.dispatchEvent(new Event('change'));
      } else {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        document.dispatchEvent(new Event('visibilitychange'));
      }
    });
    expect(result.current.text).toEqual({ text: '先收到的完整内容', isTyping: false });
    expect(result.current.rows).toEqual({ count: 3, isTyping: false });
    expect(frames.size).toBe(0);
    expectNoListeners();
    act(() => {
      motion.matches = false;
      motion.dispatchEvent(new Event('change'));
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const complete = '先收到的完整内容，恢复后新增的文字继续播放';
    rerender({ text: complete, total: 5 });
    if (kind === 'text') expect(result.current.text).toEqual({ text: '先收到的完整内容', isTyping: true });
    else expect(result.current.rows).toEqual({ count: 3, isTyping: true });
    advance(10_000);
    expect(result.current.text).toEqual({ text: complete, isTyping: false });
    expect(result.current.rows).toEqual({ count: 5, isTyping: false });
    expectNoListeners();
    expect(frames.size).toBe(0);
    unmount();
    expectNoListeners();
    expect(frames.size).toBe(0);
  });

  it('finishes structured table playback after the stream ends', () => {
    const { result, rerender } = startTable();
    rerender({ total: 100, streaming: true, enabled: true });
    advance(96);
    expect(result.current.count).toBeGreaterThan(0);
    expect(result.current.count).toBeLessThan(100);
    rerender({ total: 100, streaming: false, enabled: true });
    advance(10_000);
    expect(result.current).toEqual({ count: 100, isTyping: false });
    expect(frames.size).toBe(0);
  });
});
