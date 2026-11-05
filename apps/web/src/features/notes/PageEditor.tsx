import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCw } from 'lucide-react';
import { api, post, put } from '../../api';
import { ApiError } from '../../api';
import { ImportModal } from '../../ImportModal';
import { ShareModal } from '../../ShareModal';
import { RichEditor } from '../../editor/RichEditor';
import { emptyDoc, extractText, type PMNode } from '../../editor/prosemirror';
import { EditorSkeleton } from '../../components/Skeleton';
import { ErrorState } from '../../components/ErrorState';
import { useToast } from '../../components/Toast';
import { useDialog } from '../../components/Dialog';
import { useFavorites } from '../../hooks/useFavorites';
import { useEditorStatus, type SaveState } from '../shell/editorStatus';
import { PageIconPicker } from '../../components/PageIconPicker';
import { useDeletePage } from './useDeletePage';
import { loadDraft, saveDraft, clearDraft, draftEquals, type LocalDraft } from '../../editor/draft';
import { consumePendingScroll, scrollEditorToText } from '../../editor/scrollTo';
import { ConflictModal } from './ConflictModal';
import type { PageDetail, Space, TreeNode, Workspace } from '../../types';

/**
 * Center-column document editor (Phase 3 + Phase 4).
 *
 * Phase 4 adds:
 *  - local draft recovery (debounced mirror to localStorage; a recovery
 *    banner when a draft diverges from the server version)
 *  - a proper version-conflict recovery UI (ConflictModal) instead of a
 *    bare confirm()
 *
 * To never clobber in-progress edits, the editor is seeded from a
 * `seed` state (not the live `doc` buffer). External reloads (page
 * switch, draft recovery, conflict resolution) bump a remount key so the
 * editor re-initialises from the new seed; autosave only touches the
 * live buffer and never resets the editor.
 */
