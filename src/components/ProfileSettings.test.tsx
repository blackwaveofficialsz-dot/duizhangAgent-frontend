import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from '../api/client';
import { ProfileSettings } from './ProfileSettings';

const mocks = vi.hoisted(() => ({
  acceptWorkspaceInvite: vi.fn(),
  logout: vi.fn(),
  refreshAuth: vi.fn(),
  joinTenant: vi.fn(),
  setInitialPassword: vi.fn(),
  getAuthCapabilities: vi.fn(),
  getContactStatus: vi.fn(),
  requestVerification: vi.fn(),
  confirmVerification: vi.fn(),
  updateContact: vi.fn(),
}));

vi.mock('../store/authStore', () => ({
  useAuthStore: () => ({
    username: 'operator', role: 'member', tenantId: 'tenant-1', token: 'jwt-1',
    hasPassword: true, workspaceType: 'tenant', activeWorkspaceId: 'tenant-1',
    workspaces: [{
      workspace_id: 'tenant-1', workspace_type: 'tenant', name: '测试租户',
      tenant_id: 'tenant-1', role: 'member', is_active: true,
    }],
    logout: mocks.logout, refreshAuth: mocks.refreshAuth, joinTenant: mocks.joinTenant,
    acceptWorkspaceInvite: mocks.acceptWorkspaceInvite,
    setInitialPassword: mocks.setInitialPassword,
  }),
}));

vi.mock('../api/auth', () => ({
  getAuthCapabilities: mocks.getAuthCapabilities,
  getContactStatus: mocks.getContactStatus,
  requestVerification: mocks.requestVerification,
  confirmVerification: mocks.confirmVerification,
  updateContact: mocks.updateContact,
}));

vi.mock('../api/client', () => ({
  apiFetch: vi.fn(),
}));

vi.mock('./PreferencesPanel', () => ({ PreferencesPanel: () => <div>preferences</div> }));

describe('ProfileSettings contacts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getAuthCapabilities.mockResolvedValue({
      verification_enabled: true,
      code_login_enabled: true,
      password_reset_enabled: true,
      contact_management_enabled: true,
      register_verification_required: true,
      code_login_reveal_unknown_contact: false,
      personal_registration_enabled: true,
    });
    mocks.getContactStatus.mockResolvedValue({
      email: { bound: true, verified: true, masked: 'o***@example.com' },
      phone: { bound: false, verified: false, masked: '' },
    });
    mocks.requestVerification.mockResolvedValue({ challenge_id: 'challenge-1', resend_after: 60 });
    mocks.confirmVerification.mockResolvedValue({ verification_token: 'verification-token' });
    mocks.updateContact.mockResolvedValue({
      message: '联系方式已更新',
      token: 'jwt-2', username: 'operator', user_id: 'user-1', tenant_id: 'tenant-1', role: 'member',
      contact: {
        email: { bound: true, verified: true, masked: 'o***@example.com' },
        phone: { bound: true, verified: true, masked: '+86 138****8000' },
      },
    });
    mocks.acceptWorkspaceInvite.mockResolvedValue('已加入测试工作空间，可在工作空间列表中切换');
  });

  it('shows masked contact status without exposing the full target', async () => {
    render(<ProfileSettings />);

    expect(await screen.findByText('o***@example.com')).toBeTruthy();
    expect(screen.getByText('未绑定手机号')).toBeTruthy();
    expect(screen.queryByText('operator@example.com')).toBeNull();
  });

  it('keeps the user signed in and refreshes the bound contact after verification', async () => {
    render(<ProfileSettings />);
    fireEvent.click(await screen.findByRole('button', { name: '绑定手机号' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByLabelText('手机号').getAttribute('value')).toBe('');
    expect(within(dialog).getByLabelText('当前密码').getAttribute('value')).toBe('');
    fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800138000' } });
    fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));
    fireEvent.change(await screen.findByLabelText('验证码'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '确认验证码' }));
    await waitFor(() => expect(mocks.confirmVerification).toHaveBeenCalled());
    fireEvent.change(within(dialog).getByLabelText('当前密码'), { target: { value: 'secret-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '确认绑定' }));

    await waitFor(() => expect(mocks.updateContact).toHaveBeenCalledWith(
      'bind', 'secret-password', 'verification-token', 'jwt-1',
    ));
    expect(mocks.refreshAuth).toHaveBeenCalledWith(expect.objectContaining({ token: 'jwt-2' }));
    await waitFor(() => expect(screen.getByText('+86 138****8000')).toBeTruthy());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('changes password with the seven to sixteen character policy and strength hint', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('{}', { status: 200 }));
    render(<ProfileSettings />);

    fireEvent.change(screen.getByLabelText('修改密码的当前密码'), { target: { value: 'current-password' } });
    fireEvent.change(screen.getByLabelText('新密码'), { target: { value: 'abc1234' } });
    fireEvent.change(screen.getByLabelText('确认新密码'), { target: { value: 'abc1234' } });
    expect(screen.getByText('密码强度：一般')).toBeTruthy();
    expect(screen.getByText('大于 6 位，最多 16 位')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '修改密码' }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/v1/auth/change-password', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ old_password: 'current-password', new_password: 'abc1234' }),
    })));
    expect(mocks.logout).toHaveBeenCalled();
  });

  it('joins a new workspace with a case-sensitive email invitation code', async () => {
    render(<ProfileSettings />);

    fireEvent.change(screen.getByLabelText('邀请码'), { target: { value: 'Ab12Mixed' } });
    fireEvent.click(screen.getByRole('button', { name: '加入新工作空间' }));

    await waitFor(() => expect(mocks.acceptWorkspaceInvite).toHaveBeenCalledWith('Ab12Mixed'));
    expect(screen.getByLabelText('邀请码').getAttribute('value')).toBe('');
  });
});
