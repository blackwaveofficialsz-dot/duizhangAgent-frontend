import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { canViewPeriod, MobileDatePopup, parseYmd } from './shared';

afterEach(() => { cleanup(); vi.useRealTimers(); });
it('allows today only when the consumer explicitly opts in', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-12T04:00:00Z'));
  expect(canViewPeriod('day', parseYmd('2026-08-12'), true)).toBe(true);
  expect(canViewPeriod('day', parseYmd('2026-08-12'))).toBe(false);
  const view = render(<MobileDatePopup value="2026-08-12" onChange={vi.fn()} allowToday />);
  expect(screen.getByRole('button', { name: /日期\s*2026-08-12/ })).toBeTruthy();
  view.rerender(<MobileDatePopup value="2026-08-12" onChange={vi.fn()} />);
  expect(screen.getByRole('button', { name: /日期\s*2026-08-11/ })).toBeTruthy();
});