export function PageEditor({ workspace, space, pageId, onSelectPage }: {
  workspace: Workspace;
  space: Space;
  pageId: string;
  onSelectPage: (id: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();
  const { setStatus } = useEditorStatus();
  const { isFavorite, toggle: toggleFavorite } = useFavorites();

  const { data, isLoading, isError, error, refetch } = useQuery<{ page: PageDetail }>({
    queryKey: ['page-detail', pageId],
    staleTime: 0,
    refetchOnWindowFocus: false,
    queryFn: () => api(`/api/pages/${pageId}`)
  });
  const page = data?.page ?? null;

  const [pageIcon, setPageIcon] = useState<string>(page?.icon ?? '');
  const pageIconRef = useRef(pageIcon);
  pageIconRef.current = pageIcon;
  const [iconAnchor, setIconAnchor] = useState<{ x: number; y: number } | null>(null);
  const [title, setTitle] = useState('');
  const [doc, setDoc] = useState<PMNode>(emptyDoc);
  const [seed, setSeed] = useState<PMNode>(emptyDoc);
  const [ek, setEk] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [pendingDraft, setPendingDraft] = useState<LocalDraft | null>(null);
  const [conflict, setConflict] = useState<{
    serverVersion: number; serverTitle?: string; serverText?: string; serverDoc: PMNode;
  } | null>(null);

  // Latest-value refs so the (stable) save closures never read stale state.
  const titleRef = useRef(title); titleRef.current = title;
  const docRef = useRef<PMNode>(emptyDoc);
  const pageRef = useRef(page); pageRef.current = page;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;

  const syncFromServer = useCallback((p: PageDetail, remount: boolean) => {
    const content = (p.contentJson && Object.keys(p.contentJson).length ? p.contentJson : emptyDoc) as PMNode;
    setTitle(p.title ?? '');
    setDoc(content);
    docRef.current = content;
    setSeed(content);
    setDirty(false);
    if (remount) setEk((k) => k + 1);
  }, []);

  // Load / switch page: seed the editor and check for a recoverable draft.
  useEffect(() => {
    if (!page) return;
    syncFromServer(page, true);
    const d = loadDraft(page.id);
    if (d && !draftEquals(d, page.title ?? '', page.contentJson)) {
      setPendingDraft(d);
    } else {
      setPendingDraft(null);
      if (d) saveDraft(page.id, { title: page.title ?? '', doc: page.contentJson, savedAt: Date.now() });
    }
  }, [page?.id]);

  // Mirror edits to localStorage (debounced) so a refresh never loses work.
  useEffect(() => {
    if (!dirty || !page) return;
    const t = window.setTimeout(() => {
      saveDraft(page.id, { title: titleRef.current, doc: docRef.current, savedAt: Date.now() });
    }, 800);
    return () => window.clearTimeout(t);
  }, [dirty, title, doc, page?.id]);

  // When a citation click requests a scroll to a specific chunk, jump to it
  // once the editor content is mounted. Retries briefly while the doc loads.
  const scrolledRef = useRef<number>(-1);
  useEffect(() => {
    const text = consumePendingScroll();
    if (!text || scrolledRef.current === ek) return;
    scrolledRef.current = ek;
    const tryScroll = (attempt: number) => {
      const root = document.querySelector('.editor-content') as HTMLElement | null;
      if (scrollEditorToText(root, text)) return;
      if (attempt < 5) window.setTimeout(() => tryScroll(attempt + 1), 300);
    };
    tryScroll(0);
  }, [ek]);

  const patchTreeNode = useCallback((p: PageDetail) => {
    qc.setQueryData<{ tree: TreeNode[] }>(['page-tree', space.id], (old) => {
      if (!old) return old;
      const walk = (nodes: TreeNode[]): TreeNode[] =>
        nodes.map((n) =>
          n.id === p.id
            ? { ...n, title: p.title, llmProcessStatus: p.llmProcessStatus }
            : { ...n, children: walk(n.children) }
        );
      return { tree: walk(old.tree) };
    });
    qc.setQueryData<{ page: PageDetail }>(['page-detail', p.id], (old) =>
      old ? { page: { ...old.page, title: p.title, contentJson: p.contentJson, contentVersion: p.contentVersion, llmProcessStatus: p.llmProcessStatus } } : old
    );
  }, [qc, space.id]);

  const doSave = useCallback((autosave: boolean) => {
    const p = pageRef.current;
    if (!p) return Promise.reject(new Error('未选择页面'));
    return put<{ page: PageDetail }>(`/api/pages/${p.id}`, {
      title: titleRef.current || '未命名笔记',
      icon: pageIconRef.current || null,
      contentJson: docRef.current,
      textContent: extractText(docRef.current),
      contentVersion: p.contentVersion,
      autosave
    });
  }, []);

  const showConflict = useCallback(async (serverVersion: number) => {
    let server: PageDetail | undefined;
    try {
      server = (await api<{ page: PageDetail }>(`/api/pages/${pageRef.current?.id}`)).page;
    } catch {
      server = undefined;
    }
    setConflict({
      serverVersion,
      serverTitle: server?.title,
      serverText: server?.textContent,
      serverDoc: (server?.contentJson && Object.keys(server.contentJson).length ? server.contentJson : emptyDoc) as PMNode
    });
  }, []);

  const handleSaveError = useCallback((e: unknown) => {
    const err = e as ApiError;
    const data = err?.data as { serverVersion?: number } | undefined;
    if ((err?.status === 409 || (err?.message ?? '').includes('conflict') || (err?.message ?? '').includes('Version')) && data && typeof data.serverVersion === 'number') {
      void showConflict(data.serverVersion);
    } else {
      toast.error(`保存失败：${err?.message ?? '未知错误'}`);
    }
  }, [showConflict, toast]);

  // saveNow is defined after `autoSave` (below) so it can close over it.

  const autoSave = useMutation({
    mutationFn: () => doSave(true),
    onSuccess: (res) => {
      setDirty(false);
      patchTreeNode(res.page);
      saveDraft(res.page.id, { title: res.page.title, doc: res.page.contentJson, savedAt: Date.now() });
    },
    onError: handleSaveError
  });

  // "立即同步" — force a save right now (save button / Ctrl-S / blur / unload
  // flush). Reuses the same autoSave pipeline; saving is automatic, this just
  // bypasses the debounce timer.
  const saveNow = useCallback(() => {
    if (dirtyRef.current && !autoSave.isPending) autoSave.mutate();
  }, [autoSave]);

  const savingRef = useRef(false);
  useEffect(() => { savingRef.current = autoSave.isPending; }, [autoSave.isPending]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dirty || !page) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      if (!savingRef.current) autoSave.mutate();
    }, 2000);
    return () => { if (autosaveTimer.current) clearTimeout(autosaveTimer.current); };
  }, [dirty, title, page?.id, autoSave]);

  // Flush on blur / tab hidden / unload so work is never lost even if the 2s
  // debounce hasn't fired. (The 800ms localStorage draft is the ultimate safety
  // net; this just keeps the server copy fresher.)
  useEffect(() => {
    const flush = () => { if (dirtyRef.current && !autoSave.isPending) autoSave.mutate(); };
    const onVis = () => { if (document.visibilityState === 'hidden') flush(); };
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', flush);
    };
  }, [autoSave]);

  // Ctrl/Cmd+S → immediate sync.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveNow();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [saveNow]);

  const exportPage = useCallback(async () => {
    if (!page) return;
    try {
      const res = await post<{ markdown: string; title: string }>(`/api/export/page/${page.id}`, {});
      const blob = new Blob([res.markdown], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${res.title || 'note'}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(`导出失败：${(e as Error).message}`);
    }
  }, [page, toast]);

  const deletePage = useDeletePage(space, (id) => { if (id === pageId) onSelectPage(''); });
  const requestDelete = useCallback(async () => {
    if (!page) return;
    const ok = await dialog.confirm({
      title: '删除这篇笔记？',
      message: '删除后可在提示中撤销。',
      confirmText: '删除',
      danger: true
    });
    if (ok) deletePage({ id: page.id, title });
  }, [page, title, dialog, deletePage]);

  // ---- Draft recovery ----
  const recoverDraft = useCallback(() => {
    const d = pendingDraft;
    if (!d) return;
    setSeed(d.doc as PMNode);
    setTitle(d.title);
    setDoc(d.doc as PMNode);
    setDirty(true);
    setEk((k) => k + 1);
    setPendingDraft(null);
  }, [pendingDraft]);

  const discardDraft = useCallback(() => {
    if (pageRef.current) clearDraft(pageRef.current.id);
    setPendingDraft(null);
  }, []);

  // ---- Conflict resolution ----
  const keepMine = useCallback(async () => {
    const c = conflict;
    if (!c) return;
    try {
      const res = await put<{ page: PageDetail }>(`/api/pages/${pageRef.current?.id}`, {
        title: titleRef.current,
        contentJson: docRef.current,
        textContent: extractText(docRef.current),
        contentVersion: c.serverVersion,
        autosave: false
      });
      const p = res.page;
      syncFromServer(p, true);
      saveDraft(p.id, { title: p.title, doc: p.contentJson, savedAt: Date.now() });
      patchTreeNode(p);
      toast.success('已用本地版本覆盖');
    } catch (e) {
      toast.error(`覆盖失败：${(e as Error).message}`);
    } finally {
      setConflict(null);
    }
  }, [conflict, patchTreeNode, toast, syncFromServer]);

  const useTheirs = useCallback(() => {
    const c = conflict;
    if (!c) return;
    syncFromServer(
      { ...(pageRef.current as PageDetail), title: c.serverTitle ?? '', contentJson: c.serverDoc, contentVersion: c.serverVersion } as PageDetail,
      true
    );
    saveDraft(pageRef.current!.id, { title: c.serverTitle ?? '', doc: c.serverDoc, savedAt: Date.now() });
    setConflict(null);
  }, [conflict, syncFromServer]);

  const saveCopy = useCallback(async () => {
    try {
      const res = await post<{ page: PageDetail }>('/api/pages', {
        spaceId: space.id,
        title: `${titleRef.current || '未命名笔记'}（副本）`,
        contentJson: docRef.current,
        textContent: extractText(docRef.current)
      });
      if (pageRef.current) clearDraft(pageRef.current.id);
      await qc.invalidateQueries({ queryKey: ['page-tree', space.id] });
      toast.success('已另存为副本');
      setConflict(null);
      onSelectPage(res.page.id);
    } catch (e) {
      toast.error(`另存失败：${(e as Error).message}`);
    }
  }, [space.id, qc, toast, onSelectPage]);

  // Publish save state + actions to the top bar.
  const saving = autoSave.isPending;
  const saveState: SaveState = conflict
    ? 'conflict'
    : autoSave.isError
    ? 'error'
    : saving ? 'saving' : dirty ? 'dirty' : page ? 'saved' : 'idle';
  // Keep the latest action callbacks in a ref so the publishing effect below
  // can subscribe only to stable primitives (page?.id / saveState / setStatus).
  // Without this, callbacks such as `requestDelete` (rebuilt every render because
  // useDeletePage captures a fresh inline arrow) would change on every render,
  // re-running this effect every render → setStatus mutates the editorStatus
  // context → every consumer re-renders → an infinite loop that pegs the CPU
  // (React 19 does not trip the max-depth guard for setState inside a passive effect).
  const actionsRef = useRef({
    onSave: () => {},
    onShare: () => {},
    onExport: () => {},
    onImport: () => {},
    onDelete: () => {},
    onPrint: () => {},
    onToggleFavorite: () => {}
  });
  const fav = page ? isFavorite(page.id) : false;
  actionsRef.current = {
    onSave: () => saveNow(),
    onShare: () => setShowShare(true),
    onExport: () => { void exportPage(); },
    onImport: () => setShowImport(true),
    onDelete: () => { void requestDelete(); },
    onPrint: () => window.print(),
    onToggleFavorite: () => {
      if (!page) return;
      const now = toggleFavorite(page.id);
      toast.success(now ? '已加入收藏' : '已取消收藏');
    }
  };

  // Publish everything the always-mounted kb toolbar needs. The effect only
  // depends on primitives so it cannot re-run on every render (see note above).
  useEffect(() => {
    setStatus({
      hasPage: !!page,
      saveState,
      pageTitle: title,
      pageId: page?.id,
      contentVersion: page?.contentVersion,
      llmStatus: page?.llmProcessStatus,
      favorite: fav,
      onSave: () => actionsRef.current.onSave(),
      onShare: () => actionsRef.current.onShare(),
      onExport: () => actionsRef.current.onExport(),
      onImport: () => actionsRef.current.onImport(),
      onDelete: () => actionsRef.current.onDelete(),
      onPrint: () => actionsRef.current.onPrint(),
      onToggleFavorite: () => actionsRef.current.onToggleFavorite()
    });
  }, [page?.id, page?.contentVersion, page?.llmProcessStatus, title, saveState, fav, setStatus]);

  // Clear the toolbar status when this editor unmounts (page switch / close).
  useEffect(() => () => setStatus({ hasPage: false, saveState: 'idle' }), [setStatus]);

  if (isLoading && !page) return <EditorSkeleton />;
  if (isError) return <ErrorState message={(error as Error)?.message} onRetry={() => refetch()} />;
  if (!page) return null;

  return (
    <div className="page-editor">
      {pendingDraft && (
        <div className="draft-banner">
          <span className="draft-info">
            <RotateCw size={14} />
            检测到未保存的本地草稿（{new Date(pendingDraft.savedAt).toLocaleString()}），是否恢复？
          </span>
          <div className="draft-actions">
            <button className="primary sm" onClick={recoverDraft}>恢复草稿</button>
            <button className="ghost sm" onClick={discardDraft}>丢弃</button>
          </div>
        </div>
      )}

      {/* Version / LLM status / save / favourite now live in the always-mounted
          KbToolbar, so switching pages no longer makes these controls jump. */}
      <div className="page-title-row">
        <button
          className="page-icon-btn"
          title="选择页面图标"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setIconAnchor((prev) => prev ? null : { x: r.left, y: r.bottom + 4 });
          }}
        >
          {pageIcon || '📄'}
        </button>
        {iconAnchor && (
          <PageIconPicker
            anchor={iconAnchor}
            current={pageIcon}
            onClose={() => setIconAnchor(null)}
            onPick={(icon) => {
              setPageIcon(icon ?? '');
              setIconAnchor(null);
              setDirty(true);
            }}
          />
        )}
        <input
          className="title-input"
          value={title}
          placeholder="无标题笔记"
          onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            const pm = document.querySelector('.editor-content .ProseMirror') as HTMLElement | null;
            pm?.focus();
          }
        }}
        />
      </div>
      <RichEditor
        key={`${page.id}:${ek}`}
        content={seed}
        workspaceId={workspace.id}
        spaceId={space.id}
        pageId={page.id}
        onChange={({ contentJson }) => { docRef.current = contentJson; setDirty(true); }}
        onSave={() => saveNow()}
      />

      {conflict && (
        <ConflictModal
          serverVersion={conflict.serverVersion}
          myTitle={title}
          myText={page?.textContent}
          serverTitle={conflict.serverTitle}
          serverText={conflict.serverText}
          onKeepMine={keepMine}
          onUseTheirs={useTheirs}
          onSaveCopy={saveCopy}
          onCancel={() => setConflict(null)}
        />
      )}

      {showImport && (
        <ImportModal workspaceId={workspace.id} spaceId={space.id} spaceName={space.name}
          onClose={() => setShowImport(false)} onImported={(id) => onSelectPage(id)} />
      )}
      {showShare && (
        <ShareModal workspaceId={workspace.id} targetType="page" targetId={page.id} targetTitle={title}
          onClose={() => setShowShare(false)} />
      )}
    </div>
  );
}
