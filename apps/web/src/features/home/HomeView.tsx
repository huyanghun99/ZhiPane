import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowRight, Brain, Clock, FileText, Loader2, PenLine, Sparkles, Star, Upload, Wand2
} from 'lucide-react';
import { api, post } from '../../api';
import { ImportModal } from '../../ImportModal';
import { useToast } from '../../components/Toast';
import { useFavorites } from '../../hooks/useFavorites';
import { SkeletonList } from '../../components/Skeleton';
import { EmptyState } from '../../components/EmptyState';
import type { MainRoute, PageDetail, RagSession, Space, TreeNode, Workspace } from '../../types';

function flatten(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => { for (const n of nodes) { out.push(n); walk(n.children); } };
  walk(tree);
  return out;
}

function timeAgo(iso?: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Home dashboard (Phase 3).
 *
 * The first thing a user sees after picking a space: where their recent work
 * is, what's waiting to be organised, and a one-line quick-capture so they can
 * start writing immediately.
 */
export function HomeView({ workspace, space, onSelectPage, onNavigate, onNewNote }: {
  workspace: Workspace;
  space: Space;
  onSelectPage: (id: string) => void;
  onNavigate: (r: MainRoute) => void;
  onNewNote: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { favorites } = useFavorites();
  const [capture, setCapture] = useState('');
  const [showImport, setShowImport] = useState(false);

  const { data: treeData, isLoading: treeLoading } = useQuery<{ tree: TreeNode[] }>({
    queryKey: ['page-tree', space.id], queryFn: () => api(`/api/pages/tree?spaceId=${space.id}`)
  });
  const flat = useMemo(() => flatten(treeData?.tree ?? []), [treeData]);
  const recent = useMemo(() => [...flat].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 5), [flat]);
  const favPages = useMemo(() => flat.filter((n) => favorites.has(n.id)).slice(0, 6), [flat, favorites]);

  const { data: inboxData } = useQuery<{ inbox: unknown[] }>({
    queryKey: ['inbox', space.id], queryFn: () => api(`/api/llm-wiki/inbox?spaceId=${space.id}`)
  });
  const inboxCount = inboxData?.inbox?.length ?? 0;

  const { data: sessData, isLoading: sessLoading } = useQuery<{ sessions: RagSession[] }>({
    queryKey: ['rag-sessions'], queryFn: () => api('/api/rag/sessions')
  });
  const sessions = (sessData?.sessions ?? []).slice(0, 5);

  const quickCapture = useMutation({
    mutationFn: () => {
      const text = capture.trim();
      const title = text.split('\n')[0].slice(0, 60) || '快速记录';
      return post<{ page: PageDetail }>('/api/capture', {
        workspaceId: workspace.id, spaceId: space.id, title, content: text, tags: []
      });
    },
    onSuccess: async (res) => {
      setCapture('');
      await qc.invalidateQueries({ queryKey: ['page-tree', space.id] });
      toast.success('已记录，可在页面列表中继续编辑');
      onSelectPage(res.page.id);
    },
    onError: (e: Error) => toast.error(`记录失败：${e.message}`)
  });

  return (
    <div className="home-view">
      <div className="home-hero">
        <div className="home-hero-icon"><Sparkles size={22} /></div>
        <div>
          <h1>{space.name}</h1>
          <p className="muted">在这里记录想法，AI 会帮你自动整理成知识。</p>
        </div>
      </div>

      {/* Quick capture */}
      <div className="home-capture">
        <PenLine size={18} className="home-capture-icon" />
        <textarea
          value={capture}
          placeholder="快速记录一个想法…（第一行会作为标题，Ctrl/⌘+Enter 保存）"
          rows={2}
          onChange={(e) => setCapture(e.target.value)}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && capture.trim()) quickCapture.mutate(); }}
        />
        <div className="home-capture-actions">
          <button className="ghost sm" onClick={() => setShowImport(true)}><Upload size={15} /> 导入</button>
          <button className="ghost sm" onClick={onNewNote}><FileText size={15} /> 新建笔记</button>
          <button className="primary sm" disabled={!capture.trim() || quickCapture.isPending} onClick={() => quickCapture.mutate()}>
            {quickCapture.isPending ? <Loader2 className="spin" size={15} /> : <PenLine size={15} />} 记录
          </button>
        </div>
      </div>

      {/* Stat cards */}
      <div className="home-stats">
        <button className="stat-card" onClick={() => onNavigate('organize')}>
          <div className="stat-icon organize"><Wand2 size={18} /></div>
          <div className="stat-num">{inboxCount}</div>
          <div className="stat-label">待整理</div>
        </button>
        <button className="stat-card" onClick={() => onNavigate('ask')}>
          <div className="stat-icon ask"><Brain size={18} /></div>
          <div className="stat-num">{sessions.length}</div>
          <div className="stat-label">最近问答</div>
        </button>
        <div className="stat-card static">
          <div className="stat-icon fav"><Star size={18} /></div>
          <div className="stat-num">{favPages.length}</div>
          <div className="stat-label">收藏</div>
        </div>
      </div>

      <div className="home-cols">
        {/* Recent */}
        <section className="home-card">
          <div className="home-card-head"><Clock size={15} /> 最近编辑</div>
          {treeLoading && <SkeletonList rows={4} />}
          {!treeLoading && recent.length === 0 && (
            <div className="home-empty-cta">
              <EmptyState icon={<FileText size={26} />} title="还没有笔记" hint="用上面的快速记录开始你的第一篇，或批量导入已有资料。" />
              <div className="home-empty-actions">
                <button className="primary sm" onClick={onNewNote}><FileText size={15} /> 新建笔记</button>
                <button className="ghost sm" onClick={() => setShowImport(true)}><Upload size={15} /> 导入 Markdown</button>
              </div>
            </div>
          )}
          {recent.map((n) => (
            <button key={n.id} className="home-row" onClick={() => onSelectPage(n.id)}>
              <FileText size={15} />
              <span className="home-row-title">{n.title || '未命名笔记'}</span>
              <span className="muted small">{timeAgo(n.updatedAt)}</span>
            </button>
          ))}
        </section>

        {/* Favorites */}
        <section className="home-card">
          <div className="home-card-head"><Star size={15} /> 收藏</div>
          {favPages.length === 0 && (
            <EmptyState icon={<Star size={26} />} title="暂无收藏" hint="在笔记中点击星标即可收藏，方便随时回看。" />
          )}
          {favPages.map((n) => (
            <button key={n.id} className="home-row" onClick={() => onSelectPage(n.id)}>
              <Star size={14} fill="currentColor" className="home-row-star" />
              <span className="home-row-title">{n.title || '未命名笔记'}</span>
            </button>
          ))}
        </section>

        {/* Recent Q&A */}
        <section className="home-card home-card-wide">
          <div className="home-card-head">
            <span><Brain size={15} /> 最近问答</span>
            <button className="link-btn" onClick={() => onNavigate('ask')}>去提问 <ArrowRight size={13} /></button>
          </div>
          {sessLoading && <SkeletonList rows={3} />}
          {!sessLoading && sessions.length === 0 && (
            <EmptyState icon={<Brain size={26} />} title="还没有问答记录" hint="向知识库提问，答案会附带可点击的来源。" />
          )}
          {sessions.map((s) => (
            <button key={s.id} className="home-qa" onClick={() => onNavigate('ask')}>
              <div className="home-qa-q">{s.query}</div>
              <div className="home-qa-a muted small">{s.answer.slice(0, 120)}</div>
            </button>
          ))}
        </section>
      </div>

      {showImport && (
        <ImportModal workspaceId={workspace.id} spaceId={space.id} spaceName={space.name}
          onClose={() => setShowImport(false)} onImported={(id) => { setShowImport(false); onSelectPage(id); }} />
      )}
    </div>
  );
}
