import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, BookOpen, Brain, CheckSquare, ChevronDown, ChevronsLeft, Clock, Compass, Download, FileText, Home, LayoutGrid, LogOut,
  Moon, Monitor, Pencil, Plus, Search, Settings, Sparkles, Star, Sun, Trash2, Wand2
} from 'lucide-react';
import { api, del, patch, post, renamePage, movePage, copyPage } from '../../api';
import { useToast } from '../../components/Toast';
import { useDialog } from '../../components/Dialog';
import { PageActionMenu, MovePageDialog, type PageAction } from '../../components/PageActionMenu';
import { ShareModal } from '../../ShareModal';
import { useFavorites } from '../../hooks/useFavorites';
import { useAdaptivePolling } from '../../hooks/useAdaptivePolling';
import { PageTree } from '../notes/PageTree';
import { useDeletePage } from '../notes/useDeletePage';
import { cycleTheme, getTheme, type ThemeMode } from '../../theme';
import type { MainRoute, PageDetail, Space, TreeNode, User, Workspace } from '../../types';

const STATUS_LABEL: Record<string, string> = {
  pending: '待整理', processing: '整理中', done: '已整理', processed: '已整理',
  failed: '整理失败', skipped: '已跳过', ignored: '未整理'
};

// Phase B3: group Spaces by kind in the sidebar (项目 / 领域 / 资料 / 收集箱).
const SPACE_KIND_ORDER = ['project', 'area', 'resource', 'inbox'] as const;
const SPACE_KIND_LABEL: Record<string, string> = {
  project: '项目', area: '领域', resource: '资料', inbox: '收集箱'
};

function flatten(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => { for (const n of nodes) { out.push(n); walk(n.children); } };
  walk(tree);
  return out;
}

