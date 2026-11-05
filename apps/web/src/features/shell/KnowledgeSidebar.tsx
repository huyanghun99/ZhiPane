import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Archive, BookOpen, Brain, ChevronsLeft, Download, FileText, Home, LayoutGrid, Pencil, Plus, Settings, Star, Trash2, Wand2
} from 'lucide-react';
import { api, del, patch, post, renamePage, movePage, copyPage, updatePageIcon } from '../../api';
import { PageIconPicker } from '../../components/PageIconPicker';
import { useToast } from '../../components/Toast';
import { useDialog } from '../../components/Dialog';
import { PageActionMenu, MovePageDialog, type PageAction } from '../../components/PageActionMenu';
import { ShareModal } from '../../ShareModal';
import { useFavorites } from '../../hooks/useFavorites';
import { useAdaptivePolling } from '../../hooks/useAdaptivePolling';
import { PageTree } from '../notes/PageTree';
import { useDeletePage } from '../notes/useDeletePage';

import type { MainRoute, PageDetail, Space, TreeNode, Workspace } from '../../types';

const STATUS_LABEL: Record<string, string> = {
  pending: '待整理', processing: '整理中', done: '已整理', processed: '已整理',
  failed: '整理失败', skipped: '已跳过', ignored: '未整理'
};

function flatten(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => { for (const n of nodes) { out.push(n); walk(n.children); } };
  walk(tree);
  return out;
}

export function KnowledgeSidebar({
  workspace, space, spaces, route, selectedPageId,
  onPickSpace, onSelectPage, onNavigate, onNewNote
}: {
  workspace: Workspace | null;
  space: Space | null;
  spaces: Space[];
  route: MainRoute;
  selectedPageId: string | null;
  onPickSpace: (s: Space) => void;
  onSelectPage: (id: string) => void;
  onNavigate: (r: MainRoute) => void;
  onNewNote: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const { favorites } = useFavorites();

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

  const favPages = useMemo(() => flat.filter((n) => favorites.has(n.id)).slice(0, 8), [flat, favorites]);

  /* ---- space CRUD (workspace CRUD moved to TopBar; no native confirm) ----
     "+" now creates a space in one click with the backend default kind (area),
     then opens the rename prompt — no two-row create form, no kind grouping. */
  const createSp = useMutation({
    mutationFn: () => post<{ space: Space }>('/api/spaces', {
      workspaceId: workspace!.id, name: '新领域', aiPrivacyPolicy: 'inherit_workspace'
    }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['spaces', workspace!.id] });
      onPickSpace(r.space);
      toast.success('已创建领域');
      const next = await dialog.prompt({
        title: '命名新领域', defaultValue: r.space.name, placeholder: '输入名称', confirmText: '保存'
      });
      if (next && next.trim() && next.trim() !== r.space.name) {
        renameSp.mutate({ id: r.space.id, name: next.trim() });
      }
    },
    onError: (e: Error) => toast.error(`创建失败：${e.message}`)
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
        else onNavigate('home');
      }
      toast.success('已删除空间');
    }
  });

  const askRename = async (cur: { id: string; name: string }) => {
    const next = await dialog.prompt({
      title: '重命名空间',
      defaultValue: cur.name,
      placeholder: '输入新名称',
      confirmText: '保存'
    });
    if (next && next !== cur.name) renameSp.mutate({ id: cur.id, name: next });
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
  const [iconTarget, setIconTarget] = useState<{ node: TreeNode; x: number; y: number } | null>(null);
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

  const HOME_NAV = { key: 'home' as MainRoute, label: '首页', icon: <Home size={16} /> };
  const TOOL_NAV = [
    { key: 'organize' as MainRoute, label: '智能整理', icon: <Wand2 size={16} />, badge: inboxCount },
    { key: 'ask' as MainRoute, label: '知识问答', icon: <Brain size={16} /> }
  ];

  return (
    <aside className={`sidebar${collapsed ? ' collapsed' : ''}`}>
      {/* Collapse lives in the bottom foot row now, so it no longer wastes an
          entire standalone row at the top of the sidebar. */}
      <div className="sb-scroll">
        {/* Primary navigation */}
        <nav className="sb-nav">
          <button key={HOME_NAV.key} className={`sb-nav-item${route === HOME_NAV.key ? ' active' : ''}`} onClick={() => onNavigate(HOME_NAV.key)}>
            {HOME_NAV.icon}<span>{HOME_NAV.label}</span>
          </button>
          <div className="sb-nav-group">
            <div className="sb-nav-group-label">工具</div>
            {TOOL_NAV.map((n) => (
              <button key={n.key} className={`sb-nav-item${route === n.key ? ' active' : ''}`} onClick={() => onNavigate(n.key)}>
                {n.icon}<span>{n.label}</span>
                {n.badge ? <span className="sb-badge">{n.badge}</span> : null}
              </button>
            ))}
          </div>
        </nav>

        {/* Recent pages intentionally omitted here to free up vertical space;
            the Home dashboard still shows them. */}

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

        {/* Spaces — single compact list, "+" creates a domain in one click.
            Counts sit on the section head / active row instead of a separate
            "领域 (n)" group header (no per-space page-count API exists). */}
        <div className="sb-section">
          <div className="sb-section-head">
            <span><LayoutGrid size={13} /> 空间 <em>{spaces.length}</em></span>
            <button className="icon-btn sb-section-add" title="添加领域" onClick={() => createSp.mutate()}><Plus size={13} /></button>
          </div>
          {spaces.map((s: Space) => (
            <div key={s.id} className={`sb-space-row${space?.id === s.id ? ' active' : ''}`}>
              <button className="sb-link sb-space-btn" onClick={() => onPickSpace(s)}>
                <BookOpen size={14} /> <span className="sb-link-title">{s.name}</span>
                {space?.id === s.id && flat.length > 0 && <span className="sb-space-count">{flat.length}</span>}
              </button>
              <div className="sb-space-actions">
                <button className="icon-btn" title="导出" onClick={() => exportSpace(s)}><Download size={12} /></button>
                <button className="icon-btn" title="重命名" onClick={() => askRename(s)}><Pencil size={12} /></button>
                <button className="icon-btn danger" title="删除" onClick={() => askDeleteSp(s)}><Trash2 size={12} /></button>
              </div>
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
                  onPickIcon={(node, x, y) => setIconTarget({ node, x, y })}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="sb-foot">
        <button className="sb-foot-btn" onClick={() => onNavigate('archive')} title="归档中心">
          <Archive size={15} /> <span>归档中心</span>
        </button>
        <button className="sb-foot-btn" onClick={() => onNavigate('settings')} title="设置">
          <Settings size={15} /> <span>设置</span>
        </button>
        <button className="sb-foot-btn" title={collapsed ? '展开侧边栏' : '收起侧边栏'} onClick={toggleCollapsed}>
          <ChevronsLeft size={15} className={collapsed ? 'flip' : ''} />
        </button>
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
      {iconTarget && (
        <PageIconPicker
          anchor={{ x: iconTarget.x, y: iconTarget.y }}
          current={iconTarget.node.icon ?? undefined}
          onClose={() => setIconTarget(null)}
          onPick={(icon) => {
            const { node } = iconTarget;
            setIconTarget(null);
            updatePageIcon(node.id, icon || null)
              .then(async () => {
                if (space) await qc.invalidateQueries({ queryKey: ['page-tree', space.id] });
                qc.invalidateQueries({ queryKey: ['page-detail', node.id] });
                toast.success('已更新页面图标');
              })
              .catch((e: Error) => toast.error(`图标更新失败：${e.message}`));
          }}
        />
      )}
    </aside>
  );
}
