/// <reference lib="es2022.intl" />
import { useEffect, useRef, useState } from 'react';

const segmenter = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const FRAME_MS = 32;
const BASE_GRAPHEMES_PER_FRAME = 2;
const STREAM_CATCH_UP_MS = 5_000;
const COMPLETION_CATCH_UP_MS = 10_000;
const TABLE_FRAME_MS = 96;

/** Display only: never delays source text, protocol events, or run completion. */
export function useTypewriter(text: string, enabled: boolean, streaming: boolean, startOnMount = false) {
  const [displayed, setDisplayed] = useState(enabled && startOnMount ? '' : text);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const hasStreamed = useRef(streaming || startOnMount);
  const displayedRef = useRef(displayed);
  const lastPaint = useRef(performance.now());
  // Very long answers render directly, keeping segmentation and repeated Markdown work bounded.
  const animate = enabled && !reducedMotion && !hidden && Boolean(segmenter)
    && text.length <= 20_000 && (streaming || hasStreamed.current);
  const compatible = text.startsWith(displayed);
  const needsPlayback = enabled && (streaming || displayed !== text);
  const refreshingEnvironment = needsPlayback && !animate && (
    reducedMotion !== (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    || hidden !== (document.visibilityState === 'hidden')
  );
  const isTyping = (animate || refreshingEnvironment) && compatible && displayed.length < text.length;

  useEffect(() => {
    if (!needsPlayback) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(media?.matches ?? false);
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    onMotion();
    onVisibility();
    media?.addEventListener?.('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      media?.removeEventListener?.('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [needsPlayback]);

  useEffect(() => {
    if (enabled && streaming) hasStreamed.current = true;
    // Completed playback has no listeners; let re-subscription refresh stale flags first.
    if (refreshingEnvironment) return;
    const publish = (value: string) => {
      displayedRef.current = value;
      setDisplayed(value);
    };
    if (!animate || !text.startsWith(displayedRef.current)) {
      publish(text);
      lastPaint.current = performance.now();
      return;
    }
    if (displayedRef.current === text || !segmenter) return;
    const boundaries = Array.from(segmenter.segment(text), ({ index, segment }) => index + segment.length);
    let position = boundaries.findIndex((end) => end > displayedRef.current.length);
    const catchUpBy = performance.now() + (streaming ? STREAM_CATCH_UP_MS : COMPLETION_CATCH_UP_MS);
    let frame: number;
    const tick = (now: number) => {
      const elapsed = now - lastPaint.current;
      if (elapsed >= FRAME_MS || now >= catchUpBy) {
        const remaining = boundaries.length - position;
        const framesLeft = Math.max(1, Math.ceil((catchUpBy - now) / FRAME_MS));
        const count = Math.max(BASE_GRAPHEMES_PER_FRAME, Math.ceil(remaining / framesLeft));
        position = Math.min(boundaries.length, position + count);
        publish(text.slice(0, boundaries[position - 1]));
        lastPaint.current = now;
      }
      if (position < boundaries.length) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [text, animate, enabled, streaming, refreshingEnvironment]);

  return {
    text: (animate || refreshingEnvironment) && compatible ? displayed : text,
    isTyping,
  };
}

/** Reveals structured table rows progressively without delaying the received payload. */
export function useTableTypewriter(total: number, enabled: boolean, streaming: boolean, startOnMount = false, frameMs = TABLE_FRAME_MS) {
  const [displayed, setDisplayed] = useState(enabled && (streaming || startOnMount) ? 0 : total);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  const [hidden, setHidden] = useState(() => document.visibilityState === 'hidden');
  const hasStreamed = useRef(streaming || startOnMount);
  const displayedRef = useRef(displayed);
  const lastPaint = useRef(performance.now());
  const animate = enabled && !reducedMotion && !hidden && (streaming || hasStreamed.current);
  const needsPlayback = enabled && (streaming || displayed !== total);
  const refreshingEnvironment = needsPlayback && !animate && (
    reducedMotion !== (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false)
    || hidden !== (document.visibilityState === 'hidden')
  );
  const isTyping = (animate || refreshingEnvironment) && displayed < total;

  useEffect(() => {
    if (!needsPlayback) return;
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const onMotion = () => setReducedMotion(media?.matches ?? false);
    const onVisibility = () => setHidden(document.visibilityState === 'hidden');
    onMotion();
    onVisibility();
    media?.addEventListener?.('change', onMotion);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      media?.removeEventListener?.('change', onMotion);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [needsPlayback]);

  useEffect(() => {
    if (enabled && streaming) hasStreamed.current = true;
    if (refreshingEnvironment) return;
    const publish = (value: number) => {
      displayedRef.current = value;
      setDisplayed(value);
    };
    if (!animate || displayedRef.current > total) {
      publish(total);
      lastPaint.current = performance.now();
      return;
    }
    if (displayedRef.current === total) return;
    const catchUpBy = performance.now() + (streaming ? STREAM_CATCH_UP_MS : COMPLETION_CATCH_UP_MS);
    let frame: number;
    const tick = (now: number) => {
      const elapsed = now - lastPaint.current;
      if (elapsed >= frameMs || now >= catchUpBy) {
        const remaining = total - displayedRef.current;
        const framesLeft = Math.max(1, Math.ceil((catchUpBy - now) / frameMs));
        publish(Math.min(total, displayedRef.current + Math.max(1, Math.ceil(remaining / framesLeft))));
        lastPaint.current = now;
      }
      if (displayedRef.current < total) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [total, animate, enabled, streaming, frameMs, refreshingEnvironment]);

  return { count: animate || refreshingEnvironment ? displayed : total, isTyping };
}
