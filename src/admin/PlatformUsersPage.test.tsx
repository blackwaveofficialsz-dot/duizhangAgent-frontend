import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createPlatformUser,
  deletePlatformUser,
  listPlatformTenants,
  listPlatformUsers,
  updatePlatformUserRole,
} from './adminApi';
import { PlatformUsersPage } from './PlatformUsersPage';

vi.mock('./adminApi', () => ({
  createPlatformUser: vi.fn(),
  deletePlatformUser: vi.fn(),
  listPlatformTenants: vi.fn(),
  listPlatformUsers: vi.fn(),
  updatePlatformUserRole: vi.fn(),
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

const user = {
  id: 'user-1',
  username: 'operator1',
  tenant_id: 'tenant-1',
  role: 'member',
  must_change_password: false,
  created_at: '2026-08-01T10:00:00+08:00',
};

describe('PlatformUsersPage', () => {
  beforeEach(() => {
    vi.mocked(listPlatformTenants).mockReset();
    vi.mocked(listPlatformUsers).mockReset();
    vi.mocked(createPlatformUser).mockReset();
    vi.mocked(updatePlatformUserRole).mockReset();
    vi.mocked(deletePlatformUser).mockReset();
    vi.mocked(listPlatformTenants).mockResolvedValue({ tenants: [tenant], total: 1 });
    vi.mocked(listPlatformUsers).mockResolvedValue({ users: [user], total: 1 });
  });

  it('opens the user creation drawer with a role control', async () => {
    render(<PlatformUsersPage />);
    await screen.findByText('operator1');

    fireEvent.click(screen.getByRole('button', { name: '新建用户' }));

    const drawer = screen.getByRole('dialog');
    expect(drawer.textContent).toContain('新建用户');
    expect(within(drawer).getByText('角色')).toBeTruthy();
  });

  it('does not offer administrators a password reset action', async () => {
    render(<PlatformUsersPage />);
    await screen.findByText('operator1');

    fireEvent.click(screen.getByRole('button', { name: '管理' }));

    expect(screen.queryByRole('button', { name: '重置密码' })).toBeNull();
  });

  it('shows users without a tenant as personal accounts', async () => {
    vi.mocked(listPlatformUsers).mockResolvedValue({
      users: [{ ...user, id: 'personal-user', username: 'personal-user', tenant_id: null, role: 'personal' }],
      total: 1,
    });

    render(<PlatformUsersPage />);

    expect(await screen.findByText('个人空间')).toBeTruthy();
    expect(screen.getByText('个人用户')).toBeTruthy();
  });
});
