import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { listUsers, updateUserRole, deleteUser } from '../../api/admin';
import { UserManagement } from './UserManagement';
vi.mock('../../api/admin', () => ({ listUsers: vi.fn(), createUser: vi.fn(), updateUserRole: vi.fn(), deleteUser: vi.fn() }));
vi.mock('../../store/authStore', () => ({ useAuthStore: (selector: (s: { userId: string }) => unknown) => selector({ userId: 'self' }) }));
vi.mock('./RegistrationInvitesPanel', () => ({ RegistrationInvitesPanel: () => null }));
vi.mock('../TableDisplayFrame', () => ({ TableDisplayFrame: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const members = [
  { id: 'self', username: '本人', tenant_id: 't', role: 'admin', must_change_password: false, created_at: '' },
  { id: 'other', username: '同事', tenant_id: 't', role: 'member', must_change_password: false, created_at: '' },
];
beforeEach(() => { vi.clearAllMocks(); vi.mocked(listUsers).mockResolvedValue({ users: members, total: 21 }); });
it('paginates on the server and protects current administrator controls', async () => {
  render(<UserManagement tenants={[]} />);
  const self = (await screen.findByText('本人')).closest('tr')!;
  expect(within(self).getByRole('button', { name: '降为成员' }).hasAttribute('disabled')).toBe(true);
  expect(within(self).getByRole('button', { name: '移除' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByTitle('2'));
  await waitFor(() => expect(listUsers).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 20, offset: 20 }), expect.any(AbortSignal)));
  fireEvent.change(screen.getByPlaceholderText('搜索用户名...'), { target: { value: '同事' } });
  await waitFor(() => expect(listUsers).toHaveBeenLastCalledWith(expect.objectContaining({ search: '同事', offset: 0 }), expect.any(AbortSignal)));
});
it('confirms role scope and removal without deleting the account', async () => {
  render(<UserManagement tenants={[]} />);
  await screen.findByText('同事');
  fireEvent.click(screen.getByRole('button', { name: '升为管理员' }));
  expect(updateUserRole).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(updateUserRole).toHaveBeenCalledWith('other', 'admin'));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  fireEvent.click(within(screen.getByText('同事').closest('tr')!).getByRole('button', { name: '移除' }));
  expect(screen.getByText(/保留账号及其他工作空间/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() => expect(deleteUser).toHaveBeenCalledWith('other'));
});
it('aborts a pending list request on unmount', async () => {
  vi.mocked(listUsers).mockImplementation(() => new Promise(() => {}));
  const { unmount } = render(<UserManagement tenants={[]} />);
  const signal = vi.mocked(listUsers).mock.calls[0][1];
  unmount();
  expect(signal?.aborted).toBe(true);
});
