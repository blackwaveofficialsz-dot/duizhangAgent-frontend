import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformTenant,
  disablePlatformTenant,
  purgePlatformTenant,
  getPlatformTenantDeletionJob,
  listPlatformTenants,
  regeneratePlatformTenantCode,
  updatePlatformTenant,
} from './adminApi';
import { PlatformTenantsPage } from './PlatformTenantsPage';

vi.mock('./adminApi', () => ({
  createPlatformTenant: vi.fn(),
  disablePlatformTenant: vi.fn(),
  purgePlatformTenant: vi.fn(),
  getPlatformTenantDeletionJob: vi.fn(),
  listPlatformTenants: vi.fn(),
  regeneratePlatformTenantCode: vi.fn(),
  updatePlatformTenant: vi.fn(),
}));

const tenant = {
  id: 'tenant-1',
  brand_name: '袁记餐饮',
  tenant_code: 'YUANJI-01',
  store_count: 12,
  model_provider: 'anthropic',
  model_name: 'claude-sonnet-4-20250514',
  is_new_tenant: '0',
  user_count: 4,
  created_at: '2026-08-01T10:00:00+08:00',
};

beforeEach(() => {
    vi.mocked(listPlatformTenants).mockReset();
    vi.mocked(createPlatformTenant).mockReset();
    vi.mocked(updatePlatformTenant).mockReset();
    vi.mocked(regeneratePlatformTenantCode).mockReset();
    vi.mocked(disablePlatformTenant).mockReset();
    vi.mocked(purgePlatformTenant).mockReset();
    vi.mocked(getPlatformTenantDeletionJob).mockReset();
    vi.mocked(getPlatformTenantDeletionJob).mockResolvedValue(null);
    vi.mocked(listPlatformTenants).mockResolvedValue({ tenants: [tenant], total: 1 });
  });

describe('PlatformTenantsPage', () => {
  it('opens the tenant form in a drawer and keeps the search after it closes', async () => {
    render(<PlatformTenantsPage />);
    await screen.findByText('袁记餐饮');

    fireEvent.change(screen.getByPlaceholderText('搜索租户名称'), { target: { value: '袁记' } });
    await waitFor(() => expect(listPlatformTenants).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: '新建租户' }));

    expect(screen.getByRole('dialog').textContent).toContain('新建租户');
    fireEvent.click(screen.getByLabelText('关闭详情抽屉'));
    expect(screen.getByDisplayValue('袁记')).toBeTruthy();
  });
});


it('disables a workspace with accurate confirmation', async () => {
  vi.mocked(listPlatformTenants).mockResolvedValue({ tenants: [{ ...tenant, status: 'active' }], total: 1 });
  render(<PlatformTenantsPage />);
  fireEvent.click(await screen.findByRole('button', { name: '管理' }));
  fireEvent.click(screen.getByRole('button', { name: '停用租户' }));
  expect(screen.getByText(/停用后成员无法访问/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(disablePlatformTenant).toHaveBeenCalledWith('tenant-1'));
  expect(purgePlatformTenant).not.toHaveBeenCalled();
});

it('requires matching code to queue a permanent purge and shows job status', async () => {
  vi.mocked(listPlatformTenants).mockResolvedValue({ tenants: [{ ...tenant, status: 'disabled' }], total: 1 });
  vi.mocked(getPlatformTenantDeletionJob).mockResolvedValue({ job_id: 'j', tenant_id: 'tenant-1', status: 'disabled', purge_queued: false });
  vi.mocked(purgePlatformTenant).mockResolvedValue({ job_id: 'j', tenant_id: 'tenant-1', status: 'purge_requested', purge_queued: true });
  render(<PlatformTenantsPage />);
  fireEvent.click(await screen.findByRole('button', { name: '管理' }));
  await waitFor(() => expect(screen.getByRole('button', { name: '永久清除' }).hasAttribute('disabled')).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: '永久清除' }));
  expect(screen.getByRole('button', { name: '确认清除' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('确认租户码'), { target: { value: 'wrong' } });
  expect(screen.getByRole('button', { name: '确认清除' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('确认租户码'), { target: { value: tenant.tenant_code } });
  fireEvent.click(screen.getByRole('button', { name: '确认清除' }));
  await waitFor(() => expect(purgePlatformTenant).toHaveBeenCalledWith('tenant-1', tenant.tenant_code));
  expect(await screen.findByText('等待清除')).toBeTruthy();
});
