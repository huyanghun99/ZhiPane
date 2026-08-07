import { useEffect, useState } from 'react';
import { api } from './api';
import { docToHtml } from './editor/prosemirror';

type SharePayload = {
  targetType: 'page' | 'topic';
  shareMode: 'live' | 'snapshot';
  title: string;
  contentJson: unknown;
  textContent: string | null;
};

export function ShareView({ token }: { token: string }) {
  const [share, setShare] = useState<SharePayload | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api<{ share: SharePayload }>(`/api/public/shares/${token}`)
      .then((res) => { if (alive) { setShare(res.share); setLoading(false); } })
      .catch((e) => { if (alive) { setError(e.message || '分享不存在或已失效'); setLoading(false); } });
    return () => { alive = false; };
  }, [token]);

  if (loading) {
    return (
      <div className="share-page">
        <div className="share-loading">加载中…</div>
      </div>
    );
  }

  if (error || !share) {
    return (
      <div className="share-page">
        <div className="share-error">
          <h2>无法打开分享</h2>
          <p>{error || '分享内容为空'}</p>
          <a className="share-home" href="/">返回 ZhiPane</a>
        </div>
      </div>
    );
  }

  const html = docToHtml(share.contentJson as Parameters<typeof docToHtml>[0]);

  return (
    <div className="share-page">
      <div className="share-doc">
        <div className="share-badge">{share.targetType === 'topic' ? '主题' : '笔记'} · {share.shareMode === 'snapshot' ? '快照' : '实时'}</div>
        <h1 className="share-title">{share.title}</h1>
        <div className="prose" dangerouslySetInnerHTML={{ __html: html }} />
        <div className="share-footer">由 ZhiPane 分享 · <a href="/">打开应用</a></div>
      </div>
    </div>
  );
}
