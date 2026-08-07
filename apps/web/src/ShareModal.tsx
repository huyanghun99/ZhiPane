import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, del } from './api';
import { useDialog } from './components/Dialog';

type ShareRow = {
  id: string;
  shareToken: string;
  shareMode: 'live' | 'snapshot';
  isEnabled: boolean;
  createdAt: string;
};

export function ShareModal({
  workspaceId, targetType, targetId, targetTitle, onClose
}: {
  workspaceId: string;
  targetType: 'page' | 'topic';
  targetId: string;
  targetTitle: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const dialog = useDialog();
  const [mode, setMode] = useState<'live' | 'snapshot'>('live');
  const [createdToken, setCreatedToken] = useState('');
  const [copied, setCopied] = useState(false);

  const listKey = ['shares', targetType, targetId];
  const { data: listData } = useQuery<{ shares: ShareRow[] }>({
    queryKey: listKey,
    queryFn: () => api(`/api/shares?targetType=${targetType}&targetId=${targetId}`)
  });
  const shares = listData?.shares ?? [];

  const create = useMutation({
    mutationFn: () => post<{ share: ShareRow }>('/api/shares', { workspaceId, targetType, targetId, shareMode: mode }),
    onSuccess: (res) => { setCreatedToken(res.share.shareToken); qc.invalidateQueries({ queryKey: listKey }); }
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/api/shares/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: listKey })
  });
  const regen = useMutation({
    mutationFn: (id: string) => post<{ share: ShareRow }>(`/api/shares/${id}/regenerate-token`, {}),
    onSuccess: (res) => { setCreatedToken(res.share.shareToken); qc.invalidateQueries({ queryKey: listKey }); }
  });

  const shareUrl = createdToken ? `${window.location.origin}/share/${createdToken}` : '';
  const copy = () => {
    if (!shareUrl) return;
    navigator.clipboard?.writeText(shareUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal share-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>分享「{targetTitle || '未命名'}」</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="share-create">
            <label className="share-mode">
              <input type="radio" name="shareMode" checked={mode === 'live'} onChange={() => setMode('live')} />
              实时（内容更新后访问者看到最新版）
            </label>
            <label className="share-mode">
              <input type="radio" name="shareMode" checked={mode === 'snapshot'} onChange={() => setMode('snapshot')} />
              快照（固定当前版本）
            </label>
            <button className="primary" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? '生成中…' : '生成分享链接'}
            </button>
          </div>

          {shareUrl && (
            <div className="share-result">
              <input className="share-url" readOnly value={shareUrl} onFocus={(e) => e.currentTarget.select()} />
              <button className="ghost" onClick={copy}>{copied ? '已复制 ✓' : '复制'}</button>
              <a className="ghost" href={shareUrl} target="_blank" rel="noreferrer">预览</a>
            </div>
          )}

          <div className="share-list">
            <div className="share-list-head">已有链接（{shares.length}）</div>
            {shares.length === 0 && <div className="muted small">还没有分享链接</div>}
            {shares.map((s) => (
              <div key={s.id} className="share-row">
                <span className={`share-tag ${s.shareMode}`}>{s.shareMode === 'snapshot' ? '快照' : '实时'}</span>
                <code className="share-token">{window.location.origin}/share/{s.shareToken}</code>
                <button className="icon-btn" title="复制" onClick={() => { navigator.clipboard?.writeText(`${window.location.origin}/share/${s.shareToken}`); }}>⎘</button>
                <button className="icon-btn" title="重置令牌" onClick={() => regen.mutate(s.id)}>↻</button>
                <button className="icon-btn danger" title="撤销" onClick={async () => { const ok = await dialog.confirm({ title: '撤销分享链接', message: '撤销后该链接将立即失效，已分享的页面将无法访问。', confirmText: '撤销', danger: true }); if (ok) remove.mutate(s.id); }}>🗑</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
