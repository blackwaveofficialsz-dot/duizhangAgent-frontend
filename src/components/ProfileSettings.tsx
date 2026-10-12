import { useEffect, useState } from 'react';
import { Button, Input, Modal, Tag, notification } from 'antd';

import {
  getAuthCapabilities,
  getContactStatus,
  updateContact,
  type ContactStatus,
  type VerificationChannel,
} from '../api/auth';
import { apiFetch } from '../api/client';
import { useAuthStore } from '../store/authStore';
import { PreferencesPanel } from './PreferencesPanel';
import { PasswordStrengthHint } from './auth/PasswordStrengthHint';
import { isPasswordLengthValid } from './auth/passwordPolicy';
import { VerificationFields } from './auth/VerificationFields';

type ContactMode = 'bind' | 'change';

export function ProfileSettings() {
  const {
    username,
    role,
    tenantId,
    token,
    hasPassword,
    workspaceType,
    activeWorkspaceId,
    workspaces,
    acceptWorkspaceInvite,
    joinTenant,
    setInitialPassword,
    logout,
    refreshAuth,
  } = useAuthStore();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [tenantCode, setTenantCode] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [tenantLoading, setTenantLoading] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [contacts, setContacts] = useState<ContactStatus | null>(null);
  const [contactManagementEnabled, setContactManagementEnabled] = useState(false);
  const [contactChannel, setContactChannel] = useState<VerificationChannel | null>(null);
  const [contactMode, setContactMode] = useState<ContactMode>('bind');
  const [contactTarget, setContactTarget] = useState('');
  const [contactPassword, setContactPassword] = useState('');
  const [contactVerificationToken, setContactVerificationToken] = useState('');
  const [contactSaving, setContactSaving] = useState(false);

  useEffect(() => {
    if (!token || workspaceType !== 'tenant') return;
    let active = true;
    getAuthCapabilities()
      .then((value) => {
        if (active) setContactManagementEnabled(value.contact_management_enabled);
      })
      .catch(() => undefined);
    getContactStatus(token)
      .then((value) => {
        if (active) setContacts(value);
      })
      .catch((error) => {
        if (active) {
          notification.error({
            title: error instanceof Error ? error.message : '联系方式加载失败',
            duration: 5,
            closable: true,
          });
        }
      });
    return () => {
      active = false;
    };
  }, [token, workspaceType]);

  async function handleChangePassword(event: React.FormEvent) {
    event.preventDefault();
    if (newPassword !== confirmPassword) {
      notification.error({ title: '两次输入的新密码不一致', duration: 5, closable: true });
      return;
    }
    if (!isPasswordLengthValid(newPassword)) {
      notification.error({ title: '密码长度必须为 7 至 16 个字符', duration: 5, closable: true });
      return;
    }

    setLoading(true);
    try {
      if (!hasPassword) {
        await setInitialPassword(newPassword);
        setNewPassword('');
        setConfirmPassword('');
        notification.success({ title: '登录密码设置成功', duration: 5, closable: true });
      } else {
        const response = await apiFetch('/api/v1/auth/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ old_password: currentPassword, new_password: newPassword }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({}));
          throw new Error(data.message ?? data.detail ?? '修改失败');
        }
        notification.success({ title: '密码修改成功，请重新登录', duration: 5, closable: true });
        void logout();
      }
    } catch (error) {
      notification.error({
        title: error instanceof Error ? error.message : '密码修改失败',
        duration: 5,
        closable: true,
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleJoinTenant(event: React.FormEvent) {
    event.preventDefault();
    const code = tenantCode.trim().toUpperCase();
    if (!code) {
      notification.warning({ title: '请输入租户码', duration: 5, closable: true });
      return;
    }
    setTenantLoading(true);
    try {
      const message = await joinTenant(code);
      notification.success({
        title: message || '申请已提交，等待目标租户管理员审批后生效',
        duration: 5,
        closable: true,
      });
      setTenantCode('');
    } catch (error) {
      notification.error({
        title: error instanceof Error ? error.message : '加入租户失败',
        duration: 5,
        closable: true,
      });
    } finally {
      setTenantLoading(false);
    }
  }

  async function handleAcceptInvite(event: React.FormEvent) {
    event.preventDefault();
    const code = inviteCode.trim();
    if (!code) {
      notification.warning({ title: '请输入邀请码', duration: 5, closable: true });
      return;
    }
    setInviteLoading(true);
    try {
      const message = await acceptWorkspaceInvite(code);
      notification.success({
        title: message || '已加入新工作空间',
        duration: 5,
        closable: true,
      });
      setInviteCode('');
    } catch (error) {
      notification.error({
        title: error instanceof Error ? error.message : '加入工作空间失败',
        duration: 5,
        closable: true,
      });
    } finally {
      setInviteLoading(false);
    }
  }

  function openContact(channel: VerificationChannel, bound: boolean) {
    setContactChannel(channel);
    setContactMode(bound ? 'change' : 'bind');
    setContactTarget('');
    setContactPassword('');
    setContactVerificationToken('');
  }

  function closeContact() {
    if (contactSaving) return;
    setContactChannel(null);
    setContactTarget('');
    setContactPassword('');
    setContactVerificationToken('');
  }

  async function handleSaveContact() {
    if (!token || !contactChannel || !contactPassword || !contactVerificationToken) return;
    setContactSaving(true);
    try {
      const result = await updateContact(contactMode, contactPassword, contactVerificationToken, token);
      refreshAuth(result);
      setContacts(result.contact);
      notification.success({ title: result.message, duration: 5, closable: true });
      setContactChannel(null);
    } catch (error) {
      notification.error({
        title: error instanceof Error ? error.message : '联系方式更新失败',
        duration: 5,
        closable: true,
      });
    } finally {
      setContactSaving(false);
    }
  }

  const inputClass = 'mobile-form-input w-full';
  const initial = username ? username[0].toUpperCase() : 'U';
  const contactTitle = contactMode === 'bind' ? '绑定' : '更换';
  const contactName = contactChannel === 'sms' ? '手机号' : '邮箱';
  const activeWorkspaceName = workspaces?.find((item) => item.workspace_id === activeWorkspaceId)?.name
    ?? (workspaceType === 'personal' ? '个人空间' : tenantId ?? '租户空间');

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-3 pb-4 md:p-6">
      <div className="mx-auto max-w-2xl space-y-6">
        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-4 text-base font-semibold text-slate-800">个人信息</h2>
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-blue-500 text-lg font-bold text-white">
              {initial}
            </div>
            <div>
              <p className="text-sm font-medium text-slate-700">{username}</p>
              <p className="text-xs text-slate-400">{workspaceRoleLabel(role)}</p>
              <p className="mt-0.5 text-xs text-slate-400">当前工作空间：{activeWorkspaceName}</p>
            </div>
          </div>
        </section>

        {workspaceType === 'tenant' && <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-4 text-base font-semibold text-slate-800">登录联系方式</h2>
          <div className="divide-y divide-slate-100">
            <ContactRow
              label="邮箱"
              value={contacts?.email.masked || '未绑定邮箱'}
              verified={Boolean(contacts?.email.verified)}
              actionLabel={contacts?.email.bound ? '更换邮箱' : '绑定邮箱'}
              actionVisible={contactManagementEnabled}
              onAction={() => openContact('email', Boolean(contacts?.email.bound))}
            />
            <ContactRow
              label="手机号"
              value={contacts?.phone.masked || '未绑定手机号'}
              verified={Boolean(contacts?.phone.verified)}
              actionLabel={contacts?.phone.bound ? '更换手机号' : '绑定手机号'}
              actionVisible={contactManagementEnabled}
              onAction={() => openContact('sms', Boolean(contacts?.phone.bound))}
            />
          </div>
        </section>}

        {workspaceType === 'tenant' && <PreferencesPanel />}

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-2 text-base font-semibold text-slate-800">加入新工作空间</h2>
          <p className="mb-4 text-sm text-slate-500">输入邮件中的邀请码，成功后可在工作空间列表中切换。</p>
          <form onSubmit={handleAcceptInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <label htmlFor="workspace-invite-code" className="block flex-1 text-sm text-slate-500">
              邀请码
              <Input
                id="workspace-invite-code"
                aria-label="邀请码"
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                placeholder="输入邮件中的邀请码"
                className={inputClass}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoComplete="off"
              />
              <span className="mt-1 block text-xs text-slate-400">邀请码区分大小写，且只能使用一次。</span>
            </label>
            <Button type="primary" htmlType="submit" loading={inviteLoading} className="sm:w-auto">
              加入新工作空间
            </Button>
          </form>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-2 text-base font-semibold text-slate-800">申请加入租户</h2>
          <p className="mb-4 text-sm text-slate-500">输入目标租户码提交申请，审批通过后下次登录生效。</p>
          <form onSubmit={handleJoinTenant} className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={tenantCode}
              onChange={(event) => setTenantCode(event.target.value.toUpperCase())}
              placeholder="输入租户码"
              className={inputClass}
            />
            <Button type="primary" htmlType="submit" loading={tenantLoading} className="sm:w-auto">
              申请加入
            </Button>
          </form>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-1 text-base font-semibold text-slate-800">{hasPassword ? '修改密码' : '设置登录密码'}</h2>
          {!hasPassword && <p className="mb-4 text-sm text-slate-500">设置后可使用手机号和密码登录。</p>}
          <form onSubmit={handleChangePassword} className="space-y-3">
            {hasPassword && <label className="block text-sm text-slate-500">
              当前密码
              <Input.Password
                aria-label="修改密码的当前密码"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
                placeholder="输入当前密码"
                className={inputClass}
                autoComplete="current-password"
              />
            </label>}
            <label className="block text-sm text-slate-500">
              新密码
              <Input.Password
                aria-label="新密码"
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                placeholder="7 至 16 个字符"
                className={inputClass}
                autoComplete="new-password"
              />
              <PasswordStrengthHint password={newPassword} />
            </label>
            <label className="block text-sm text-slate-500">
              确认新密码
              <Input.Password
                aria-label="确认新密码"
                value={confirmPassword}
                onChange={(event) => setConfirmPassword(event.target.value)}
                placeholder="再次输入新密码"
                className={inputClass}
                autoComplete="new-password"
              />
            </label>
            <Button type="primary" htmlType="submit" loading={loading}>{hasPassword ? '修改密码' : '设置密码'}</Button>
          </form>
        </section>

        <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-6">
          <h2 className="mb-2 text-base font-semibold text-slate-800">退出登录</h2>
          <Button danger onClick={() => { void logout(); }}>退出登录</Button>
        </section>
      </div>

      <Modal
        open={contactChannel !== null}
        title={`${contactTitle}${contactName}`}
        onCancel={closeContact}
        footer={null}
        destroyOnHidden
      >
        {contactChannel && (
          <div className="space-y-4 pt-2">
            <VerificationFields
              key={`${contactChannel}-${contactMode}`}
              channel={contactChannel}
              target={contactTarget}
              onTargetChange={setContactTarget}
              purpose={contactMode === 'bind' ? 'bind_contact' : 'change_contact'}
              authToken={token}
              targetLabel={contactName}
              showChannelSelector={false}
              onVerified={setContactVerificationToken}
            />
            <label className="block text-sm text-slate-600">
              当前密码
              <Input.Password
                aria-label="当前密码"
                value={contactPassword}
                onChange={(event) => setContactPassword(event.target.value)}
                placeholder="请输入当前密码"
                autoComplete="current-password"
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button onClick={closeContact}>取消</Button>
              <Button
                type="primary"
                loading={contactSaving}
                disabled={!contactVerificationToken || !contactPassword}
                onClick={handleSaveContact}
              >
                确认{contactTitle}
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function workspaceRoleLabel(role: 'admin' | 'member' | 'personal'): string {
  if (role === 'admin') return '管理员';
  if (role === 'member') return '成员';
  return '个人空间';
}

function ContactRow({
  label,
  value,
  verified,
  actionLabel,
  actionVisible,
  onAction,
}: {
  label: string;
  value: string;
  verified: boolean;
  actionLabel: string;
  actionVisible: boolean;
  onAction: () => void;
}) {
  return (
    <div className="flex min-h-16 items-center gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-xs text-slate-400">{label}</p>
        <div className="mt-1 flex items-center gap-2">
          <span className="truncate text-sm text-slate-700">{value}</span>
          {verified && <Tag color="success">已验证</Tag>}
        </div>
      </div>
      {actionVisible && <Button htmlType="button" onClick={onAction}>{actionLabel}</Button>}
    </div>
  );
}
