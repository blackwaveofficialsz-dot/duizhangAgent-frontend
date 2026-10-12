import { beforeEach, describe, expect, it, vi } from 'vitest';

import { apiFetch } from './client';
import { createRegistrationInvite, listRegistrationInvites, listUsers, createUser, updateUserRole, deleteUser } from './admin';

vi.mock('./client', () => ({ apiFetch: vi.fn() }));

function ok(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe('admin invitations api', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  it('lists tenant registration invite statuses', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({
      items: [{
        id: 'invite-1',
        tenant_id: 'tenant-a',
        role: 'member',
        created_by: 'admin-a',
        expires_at: '2026-08-26T12:00:00+08:00',
        used_at: null,
        used_by: null,
        revoked_at: null,
        status: 'active',
        invite_token: 'AB12cd34EF',
        invite_email: 'member@example.com',
      }],
    }));

    const result = await listRegistrationInvites();

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/users/invitations');
    expect(result[0].status).toBe('active');
    expect(result[0].invite_token).toBe('AB12cd34EF');
    expect(result[0].invite_email).toBe('member@example.com');
  });

  it('creates a registration invite with an explicit expiry', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invite_token: 'raw-token', email_sent: false }));

    const result = await createRegistrationInvite(2880);

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/users/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_minutes: 2880 }),
    });
    expect(result.invite_token).toBe('raw-token');
  });

  it('creates and sends a registration invite to an email address', async () => {
    vi.mocked(apiFetch).mockResolvedValue(ok({ invite_token: 'raw-token', email_sent: true }));

    const result = await createRegistrationInvite(1440, 'user@example.com');

    expect(apiFetch).toHaveBeenCalledWith('/api/v1/admin/users/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expires_minutes: 1440, email: 'user@example.com' }),
    });
    expect(result.email_sent).toBe(true);
  });
});


describe('workspace member API failures', () => {
  it.each([
    () => listUsers({}),
    () => createUser({ username: 'name', password: 'password', tenant_id: 't', role: 'member' }),
    () => updateUserRole('u', 'member'),
    () => deleteUser('u'),
  ])('does not treat a denied operation as success', async (request) => {
    vi.mocked(apiFetch).mockResolvedValue({ ok: false, json: async () => ({ detail: '需要管理员权限' }) } as Response);
    await expect(request()).rejects.toThrow('需要管理员权限');
  });
});
