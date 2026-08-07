import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Check, ChevronDown, ChevronRight, Download, Loader2, MoreHorizontal,
  Printer, Search, Settings, Share2, Trash2, Upload
} from 'lucide-react';
import { useEditorStatus } from './editorStatus';
import { SaveIndicator } from './SaveIndicator';
import { urls } from '../../nav';
import type { MainRoute, Space, TreeNode, Workspace } from '../../types';

const ROUTE_LABEL: Record<MainRoute, string> = {
  home: '首页', page: '', organize: '智能整理', search: '搜索', ask: '知识问答', map: '关系图', archive: '归档中心', tasks: '任务管理', nav: '常用导航'
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

export function TopBar({ workspace, workspaces, space, spaces, route, pageId, pageTitle, onOpenPalette, onSwitchWorkspace, onSwitchSpace, tree }: {
  workspace: Workspace | null;
  workspaces: Workspace[];
  space: Space | null;
  spaces: Space[];
  route: MainRoute;
  pageId: string | null;
  pageTitle?: string | null;
  onOpenPalette: () => void;
  onSwitchWorkspace?: (wsId: string) => void;
  onSwitchSpace?: (spId: string) => void;
  tree?: TreeNode[];
}) {
  const navigate = useNavigate();
  const { status } = useEditorStatus();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const [wsDropdown, setWsDropdown] = useState(false);
  const [spaceDropdown, setSpaceDropdown] = useState(false);
  const wsDropRef = useRef<HTMLDivElement | null>(null);
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
    if (!wsDropdown && !spaceDropdown) return;
    const onClick = (e: MouseEvent) => {
      if (wsDropRef.current && !wsDropRef.current.contains(e.target as Node)) setWsDropdown(false);
      if (spDropRef.current && !spDropRef.current.contains(e.target as Node)) setSpaceDropdown(false);
    };
    window.addEventListener('mousedown', onClick);
    return () => window.removeEventListener('mousedown', onClick);
  }, [wsDropdown, spaceDropdown]);


  const crumbTail = route === 'page' ? (pageTitle || status.pageTitle || '未命名笔记') : ROUTE_LABEL[route];

  // Phase C2.2 (U8): ancestor chain for the current page, drawn from the tree.
  const crumbChain = useMemo(
    () => (route === 'page' && pageId ? buildCrumbChain(tree, pageId) : []),
    [route, pageId, tree]
  );

  return (
    <header className="topbar">
      <div className="crumbs">
        {/* Workspace — clickable + dropdown */}
        <div className="crumb-dropdown" ref={wsDropRef}>
          <button className="crumb-link" onClick={() => setWsDropdown((v) => !v)}>
            {workspace?.name ?? '知识库'} <ChevronDown size={11} />
          </button>
          {wsDropdown && onSwitchWorkspace && (
            <div className="crumb-pop">
              {workspaces.map((ws) => (
                <button key={ws.id} className={`crumb-pop-item${ws.id === workspace?.id ? ' active' : ''}`}
                  onClick={() => { setWsDropdown(false); onSwitchWorkspace?.(ws.id); }}>
                  {ws.name}
                </button>
              ))}
              <div className="crumb-pop-sep" />
              <button className="crumb-pop-item" onClick={() => { setWsDropdown(false); navigate(urls.settings()); }}>
                <Settings size={13} /> 知识库设置
              </button>
            </div>
          )}
        </div>

        {/* Space — clickable + dropdown */}
        {space && (
          <>
            <ChevronRight size={13} className="crumb-sep" />
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
                  <div className="crumb-pop-sep" />
                  <button className="crumb-pop-item" onClick={() => { setSpaceDropdown(false); navigate(urls.settings()); }}>
                    <Settings size={13} /> 空间设置
                  </button>
                </div>
              )}
            </div>
          </>
        )}

        {/* Page hierarchy — when we have a tree, render the full ancestor chain */}
        {route === 'page' && pageId && crumbChain.length > 0 ? (
          crumbChain.map((node, i) => {
            const isLast = i === crumbChain.length - 1;
            const label = node.title || '未命名笔记';
            return (
              <Fragment key={node.id}>
                <ChevronRight size={13} className="crumb-sep" />
                {isLast ? (
                  <span className="crumb-current" title={label}>{label}</span>
                ) : (
                  <button className="crumb-link" title={label} onClick={() => navigate(urls.page(node.id))}>
                    {label}
                  </button>
                )}
              </Fragment>
            );
          })
        ) : crumbTail ? (
          <>
            <ChevronRight size={13} className="crumb-sep" />
            {route === 'page' && pageId ? (
              <button className="crumb-link crumb-current" onClick={() => navigate(urls.page(pageId))}>
                {crumbTail}
              </button>
            ) : (
              <span className="crumb-current">{crumbTail}</span>
            )}
          </>
        ) : null}
      </div>

      <button className="palette-trigger" onClick={onOpenPalette}>
        <Search size={15} />
        <span>搜索笔记或执行命令</span>
        <kbd>⌘K</kbd>
      </button>

      <div className="topbar-actions">
        {status.hasPage && <SaveIndicator state={status.saveState} />}
        {status.hasPage && status.onSave && (
          <button className="primary sm" disabled={status.saveState === 'saved' || status.saveState === 'saving'} onClick={status.onSave}>
            {status.saveState === 'saving' ? <Loader2 className="spin" size={14} /> : <Check size={14} />} 保存
          </button>
        )}
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
