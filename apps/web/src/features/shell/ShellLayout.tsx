import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, PanelRight } from 'lucide-react';
import { api, post } from '../../api';
import { urls, routeToUrl } from '../../nav';
import { extractText } from '../../editor/prosemirror';
import { getTheme, cycleTheme, type ThemeMode } from '../../theme';
import { CommandPalette } from '../../components/CommandPalette';
import { ShortcutsHelp } from '../../components/ShortcutsHelp';
import { Onboarding } from '../../components/Onboarding';
import { EmptyState } from '../../components/EmptyState';
import { EditorSkeleton } from '../../components/Skeleton';
import { NewPageDialog } from '../../components/NewPageDialog';
import { useToast } from '../../components/Toast';
import { useAiCompletionNotify } from '../../hooks/useAiCompletionNotify';
import { getTemplate } from '../../editor/templates';
import { TopBar } from './TopBar';
import { KnowledgeSidebar } from './KnowledgeSidebar';
import type { ModuleKey } from '../../types';
import { NavSidebar } from './NavSidebar';
import { RightPanel } from './RightPanel';
import { useShellContext, loadLastSpace } from './useShellContext';
import { HomeView } from '../home/HomeView';
import { ArchiveCenter } from './ArchiveCenter';
import { PageEditor } from '../notes/PageEditor';
import { WikiView } from '../wiki/WikiView';
import { SearchView } from '../search/SearchView';
import { AskView } from '../ask/AskView';
import { GraphView } from '../../GraphView';
import { SettingsView } from '../settings/SettingsView';
import { TasksView } from '../tasks/TasksView';
import { listProjects, listTasks, createTask, updateTask, deleteProject, createProject, updateProject, type Task, type TaskStatus, type Project } from '../tasks/api';
import { TasksSidebar, type TaskFilter } from '../tasks/components/TasksSidebar';
import { useDialog } from '../../components/Dialog';
import { NavView } from '../nav/NavView';
import type { MainRoute, PageDetail, Space, TreeNode, User, Workspace } from '../../types';

const MODULE_POSITIONS_KEY = 'zp.modulePositions';
function loadModulePositions(): Record<string, string> {
  try { return JSON.parse(sessionStorage.getItem(MODULE_POSITIONS_KEY) || '{}'); } catch { return {}; }
}

