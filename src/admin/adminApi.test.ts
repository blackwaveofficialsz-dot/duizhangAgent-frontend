import { afterEach, describe, expect, it, vi } from 'vitest';
import { getPlatformHealth } from './adminApi';

describe('adminApi', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads health from the readiness endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'ready',
      services: { database: 'ok', redis: 'ok' },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await getPlatformHealth();

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/health\/ready$/);
  });
});
