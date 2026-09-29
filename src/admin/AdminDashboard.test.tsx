import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getPlatformHealth,
  listDaily,
  listPlatformTasks,
  listPlatformTenants,
  listPlatformUsers,
  listSummaries,
  recomputePeriod,
} from './adminApi';
import { AdminDashboard } from './AdminDashboard';

vi.mock('./adminApi', () => ({
  getPlatformHealth: vi.fn(),
  listDaily: vi.fn(),
  listPlatformTasks: vi.fn(),
  listPlatformTenants: vi.fn(),
  listPlatformUsers: vi.fn(),
  listSummaries: vi.fn(),
  recomputePeriod: vi.fn(),
}));

describe('AdminDashboard', () => {
  beforeEach(() => {
    vi.mocked(getPlatformHealth).mockReset();
    vi.mocked(listDaily).mockReset();
    vi.mocked(listPlatformTasks).mockReset();
    vi.mocked(listPlatformTenants).mockReset();
    vi.mocked(listPlatformUsers).mockReset();
    vi.mocked(listSummaries).mockReset();
    vi.mocked(recomputePeriod).mockReset();

    vi.mocked(getPlatformHealth).mockRejectedValue(new Error('network unavailable'));
    vi.mocked(recomputePeriod).mockResolvedValue({ period: '2026-08', rows: 0 });
    vi.mocked(listSummaries).mockResolvedValue([]);
    vi.mocked(listDaily).mockResolvedValue([]);
    vi.mocked(listPlatformTenants).mockResolvedValue({ tenants: [], total: 3 });
    vi.mocked(listPlatformUsers).mockResolvedValue({ users: [], total: 12 });
    vi.mocked(listPlatformTasks)
      .mockResolvedValueOnce({ tasks: [], total: 2 })
      .mockResolvedValueOnce({ tasks: [], total: 1 });
  });

  it('keeps the dashboard usable when the health check is unavailable', async () => {
    render(<AdminDashboard />);

    await screen.findByText('健康检查不可用');
    expect(screen.getByText('运行关注')).toBeTruthy();
    expect(screen.getByRole('region', { name: '关键指标' }).textContent).toContain('失败任务2');
    expect(screen.getByRole('region', { name: '关键指标' }).textContent).toContain('运行任务1');
    expect(screen.getByRole('region', { name: '关键指标' }).textContent).toContain('用户数12');
    await waitFor(() => {
      expect(listPlatformTasks).toHaveBeenNthCalledWith(1, { status: 'failed', limit: 5 });
      expect(listPlatformTasks).toHaveBeenNthCalledWith(2, { status: 'running', limit: 1 });
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('keeps successful usage data when one metric request fails', async () => {
    vi.mocked(listSummaries).mockResolvedValue([{
      id: 'summary-1',
      tenant_id: 'tenant-1',
      period: '2026-09',
      cache_read_tokens: 1,
      cache_write_tokens: 2,
      cache_miss_tokens: 3,
      output_tokens: 4,
      amount_yuan: '64.0778',
      computed_at: '2026-09-29T11:00:00+08:00',
    }]);
    vi.mocked(listPlatformUsers).mockRejectedValue(new Error('用户统计加载失败'));

    render(<AdminDashboard />);

    expect((await screen.findByRole('alert')).textContent).toContain('用户统计加载失败');
    expect(screen.getByRole('region', { name: '关键指标' }).textContent).toContain('本期金额¥64.0778');
    expect(screen.getByText('tenant-1')).toBeTruthy();
  });

  it('shows the readiness endpoint as healthy', async () => {
    vi.mocked(getPlatformHealth).mockResolvedValue({
      status: 'ready',
      services: { database: 'ok', redis: 'ok' },
    });

    render(<AdminDashboard />);

    expect(await screen.findByText('正常')).toBeTruthy();
  });
});
