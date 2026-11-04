import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BookOpen, CheckSquare, ChevronDown, ChevronRight, Compass, Download,
  MoreHorizontal, Printer, Search, Share2, Trash2, Upload
} from 'lucide-react';
import { useEditorStatus } from './editorStatus';
import { SaveIndicator } from './SaveIndicator';
import { urls } from '../../nav';
import type { ModuleKey } from './TopAppSwitcher';
import type { MainRoute, Space, TreeNode, Workspace } from '../../types';

const ROUTE_LABEL: Record<MainRoute, string> = {
  home: '首页', page: '', organize: '智能整理', search: '搜索', ask: '知识问答', map: '关系图', archive: '归档中心', settings: '设置', tasks: '任务管理', nav: '常用导航'
};

// Phase C2.2 (U8): build the ancestor chain for a page from the full tree so the
// breadcrumb reflects the real parent > child hierarchy (the REST API only
// returns a single `parentPageId`, so we walk the in-memory tree instead of
// adding a backend endpoint).
function buildCrumbChain(tree: TreeNode[] | undefined, pageId: string | null): TreeNode[] {
  if (!tree || !pageId) return [];
  const byId = new Map<string, TreeNode>();
  const walk = (nodes: TreeNode[]) => { for (const n of nodes) { byId.set(n.id, n); walk(n.children); } };
  walk(tree);
  const chain: TreeNode[] = [];
  const seen = new Set<string>();
  let cur = byId.get(pageId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.parentPageId ? byId.get(cur.parentPageId) : undefined;
  }
  return chain;
}

