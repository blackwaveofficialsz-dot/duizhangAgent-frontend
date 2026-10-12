import { useEffect, useRef, useState } from 'react';
import { Button, Input, Modal, Select, Table, Tabs, Tag, type TableColumnsType } from 'antd';
import { listUsers } from '../../api/admin';
import { deleteStoreAccess, getMemberStoreAccess, listAccessStores, listStoreAccess, saveStoreAccess,
  type AccessKind, type AccessPrincipal, type EffectiveStoreAccess, type StoreOption } from '../../api/storeAccess';
import { FloatingNotice, type FloatingNoticeState } from '../FloatingNotice';

export function StoreAccessManagement({ refreshKey }: { refreshKey: number }) {
  const [kind, setKind] = useState<AccessKind>('group');
  const [rows, setRows] = useState<AccessPrincipal[]>([]);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [members, setMembers] = useState<{ id: string; username: string }[]>([]);
  const [search, setSearch] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editor, setEditor] = useState<AccessPrincipal | 'new' | null>(null);
  const [name, setName] = useState('');
  const [memberIds, setMemberIds] = useState<string[]>([]);
  const [storeKeys, setStoreKeys] = useState<string[]>([]);
  const [pendingDelete, setPendingDelete] = useState<AccessPrincipal | null>(null);
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState<string>();
  const [preview, setPreview] = useState<EffectiveStoreAccess>();
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const operations = useRef(new Set<AbortController>());
  const label = kind === 'group' ? '群组' : '角色';
  const fail = (error: unknown) => setNotice({ variant: 'error', message: error instanceof Error ? error.message : '操作失败' });

  useEffect(() => () => { operations.current.forEach(c => c.abort()); operations.current.clear(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    Promise.all([listStoreAccess(kind, controller.signal), listAccessStores(controller.signal)])
      .then(([access, catalog]) => { if (!controller.signal.aborted) { setRows(access.items); setStores(catalog.items); } })
      .catch(e => { if (!controller.signal.aborted) fail(e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [kind, refresh, refreshKey]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      listUsers({ limit: 200, search }, controller.signal)
        .then(data => { if (!controller.signal.aborted) setMembers(data.users); })
        .catch(e => { if (!controller.signal.aborted) fail(e); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, refreshKey]);
  useEffect(() => {
    setPreview(undefined);
    if (!previewId) return;
    const controller = new AbortController();
    getMemberStoreAccess(previewId, controller.signal)
      .then(data => { if (!controller.signal.aborted) setPreview(data); })
      .catch(e => { if (!controller.signal.aborted) fail(e); });
    return () => controller.abort();
  }, [previewId, refresh, refreshKey]);

  function edit(row: AccessPrincipal | 'new') {
    setEditor(row); setName(row === 'new' ? '' : row.name);
    setMemberIds(row === 'new' ? [] : row.members.map(m => m.id));
    setStoreKeys(row === 'new' ? [] : row.store_keys);
    setSearch('');
  }
  async function mutate(action: (signal: AbortSignal) => Promise<unknown>, message: string) {
    if (busy) return;
    const controller = new AbortController(); operations.current.add(controller); setBusy(true);
    try {
      await action(controller.signal);
      if (!controller.signal.aborted) {
        setEditor(null); setPendingDelete(null); setRefresh(n => n + 1);
        setNotice({ variant: 'success', message });
      }
    } catch (e) { if (!controller.signal.aborted) fail(e); }
    finally { operations.current.delete(controller); if (!controller.signal.aborted) setBusy(false); }
  }
  const selectedMembers = editor && editor !== 'new' ? editor.members : [];
  const memberOptions = [...new Map([...selectedMembers, ...members].map(m => [m.id, { value: m.id, label: m.username }])).values()];
  const storeNames = new Map(stores.map(s => [s.key, s.name]));
  const columns: TableColumnsType<AccessPrincipal> = [
    { title: `${label}名称`, dataIndex: 'name', key: 'name' },
    { title: '成员', key: 'members', render: (_, row) => <span title={row.members.map(m => m.username).join('、')}>{row.members.length} 人 · {row.members.slice(0, 3).map(m => m.username).join('、') || '未分配'}</span> },
    { title: '可查看店铺', key: 'stores', render: (_, row) => <span title={row.store_keys.map(k => storeNames.get(k) || k).join('、')}>{row.store_keys.length} 家 · {row.store_keys.slice(0, 3).map(k => storeNames.get(k) || k).join('、') || '无店铺权限'}</span> },
    { title: '操作', key: 'actions', width: 160, render: (_, row) => <div className="flex gap-2"><Button size="small" onClick={() => edit(row)}>编辑</Button><Button size="small" danger onClick={() => setPendingDelete(row)}>删除</Button></div> },
  ];
  return <section className="rounded-xl border border-slate-200 bg-white p-5">
    {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}
    <h2 className="text-base font-semibold text-slate-800">群组与业务角色</h2>
    <p className="mt-2 text-sm text-slate-500">成员可加入多个群组和角色，可查看店铺取所有授权的并集。未授权的普通成员不可查看店铺；管理员可查看全部店铺。业务角色不授予管理权限。</p>
    <Tabs activeKey={kind} onChange={v => setKind(v as AccessKind)} items={[{ key: 'group', label: '群组管理' }, { key: 'role', label: '角色管理' }]} tabBarExtraContent={<Button type="primary" onClick={() => edit('new')}>新建{label}</Button>} />
    <Table rowKey="id" dataSource={rows} columns={columns} loading={loading} pagination={{ pageSize: 10 }} scroll={{ x: 680 }} locale={{ emptyText: `暂无${label}，可新建并分配成员与店铺` }} />
    <div className="mt-5 border-t border-slate-100 pt-4">
      <label htmlFor="store-access-preview" className="mr-3 text-sm">查看成员最终权限</label>
      <Select id="store-access-preview" aria-label="查看成员最终权限" showSearch={{ onSearch: setSearch, filterOption: false }} allowClear value={previewId} onChange={setPreviewId} options={memberOptions} placeholder="搜索并选择成员" style={{ minWidth: 240 }} />
      {preview && <div className="mt-3 text-sm">{preview.all_stores ? '管理员：全部店铺' : preview.store_keys.length ? preview.store_keys.map(k => <Tag key={k}>{storeNames.get(k) || k}</Tag>) : '尚未获得任何店铺查看权限'}</div>}
    </div>
    <Modal title={`${editor === 'new' ? '新建' : '编辑'}${label}`} open={editor !== null} onCancel={() => { if (!busy) setEditor(null); }} confirmLoading={busy} okText="保存权限" cancelText="取消" okButtonProps={{ disabled: !name.trim() }} onOk={() => {
      if (!editor) return;
      void mutate(signal => saveStoreAccess(editor === 'new' ? undefined : editor.id, { kind, name: name.trim(), member_ids: memberIds, store_keys: storeKeys, version: editor === 'new' ? undefined : editor.version }, signal), '权限已保存，下次查询生效');
    }}>
      <div className="space-y-4 py-3">
        <div><label htmlFor="access-name">{label}名称</label><Input id="access-name" maxLength={80} value={name} onChange={e => setName(e.target.value)} placeholder={kind === 'group' ? '例如：华东区域' : '例如：区域运营'} /></div>
        <div><label htmlFor="access-members">分配成员</label><Select id="access-members" aria-label="分配成员" mode="multiple" value={memberIds} onChange={setMemberIds} showSearch={{ onSearch: setSearch, filterOption: false }} options={memberOptions} style={{ width: '100%' }} placeholder="搜索成员用户名，支持多选" maxTagCount="responsive" /></div>
        <div><label htmlFor="access-stores">可查看店铺</label><Select id="access-stores" aria-label="可查看店铺" mode="multiple" value={storeKeys} onChange={setStoreKeys} showSearch={{ optionFilterProp: 'label' }} options={stores.map(s => ({ value: s.key, label: `${s.name} (${s.key})` }))} style={{ width: '100%' }} placeholder="选择可查看的店铺" maxTagCount="responsive" allowClear /></div>
        <p className="text-xs text-slate-500">留空表示不授予店铺权限。仅列出当前工作空间已确认的店铺；新增店铺需另行授权。</p>
      </div>
    </Modal>
    <Modal title={`删除${pendingDelete?.kind === 'group' ? '群组' : '角色'}`} open={pendingDelete !== null} onCancel={() => { if (!busy) setPendingDelete(null); }} confirmLoading={busy} okText="确认删除" cancelText="取消" okButtonProps={{ danger: true }} onOk={() => {
      if (pendingDelete) void mutate(signal => deleteStoreAccess(pendingDelete, signal), '已删除，对应授权已移除');
    }}><p>删除“{pendingDelete?.name}”会移除它授予成员的店铺权限。其他群组和角色的授权继续保留。</p></Modal>
  </section>;
}
