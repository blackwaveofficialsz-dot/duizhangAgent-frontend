import { CopyOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { Button, Input, Modal, Select, Table, type TableColumnsType } from 'antd';
import { useEffect, useRef, useState } from 'react';
import type { AdminTenant } from '../types';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FloatingNotice, type FloatingNoticeState } from '../components/FloatingNotice';
import { formatBeijingTime } from '../utils/time';
import {
  createPlatformTenant,
  disablePlatformTenant,
  purgePlatformTenant,
  getPlatformTenantDeletionJob,
  type TenantDeletionJob,
  listPlatformTenants,
  regeneratePlatformTenantCode,
  updatePlatformTenant,
} from './adminApi';
import { PlatformDetailDrawer } from './components/PlatformDetailDrawer';
import { PlatformFilterBar } from './components/PlatformFilterBar';
import { PlatformPageHeader } from './components/PlatformPageHeader';
import { PaginationControls } from './PaginationControls';

const PAGE_SIZE = 20;

type TenantFormState = {
  brand_name: string;
  store_count: number;
  model_provider: string;
  model_name: string;
};

const emptyTenantForm: TenantFormState = {
  brand_name: '',
  store_count: 0,
  model_provider: 'anthropic',
  model_name: 'claude-sonnet-4-20250514',
};

