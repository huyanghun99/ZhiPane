import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ChevronDown, ChevronRight, Download, Maximize2, Minimize2, Printer, Share2, Star, Trash2, Upload
} from 'lucide-react';
import { LLM_STATUS_LABEL, useEditorStatus } from './editorStatus';
import { SaveIndicator } from './SaveIndicator';
import { urls } from '../../nav';
import type { MainRoute, Space, TreeNode } from '../../types';

const ROUTE_LABEL: Record<MainRoute, string> = {
  home: '首页', page: '', organize: '智能整理', search: '搜索', ask: '知识问答',
  map: '关系图', archive: '归档中心', settings: '设置', tasks: '任务管理', nav: '常用导航'
};

// Phase C2.2 (U8): ancestor chain from the in-memory tree (the REST API only
// returns a single parentPageId). Reused here after moving crumbs out of TopBar.
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

/**
 * Always-mounted second row for the knowledge-base module. Keeping it out of
 * the header means the row never appears/disappears as pages change — the
 * "unstable buttons" the user reported. Left = breadcrumbs, right = the page
 * actions that used to live in the header and in .page-editor-head.
 */
export function KbToolbar({ space, spaces, route, pageId, pageTitle, tree, onSwitchSpace, fullWidth, onToggleFullWidth }: {
  space: Space | null;
  spaces: Space[];
  route: MainRoute;
  pageId: string | null;
  pageTitle?: string | null;
  tree?: TreeNode[];
  onSwitchSpace?: (spId: string) => void;
  fullWidth: boolean;
  onToggleFullWidth: () => void;
}) {
  const navigate = useNavigate();
  const { status } = useEditorStatus();
  const [spaceDropdown, setSpaceDropdown] = useState(false);
  const [midOpen, setMidOpen] = useState(false);
  const spDropRef = useRef<HTMLDivElement | null>(null);

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
  const crumbChain = useMemo(
    () => (route === 'page' && pageId ? buildCrumbChain(tree, pageId) : []),
    [route, pageId, tree]
  );

  // P0-2: collapse the middle of deep hierarchies into an expandable "…".
  const renderChain = (chain: TreeNode[]) => {
    type Part = { id: string; label: string; onClick: () => void };
    const parts: Part[] = chain.map((node) => ({
      id: node.id,
      label: node.title || '未命名笔记',
      onClick: () => navigate(urls.page(node.id))
    }));
    const visible: Array<Part | '…'> = parts.length <= 3
      ? parts
      : [parts[0], '…', parts[parts.length - 1]];
    return (
      <>
        {visible.map((p, i) => {
          const sep = <ChevronRight size={12} className="crumb-sep" />;
          if (p === '…') {
            return (
              <Fragment key="ellipsis">
                {sep}
                <div className="crumb-dropdown">
                  <button className="crumb-link" onClick={() => setMidOpen((v) => !v)}>…</button>
                  {midOpen && (
                    <div className="crumb-pop">
                      {parts.slice(1, parts.length - 1).map((m) => (
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
    <div className="kb-toolbar">
      <div className="crumbs">
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
        {route === 'page' && pageId && crumbChain.length > 0 ? (
          renderChain(crumbChain)
        ) : route !== 'home' && crumbTail ? (
          <>
            <ChevronRight size={12} className="crumb-sep" />
            <span className="crumb-current">{crumbTail}</span>
          </>
        ) : null}
      </div>

      <div className="kb-toolbar-actions">
        {status.hasPage && (
          <>
            <span className="kb-meta">
              {status.contentVersion !== undefined ? `v${status.contentVersion}` : ''}
              {status.llmStatus ? ` · ${LLM_STATUS_LABEL[status.llmStatus] ?? status.llmStatus}` : ''}
            </span>
            <SaveIndicator state={status.saveState} />
            <span className="kb-tool-sep" />
            <button className={`kb-tool${fullWidth ? ' active' : ''}`}
              title={fullWidth ? '退出全宽模式' : '全宽模式（正文铺满并收起右侧 AI 面板）'}
              aria-label={fullWidth ? '退出全宽模式' : '全宽模式'} onClick={onToggleFullWidth}>
              {fullWidth ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              <span className="kb-tool-label">全宽</span>
            </button>
            {/* Labels stay fixed-width (e.g. always "收藏", never "取消收藏")
                so toggling favourite cannot make the row jump. */}
            <button className={`kb-tool${status.favorite ? ' on' : ''}`} title={status.favorite ? '取消收藏' : '收藏'}
              aria-label={status.favorite ? '取消收藏' : '收藏'} onClick={() => status.onToggleFavorite?.()}>
              <Star size={14} fill={status.favorite ? 'currentColor' : 'none'} />
              <span className="kb-tool-label">收藏</span>
            </button>
            <button className="kb-tool" title="分享" aria-label="分享" onClick={() => status.onShare?.()}>
              <Share2 size={14} /><span className="kb-tool-label">分享</span>
            </button>
            <button className="kb-tool" title="导出 Markdown" aria-label="导出 Markdown" onClick={() => status.onExport?.()}>
              <Download size={14} /><span className="kb-tool-label">导出</span>
            </button>
            <button className="kb-tool kb-tool-secondary" title="导入 Markdown" aria-label="导入 Markdown" onClick={() => status.onImport?.()}>
              <Upload size={14} /><span className="kb-tool-label">导入</span>
            </button>
            <button className="kb-tool kb-tool-secondary" title="打印 / 导出 PDF" aria-label="打印 / 导出 PDF" onClick={() => status.onPrint?.()}>
              <Printer size={14} /><span className="kb-tool-label">打印</span>
            </button>
            <button className="kb-tool danger" title="删除笔记" aria-label="删除笔记" onClick={() => status.onDelete?.()}>
              <Trash2 size={14} /><span className="kb-tool-label">删除</span>
            </button>
          </>
        )}
      </div>
    </div>
  );
}
