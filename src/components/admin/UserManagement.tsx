import { useEffect, useRef, useState } from 'react';
import { Button, Input, Select, Table, type TableColumnsType } from 'antd';
import type { AdminUser, AdminTenant } from '../../types';
import { listUsers, createUser, updateUserRole, deleteUser } from '../../api/admin';
import { useAuthStore } from '../../store/authStore';
import { TableDisplayFrame } from '../TableDisplayFrame';
import { formatBeijingTime } from '../../utils/time';
import { ConfirmDialog } from '../ConfirmDialog';
import { FloatingNotice, type FloatingNoticeState } from '../FloatingNotice';
import { RegistrationInvitesPanel } from './RegistrationInvitesPanel';

interface UserManagementProps {
  tenants: AdminTenant[];
  refreshKey?: number;
  onMembersChanged?: () => void;
}

export function UserManagement({ tenants, refreshKey = 0, onMembersChanged }: UserManagementProps) {
  const currentUserId = useAuthStore((s) => s.userId);
  const [page, setPage] = useState(1);
  const [role, setRole] = useState('');
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', password: '', tenant_id: tenants[0]?.id ?? '', role: 'member' });
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  function showNotice(message: string, variant: FloatingNoticeState['variant'] = 'info') {
    setNotice({ message, variant });
  }

  useEffect(() => {
    if (tenants[0]?.id) {
      setNewUser((prev) => ({ ...prev, tenant_id: tenants[0].id }));
    }
  }, [tenants]);

  function refreshMembers() {
    setRevision((value) => value + 1);
    onMembersChanged?.();
  }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listUsers({ search: search || undefined, role: role || undefined, limit: 20, offset: (page - 1) * 20 }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        const lastPage = Math.max(1, Math.ceil(data.total / 20));
        if (page > lastPage) { setPage(lastPage); return; }
        setUsers(data.users);
        setTotal(data.total);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setUsers([]);
        setTotal(0);
        showNotice(error instanceof Error ? error.message : '加载成员失败', 'error');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, role, page, revision, refreshKey]);

  async function handleCreate() {
    if (!newUser.username || !newUser.password || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await createUser(newUser);
      setShowCreate(false);
      setNewUser({ username: '', password: '', tenant_id: tenants[0]?.id ?? '', role: 'member' });
      refreshMembers();
      showNotice('用户已创建', 'success');
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '创建失败', 'error');
    } finally { busyRef.current = false; setBusy(false); }
  }

  function handleRoleChange(user: AdminUser) {
    const newRole = user.role === 'member' ? 'admin' : 'member';
    setConfirmDialog({
      title: '修改成员权限',
      message: `将 ${user.username} 设为${newRole === 'admin' ? '管理员，可管理成员、邀请及空间设置' : '成员，撤销管理权限'}？仅影响当前工作空间。`,
      onConfirm: async () => {
        await updateUserRole(user.id, newRole);
        refreshMembers();
        showNotice('成员权限已更新', 'success');
      },
    });
  }

  async function handleDelete(id: string) {
    setConfirmDialog({
      title: '移除成员',
      message: '确定移除该成员？将撤销当前空间的访问权，保留账号及其他工作空间。',
      onConfirm: async () => {
        await deleteUser(id);
        refreshMembers();
        showNotice('成员已移除', 'success');
      },
    });
  }

  async function handleConfirmDialog() {
    if (!confirmDialog || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await confirmDialog.onConfirm();
    } catch (e) {
      showNotice(e instanceof Error ? e.message : '操作失败', 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setConfirmDialog(null);
    }
  }

  const tenantNameMap: Record<string, string> = {};
  tenants.forEach((t) => { tenantNameMap[t.id] = t.brand_name; });
  const inputCls = 'px-3 py-2 border border-slate-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500';
  const columns: TableColumnsType<AdminUser> = [
    {
      title: '用户名',
      dataIndex: 'username',
      render: (value) => <span className="font-medium">{value}</span>,
    },
    {
      title: '所属租户',
      dataIndex: 'tenant_id',
      render: (tenantId) => <span className="text-slate-500">{tenantNameMap[tenantId] ?? tenantId}</span>,
    },
    {
      title: '角色',
      dataIndex: 'role',
      render: (role) => (
        <span className={`px-2 py-0.5 rounded text-xs font-medium ${role === 'admin' ? 'bg-purple-100 text-purple-700' : 'bg-slate-100 text-slate-600'}`}>{role === 'admin' ? '管理员' : '成员'}</span>
      ),
    },
    {
      title: '需改密',
      dataIndex: 'must_change_password',
      render: (mustChange) => (mustChange ? <span className="text-amber-600">是</span> : <span className="text-slate-400">否</span>),
    },
    {
      title: '创建时间',
      dataIndex: 'created_at',
      render: (createdAt) => <span className="text-slate-500">{formatBeijingTime(createdAt, { year: 'numeric', month: '2-digit', day: '2-digit' })}</span>,
    },
    {
      title: '操作',
      key: 'actions',
      align: 'right',
      render: (_, u) => (
        <div className="space-x-2">
          <Button autoInsertSpace={false} type="text" disabled={busy || u.id === currentUserId} title={u.id === currentUserId ? '请由其他管理员调整您的权限' : undefined} onClick={() => handleRoleChange(u)} className="h-auto border-0 p-0 text-xs text-blue-600 shadow-none hover:text-blue-800">{u.role === 'admin' ? '降为成员' : '升为管理员'}</Button>
          <Button autoInsertSpace={false} type="text" disabled={busy || u.id === currentUserId} onClick={() => handleDelete(u.id)} className="h-auto border-0 p-0 text-xs text-red-600 shadow-none hover:text-red-800">移除</Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
        <h2 className="mb-2 font-semibold text-slate-800">成员与权限</h2>
        管理员可管理成员、邀请和空间设置；成员可使用已开放的业务功能。角色仅在当前工作空间生效。
        当前账号的权限请由其他管理员调整，空间至少保留一名管理员。
      </div>
      <RegistrationInvitesPanel />
	      <div className="flex items-center justify-between">
	        <Input type="text" placeholder="搜索用户名..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} className={inputCls + ' w-64'} />
	        <Select aria-label="按角色筛选" value={role} onChange={(value) => { setRole(value); setPage(1); }}
          options={[{ value: '', label: '全部角色' }, { value: 'admin', label: '管理员' }, { value: 'member', label: '成员' }]} />
        <Button autoInsertSpace={false} onClick={() => setShowCreate(!showCreate)} className="h-auto rounded-lg bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">+ 新建用户</Button>
	      </div>

      {showCreate && (
        <div className="p-4 bg-slate-50 rounded-lg border border-slate-200 space-y-3">
	          <div className="grid grid-cols-2 gap-3">
	            <Input placeholder="用户名" value={newUser.username} onChange={(e) => setNewUser({ ...newUser, username: e.target.value })} className={inputCls} />
	            <Input.Password placeholder="密码" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} className={inputCls} />
	            {tenants.length > 1 ? (
	              <Select
	                value={newUser.tenant_id}
	                onChange={(tenant_id) => setNewUser({ ...newUser, tenant_id })}
	                className={inputCls}
	                options={tenants.map(t => ({ value: t.id, label: t.brand_name }))}
	              />
	            ) : (
	              <div className={`${inputCls} bg-slate-50 text-slate-500`}>{tenants[0]?.brand_name ?? '当前租户'}</div>
	            )}
	            <Select
	              value={newUser.role}
	              onChange={(role) => setNewUser({ ...newUser, role })}
	              className={inputCls}
	              options={[
	                { value: 'member', label: '成员' },
	                { value: 'admin', label: '管理员' },
	              ]}
	            />
	          </div>
	          <div className="flex gap-2">
	            <Button autoInsertSpace={false} loading={busy} onClick={handleCreate} className="h-auto rounded bg-blue-500 px-4 py-2 text-sm text-white hover:bg-blue-600">创建</Button>
	            <Button autoInsertSpace={false} onClick={() => setShowCreate(false)} className="h-auto rounded bg-slate-200 px-4 py-2 text-sm text-slate-700 hover:bg-slate-300">取消</Button>
	          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center py-20 text-slate-400">加载中...</div>
      ) : (
        <div className="bg-white rounded-lg border border-slate-200 overflow-hidden">
          <TableDisplayFrame title="用户管理列表" filename="用户管理列表" tableClassName="overflow-x-auto">
            <Table<AdminUser>
              rowKey="id"
              columns={columns}
              dataSource={users}
              pagination={{ current: page, pageSize: 20, total, showSizeChanger: false, onChange: setPage }}
              size="small"
              locale={{ emptyText: '无数据' }}
            />
          </TableDisplayFrame>
        </div>
      )}
      <div className="text-xs text-slate-400">共 {total} 位用户</div>
      {confirmDialog && (
        <ConfirmDialog
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel="确认"
          loading={busy}
          onConfirm={handleConfirmDialog}
          onCancel={() => setConfirmDialog(null)}
        />
      )}
      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
