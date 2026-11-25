/** 经营分析入口。各业务块拆到 analytics/*，这里只保留 tab 和全局提示。 */

import { lazy, Suspense, useState } from 'react';
import { Button } from 'antd';
import { useAuthStore } from '../store/authStore';
import { OrdersSection } from './analytics/OrdersSection';
import { LaborSection } from './analytics/LaborSection';
import { ProductSection } from './analytics/ProductSection';
import { AlertsSection } from './analytics/AlertsSection';
import { SettingsSection } from './analytics/SettingsSection';

const DashboardPage = lazy(() => import('./analytics/DashboardPage').then(module => ({ default: module.DashboardPage })));

type SubTab = 'dashboard' | 'orders' | 'labor' | 'product' | 'alerts' | 'settings';
const SUB_TABS: { key: SubTab; label: string }[] = [
  { key: 'orders', label: '订单统计' },
  { key: 'dashboard', label: '经营看板' },
  { key: 'labor', label: '人效' },
  { key: 'product', label: '产品' },
  { key: 'alerts', label: '营收报警' },
  { key: 'settings', label: '设置' },
];

export function AnalyticsPage() {
  const canManage = useAuthStore(s => s.role === 'admin');
  const dashboardScope = useAuthStore(s => JSON.stringify([s.userId, s.tenantId, s.activeWorkspaceId]));
  const [tab, setTab] = useState<SubTab>('orders');
  const [notice, setNotice] = useState<string>('');
  const show = (m: string) => { setNotice(m); window.setTimeout(() => setNotice(''), 4000); };
  const tabs = canManage ? SUB_TABS : SUB_TABS.filter(t => t.key !== 'settings');

  return (
    <div className="flex-1 overflow-y-auto bg-slate-50 p-3 pb-4 md:p-6">
      <div className="w-full max-w-none space-y-4">
        <h1 className="hidden text-lg font-semibold text-slate-800 md:block">经营分析</h1>
        <GuideCard onJump={setTab} canManage={canManage} />
        <div className="-mx-1 overflow-x-auto px-1">
        <div className="flex w-max gap-1 rounded-lg bg-slate-100 p-0.5 md:w-fit">
          {tabs.map(t => (
            <Button autoInsertSpace={false} key={t.key} htmlType="button" onClick={() => setTab(t.key)}
              className={`h-10 shrink-0 border-0 px-4 py-1.5 rounded-md text-sm shadow-none transition-colors cursor-pointer ${tab === t.key ? 'bg-white text-blue-700 shadow-sm font-medium' : 'text-slate-500 hover:text-slate-700'}`}>
              {t.label}
            </Button>
          ))}
        </div>
        </div>
        {tab === 'dashboard' && (
          <Suspense fallback={<div className="rounded-lg border border-slate-200 bg-white p-5 text-sm text-slate-400">经营看板加载中…</div>}>
            <DashboardPage key={dashboardScope} show={show} />
          </Suspense>
        )}
        {tab === 'orders' && <OrdersSection key={dashboardScope} show={show} canManage={canManage} />}
        {canManage && tab === 'settings' && <SettingsSection show={show} />}
        {tab === 'labor' && <LaborSection show={show} />}
        {tab === 'product' && <ProductSection show={show} />}
        {tab === 'alerts' && <AlertsSection show={show} canManage={canManage} />}
        {notice && <div className="fixed bottom-6 right-6 rounded-lg bg-slate-800 text-white text-sm px-4 py-2 shadow-lg">{notice}</div>}
      </div>
    </div>
  );
}

const GUIDE: { tab: SubTab; title: string; desc: string }[] = [
  { tab: 'settings', title: '①配置店铺映射/平台名', desc: '人效需要先把食亨店铺对到 HR 门店；顺手校准平台名。' },
  { tab: 'orders', title: '②看订单统计', desc: '分店铺/分平台/整合 × 天/周/月，净收、客单价、退款率一目了然。' },
  { tab: 'orders', title: '③设为定时推送', desc: '（接自动化）把日报/周报设成定时推送。' },
  { tab: 'orders', title: '④对话里追问', desc: '在对话里直接问「本周各店销售」。' },
];
const ANALYTICS_GUIDE_KEY = 'analytics_guide_collapsed';

function readAnalyticsGuideCollapsed(): boolean {
  try {
    const value = localStorage.getItem(ANALYTICS_GUIDE_KEY);
    return value === null ? true : value === '1';
  } catch {
    return true;
  }
}

function GuideCard({ onJump, canManage }: { onJump: (t: SubTab) => void; canManage: boolean }) {
  const [collapsed, setCollapsed] = useState(readAnalyticsGuideCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try { localStorage.setItem(ANALYTICS_GUIDE_KEY, next ? '1' : '0'); } catch { /* ignore */ }
  };
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-blue-100 bg-blue-50/60 px-3 py-3 md:px-4">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm font-medium text-blue-800">经营分析操作引导</span>
        <Button autoInsertSpace={false} htmlType="button" onClick={toggle} className="h-9 min-w-11 border-0 px-2 text-xs text-blue-600 shadow-none hover:underline cursor-pointer">{collapsed ? '展开' : '收起'}</Button>
      </div>
      {!collapsed && (
        <ol className="mt-3 grid min-w-0 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {GUIDE.filter(s => canManage || s.tab !== 'settings').map((s, i) => (
            <li key={i} className="min-w-0">
              <button
                type="button"
                onClick={() => onJump(s.tab)}
                className="flex min-h-20 w-full min-w-0 flex-col rounded-lg border border-transparent bg-white/70 px-3 py-2 text-left shadow-none transition-colors hover:bg-white"
              >
                <span className="max-w-full break-words text-sm font-medium leading-snug text-slate-700">{s.title}</span>
                <span className="mt-1 max-w-full break-words text-xs leading-relaxed text-slate-500">{s.desc}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ── 订单统计 ──────────────────────────────────────────────────────────────