export function PlatformTenantsPage() {
  const [tenants, setTenants] = useState<AdminTenant[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [revision, setRevision] = useState(0);
  const [jobRevision, setJobRevision] = useState(0);
  const [job, setJob] = useState<TenantDeletionJob | null>(null);
  const [jobLoading, setJobLoading] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeCode, setPurgeCode] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [drawerMode, setDrawerMode] = useState<'create' | 'edit' | null>(null);
  const [editingTenant, setEditingTenant] = useState<AdminTenant | null>(null);
  const [form, setForm] = useState<TenantFormState>(emptyTenantForm);
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const [confirmDialog, setConfirmDialog] = useState<{ title: string; message: string; onConfirm: () => Promise<void> } | null>(null);

  function showNotice(message: string, variant: FloatingNoticeState['variant'] = 'info') {
    setNotice({ message, variant });
  }

  function fetchTenants() { setRevision((value) => value + 1); }

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listPlatformTenants({ search: search || undefined, limit: PAGE_SIZE, offset: page * PAGE_SIZE }, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setTenants(data.tenants);
        setTotal(data.total);
        setEditingTenant((previous) => previous ? data.tenants.find((t) => t.id === previous.id) ?? previous : null);
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setTenants([]);
        setTotal(0);
        showNotice(error instanceof Error ? error.message : '加载租户失败', 'error');
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [search, page, revision]);

  const editingTenantId = editingTenant?.id;
  useEffect(() => {
    if (!editingTenantId) { setJob(null); return; }
    const controller = new AbortController();
    setJobLoading(true);
    setJob(null);
    getPlatformTenantDeletionJob(editingTenantId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setJob(value);
    }).catch((error) => {
      if (!controller.signal.aborted) showNotice(error instanceof Error ? error.message : '加载清除状态失败', 'error');
    }).finally(() => { if (!controller.signal.aborted) setJobLoading(false); });
    return () => controller.abort();
  }, [editingTenantId, jobRevision]);

  async function confirmPurge() {
    if (!editingTenant || busyRef.current || !editingTenant.tenant_code || purgeCode.trim().toUpperCase() !== editingTenant.tenant_code.toUpperCase()) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await purgePlatformTenant(editingTenant.id, purgeCode);
      setJob(result);
      setPurgeOpen(false);
      fetchTenants();
      showNotice('清除任务已提交，可刷新查看处理状态', 'success');
    } catch (error) {
      setPurgeOpen(false);
      showNotice(error instanceof Error ? error.message : '提交清除失败', 'error');
      setJobRevision((value) => value + 1);
    } finally { busyRef.current = false; setBusy(false); }
  }

  function closeDrawer() {
    setDrawerMode(null);
    setEditingTenant(null);
    setForm(emptyTenantForm);
  }

  function openCreate() {
    setEditingTenant(null);
    setForm(emptyTenantForm);
    setDrawerMode('create');
  }

  function openEdit(tenant: AdminTenant) {
    setEditingTenant(tenant);
    setForm({
      brand_name: tenant.brand_name,
      store_count: tenant.store_count,
      model_provider: tenant.model_provider,
      model_name: tenant.model_name,
    });
    setDrawerMode('edit');
  }

  async function handleCreate() {
    if (!form.brand_name) return;
    try {
      await createPlatformTenant(form);
      closeDrawer();
      await fetchTenants();
      showNotice('租户已创建', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '创建租户失败', 'error');
    }
  }

  async function handleSave() {
    if (!editingTenant) return;
    try {
      await updatePlatformTenant(editingTenant.id, form);
      closeDrawer();
      await fetchTenants();
      showNotice('租户信息已保存', 'success');
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '保存租户失败', 'error');
    }
  }

  function refreshCode(id: string) {
    setConfirmDialog({
      title: '刷新租户码',
      message: '确定刷新租户码？旧租户码将失效。',
      onConfirm: async () => {
        await regeneratePlatformTenantCode(id);
        await fetchTenants();
        showNotice('租户码已刷新', 'success');
      },
    });
  }

  function removeTenant(id: string) {
    setConfirmDialog({
      title: '停用租户',
      message: '停用后成员无法访问此工作空间，进行中的任务将被取消。数据将保留，永久清除需另行确认。',
      onConfirm: async () => {
        await disablePlatformTenant(id);
        closeDrawer();
        await fetchTenants();
        showNotice('租户已停用', 'success');
      },
    });
  }

  async function copyCode(code: string) {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showNotice('租户码已复制', 'success');
    } catch {
      showNotice(`租户码：${code}`, 'info');
    }
  }

  async function handleConfirmDialog() {
    if (!confirmDialog || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await confirmDialog.onConfirm();
    } catch (err) {
      showNotice(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setConfirmDialog(null);
    }
  }

  const columns: TableColumnsType<AdminTenant> = [
    { title: '状态', dataIndex: 'status', render: (status) => ({ active: '正常', disabled: '已停用', purged: '已清除' }[status as string] ?? '正常') },
    {
      title: '品牌 / 租户码',
      key: 'tenant',
      width: 260,
      render: (_, tenant) => (
        <div className="min-w-0">
          <div className="truncate font-medium text-slate-800">{tenant.brand_name}</div>
          <div className="mt-1 truncate font-mono text-xs text-slate-500">{tenant.tenant_code || '未生成租户码'}</div>
        </div>
      ),
    },
    { title: '用户数', dataIndex: 'user_count', key: 'user_count', width: 92, align: 'right' },
    { title: '门店数', dataIndex: 'store_count', key: 'store_count', width: 92, align: 'right' },
    {
      title: '模型',
      key: 'model',
      width: 260,
      render: (_, tenant) => <span className="text-slate-600">{tenant.model_provider}/{tenant.model_name}</span>,
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
      render: (_, tenant) => (
        <Button
          type="link"
          icon={<EditOutlined aria-hidden />}
          onClick={(event) => {
            event.stopPropagation();
            openEdit(tenant);
          }}
        >
          管理
        </Button>
      ),
    },
  ];

  const drawerFooter = (
    <div className="flex justify-end gap-2">
      <Button onClick={closeDrawer}>取消</Button>
      <Button type="primary" disabled={drawerMode === 'edit' && editingTenant?.status !== undefined && editingTenant.status !== 'active'} onClick={drawerMode === 'create' ? handleCreate : handleSave}>
        {drawerMode === 'create' ? '创建租户' : '保存变更'}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <PlatformPageHeader
        title="租户管理"
        description="维护租户的品牌、门店规模和默认模型配置。"
        primaryAction={<Button type="primary" icon={<PlusOutlined aria-hidden />} onClick={openCreate}>新建租户</Button>}
      />
      <PlatformFilterBar resultCount={total}>
        <Input
          allowClear
          placeholder="搜索租户名称"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
          className="w-full sm:w-72"
        />
        <Button onClick={() => { fetchTenants(); setJobRevision((value) => value + 1); }}>刷新状态</Button>
      </PlatformFilterBar>
      <section className="overflow-hidden rounded-md border border-slate-200 bg-white">
        <Table<AdminTenant>
          columns={columns}
          dataSource={tenants}
          loading={loading}
          locale={{ emptyText: '无数据' }}
          pagination={false}
          rowKey="id"
          size="small"
          scroll={{ x: 960 }}
          onRow={(tenant) => ({
            onClick: () => openEdit(tenant),
            className: 'cursor-pointer',
          })}
        />
        <PaginationControls page={page} pageSize={PAGE_SIZE} total={total} loading={loading} onPageChange={setPage} />
      </section>
      <PlatformDetailDrawer
        open={drawerMode !== null}
        title={drawerMode === 'create' ? '新建租户' : `${editingTenant?.brand_name || '租户'} · 管理`}
        onClose={closeDrawer}
        footer={drawerFooter}
      >
        <div className="space-y-5">
          {drawerMode === 'edit' && editingTenant && (
            <section className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div>
                <div className="text-xs text-slate-500">租户码</div>
                <div className="mt-1 font-mono text-sm text-slate-800">{editingTenant.tenant_code || '未生成'}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button icon={<CopyOutlined aria-hidden />} onClick={() => void copyCode(editingTenant.tenant_code)}>复制租户码</Button>
                <Button disabled={editingTenant.status === 'purged' || job?.purge_queued} icon={<ReloadOutlined aria-hidden />} onClick={() => refreshCode(editingTenant.id)}>刷新租户码</Button>
                {(!editingTenant.status || editingTenant.status === 'active') && <Button danger icon={<DeleteOutlined aria-hidden />} onClick={() => removeTenant(editingTenant.id)}>停用租户</Button>}
                {editingTenant.status === 'disabled' && <Button danger disabled={jobLoading || !job || !['disabled', 'failed'].includes(job.status) || !editingTenant.tenant_code}
                  onClick={() => { setPurgeCode(''); setPurgeOpen(true); }}>永久清除</Button>}
                <Button loading={jobLoading} onClick={() => { setJobRevision((value) => value + 1); fetchTenants(); }}>刷新清除状态</Button>
              </div>
              {job && <div className="text-sm text-slate-600">
                <span>{({ disabled: '尚未清除', purge_requested: '等待清除', running: '清除中', failed: '清除失败，可重试', completed: '已永久清除' } as Record<string, string>)[job.status] ?? job.status}</span>
                {job.last_error && <p>失败原因：{job.last_error}</p>}
              </div>}
            </section>
          )}
          <TenantFields value={form} onChange={setForm} />
        </div>
      </PlatformDetailDrawer>
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
      <Modal open={purgeOpen} title="永久清除租户" okText="确认清除" cancelText="取消" confirmLoading={busy}
        onOk={() => void confirmPurge()} onCancel={() => { if (!busy) setPurgeOpen(false); }}
        okButtonProps={{ danger: true, disabled: !editingTenant?.tenant_code || purgeCode.trim().toUpperCase() !== editingTenant.tenant_code.toUpperCase() }}
        cancelButtonProps={{ disabled: busy }}>
        <p className="mb-3">此操作不可撤销，将永久清除此租户的数据和成员关系。全局账号及其他工作空间会保留。</p>
        <label>请输入租户码 {editingTenant?.tenant_code}<Input aria-label="确认租户码" value={purgeCode} onChange={(event) => setPurgeCode(event.target.value)} /></label>
      </Modal>
      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}

function TenantFields({ value, onChange }: { value: TenantFormState; onChange: (next: TenantFormState) => void }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>品牌名称</span>
        <Input value={value.brand_name} onChange={(event) => onChange({ ...value, brand_name: event.target.value })} />
      </label>
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>门店数量</span>
        <Input type="number" value={value.store_count} onChange={(event) => onChange({ ...value, store_count: Number.parseInt(event.target.value, 10) || 0 })} />
      </label>
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>模型提供方</span>
        <Select
          value={value.model_provider}
          onChange={(model_provider) => onChange({ ...value, model_provider })}
          options={[
            { value: 'anthropic', label: 'Anthropic' },
            { value: 'openai', label: 'OpenAI' },
            { value: 'qwen', label: 'Qwen' },
            { value: 'deepseek', label: 'DeepSeek' },
          ]}
        />
      </label>
      <label className="space-y-1.5 text-sm text-slate-700">
        <span>模型名称</span>
        <Input value={value.model_name} onChange={(event) => onChange({ ...value, model_name: event.target.value })} />
      </label>
    </div>
  );
}
