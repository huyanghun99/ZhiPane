import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Layers, RefreshCw, Trash2 } from 'lucide-react';
import {
  getArchivedSpaces, getArchivedTopics, getLifecycleSuggestions,
  archiveTopic, reactivateTopic, updateTopic, ignoreSuggestion, updateSpace
} from '../../api';
import { useToast } from '../../components/Toast';
import type { LifecycleSuggestion, MainRoute, Space, Workspace } from '../../types';

type Tab = 'suggestions' | 'topics' | 'spaces';

const SUGGESTION_LABEL: Record<string, string> = {
  lifecycle_archive: '建议归档',
  lifecycle_cooling: '建议降权',
  reactivation: '建议恢复',
  inbox_classify: '建议分类'
};

export function ArchiveCenter({
  space, workspace, onNavigate
}: {
  space: Space | null;
  workspace: Workspace | null;
  onNavigate: (r: MainRoute) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('suggestions');

  const suggestionsQ = useQuery({
    queryKey: ['lifecycle-suggestions', space?.id],
    enabled: !!space,
    queryFn: () => getLifecycleSuggestions(space!.id)
  });
  const archivedTopicsQ = useQuery({
    queryKey: ['archived-topics', space?.id],
    enabled: !!space && tab === 'topics',
    queryFn: () => getArchivedTopics(space!.id)
  });
  const archivedSpacesQ = useQuery({
    queryKey: ['archived-spaces', workspace?.id],
    enabled: !!workspace && tab === 'spaces',
    queryFn: () => getArchivedSpaces(workspace!.id)
  });

  const applySuggestion = useMutation({
    mutationFn: async (s: LifecycleSuggestion) => {
      const topicId = s.payload?.topicId as string | undefined;
      if (s.type === 'lifecycle_archive' && topicId) await archiveTopic(topicId);
      else if (s.type === 'reactivation' && topicId) await reactivateTopic(topicId);
      else if (s.type === 'lifecycle_cooling' && topicId) await updateTopic(topicId, { lifecycleStatus: 'cooling' });
      if (s.id) await ignoreSuggestion(s.id);
      return s;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lifecycle-suggestions', space?.id] });
      qc.invalidateQueries({ queryKey: ['topics', space?.id] });
      toast.success('已处理该建议');
    },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const dismissSuggestion = useMutation({
    mutationFn: (id: string) => ignoreSuggestion(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lifecycle-suggestions', space?.id] }),
    onError: (e) => toast.error(`忽略失败：${(e as Error).message}`)
  });
  const restoreTopic = useMutation({
    mutationFn: (topicId: string) => reactivateTopic(topicId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['archived-topics', space?.id] });
      qc.invalidateQueries({ queryKey: ['topics', space?.id] });
      toast.success('主题已恢复');
    },
    onError: (e) => toast.error(`恢复失败：${(e as Error).message}`)
  });
  const restoreSpace = useMutation({
    mutationFn: (id: string) => updateSpace(id, { lifecycleStatus: 'active' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['archived-spaces', workspace?.id] });
      qc.invalidateQueries({ queryKey: ['spaces', workspace?.id] });
      toast.success('空间已恢复');
    },
    onError: (e) => toast.error(`恢复失败：${(e as Error).message}`)
  });

  const suggestions = suggestionsQ.data?.suggestions ?? [];
  const grouped = useMemo(() => {
    const g: Record<string, LifecycleSuggestion[]> = {};
    for (const s of suggestions) (g[s.type] ??= []).push(s);
    return g;
  }, [suggestions]);

  const archivedTopics = (archivedTopicsQ.data?.topics ?? []) as Array<{ id: string; title: string; lifecycleStatus?: string }>;
  const archivedSpaces = archivedSpacesQ.data?.spaces ?? [];

  return (
    <div style={{ padding: 24, maxWidth: 960, margin: '0 auto', width: '100%' }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Archive size={20} /> 归档中心
      </h2>
      <p className="muted small">集中管理生命周期建议、已归档主题与已归档空间。归档/删除均为可恢复操作。</p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0', borderBottom: '1px solid var(--border, #eee)', paddingBottom: 8 }}>
        <TabButton active={tab === 'suggestions'} onClick={() => setTab('suggestions')}>归档建议 ({suggestions.length})</TabButton>
        <TabButton active={tab === 'topics'} onClick={() => setTab('topics')}>已归档主题 ({archivedTopics.length})</TabButton>
        <TabButton active={tab === 'spaces'} onClick={() => setTab('spaces')}>已归档空间 ({archivedSpaces.length})</TabButton>
      </div>

      {tab === 'suggestions' && (
        <div>
          {suggestionsQ.isLoading && <div className="muted small">加载中…</div>}
          {!suggestionsQ.isLoading && suggestions.length === 0 && (
            <div className="muted small">暂无归档建议。运行「生命周期评估」后会在此出现。</div>
          )}
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type} style={{ marginBottom: 16 }}>
              <h4 style={{ margin: '8px 0' }}>{SUGGESTION_LABEL[type] ?? type} ({items.length})</h4>
              {items.map((s) => (
                <div key={s.id} className="archive-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '10px 12px', border: '1px solid var(--border, #eee)', borderRadius: 8, marginBottom: 8 }}>
                  <div>
                    <div><b>{(s.payload?.topicTitle as string) ?? '(未命名主题)'}</b></div>
                    <div className="muted small">{(s.payload?.reason as string) ?? ''}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, whiteSpace: 'nowrap' }}>
                    {(s.type === 'lifecycle_archive' || s.type === 'reactivation' || s.type === 'lifecycle_cooling') && (
                      <button className="primary sm" disabled={applySuggestion.isPending} onClick={() => applySuggestion.mutate(s)}>
                        {s.type === 'reactivation' ? '恢复' : s.type === 'lifecycle_cooling' ? '降权' : '归档'}
                      </button>
                    )}
                    <button className="ghost sm" disabled={dismissSuggestion.isPending} onClick={() => dismissSuggestion.mutate(s.id!)}>忽略</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {tab === 'topics' && (
        <div>
          {archivedTopicsQ.isLoading && <div className="muted small">加载中…</div>}
          {!archivedTopicsQ.isLoading && archivedTopics.length === 0 && (
            <div className="muted small">没有已归档主题。</div>
          )}
          {archivedTopics.map((t) => (
            <div key={t.id} className="archive-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border, #eee)', borderRadius: 8, marginBottom: 8 }}>
              <div>
                <b>{t.title}</b>
                {t.lifecycleStatus === 'archived' && <span className="tag">已删除/归档</span>}
              </div>
              <button className="primary sm" disabled={restoreTopic.isPending} onClick={() => restoreTopic.mutate(t.id)}>
                <ArchiveRestore size={14} /> 恢复
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'spaces' && (
        <div>
          {archivedSpacesQ.isLoading && <div className="muted small">加载中…</div>}
          {!archivedSpacesQ.isLoading && archivedSpaces.length === 0 && (
            <div className="muted small">没有已归档空间。</div>
          )}
          {archivedSpaces.map((s: Space) => (
            <div key={s.id} className="archive-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--border, #eee)', borderRadius: 8, marginBottom: 8 }}>
              <div>
                <Layers size={14} /> <b>{s.name}</b>
                {s.kind && <span className="muted small"> · {s.kind}</span>}
              </div>
              <button className="primary sm" disabled={restoreSpace.isPending} onClick={() => restoreSpace.mutate(s.id)}>
                <RefreshCw size={14} /> 恢复
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginTop: 24 }}>
        <button className="ghost" onClick={() => onNavigate('organize')}><Trash2 size={14} /> 返回智能整理</button>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: 'transparent', border: 'none', padding: '8px 12px', cursor: 'pointer',
        color: active ? 'var(--accent, #4f46e5)' : 'var(--text, #333)',
        borderBottom: active ? '2px solid var(--accent, #4f46e5)' : '2px solid transparent',
        fontWeight: active ? 600 : 400
      }}
    >
      {children}
    </button>
  );
}
