import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, FileText, Layers, RefreshCw, Trash2 } from 'lucide-react';
import {
  getArchivedSpaces, getArchivedTopics, getLifecycleSuggestions, listSpaces,
  archiveTopic, reactivateTopic, updateTopic, ignoreSuggestion, updateSpace,
  getArchivedPages, unarchivePage
} from '../../api';
import { useToast } from '../../components/Toast';
import type { ArchivedPage, LifecycleSuggestion, MainRoute, Space, Workspace } from '../../types';

type Tab = 'notes' | 'spaces' | 'topics' | 'suggestions';

const SUGGESTION_LABEL: Record<string, string> = {
  lifecycle_archive: '建议归档',
  lifecycle_cooling: '建议降权',
  reactivation: '建议恢复',
  inbox_classify: '建议分类'
};

/**
 * Archive Center — organised along the real hierarchy 知识库 → 空间 → 笔记.
 *
 * Previously this view only offered RECOVERY (restore an already-archived
 * Topic / Space), so there was no way to actually archive anything. The scope
 * selector keeps every query inside one knowledge base so switching bases
 * cannot mix data, and Archived Spaces no longer leak into the sidebar.
 */
export function ArchiveCenter({
  space, workspace, workspaces, onNavigate
}: {
  space: Space | null;
  workspace: Workspace | null;
  workspaces: Workspace[];
  onNavigate: (r: MainRoute) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('notes');
  const [scopeWsId, setScopeWsId] = useState<string | null>(workspace?.id ?? null);

  // Follow the shell's current knowledge base when the user switches it.
  useEffect(() => {
    if (workspace?.id) setScopeWsId(workspace.id);
  }, [workspace?.id]);

  const scope = scopeWsId ?? workspace?.id ?? null;
  const scopeName = workspaces.find((w) => w.id === scope)?.name ?? '未选择知识库';

  const activeSpacesQ = useQuery({
    queryKey: ['archive-active-spaces', scope],
    enabled: !!scope,
    queryFn: () => listSpaces(scope!)
  });
  const archivedSpacesQ = useQuery({
    queryKey: ['archived-spaces', scope],
    enabled: !!scope,
    queryFn: () => getArchivedSpaces(scope!)
  });
  const archivedPagesQ = useQuery({
    queryKey: ['archived-pages', scope],
    enabled: !!scope,
    queryFn: () => getArchivedPages(scope!)
  });
  // Topics / AI suggestions are space-scoped in the backend, so they stay
  // bound to the current space and are labelled as such in the UI.
  const archivedTopicsQ = useQuery({
    queryKey: ['archived-topics', space?.id],
    enabled: !!space,
    queryFn: () => getArchivedTopics(space!.id)
  });
  const suggestionsQ = useQuery({
    queryKey: ['lifecycle-suggestions', space?.id],
    enabled: !!space,
    queryFn: () => getLifecycleSuggestions(space!.id)
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
      qc.invalidateQueries({ queryKey: ['lifecycle-suggestions'] });
      qc.invalidateQueries({ queryKey: ['archived-topics'] });
      qc.invalidateQueries({ queryKey: ['topics'] });
      toast.success('已处理该建议');
    },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const dismissSuggestion = useMutation({
    mutationFn: (id: string) => ignoreSuggestion(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['lifecycle-suggestions'] }),
    onError: (e) => toast.error(`忽略失败：${(e as Error).message}`)
  });
  const restoreTopic = useMutation({
    mutationFn: (topicId: string) => reactivateTopic(topicId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['archived-topics'] });
      qc.invalidateQueries({ queryKey: ['topics'] });
      toast.success('主题已恢复');
    },
    onError: (e) => toast.error(`恢复失败：${(e as Error).message}`)
  });

  // One mutation for both directions of Space archiving. invalidate ['spaces']
  // so the left sidebar immediately drops/restores the space.
  const setSpaceLifecycle = useMutation({
    mutationFn: ({ id, status }: { id: string; status: 'archived' | 'active' }) =>
      updateSpace(id, { lifecycleStatus: status }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['archive-active-spaces'] });
      qc.invalidateQueries({ queryKey: ['archived-spaces'] });
      qc.invalidateQueries({ queryKey: ['spaces'] });
      toast.success(vars.status === 'archived' ? '空间已归档' : '空间已恢复');
    },
    onError: (e) => toast.error(`操作失败：${(e as Error).message}`)
  });
  const restoreNote = useMutation({
    mutationFn: (id: string) => unarchivePage(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['archived-pages'] });
      qc.invalidateQueries({ queryKey: ['page-tree'] });
      toast.success('笔记已恢复，已回到目录树');
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
  const activeSpaces = (activeSpacesQ.data?.spaces ?? []).filter((s) => s.lifecycleStatus !== 'archived');
  const archivedPages: ArchivedPage[] = archivedPagesQ.data?.pages ?? [];

  return (
    <div className="archive-page">
      <h2><Archive size={20} /> 归档中心</h2>
      <p className="muted small">
        按「知识库 → 空间 → 笔记」层级管理归档。空间与笔记均可主动归档并随时恢复；归档后不再出现在侧栏或目录树中。
      </p>

      <div className="archive-scope">
        <label htmlFor="archive-ws">知识库</label>
        <select id="archive-ws" value={scope ?? ''} onChange={(e) => setScopeWsId(e.target.value)}>
          {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <span className="muted small">
          当前范围：{scopeName}。知识库本身不归档，如需移除请使用左上角知识库菜单中的「删除」。
        </span>
      </div>

      <div className="archive-tabs">
        <TabButton active={tab === 'notes'} onClick={() => setTab('notes')}>已归档笔记 ({archivedPages.length})</TabButton>
        <TabButton active={tab === 'spaces'} onClick={() => setTab('spaces')}>空间归档 ({activeSpaces.length + archivedSpaces.length})</TabButton>
        <TabButton active={tab === 'topics'} onClick={() => setTab('topics')}>已归档主题 ({archivedTopics.length})</TabButton>
        <TabButton active={tab === 'suggestions'} onClick={() => setTab('suggestions')}>归档建议 ({suggestions.length})</TabButton>
      </div>

      {tab === 'notes' && (
        <div>
          <p className="archive-subhead">属于「{scopeName}」下所有空间。在笔记右上角「更多 → 归档笔记」可发起归档。</p>
          {archivedPagesQ.isLoading && <div className="muted small">加载中…</div>}
          {!archivedPagesQ.isLoading && archivedPages.length === 0 && (
            <div className="muted small">没有已归档笔记。</div>
          )}
          {archivedPages.map((p) => (
            <div key={p.id} className="archive-row">
              <div className="archive-item-main">
                <div><FileText size={14} /> <b>{p.title || '未命名笔记'}</b></div>
                <div className="muted small">所属空间：{p.spaceName}</div>
              </div>
              <button className="primary sm" disabled={restoreNote.isPending} onClick={() => restoreNote.mutate(p.id)}>
                <ArchiveRestore size={14} /> 恢复
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === 'spaces' && (
        <div>
          <p className="archive-subhead">属于「{scopeName}」。归档空间后，其空间会从左侧菜单隐藏，但笔记数据保留。</p>
          <div className="archive-group">
            <h4>活跃空间 · 可归档 ({activeSpaces.length})</h4>
            {activeSpaces.length === 0 && <div className="muted small">没有可归档的空间。</div>}
            {activeSpaces.map((s: Space) => (
              <div key={s.id} className="archive-row">
                <div className="archive-item-main">
                  <div><Layers size={14} /> <b>{s.name}</b>{s.kind && <span className="muted small"> · {s.kind}</span>}</div>
                  <div className="muted small">状态：{s.lifecycleStatus ?? 'active'}</div>
                </div>
                <div className="archive-item-actions">
                  <button className="ghost sm" disabled={setSpaceLifecycle.isPending}
                    onClick={() => setSpaceLifecycle.mutate({ id: s.id, status: 'archived' })}>
                    <Archive size={14} /> 归档
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="archive-group">
            <h4>已归档空间 · 可恢复 ({archivedSpaces.length})</h4>
            {archivedSpaces.length === 0 && <div className="muted small">没有已归档空间。</div>}
            {archivedSpaces.map((s: Space) => (
              <div key={s.id} className="archive-row">
                <div className="archive-item-main"><div><Layers size={14} /> <b>{s.name}</b></div></div>
                <div className="archive-item-actions">
                  <button className="primary sm" disabled={setSpaceLifecycle.isPending}
                    onClick={() => setSpaceLifecycle.mutate({ id: s.id, status: 'active' })}>
                    <RefreshCw size={14} /> 恢复
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {tab === 'topics' && (
        <div>
          <p className="archive-subhead">仅当前空间「{space?.name ?? '—'}」的 LLM Wiki 主题。</p>
          {archivedTopicsQ.isLoading && <div className="muted small">加载中…</div>}
          {!archivedTopicsQ.isLoading && archivedTopics.length === 0 && <div className="muted small">没有已归档主题。</div>}
          {archivedTopics.map((t) => (
            <div key={t.id} className="archive-row">
              <div className="archive-item-main">
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

      {tab === 'suggestions' && (
        <div>
          <p className="archive-subhead">AI 对当前空间「{space?.name ?? '—'}」的生命周期建议。</p>
          {suggestionsQ.isLoading && <div className="muted small">加载中…</div>}
          {!suggestionsQ.isLoading && suggestions.length === 0 && (
            <div className="muted small">暂无归档建议。运行「生命周期评估」后会在此出现。</div>
          )}
          {Object.entries(grouped).map(([type, items]) => (
            <div key={type} className="archive-group">
              <h4>{SUGGESTION_LABEL[type] ?? type} ({items.length})</h4>
              {items.map((s) => (
                <div key={s.id} className="archive-row">
                  <div className="archive-item-main">
                    <div><b>{(s.payload?.topicTitle as string) ?? '(未命名主题)'}</b></div>
                    <div className="muted small">{(s.payload?.reason as string) ?? ''}</div>
                  </div>
                  <div className="archive-item-actions">
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

      <div>
        <button className="ghost" onClick={() => onNavigate('organize')}><Trash2 size={14} /> 返回智能整理</button>
      </div>
    </div>
  );
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={'archive-tab' + (active ? ' active' : '')}>
      {children}
    </button>
  );
}