export function LeftSidebar({
  me, workspace, workspaces, space, spaces, route, selectedPageId,
  onPickWorkspace, onPickSpace, onSelectPage, onNavigate, onNewNote, onLogout, onNavigateHome, onOpenSettings
}: {
  me: User;
  workspace: Workspace | null;
  workspaces: Workspace[];
  space: Space | null;
  spaces: Space[];
  route: MainRoute;
  selectedPageId: string | null;
  onPickWorkspace: (w: Workspace) => void;
  onPickSpace: (s: Space) => void;
  onSelectPage: (id: string) => void;
  onNavigate: (r: MainRoute) => void;
  onNewNote: () => void;
  onLogout: () => void;
  onNavigateHome: () => void;
  onOpenSettings: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const { favorites } = useFavorites();
  const [theme, setTheme] = useState<ThemeMode>(() => getTheme());
  const onToggleTheme = () => setTheme(cycleTheme(theme));

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem('sb.collapsed') === '1'; } catch { return false; }
  });
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      try { localStorage.setItem('sb.collapsed', next ? '1' : '0'); } catch { /* ignore */ }
      return next;
    });
  };

  const [wsOpen, setWsOpen] = useState(false);
  const [wsName, setWsName] = useState('');
  const [spName, setSpName] = useState('');
  const [spKind, setSpKind] = useState<'project' | 'area' | 'resource' | 'inbox'>('area');
  const [addingSpace, setAddingSpace] = useState(false);

  const { data: treeData, isLoading: treeLoading } = useQuery<{ tree: TreeNode[] }>({
    queryKey: ['page-tree', space?.id], enabled: !!space,
    queryFn: () => api(`/api/pages/tree?spaceId=${space!.id}`)
  });
  const tree = treeData?.tree ?? [];
  const flat = useMemo(() => flatten(tree), [tree]);

  // "待整理" badge count with adaptive polling (jargon-free label for the inbox).
  const { data: inboxData } = useQuery<{ inbox: unknown[] }>({
    queryKey: ['inbox', space?.id], enabled: !!space,
    queryFn: () => api(`/api/llm-wiki/inbox?spaceId=${space!.id}`),
    refetchInterval: useAdaptivePolling({ enabled: !!space, hasActivity: false })
  });
  const inboxCount = inboxData?.inbox?.length ?? 0;

  const recent = useMemo(
    () => [...flat].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')).slice(0, 5),
    [flat]
  );
  const favPages = useMemo(() => flat.filter((n) => favorites.has(n.id)).slice(0, 8), [flat, favorites]);

  // Phase B3: bucket Spaces into kind groups for the sidebar.
  const groupedSpaces = useMemo(() => {
    const g: Record<string, Space[]> = { project: [], area: [], resource: [], inbox: [] };
    for (const s of spaces) (g[s.kind ?? 'area'] ??= []).push(s);
    return g;
  }, [spaces]);

  /* ---- workspace / space CRUD (no native confirm) ---- */
  const createWs = useMutation({
    mutationFn: () => post<{ workspace: Workspace }>('/api/workspaces', { name: wsName || '我的知识库' }),
    onSuccess: async (r) => { setWsName(''); setWsOpen(false); await qc.invalidateQueries({ queryKey: ['workspaces'] }); onPickWorkspace(r.workspace); toast.success('已创建知识库'); }
  });
  const renameWs = useMutation({
    mutationFn: (name: string) => patch(`/api/workspaces/${workspace!.id}`, { name }),
    onSuccess: async (_r, name) => { await qc.invalidateQueries({ queryKey: ['workspaces'] }); onPickWorkspace({ ...workspace!, name }); }
  });
  const deleteWs = useMutation({
    mutationFn: () => del(`/api/workspaces/${workspace!.id}`),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['workspaces'] }); onNavigateHome(); toast.success('已删除知识库'); }
  });
  const createSp = useMutation({
    mutationFn: () => post<{ space: Space }>('/api/spaces', { workspaceId: workspace!.id, name: spName || '新空间', aiPrivacyPolicy: 'inherit_workspace', spaceKind: spKind }),
    onSuccess: async (r) => { setSpName(''); setSpKind('area'); setAddingSpace(false); await qc.invalidateQueries({ queryKey: ['spaces', workspace!.id] }); onPickSpace(r.space); toast.success('已创建空间'); }
  });
  const renameSp = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => patch(`/api/spaces/${id}`, { name }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['spaces', workspace!.id] }); }
  });
  const deleteSp = useMutation({
    mutationFn: (id: string) => del(`/api/spaces/${id}`),
    onSuccess: async (_r, id) => {
      await qc.invalidateQueries({ queryKey: ['spaces', workspace!.id] });
      const remaining = spaces.find((s) => s.id !== id);
      if (space?.id === id) {
        if (remaining) onPickSpace(remaining);
        else onNavigateHome();
      }
      toast.success('已删除空间');
    }
  });

  const askRename = async (kind: 'ws' | 'sp', cur: { id: string; name: string }) => {
    const next = await dialog.prompt({
      title: kind === 'ws' ? '重命名知识库' : '重命名空间',
      defaultValue: cur.name,
      placeholder: '输入新名称',
      confirmText: '保存'
    });
    if (next && next !== cur.name) {
      if (kind === 'ws') renameWs.mutate(next);
      else renameSp.mutate({ id: cur.id, name: next });
    }
  };

  const askDeleteWs = async () => {
    if (!workspace) return;
    const ok = await dialog.confirm({ title: `删除知识库「${workspace.name}」？`, message: '其中所有空间与笔记都会被删除，此操作不可撤销。', confirmText: '删除', danger: true });
    if (ok) deleteWs.mutate();
  };
  const askDeleteSp = async (s: Space) => {
    const ok = await dialog.confirm({ title: `删除空间「${s.name}」？`, message: '其中所有笔记都会被删除，此操作不可撤销。', confirmText: '删除', danger: true });
    if (ok) deleteSp.mutate(s.id);
  };
  const exportSpace = async (s: Space) => {
    try {
      const res = await post<{ markdown: string }>(`/api/export/space/${s.id}`, {});
      const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${s.name || 'space'}.md`; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error(`导出失败：${(e as Error).message}`); }
  };

  /* ---- page operation menu / drag reorder (Phase 6) ---- */
  const [menu, setMenu] = useState<{ page: TreeNode; x: number; y: number } | null>(null);
  const [moveTarget, setMoveTarget] = useState<TreeNode | null>(null);
  const [shareTarget, setShareTarget] = useState<TreeNode | null>(null);
  const deletePage = useDeletePage(space, (id) => { if (id === selectedPageId) onSelectPage(''); });

  const findNode = useCallback((id: string): TreeNode | undefined => {
    let found: TreeNode | undefined;
    const walk = (ns: TreeNode[]) => { for (const n of ns) { if (n.id === id) found = n; walk(n.children); } };
    walk(tree);
    return found;
  }, [tree]);

  const downloadMarkdown = (markdown: string, filename: string) => {
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const handlePageAction = useCallback(async (action: PageAction, page: TreeNode) => {
    if (!space) return;
    if (action === 'createChild') {
      try {
        const res = await post<{ page: PageDetail }>(`/api/pages`, { spaceId: space.id, parentPageId: page.id, title: '新页面' });
        await qc.invalidateQueries({ queryKey: ['page-tree', space.id] });
        toast.success('已创建子页面');
        onSelectPage(res.page.id);
      } catch (e) { toast.error(`创建失败：${(e as Error).message}`); }
    } else if (action === 'rename') {
      const next = await dialog.prompt({ title: '重命名页面', defaultValue: page.title, placeholder: '输入新标题', confirmText: '保存' });
      if (next && next.trim() && next.trim() !== page.title) {
        try {
          await renamePage(page.id, next.trim());
          await qc.invalidateQueries({ queryKey: ['page-tree', space.id] });
          toast.success('已重命名');
        } catch (e) { toast.error(`重命名失败：${(e as Error).message}`); }
      }
    } else if (action === 'move') {
      setMoveTarget(page);
    } else if (action === 'copy') {
      try {
        const { page: src } = await api<{ page: PageDetail }>(`/api/pages/${page.id}`);
        const res = await copyPage({ spaceId: space.id, title: `${src.title || '未命名笔记'} 副本`, contentJson: src.contentJson, textContent: src.textContent });
        await qc.invalidateQueries({ queryKey: ['page-tree', space.id] });
        toast.success('已复制页面');
        onSelectPage(res.page.id);
      } catch (e) { toast.error(`复制失败：${(e as Error).message}`); }
    } else if (action === 'share') {
      setShareTarget(page);
    } else if (action === 'export') {
      try {
        const res = await post<{ markdown: string; title: string }>(`/api/export/page/${page.id}`, {});
        downloadMarkdown(res.markdown, `${res.title || 'note'}.md`);
      } catch (e) { toast.error(`导出失败：${(e as Error).message}`); }
    } else if (action === 'delete') {
      const ok = await dialog.confirm({ title: `删除「${page.title || '未命名笔记'}」？`, message: '删除后可在提示中撤销。', confirmText: '删除', danger: true });
      if (ok) deletePage({ id: page.id, title: page.title });
    }
  }, [space, dialog, qc, toast, onSelectPage, deletePage]);

  const onReorder = useCallback((dragId: string, targetId: string | null, position: number, mode: 'child' | 'sibling' = 'sibling') => {
    if (!space) return;
    const target = targetId ? findNode(targetId) : null;
    // Phase C2.1 (U8): dropping on the top half makes the page a CHILD of the
    // target; the bottom half makes it a SIBLING (same parent as the target).
    const parentPageId = mode === 'child' && target ? target.id : (target ? target.parentPageId : null);
    const pos = mode === 'child' ? 1e9 : position;
    movePage(dragId, { parentPageId, position: pos })
      .then(() => qc.invalidateQueries({ queryKey: ['page-tree', space.id] }))
      .catch((e: Error) => toast.error(`移动失败：${e.message}`));
  }, [space, findNode, movePage, qc, toast]);

  const onMoveTarget = useCallback((parentPageId: string | null) => {
    if (!moveTarget || !space) return;
    // Append to the end of the target parent's list.
    movePage(moveTarget.id, { parentPageId, position: 1e9 })
      .then(() => qc.invalidateQueries({ queryKey: ['page-tree', space.id] }))
      .then(() => toast.success('已移动'))
      .catch((e: Error) => toast.error(`移动失败：${e.message}`))
      .finally(() => setMoveTarget(null));
  }, [moveTarget, space, movePage, qc, toast]);

  const NAV: { key: MainRoute; label: string; icon: React.ReactNode; badge?: number }[] = [
    { key: 'home', label: '首页', icon: <Home size={16} /> },
    { key: 'tasks', label: '任务管理', icon: <CheckSquare size={16} /> },
    { key: 'nav', label: '常用导航', icon: <Compass size={16} /> },
    { key: 'organize', label: '智能整理', icon: <Wand2 size={16} />, badge: inboxCount },
    { key: 'search', label: '搜索', icon: <Search size={16} /> },
    { key: 'ask', label: '知识问答', icon: <Brain size={16} /> },
    { key: 'map', label: '关系图', icon: <LayoutGrid size={16} /> },
    { key: 'archive', label: '归档中心', icon: <Archive size={16} /> }
  ];

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      {/* Knowledge base (workspace) */}
      <div className="sb-brand">
        <div className="sb-brand-mark"><Sparkles size={18} /></div>
        <button className="sb-collapse-btn" title={collapsed ? '展开侧边栏' : '收起侧边栏'} onClick={toggleCollapsed}>
          <ChevronsLeft size={16} className={collapsed ? 'flip' : ''} />
        </button>
        <div className="sb-ws">
          <button className="sb-ws-trigger" onClick={() => setWsOpen((o) => !o)}>
            <span className="sb-ws-name">{workspace?.name ?? '选择知识库'}</span>
            <ChevronDown size={14} />
          </button>
          {wsOpen && (
            <>
              <div className="sb-backdrop" onClick={() => setWsOpen(false)} />
              <div className="sb-menu">
                {workspaces.map((w) => (
                  <button key={w.id} className={`sb-menu-item${workspace?.id === w.id ? ' active' : ''}`}
                    onClick={() => { onPickWorkspace(w); setWsOpen(false); }}>
                    <BookOpen size={14} /> {w.name}
                  </button>
                ))}
                {workspace && (
                  <div className="sb-menu-row">
                    <button className="sb-mini" onClick={() => askRename('ws', workspace)}><Pencil size={12} /> 重命名</button>
                    <button className="sb-mini danger" onClick={askDeleteWs}><Trash2 size={12} /> 删除</button>
                  </div>
                )}
                <div className="sb-new">
                  <input value={wsName} placeholder="新建知识库" onChange={(e) => setWsName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createWs.mutate()} />
                  <button className="icon-btn" onClick={() => createWs.mutate()}><Plus size={14} /></button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="sb-scroll">
        {/* Primary navigation */}
        <nav className="sb-nav">
          {NAV.map((n) => (
            <button key={n.key} className={`sb-nav-item${route === n.key ? ' active' : ''}`} onClick={() => onNavigate(n.key)}>
              {n.icon}<span>{n.label}</span>
              {n.badge ? <span className="sb-badge">{n.badge}</span> : null}
            </button>
          ))}
        </nav>

        {/* Recent */}
        {recent.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-head"><Clock size={13} /> 最近</div>
            {recent.map((n) => (
              <button key={n.id} className={`sb-link${selectedPageId === n.id && route === 'page' ? ' active' : ''}`} onClick={() => onSelectPage(n.id)}>
                <FileText size={14} /> <span className="sb-link-title">{n.title || '未命名笔记'}</span>
              </button>
            ))}
          </div>
        )}

        {/* Favorites */}
        {favPages.length > 0 && (
          <div className="sb-section">
            <div className="sb-section-head"><Star size={13} /> 收藏</div>
            {favPages.map((n) => (
              <button key={n.id} className={`sb-link${selectedPageId === n.id && route === 'page' ? ' active' : ''}`} onClick={() => onSelectPage(n.id)}>
                <Star size={13} fill="currentColor" /> <span className="sb-link-title">{n.title || '未命名笔记'}</span>
              </button>
            ))}
          </div>
        )}

        {/* Spaces */}
        <div className="sb-section">
          <div className="sb-section-head">
            <span><LayoutGrid size={13} /> 空间</span>
            <button className="icon-btn sb-section-add" title="新建空间" onClick={() => setAddingSpace((v) => !v)}><Plus size={13} /></button>
          </div>
          {addingSpace && (
            <div className="sb-new">
              <input autoFocus value={spName} placeholder="新空间名称" onChange={(e) => setSpName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createSp.mutate()} />
              <select className="sb-kind-select" value={spKind}
                onChange={(e) => setSpKind(e.target.value as 'project' | 'area' | 'resource' | 'inbox')}
                title="空间类型">
                <option value="project">项目（有目标/期限）</option>
                <option value="area">领域（长期维护）</option>
                <option value="resource">资料（参考资料）</option>
                <option value="inbox">收集箱（待分类）</option>
              </select>
              <button className="icon-btn" onClick={() => createSp.mutate()}><Plus size={14} /></button>
            </div>
          )}
          {SPACE_KIND_ORDER.filter((k) => groupedSpaces[k].length > 0).map((k) => (
            <div key={k} className="sb-space-group">
              <div className="sb-section-subhead">{SPACE_KIND_LABEL[k]} ({groupedSpaces[k].length})</div>
              {groupedSpaces[k].map((s: Space) => (
                <div key={s.id} className={`sb-space-row${space?.id === s.id ? ' active' : ''}`}>
                  <button className="sb-link sb-space-btn" onClick={() => { onPickSpace(s); }}>
                    <BookOpen size={14} /> <span className="sb-link-title">{s.name}</span>
                  </button>
                  <div className="sb-space-actions">
                    <button className="icon-btn" title="导出" onClick={() => exportSpace(s)}><Download size={12} /></button>
                    <button className="icon-btn" title="重命名" onClick={() => askRename('sp', s)}><Pencil size={12} /></button>
                    <button className="icon-btn danger" title="删除" onClick={() => askDeleteSp(s)}><Trash2 size={12} /></button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Page tree for the current space */}
        {space && (
          <div className="sb-section sb-tree-section">
            <div className="sb-section-head">
              <span><FileText size={13} /> 页面 {tree.length > 0 && <em>{flat.length}</em>}</span>
              <button className="icon-btn sb-section-add" title="新建笔记" onClick={onNewNote}><Plus size={13} /></button>
            </div>
            {treeLoading && <div className="muted small sb-pad">加载中…</div>}
            {!treeLoading && tree.length === 0 && <div className="muted small sb-pad">还没有笔记，点击 + 新建</div>}
            {!treeLoading && tree.length > 0 && (
              <div className="sb-tree">
                <PageTree
                  tree={tree}
                  selectedId={route === 'page' ? selectedPageId : null}
                  onSelect={onSelectPage}
                  statusLabel={(s) => STATUS_LABEL[s] ?? s}
                  onContextMenu={(node, x, y) => setMenu({ page: node, x, y })}
                  onMore={(node, x, y) => setMenu({ page: node, x, y })}
                  onReorder={onReorder}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <span className="sb-user">{me.name}{me.isInstanceOwner && <span className="tag">Owner</span>}</span>
        <button className="icon-btn" title={theme === 'dark' ? '深色模式' : theme === 'light' ? '浅色模式' : '跟随系统'} onClick={onToggleTheme}>
          {theme === 'dark' ? <Moon size={15} /> : theme === 'light' ? <Sun size={15} /> : <Monitor size={15} />}
        </button>
        <button className="icon-btn" title="设置" onClick={onOpenSettings}><Settings size={15} /></button>
        <button className="icon-btn" title="退出登录" onClick={onLogout}><LogOut size={15} /></button>
      </div>

      {menu && (
        <PageActionMenu
          page={menu.page}
          x={menu.x}
          y={menu.y}
          onAction={handlePageAction}
          onClose={() => setMenu(null)}
        />
      )}
      {moveTarget && (
        <MovePageDialog
          page={moveTarget}
          tree={tree}
          onClose={() => setMoveTarget(null)}
          onMove={onMoveTarget}
        />
      )}
      {shareTarget && (
        <ShareModal
          workspaceId={workspace!.id}
          targetType="page"
          targetId={shareTarget.id}
          targetTitle={shareTarget.title}
          onClose={() => setShareTarget(null)}
        />
      )}
    </aside>
  );
}