export function TopBar({ space, spaces, route, pageId, pageTitle, module, onOpenPalette, onNavigate, onSwitchSpace, tree }: {
  workspace: Workspace | null;
  workspaces: Workspace[];
  space: Space | null;
  spaces: Space[];
  route: MainRoute;
  module?: ModuleKey;
  pageId: string | null;
  pageTitle?: string | null;
  onOpenPalette: () => void;
  onNavigate: (r: MainRoute) => void;
  onSwitchWorkspace?: (wsId: string) => void;
  onSwitchSpace?: (spId: string) => void;
  tree?: TreeNode[];
}) {
  const navigate = useNavigate();
  const { status } = useEditorStatus();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [spaceDropdown, setSpaceDropdown] = useState(false);
  const [midOpen, setMidOpen] = useState(false);
  const spDropRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!moreOpen) return;
    const onClick = (e: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [moreOpen]);

  useEffect(() => {
    if (!spaceDropdown && !midOpen) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (spDropRef.current && !spDropRef.current.contains(t)) setSpaceDropdown(false);
      if (!t.closest('.crumb-dropdown')) setMidOpen(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [spaceDropdown, midOpen]);


  const crumbTail = route === 'page' ? (pageTitle || status.pageTitle || '未命名笔记') : ROUTE_LABEL[route];

  // Phase C2.2 (U8): ancestor chain for the current page, drawn from the tree.
  const crumbChain = useMemo(
    () => (route === 'page' && pageId ? buildCrumbChain(tree, pageId) : []),
    [route, pageId, tree]
  );

  // P0-2: render a page's ancestor chain with middle-collapse. When the path
  // exceeds 3 segments we keep the first segment + the last two and fold the
  // middle into an expandable "…" dropdown so deep hierarchies stay readable.
  const renderChain = (chain: TreeNode[]) => {
    type Part = { id: string; label: string; onClick: () => void };
    const parts: Part[] = chain.map((node) => ({
      id: node.id,
      label: node.title || '未命名笔记',
      onClick: () => navigate(urls.page(node.id))
    }));
    const showAll = parts.length <= 3;
    const visible: Array<Part | '…'> = showAll
      ? parts
      : [parts[0], '…', parts[parts.length - 2], parts[parts.length - 1]];
    return (
      <>
        {visible.map((p, i) => {
          const sep = <ChevronRight size={13} className="crumb-sep" />;
          if (p === '…') {
            return (
              <Fragment key="ellipsis">
                {sep}
                <div className="crumb-dropdown">
                  <button className="crumb-link" onClick={() => setMidOpen((v) => !v)}>…</button>
                  {midOpen && (
                    <div className="crumb-pop">
                      {parts.slice(1, parts.length - 2).map((m) => (
                        <button key={m.id} className="crumb-pop-item" onClick={() => { setMidOpen(false); m.onClick(); }}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </Fragment>
            );
          }
          const isLast = i === visible.length - 1;
          return (
            <Fragment key={p.id}>
              {sep}
              {isLast ? (
                <span className="crumb-current" title={p.label}>{p.label}</span>
              ) : (
                <button className="crumb-link" title={p.label} onClick={() => p.onClick()}>{p.label}</button>
              )}
            </Fragment>
          );
        })}
      </>
    );
  };

  return (
    <header className="topbar">
      {/* Module switcher — pure client-side route switch, no API call */}
      <div className="topbar-mods" role="tablist" aria-label="模块切换">
        <button
          className={`mod-tab${module === 'kb' ? ' active' : ''}`}
          title="知识库"
          aria-label="知识库"
          onClick={() => onNavigate('home')}
        >
          <BookOpen size={18} />
        </button>
        <button
          className={`mod-tab${module === 'tasks' ? ' active' : ''}`}
          title="任务"
          aria-label="任务"
          onClick={() => onNavigate('tasks')}
        >
          <CheckSquare size={18} />
        </button>
        <button
          className={`mod-tab${module === 'nav' ? ' active' : ''}`}
          title="导航"
          aria-label="导航"
          onClick={() => onNavigate('nav')}
        >
          <Compass size={18} />
        </button>
      </div>

      <button className="palette-trigger" onClick={onOpenPalette}>
        <Search size={15} />
        <span>搜索笔记或执行命令</span>
        <kbd>⌘K</kbd>
      </button>

      {module === 'kb' && (
        <div className="crumbs">
          {route === 'page' && pageId && crumbChain.length > 0 ? (
            <>
              {space && (
                <div className="crumb-dropdown" ref={spDropRef}>
                  <button className="crumb-link" onClick={() => setSpaceDropdown((v) => !v)}>
                    {space.name} <ChevronDown size={11} />
                  </button>
                  {spaceDropdown && spaces.length > 0 && (
                    <div className="crumb-pop">
                      {spaces.map((sp) => (
                        <button key={sp.id} className={`crumb-pop-item${sp.id === space.id ? ' active' : ''}`}
                          onClick={() => { setSpaceDropdown(false); onSwitchSpace?.(sp.id); }}>
                          {sp.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {renderChain(crumbChain)}
            </>
          ) : crumbTail ? (
            <span className="crumb-current">{crumbTail}</span>
          ) : null}
        </div>
      )}

      <div className="topbar-actions">
        {status.hasPage && <SaveIndicator state={status.saveState} />}
        {status.hasPage && status.onShare && (
          <button className="ghost sm" title="分享" onClick={status.onShare}><Share2 size={15} /> 分享</button>
        )}
        {status.hasPage && (
          <div className="more-menu" ref={moreRef}>
            <button className="icon-btn" title="更多" onClick={() => setMoreOpen((o) => !o)}><MoreHorizontal size={17} /></button>
            {moreOpen && (
              <div className="more-pop">
                <button className="more-item" onClick={() => { setMoreOpen(false); status.onExport?.(); }}><Download size={14} /> 导出 Markdown</button>
                <button className="more-item" onClick={() => { setMoreOpen(false); status.onImport?.(); }}><Upload size={14} /> 导入 Markdown</button>
                <button className="more-item" onClick={() => { setMoreOpen(false); status.onPrint?.(); }}><Printer size={14} /> 打印 / 导出 PDF</button>
                <div className="more-sep" />
                <button className="more-item danger" onClick={() => { setMoreOpen(false); status.onDelete?.(); }}><Trash2 size={14} /> 删除笔记</button>
              </div>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
