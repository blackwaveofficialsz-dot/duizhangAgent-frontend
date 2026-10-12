import { useEffect, useState } from 'react';
import { Button, Table, type TableColumnsType } from 'antd';
import { useUiStore } from '../../store/uiStore';
import { listTenants } from '../../api/admin';
import type { AdminTenant } from '../../types';
import { StoreAccessManagement } from './StoreAccessManagement';
import { UserManagement } from './UserManagement';
import { JoinRequestsPanel } from './JoinRequestsPanel';
import { ConnectorsPage } from '../ConnectorsPage';
import { AutomationMessagingPage } from './AutomationMessagingPage';
import { TableDisplayFrame } from '../TableDisplayFrame';
import { FloatingNotice, type FloatingNoticeState } from '../FloatingNotice';

type AdminTab = 'users' | 'stats' | 'connectors' | 'automation';

export function AdminPage() {
  const { route, navigate } = useUiStore();
  const [tenants, setTenants] = useState<AdminTenant[]>([]);

  const [refreshKey, setRefreshKey] = useState(0);
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const refresh = () => setRefreshKey((value) => value + 1);

  useEffect(() => {
    const controller = new AbortController();
    listTenants({}, controller.signal)
      .then(data => { if (!controller.signal.aborted) setTenants(Array.isArray(data.tenants) ? data.tenants : []); })
      .catch((error) => { if (!controller.signal.aborted) setNotice({ message: error.message || '加载概览失败', variant: 'error' }); });
    return () => controller.abort();
  }, [refreshKey]);

  const tabs: { key: AdminTab; label: string; routePath: string }[] = [
    { key: 'stats', label: '概览', routePath: 'admin' },
    { key: 'users', label: '成员与权限', routePath: 'admin-users' },
    { key: 'connectors', label: '连接器设置', routePath: 'admin-connectors' },
    { key: 'automation', label: '自动化与消息', routePath: 'admin-automation' },
  ];

  return (
    <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}
      <div className="bg-white border-b border-slate-200 px-3 py-3 md:px-6 md:py-4">
        <h1 className="text-lg font-semibold text-slate-800">管理后台</h1>
        <div className="mt-3 flex w-full gap-1 overflow-x-auto rounded-lg bg-slate-100 p-0.5 md:w-fit">
          {tabs.map(t => (
		            <Button
		              key={t.key}
		              onClick={() => navigate(t.routePath as any)}
		              className={`h-auto shrink-0 border-0 px-4 py-1.5 rounded-md text-sm shadow-none transition-colors cursor-pointer ${
	                route === t.routePath
	                  ? 'bg-white text-blue-700 shadow-sm font-medium'
	                  : 'text-slate-500 hover:text-slate-700'
	              }`}
	            >
	              {t.label}
	            </Button>
          ))}
        </div>
      </div>

      <div className={`flex-1 overflow-y-auto ${route === 'admin-connectors' ? 'p-0' : 'p-3 md:p-6'}`}>
        {route === 'admin' && <OverviewStats tenants={tenants} />}
        {route === 'admin-users' && (
          <div className="space-y-6">
            <JoinRequestsPanel onApproved={refresh} />
            <UserManagement tenants={tenants} refreshKey={refreshKey} onMembersChanged={refresh} />
            <StoreAccessManagement refreshKey={refreshKey} />
          </div>
        )}
        {route === 'admin-connectors' && <ConnectorsPage />}
        {route === 'admin-automation' && <AutomationMessagingPage />}
      </div>
    </div>
  );
}

function OverviewStats({ tenants }: { tenants: AdminTenant[] }) {
  const safeTenants = Array.isArray(tenants) ? tenants : [];
  const totalUsers = safeTenants.reduce((s, t) => s + (t.user_count ?? 0), 0);
  const tenant = safeTenants[0];
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);

  function showNotice(message: string, variant: FloatingNoticeState['variant'] = 'info') {
    setNotice({ message, variant });
  }

  async function copyCode(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      showNotice('租户加入码已复制', 'success');
    } catch {
      showNotice(`租户加入码：${code}`, 'info');
    }
  }

  const cards = [
    { label: '本租户用户数', value: totalUsers, icon: '👤' },
    { label: '门店数', value: tenant?.store_count ?? 0, icon: '🏬' },
    { label: '连接器配置', value: '管理', icon: '🔌' },
  ];
  const columns: TableColumnsType<AdminTenant> = [
    { title: '品牌', dataIndex: 'brand_name' },
    {
      title: '租户加入码',
      dataIndex: 'tenant_code',
      render: (tenantCode) => (
        <>
          <span className="font-mono font-medium text-slate-800">{tenantCode || '未生成'}</span>
          {tenantCode && (
            <Button htmlType="button" onClick={() => copyCode(tenantCode)} className="ml-2 h-auto border-0 p-0 text-xs font-medium text-blue-600 shadow-none hover:text-blue-700 cursor-pointer">复制加入码</Button>
          )}
        </>
      ),
    },
    { title: '用户数', dataIndex: 'user_count' },
    { title: '门店数', dataIndex: 'store_count' },
    {
      title: '使用模型',
      key: 'model',
      render: (_, row) => <span className="text-slate-500">{row.model_provider}/{row.model_name}</span>,
    },
  ];
  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-3">
        {cards.map(c => (
          <div key={c.label} className="bg-white rounded-lg border border-slate-200 p-5">
            <div className="text-2xl mb-2">{c.icon}</div>
            <div className="text-2xl font-bold text-slate-800 md:text-3xl">{c.value}</div>
            <div className="text-sm text-slate-500 mt-1">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="bg-white rounded-lg border border-slate-200 p-5">
        <h3 className="font-medium text-slate-700 mb-1">当前租户</h3>
        <p className="text-xs text-slate-400 mb-3">租户加入码仅用于已有账号在「个人设置」申请加入租户，不能用于新用户注册。新用户请在「用户管理」生成注册邀请码。</p>
        {safeTenants.length === 0 ? (
          <div className="text-slate-400 text-sm">暂无租户数据</div>
        ) : (
          <TableDisplayFrame title="当前租户" filename="当前租户" tableClassName="overflow-x-auto">
          <Table<AdminTenant>
            rowKey="id"
            columns={columns}
            dataSource={safeTenants}
            pagination={false}
            size="small"
          />
          </TableDisplayFrame>
        )}
      </div>
      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}
    </div>
  );
}
