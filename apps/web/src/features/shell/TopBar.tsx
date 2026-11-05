import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen, CheckSquare, ChevronDown, Compass, LogOut, Monitor, Moon,
  Pencil, Plus, Search, Settings, Settings2, Sparkles, Sun, Trash2
} from 'lucide-react';
import { del, patch, post } from '../../api';
import { useDialog } from '../../components/Dialog';
import { useToast } from '../../components/Toast';
import { urls } from '../../nav';
import type { ModuleKey, MainRoute, User, Workspace } from '../../types';
import type { ThemeMode } from '../../theme';

/**
 * Global header. Only module-stable chrome lives here: brand + knowledge-base
 * picker (left), module switch + palette + user menu (right). Per-page crumbs
 * and document actions moved to the always-mounted KbToolbar below so they no
 * longer appear/disappear as the user switches pages.
 */
export function TopBar({ module, workspace, workspaces, onPickWorkspace, onOpenKbSettings, onOpenPalette, onNavigate, me, theme, onToggleTheme, onLogout }: {
  module?: ModuleKey;
  workspace: Workspace | null;
  workspaces: Workspace[];
  onPickWorkspace: (w: Workspace) => void;
  onOpenKbSettings?: () => void;
  onOpenPalette: () => void;
  onNavigate: (r: MainRoute) => void;
  me?: User;
  theme?: ThemeMode;
  onToggleTheme?: () => void;
  onLogout?: () => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const dialog = useDialog();

  const [wsOpen, setWsOpen] = useState(false);
  const [wsName, setWsName] = useState('');
  const [userOpen, setUserOpen] = useState(false);
  const wsRef = useRef<HTMLDivElement | null>(null);
  const userRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!wsOpen && !userOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wsRef.current && !wsRef.current.contains(t)) setWsOpen(false);
      if (userRef.current && !userRef.current.contains(t)) setUserOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [wsOpen, userOpen]);

  // Workspace CRUD moved here together with the picker (was in KnowledgeSidebar).
  const createWs = useMutation({
    mutationFn: () => post<{ workspace: Workspace }>('/api/workspaces', { name: wsName || '我的知识库' }),
    onSuccess: async (r) => {
      setWsName(''); setWsOpen(false);
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      onPickWorkspace(r.workspace);
      toast.success('已创建知识库');
    },
    onError: (e: Error) => toast.error(`创建失败：${e.message}`)
  });
  const renameWs = useMutation({
    mutationFn: (name: string) => patch(`/api/workspaces/${workspace!.id}`, { name }),
    onSuccess: async (_r, name) => {
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      onPickWorkspace({ ...workspace!, name });
    },
    onError: (e: Error) => toast.error(`重命名失败：${e.message}`)
  });
  const deleteWs = useMutation({
    mutationFn: () => del(`/api/workspaces/${workspace!.id}`),
    onSuccess: async () => {
      setWsOpen(false);
      await qc.invalidateQueries({ queryKey: ['workspaces'] });
      onNavigate('home');
      toast.success('已删除知识库');
    },
    onError: (e: Error) => toast.error(`删除失败：${e.message}`)
  });

  const askRenameWs = async () => {
    if (!workspace) return;
    const next = await dialog.prompt({
      title: '重命名知识库', defaultValue: workspace.name,
      placeholder: '输入新名称', confirmText: '保存'
    });
    if (next && next !== workspace.name) renameWs.mutate(next);
  };
  const askDeleteWs = async () => {
    if (!workspace) return;
    const ok = await dialog.confirm({
      title: `删除知识库「${workspace.name}」？`,
      message: '其中所有空间与笔记都会被删除，此操作不可撤销。',
      confirmText: '删除', danger: true
    });
    if (ok) deleteWs.mutate();
  };

  return (
    <header className="topbar">
      {/* Three-zone header: brand + knowledge-base picker on the left, search
          pinned in the centre, module switch + user menu on the right. */}
      <div className="topbar-left">
        <div className="topbar-brand">
          <span className="topbar-logo" title="ZhiPane 知行台"><Sparkles size={18} /></span>
          <span className="topbar-brand-name">知行台</span>
        </div>

        {/* Knowledge-base-level settings lives next to the picker; /settings is global. */}
        {module === 'kb' && (
          <button className="ws-settings-btn" title="知识库设置" aria-label="知识库设置" onClick={() => onOpenKbSettings?.()}>
            <Settings2 size={15} />
          </button>
        )}
        {/* The knowledge-base picker only makes sense in the kb module. */}
        {module === 'kb' && (
          <div className="topbar-ws" ref={wsRef}>
            <button className="topbar-ws-trigger" onClick={() => setWsOpen((v) => !v)}>
              <BookOpen size={14} />
              <span>{workspace?.name ?? '选择知识库'}</span>
              <ChevronDown size={12} />
            </button>
            {wsOpen && (
              <div className="ws-pop">
                {workspaces.map((w) => (
                  <button key={w.id} className={`ws-pop-item${workspace?.id === w.id ? ' active' : ''}`}
                    onClick={() => { onPickWorkspace(w); setWsOpen(false); }}>
                    <BookOpen size={14} /> {w.name}
                  </button>
                ))}
                {workspace && (
                  <div className="ws-pop-row">
                    <button className="ws-mini" onClick={askRenameWs}><Pencil size={12} /> 重命名</button>
                    <button className="ws-mini danger" onClick={askDeleteWs}><Trash2 size={12} /> 删除</button>
                  </div>
                )}
                <div className="ws-new">
                  <input value={wsName} placeholder="新建知识库"
                    onChange={(e) => setWsName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') createWs.mutate(); }} />
                  <button className="icon-btn" title="创建" onClick={() => createWs.mutate()}><Plus size={14} /></button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      <button className="palette-trigger" onClick={onOpenPalette}>
        <Search size={15} />
        <span>搜索笔记或执行命令</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="topbar-right">
        <div className="topbar-mods" role="tablist" aria-label="模块切换">
          <button className={`mod-tab${module === 'kb' ? ' active' : ''}`} title="知识库" aria-label="知识库" onClick={() => onNavigate('home')}>
            <BookOpen size={18} />
          </button>
          <button className={`mod-tab${module === 'tasks' ? ' active' : ''}`} title="任务" aria-label="任务" onClick={() => onNavigate('tasks')}>
            <CheckSquare size={18} />
          </button>
          <button className={`mod-tab${module === 'nav' ? ' active' : ''}`} title="导航" aria-label="导航" onClick={() => onNavigate('nav')}>
            <Compass size={18} />
          </button>
        </div>

        <div className="topbar-actions">
          <div className="more-menu" ref={userRef}>
            <button className="avatar-trigger" onClick={() => setUserOpen((v) => !v)}>
              {(me?.name ?? 'U').slice(0, 1).toUpperCase()}
            </button>
            {userOpen && (
              <div className="more-pop">
                <div className="more-item" style={{ cursor: 'default', color: 'var(--muted)' }}>{me?.name}</div>
                <div className="more-sep" />
                <button className="more-item" onClick={onToggleTheme}>
                  {theme === 'dark' ? <Sun size={14} /> : theme === 'light' ? <Moon size={14} /> : <Monitor size={14} />}
                  {' '}主题：{theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}
                </button>
                <button className="more-item" onClick={() => navigate(urls.settings())}><Settings size={14} /> 全局设置</button>
                <div className="more-sep" />
                <button className="more-item danger" onClick={onLogout}><LogOut size={14} /> 退出登录</button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
