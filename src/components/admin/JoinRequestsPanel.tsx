import { useEffect, useState } from 'react';
import { Button } from 'antd';
import { FloatingNotice, type FloatingNoticeState } from '../FloatingNotice';
import { approveJoinRequest, listJoinRequests, rejectJoinRequest, type JoinRequest } from '../../api/admin';

/**
 * 迁入租户申请审批面板：用户凭租户码申请加入本租户，管理员在此通过/驳回。
 * 自包含状态，挂在后台「用户」标签页。
 */
export function JoinRequestsPanel({ onApproved }: { onApproved?: () => void } = {}) {
  const [items, setItems] = useState<JoinRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<FloatingNoticeState | null>(null);
  const [revision, setRevision] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    listJoinRequests(controller.signal).then((data) => {
      if (!controller.signal.aborted) setItems(data);
    }).catch((error) => {
      if (!controller.signal.aborted) setNotice({ message: error.message, variant: 'error' });
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [revision]);

  async function decide(id: string, action: 'approve' | 'reject') {
    setBusyId(id);
    setNotice(null);
    try {
      if (action === 'approve') await approveJoinRequest(id);
      else await rejectJoinRequest(id);
      setRevision((value) => value + 1);
      if (action === 'approve') onApproved?.();
      setNotice({ message: action === 'approve' ? '已批准加入工作空间' : '已驳回申请', variant: 'success' });
    } catch (e) {
      setNotice({ message: (e as Error).message, variant: 'error' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">加入申请</h3>
          <p className="mt-0.5 text-xs text-slate-400">用户凭租户码申请加入，审批通过后可从空间切换器进入。</p>
        </div>
        <span className="text-[11px] text-slate-400">待处理 {items.length}</span>
      </div>

      {notice && <FloatingNotice notice={notice} onClose={() => setNotice(null)} />}

      {loading ? (
        <p className="py-4 text-center text-xs text-slate-400">加载中…</p>
      ) : items.length === 0 ? (
        <p className="py-4 text-center text-xs text-slate-400">暂无待处理的加入申请</p>
      ) : (
        <div className="space-y-2">
          {items.map((it) => (
            <div key={it.id} className="flex items-center justify-between rounded-lg border border-slate-100 bg-slate-50/60 px-3 py-2">
              <div className="min-w-0 text-sm">
                <span className="font-medium text-slate-800">{it.username}</span>
                <span className="ml-2 text-xs text-slate-400">来自：{it.from_brand || it.from_tenant_id}</span>
              </div>
              <div className="flex shrink-0 gap-2">
	                <Button
	                  autoInsertSpace={false}
	                  onClick={() => decide(it.id, 'approve')}
	                  disabled={busyId !== null}
	                  className="h-auto rounded-lg bg-emerald-500 px-3 py-1 text-xs font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
	                >
	                  通过
	                </Button>
	                <Button
	                  autoInsertSpace={false}
	                  onClick={() => decide(it.id, 'reject')}
	                  disabled={busyId !== null}
	                  className="h-auto rounded-lg border-slate-200 px-3 py-1 text-xs text-slate-600 hover:bg-slate-50 disabled:opacity-40"
	                >
	                  驳回
	                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