export function ShellLayout({ me }: { me: User }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  const ctx = useShellContext(me);
  const { workspaces, spaces, workspace, space, pageId, activeRoute, me: meUser } = ctx;

  const toast = useToast();
  // Phase 6: surface an "AI 已完成整理" toast when a page transitions out of
  // the pending state (client-side detection — no new backend endpoint).
  useAiCompletionNotify(space?.id);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(true);
  const [newPageOpen, setNewPageOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState<boolean>(() => {
    try { return !localStorage.getItem('ml.onboarded'); } catch { return false; }
  });

  const pathname = location.pathname;
  const isRoot = pathname === '/';
  const isSettings = pathname === '/settings';
  const isSearch = pathname === '/search';
  const wikiMatch = /^\/wiki\//.test(pathname);
  const askMatch = /^\/ask\//.test(pathname);
  const mapMatch = /^\/map\//.test(pathname);
  const spaceHomeMatch = /^\/w\/([^/]+)\/s\/([^/]+)/.test(pathname);
  const pageMatch = /^\/p\/([^/]+)/.test(pathname);
  const archiveMatch = pathname === '/archive';
  const tasksMatch = pathname === '/tasks';
  const navMatch = pathname === '/nav';

  // On-demand provisioning for accounts with no workspace yet.
  const provision = useMutation({
    mutationFn: () => post<{ workspace: Workspace; space: Space }>('/api/workspaces/provision-default', {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspaces'] });
    }
  });
  const provisionedRef = useRef(false);
  useEffect(() => {
    if (!workspaces || provisionedRef.current) return;
    if (workspaces.length > 0) {
      provisionedRef.current = true;
      return;
    }
    provisionedRef.current = true;
    provision.mutate();
  }, [workspaces, provision]);

  const logout = useMutation({
    mutationFn: () => post('/api/auth/logout', {}),
    onSuccess: () => {
      qc.clear();
      navigate(urls.home());
    }
  });

  const [theme, setTheme] = useState<ThemeMode>(() => getTheme());
  const onToggleTheme = useCallback(() => setTheme((t) => cycleTheme(t)), []);

  // Phase 6: create a page from a template (or blank). The template only
  // pre-fills contentJson — no new backend endpoint.
  const createWithTemplate = useMutation({
    mutationFn: (templateId: string) => {
      if (!space) throw new Error('未选择空间');
      const t = getTemplate(templateId);
      return post<{ page: PageDetail }>('/api/pages', {
        spaceId: space.id,
        title: t.title,
        contentJson: t.contentJson,
        textContent: extractText(t.contentJson)
      });
    },
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ['page-tree', space!.id] });
      setNewPageOpen(false);
      navigate(urls.page(res.page.id));
    },
    onError: (e: Error) => toast.error(`新建失败：${e.message}`)
  });

  // `/` → redirect to the last-visited space, else the first available space.
  const lastVisited = useMemo(() => loadLastSpace(), []);
  const validLast = useMemo(
    () => (lastVisited && workspaces.some((w) => w.id === lastVisited.workspaceId) ? lastVisited : null),
    [lastVisited, workspaces]
  );
  const { data: defaultSpaces } = useQuery<{ spaces: Space[] }>({
    queryKey: ['spaces', workspaces[0]?.id],
    enabled: isRoot && !!workspaces[0] && !validLast,
    queryFn: () => api(`/api/spaces?workspaceId=${workspaces[0]!.id}`)
  });
  useEffect(() => {
    if (!isRoot) return;
    if (validLast) {
      navigate(urls.spaceHome(validLast.workspaceId, validLast.spaceId), { replace: true });
    } else if (workspaces[0] && defaultSpaces?.spaces?.length) {
      navigate(urls.spaceHome(workspaces[0].id, defaultSpaces.spaces[0].id), { replace: true });
    }
  }, [isRoot, validLast, workspaces, defaultSpaces, navigate]);

  // Cmd/Ctrl+K opens the command palette — unless there is a live text
  // selection inside the editor, in which case Cmd+K is the "insert link"
  // shortcut and the editor handles it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        const sel = window.getSelection();
        const inEditor = !!sel && !sel.isCollapsed && !!sel.anchorNode &&
          !!(sel.anchorNode.nodeType === 1
            ? (sel.anchorNode as Element)
            : sel.anchorNode.parentElement)?.closest('.ProseMirror');
        if (inEditor) return; // editor's Mod-k opens the link editor
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Phase 6: Cmd/Ctrl+N → new page (template picker); Cmd/Ctrl+P → quick page
  // switcher (reuses the command palette, which already does title search).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'n') { e.preventDefault(); if (space) setNewPageOpen(true); }
      else if (k === 'p') { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [space]);

  // Phase C2.7 (U12): `?` opens the keyboard-shortcuts panel — unless the user
  // is typing in a field or the editor (where `?` is literal input).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || !!t.closest('.ProseMirror'))) return;
      e.preventDefault();
      setShortcutsOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Browser tab title follows the current page (deep-link friendly).
  useEffect(() => {
    if (pageId) document.title = ctx.pageTitle ? `${ctx.pageTitle} - ZhiPane` : 'ZhiPane';
    else document.title = 'ZhiPane';
  }, [pageId, ctx.pageTitle]);

  const onSelectPage = useCallback(
    (id: string) => {
      if (id) navigate(urls.page(id));
      else if (workspace && space) navigate(urls.spaceHome(workspace.id, space.id));
    },
    [navigate, workspace, space]
  );
  const onOpenPage = useCallback((id: string) => { if (id) navigate(urls.page(id)); }, [navigate]);
  const onNavigate = useCallback(
    (r: MainRoute) => navigate(routeToUrl(r, workspace?.id, space?.id)),
    [navigate, workspace, space]
  );

  // P2-2: remember the last position (URL) per module — the state is declared
  // here; the recording effect + wrapped navigator are defined after `moduleKey`.
  const [modulePositions, setModulePositions] = useState<Record<string, string>>(() => loadModulePositions());
  const onNewNote = useCallback(() => { if (space) setNewPageOpen(true); }, [space]);
  const onRunSearch = useCallback((q: string) => navigate(urls.search(q, space?.id)), [navigate, space]);
  const onPickWorkspace = useCallback(
    async (w: Workspace) => {
      const sp = await api<{ spaces: Space[] }>(`/api/spaces?workspaceId=${w.id}`);
      if (sp.spaces?.length) navigate(urls.spaceHome(w.id, sp.spaces[0].id));
      else navigate(urls.home());
    },
    [navigate]
  );
  const onPickSpace = useCallback(
    (s: Space) => {
      if (workspace) navigate(urls.spaceHome(workspace.id, s.id));
    },
    [navigate, workspace]
  );
  const onLogout = useCallback(() => logout.mutate(), [logout]);

  // R2-3: lift the task module's filter + selection to the shell so the sidebar
  // (rendered in the shell column, in parallel with the knowledge sidebar) and the
  // task workbench stay in sync, and the filter survives module switches.
  const dialog = useDialog();
  const TASK_FILTER_KEY = 'zp.taskFilter';
  const [taskFilter, setTaskFilter] = useState<TaskFilter>(() => {
    try { const v = sessionStorage.getItem(TASK_FILTER_KEY); if (v) return v as TaskFilter; } catch { /* ignore */ }
    return 'inbox';
  });
  const onTaskFilterChange = useCallback((f: TaskFilter) => {
    setTaskFilter(f);
    try { sessionStorage.setItem(TASK_FILTER_KEY, f); } catch { /* ignore */ }
  }, []);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const selectedTaskId = selectedTask?.id ?? null;
  const onSelectTask = useCallback((t: Task | null) => setSelectedTask(t), []);

  // Tasks data for the shell-level sidebar (query keys are shared with TasksView
  // so React Query dedupes the network requests).
  const tasksWsForSidebar = workspace ?? workspaces[0] ?? null;
  const sidebarTasksQ = useQuery({ queryKey: ['tasks-all', tasksWsForSidebar?.id], enabled: !!tasksWsForSidebar && activeRoute === 'tasks', queryFn: () => listTasks({}) });
  const sidebarProjectsQ = useQuery({ queryKey: ['tasks-projects', tasksWsForSidebar?.id], enabled: !!tasksWsForSidebar && activeRoute === 'tasks', queryFn: listProjects });
  const sidebarTasks = sidebarTasksQ.data?.tasks ?? [];
  const sidebarProjects = sidebarProjectsQ.data?.projects ?? [];

  const invalidateSidebar = useCallback(() => {
    const id = tasksWsForSidebar?.id;
    if (!id) return;
    qc.invalidateQueries({ queryKey: ['tasks', id] });
    qc.invalidateQueries({ queryKey: ['tasks-all', id] });
    qc.invalidateQueries({ queryKey: ['tasks-projects', id] });
  }, [qc, tasksWsForSidebar]);

  const sidebarCreateTask = useMutation({ mutationFn: (input: Partial<Task>) => createTask({ workspaceId: tasksWsForSidebar!.id, ...input }), onSuccess: invalidateSidebar, onError: (e) => toast.error(`创建失败：${(e as Error).message}`) });
  const sidebarUpdateTask = useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<Task> }) => updateTask(id, input), onSuccess: invalidateSidebar, onError: (e) => toast.error(`更新失败：${(e as Error).message}`) });
  const sidebarCreateProject = useMutation({ mutationFn: (input: Partial<Project>) => createProject(input), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks-projects', tasksWsForSidebar?.id] }), onError: (e) => toast.error(`项目创建失败：${(e as Error).message}`) });
  const sidebarUpdateProject = useMutation({ mutationFn: ({ id, input }: { id: string; input: Partial<Project> }) => updateProject(id, input), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks-projects', tasksWsForSidebar?.id] }), onError: (e) => toast.error(`项目更新失败：${(e as Error).message}`) });
  const sidebarDeleteProjectMut = useMutation({ mutationFn: (id: string) => deleteProject(id), onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks-projects', tasksWsForSidebar?.id] }), onError: (e) => toast.error(`项目删除失败：${(e as Error).message}`) });

  const sidebarAddTask = useCallback((title: string) => {
    const status: TaskStatus = (typeof taskFilter === 'string' && ['inbox', 'today', 'next', 'scheduled', 'waiting', 'someday'].includes(taskFilter)) ? (taskFilter as TaskStatus) : 'inbox';
    const projectId = typeof taskFilter === 'string' && taskFilter.startsWith('p_') ? taskFilter.slice(2) : null;
    sidebarCreateTask.mutate({ title, status, projectId });
  }, [sidebarCreateTask, taskFilter]);

  const sidebarToggleStatus = useCallback((task: Task) => {
    const done = task.status === 'done';
    sidebarUpdateTask.mutate({ id: task.id, input: done ? { status: 'inbox', progress: 0, completedAt: null } : { status: 'done', progress: 100, completedAt: new Date().toISOString() } });
  }, [sidebarUpdateTask]);

  const sidebarDeleteProjectHandler = useCallback(async (p: Project) => {
    const ok = await dialog.confirm({ title: `删除项目「${p.name}」？`, message: '相关任务将变为未分类。', confirmText: '删除', danger: true });
    if (ok) sidebarDeleteProjectMut.mutate(p.id);
  }, [dialog, sidebarDeleteProjectMut]);

  // Tree for the command palette (instant title search within the current space).
  const { data: treeData } = useQuery<{ tree: TreeNode[] }>({
    queryKey: ['page-tree', space?.id],
    enabled: !!space,
    queryFn: () => api(`/api/pages/tree?spaceId=${space!.id}`)
  });

  const renderCenter = () => {
    if (isSettings) return <SettingsView me={meUser} onLogout={onLogout} />;
    if (archiveMatch) return <ArchiveCenter space={space} workspace={workspace} onNavigate={onNavigate} />;
    if (tasksMatch) {
      // /tasks carries no workspaceId in the URL; fall back to the first
      // available workspace so the workbench can resolve its scope.
      const tasksWs = workspace ?? workspaces[0] ?? null;
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!tasksWs) return <AccessDenied />;
      return (
        <TasksView
          workspace={tasksWs}
          filter={taskFilter}
          selectedTask={selectedTask}
          onSelectTask={onSelectTask}
          onNavigate={onNavigate}
        />
      );
    }

    if (navMatch) {
      const navWs = workspace ?? workspaces[0] ?? null;
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!navWs) return <AccessDenied />;
      return <NavView workspace={navWs} />;
    }

    if (wikiMatch) {
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!space) return <AccessDenied />;
      return <WikiView space={space} onOpenPage={onOpenPage} />;
    }
    if (askMatch) {
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!workspace || !space) return <AccessDenied />;
      return <AskView workspace={workspace} space={space} onOpenPage={onOpenPage} />;
    }
    if (mapMatch) {
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!space) return <AccessDenied />;
      return <GraphView space={space} onOpenPage={onOpenPage} />;
    }
    if (isSearch) {
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!workspace || !space) return <AccessDenied />;
      const q = new URLSearchParams(location.search).get('q') ?? undefined;
      return (
        <SearchView
          workspace={workspace}
          space={space}
          spaces={spaces}
          initialQuery={q}
          onOpenPage={onOpenPage}
        />
      );
    }
    if (pageMatch) {
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!workspace || !space) return <AccessDenied />;
      return <PageEditor workspace={workspace} space={space} pageId={pageId!} onSelectPage={onSelectPage} />;
    }
    if (spaceHomeMatch) {
      if (ctx.isResolving) return <EditorSkeleton />;
      if (!workspace || !space) return <AccessDenied />;
      return (
        <HomeView
          workspace={workspace}
          space={space}
          onSelectPage={onSelectPage}
          onNavigate={onNavigate}
          onNewNote={onNewNote}
        />
      );
    }
    if (isRoot) {
      return (
        <EmptyState
          icon={<BookOpen size={40} />}
          title="选择一个空间开始"
          hint="在左侧选择或创建知识库与空间。"
        />
      );
    }
    return (
      <EmptyState
        icon={<BookOpen size={40} />}
        title="页面不存在"
        hint="返回首页或选择一个空间。"
      />
    );
  };

  const showRight = pageMatch && !!workspace && !!space;

  const moduleKey: ModuleKey =
    activeRoute === 'tasks' ? 'tasks' : activeRoute === 'nav' ? 'nav' : 'kb';

  // P2-2: remember the last position (URL) per module so switching back restores
  // where the user left off instead of "restarting" at the module root.
  useEffect(() => {
    const url = location.pathname + location.search;
    setModulePositions((prev) => {
      if (prev[moduleKey] === url) return prev;
      const next = { ...prev, [moduleKey]: url };
      try { sessionStorage.setItem(MODULE_POSITIONS_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, [moduleKey, location.pathname, location.search]);

  const MODULE_ROOT_TO_KEY: Partial<Record<MainRoute, ModuleKey>> = { home: 'kb', tasks: 'tasks', nav: 'nav' };
  const onNavigateWrapped = useCallback((r: MainRoute) => {
    const mod = MODULE_ROOT_TO_KEY[r];
    if (mod) {
      const saved = modulePositions[mod];
      const cur = location.pathname + location.search;
      if (saved && saved === cur) return;
      if (saved) { navigate(saved); return; }
    }
    onNavigate(r);
  }, [onNavigate, navigate, modulePositions, location.pathname, location.search]);


  // Redirect `/` to the resolved space (handled above); render nothing meanwhile.
  // IMPORTANT: this early return MUST come after every hook call above. Placing
  // it before `switchModule` made the `/` render call fewer hooks than the
  // non-root renders, which throws "Rendered fewer hooks than expected".
  if (isRoot && (validLast || workspaces[0])) {
    // The effect navigates away; avoid a flash of the landing state.
    if (validLast) return null;
    if (workspaces[0] && defaultSpaces?.spaces?.length) return null;
  }

  return (
    <div className="app-shell-3">
      <TopBar
        space={space}
        spaces={spaces ?? []}
        route={activeRoute}
        module={moduleKey}
        pageId={pageId}
        pageTitle={ctx.pageTitle}
        tree={treeData?.tree ?? []}
        onOpenPalette={() => setPaletteOpen(true)}
        onNavigate={onNavigateWrapped}
        onSwitchSpace={(spId) => { const sp = spaces?.find((s) => s.id === spId); if (sp) onPickSpace(sp); }}
        me={meUser}
        theme={theme}
        onToggleTheme={onToggleTheme}
        onLogout={onLogout}
      />

      <div className="shell-body">
        {moduleKey === 'kb' && (
          <KnowledgeSidebar
            workspace={workspace}
            workspaces={workspaces}
            space={space}
            spaces={spaces}
            route={activeRoute}
            selectedPageId={pageId}
            onPickWorkspace={onPickWorkspace}
            onPickSpace={onPickSpace}
            onSelectPage={onSelectPage}
            onNavigate={onNavigate}
            onNewNote={onNewNote}
          />
        )}
        {moduleKey === 'tasks' && tasksWsForSidebar && (
          <TasksSidebar
            tasks={sidebarTasks}
            projects={sidebarProjects}
            filter={taskFilter}
            onFilterChange={onTaskFilterChange}
            onAddTask={sidebarAddTask}
            onSelectTask={onSelectTask}
            onToggleStatus={sidebarToggleStatus}
            onAddProject={(name, color) => sidebarCreateProject.mutate({ name, color })}
            onUpdateProject={(id, updates) => sidebarUpdateProject.mutate({ id, input: updates })}
            onDeleteProject={sidebarDeleteProjectHandler}
            selectedTaskId={selectedTaskId}
          />
        )}
        {moduleKey === 'nav' && (
          <NavSidebar workspace={workspace} />
        )}

        <div className="main-col">
          <div className="center-and-right">
            <div className="center">{renderCenter()}</div>

            {showRight && (
              <>
                <div className={`right-region${rightOpen ? '' : ' collapsed'}`}>
                  <RightPanel
                    workspace={workspace!}
                    space={space!}
                    pageId={pageId!}
                    onOpenPage={onOpenPage}
                    onClose={() => setRightOpen(false)}
                  />
                </div>
                {!rightOpen && (
                  <button
                    className="right-reopen"
                    title="展开侧栏"
                    onClick={() => setRightOpen(true)}
                  >
                    <PanelRight size={16} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        tree={treeData?.tree ?? []}
        onSelectPage={onSelectPage}
        onNavigate={onNavigate}
        onNewNote={onNewNote}
        onRunSearch={onRunSearch}
        workspaceId={workspace?.id ?? ''}
        spaceId={space?.id}
      />

      {newPageOpen && (
        <NewPageDialog
          onClose={() => setNewPageOpen(false)}
          onCreate={(id) => createWithTemplate.mutate(id)}
        />
      )}

      <ShortcutsHelp open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      {showOnboarding && <Onboarding onClose={() => setShowOnboarding(false)} />}
    </div>
  );
}

function AccessDenied() {
  return (
    <EmptyState
      icon={<BookOpen size={40} />}
      title="空间不存在或无权访问"
      hint="它可能已被删除，或你当前的账号无权访问。请返回首页或选择一个空间。"
    />
  );
}
