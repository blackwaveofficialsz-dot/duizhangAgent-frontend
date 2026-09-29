import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import { Button, Input, Select, Table, type TableColumnsType } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import type { AdminTenant, AdminUser } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FloatingNotice, type FloatingNoticeState } from '../components/FloatingNotice';
import { formatBeijingTime } from '../utils/time';
import {
  createPlatformUser,
  deletePlatformUser,
  listPlatformTenants,
  listPlatformUsers,
  updatePlatformUserRole,
} from './adminApi';
import { PlatformDetailDrawer } from './components/PlatformDetailDrawer';
import { PlatformFilterBar } from './components/PlatformFilterBar';
import { PlatformPageHeader } from './components/PlatformPageHeader';
import { PlatformStatusTag } from './components/PlatformStatusTag';
import { PaginationControls } from './PaginationControls';

const PAGE_SIZE = 20;

type UserDraft = {
  username: string;
  password: string;
  tenant_id: string;
  role: 'member' | 'admin';
};

function initialUserDraft(tenantId = ''): UserDraft {
  return { username: '', password: '', tenant_id: tenantId, role: 'member' };
}

export function PlatformUsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [tenantId, setTenantId] = useState('');
  const [role, setRole] = useState('');
  const [page, setPage] = useState(0);
  const [error, setError] = useState('');
  const [drawerMode, setDrawerMode] = useState<'create' | 'manage' | null>(null);
  const [editingUser, setEditingUser] = useState<AdminUser | null>(null);
  const [newUser, setNewUser] = useState<UserDraft>(initialUserDraft());
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  function showNotice(message: string, variant: FloatingNoticeState['variant'] = 'info') {
    setNotice({ message, variant });
  }

  useEffect(() => {
    listPlatformTenants({ limit: 200 })
      .then((data) => {
        setTenants(data.tenants);
        setNewUser((previous) => ({ ...previous, tenant_id: previous.tenant_id || data.tenants[0]?.id || '' }));
      })
      .catch(() => {});
  }, []);

  async function fetchUsers() {
    setLoading(true);
    setError('');
    try {
      const data = await listPlatformUsers({
        search: search || undefined,
        tenant_id: tenantId || undefined,
        role: role || undefined,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setUsers([]);
      setTotal(0);
      setError(err instanceof Error ? err.message : '加载用户失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void fetchUsers();
  }, [search, tenantId, role, page]);

  const tenantNameMap = useMemo(() => {
    const map: Record<string, string> = {};
    tenants.forEach((tenant) => {
      map[tenant.id] = tenant.brand_name;
    });
    return map;
  }, [tenants]);

  function closeDrawer() {
    setDrawerMode(null);
    setEditingUser(null);
    setNewUser(initialUserDraft(tenants[0]?.id || ''));
  }

  function openCreate() {
    setEditingUser(null);
    setNewUser(initialUserDraft(tenants[0]?.id || ''));
    setDrawerMode('create');
  }

  function openManage(user: AdminUser) {
    setEditingUser(user);
    setDrawerMode('manage');
  }

  async function handleCreate() {
    if (!newUser.username || !newUser.password || !newUser.tenant_id) return;
    try {
      await createPlatformUser(newUser);
      closeDrawer();
      await fetchUsers();
      showNotice('用户已创建', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '创建用户失败', 'error');
    }
  }

  async function handleRoleChange(nextRole: UserDraft['role']) {
    if (!editingUser || editingUser.role === nextRole) return;
    try {
      await updatePlatformUserRole(editingUser.id, nextRole);
      setEditingUser({ ...editingUser, role: nextRole });
      await fetchUsers();
      showNotice('用户角色已更新', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '角色更新失败', 'error');
    }
  }

  function removeUser(id: string) {
    setConfirmDialog({
      title: '删除用户',
      message: '确定删除该用户？',
      onConfirm: async () => {
        await deletePlatformUser(id);
        closeDrawer();
        await fetchUsers();
        showNotice('用户已删除', 'success');
      },
    });
  }

  async function handleConfirmDialog() {
    if (!confirmDialog) return;
    try {
      await confirmDialog.onConfirm();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setConfirmDialog(null);
    }
  }

  const columns: TableColumnsType<AdminUser> = [
    { title: '用户名', dataIndex: 'username', key: 'username', width: 180, render: (value) => <span className="font-medium text-slate-800">{String(value)}</span> },
    {
      title: '租户',
      dataIndex: 'tenant_id',
      key: 'tenant_id',
      width: 220,
      render: (value) => <span className="text-slate-600">{value ? tenantNameMap[String(value)] ?? String(value) : '个人空间'}</span>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      width: 112,
      render: (value) => (
        <PlatformStatusTag
          label={value === 'admin' ? '管理员' : value === 'personal' ? '个人用户' : '成员'}
          tone={value === 'admin' ? 'info' : 'neutral'}
        />
      ),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      key: 'created_at',
      width: 128,
      render: (value) => value ? formatBeijingTime(String(value), { year: 'numeric', month: '2-digit', day: '2-digit' }) : '-',
    },
    {
      title: '操作',
      key: 'actions',
      width: 88,
      fixed: 'right',
      render: (_, user) => (
        <Button
          type="link"
          icon={<EditOutlined aria-hidden />}
          onClick={(event) => {
            event.stopPropagation();
            openManage(user);
          }}
        >
          管理
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PlatformPageHeader
        title="用户管理"
        description="管理全平台用户账号与访问角色。"
        primaryAction={<Button type="primary" icon={<PlusOutlined aria-hidden />} onClick={openCreate}>新建用户</Button>}
      />
      <PlatformFilterBar resultCount={total}>
        <Input
          allowClear
          placeholder="搜索用户名"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          className="w-full sm:w-56"
        />
        <Select
          allowClear
          aria-label="筛选租户"
          placeholder="全部租户"
          value={tenantId || undefined}
          onChange={(value) => {
            setTenantId(value || '');
            setPage(0);
          }}
          options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.brand_name }))}
          className="w-40"
        />
        <Select
          allowClear
          aria-label="筛选角色"
          placeholder="全部角色"
          value={role || undefined}
          onChange={(value) => {
            setRole(value || '');
            setPage(0);
          }}
          options={[
            { value: 'member', label: '成员' },
            { value: 'admin', label: '管理员' },
            { value: 'personal', label: '个人用户' },
          ]}
          className="w-32"
        />
      </PlatformFilterBar>
      {error && <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <Table<AdminUser>
          columns={columns}
          dataSource={users}
          loading={loading}
          locale={{ emptyText: '无数据' }}
          pagination={false}
          rowKey="id"
          size="small"
          scroll={{ x: 760 }}
          onRow={(user) => ({
            onClick: () => openManage(user),
            className: 'cursor-pointer',
          })}
        />
        <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} loading={loading} onPageChange={setPage} />
      </section>
      <PlatformDetailDrawer
        open={drawerMode !== null}
        title={drawerMode === 'create' ? '新建用户' : `${editingUser?.username || '用户'} · 管理`}
        onClose={closeDrawer}
        footer={drawerMode === 'create' ? (
          <div className="flex justify-end gap-2">
            <Button onClick={closeDrawer}>取消</Button>
            <Button type="primary" onClick={handleCreate}>创建用户</Button>
          </div>
        ) : undefined}
      >
        {drawerMode === 'create' ? (
          <UserCreateFields value={newUser} tenants={tenants} onChange={setNewUser} />
        ) : editingUser ? (
          <div className="space-y-5">
            <dl className="grid grid-cols-2 gap-4 text-sm">
              <div><dt className="text-slate-500">用户名</dt><dd className="mt-1 font-medium text-slate-800">{editingUser.username}</dd></div>
              <div><dt className="text-slate-500">所属租户</dt><dd className="mt-1 font-medium text-slate-800">{editingUser.tenant_id ? tenantNameMap[editingUser.tenant_id] ?? editingUser.tenant_id : '个人空间'}</dd></div>
              <div><dt className="text-slate-500">创建时间</dt><dd className="mt-1 text-slate-800">{editingUser.created_at ? formatBeijingTime(editingUser.created_at) : '-'}</dd></div>
            </dl>
            <label className="block space-y-1.5 text-sm text-slate-700">
              <span>角色</span>
              {editingUser.role === 'personal' ? (
                <div><PlatformStatusTag label="个人用户" tone="neutral" /></div>
              ) : (
                <Select<UserDraft['role']>
                  value={editingUser.role as UserDraft['role']}
                  onChange={handleRoleChange}
                  options={[
                    { value: 'member', label: '成员' },
                    { value: 'admin', label: '管理员' },
                  ]}
                  className="w-full"
                />
              )}
            </label>
            <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
              <Button danger icon={<DeleteOutlined aria-hidden />} onClick={() => removeUser(editingUser.id)}>删除用户</Button>
            </div>
          </div>
        ) : null}
      </PlatformDetailDrawer>
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel="确认"
          onConfirm={handleConfirmDialog}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

function UserCreateFields({
  value,
  tenants,
  onChange,
}: {
  value: UserDraft;
  tenants: AdminTenant[];
  onChange: (next: UserDraft) => void;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>用户名</span>
        <Input value={value.username} onChange={(event) => onChange({ ...value, username: event.target.value })} />
      </label>
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>初始密码</span>
        <Input.Password value={value.password} onChange={(event) => onChange({ ...value, password: event.target.value })} />
      </label>
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>所属租户</span>
        <Select value={value.tenant_id || undefined} onChange={(tenant_id) => onChange({ ...value, tenant_id })} options={tenants.map((tenant) => ({ value: tenant.id, label: tenant.brand_name }))} />
      </label>
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>角色</span>
        <Select<UserDraft['role']>
          value={value.role}
          onChange={(role) => onChange({ ...value, role })}
          options={[
            { value: 'member', label: '成员' },
            { value: 'admin', label: '管理员' },
          ]}
        />
      </label>
    </div>
  );
}
