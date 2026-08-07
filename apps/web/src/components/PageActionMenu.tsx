import { useEffect, useRef } from 'react';
import {
  Copy, Download, FileText, FilePlus, FolderInput, Share2, Trash2, Pencil
} from 'lucide-react';
import type { TreeNode } from '../types';

export type PageAction = 'rename' | 'move' | 'copy' | 'share' | 'export' | 'delete' | 'createChild';

/**
 * Floating page action menu (Phase 6 — task 3).
 *
 * Opened by right-clicking a tree row or clicking its "⋯" button. Renders a
 * positioned popover with the full page-operation set; the parent owns the
 * actual behaviour so this stays a pure presentation surface.
 */
export function PageActionMenu({
  page,
  x,
  y,
  onAction,
  onClose
}: {
  page: TreeNode;
  x: number;
  y: number;
  onAction: (action: PageAction, page: TreeNode) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
    };
  }, [onClose]);

  // Keep the menu on-screen.
  const left = Math.min(x, window.innerWidth - 210);
  const top = Math.min(y, window.innerHeight - 260);

  const item = (action: PageAction, icon: React.ReactNode, label: string, danger = false) => (
    <button
      className={`ctx-item${danger ? ' danger' : ''}`}
      onClick={() => { onAction(action, page); onClose(); }}
    >
      {icon}<span>{label}</span>
    </button>
  );

  return (
    <div ref={ref} className="ctx-menu" style={{ left, top }} role="menu">
      {item('createChild', <FilePlus size={14} />, '创建子页面')}
      {item('rename', <Pencil size={14} />, '重命名')}
      {item('move', <FolderInput size={14} />, '移动到')}
      {item('copy', <Copy size={14} />, '复制')}
      {item('share', <Share2 size={14} />, '分享')}
      {item('export', <Download size={14} />, '导出 Markdown')}
      <div className="ctx-sep" />
      {item('delete', <Trash2 size={14} />, '删除', true)}
    </div>
  );
}

/** "移动到" target picker (Phase 6 — task 3). */
export function MovePageDialog({
  page,
  tree,
  onClose,
  onMove
}: {
  page: TreeNode;
  tree: TreeNode[];
  onClose: () => void;
  onMove: (parentPageId: string | null) => void;
}) {
  // Collect descendants of `page` so we can't move it into its own subtree.
  const banned = new Set<string>([page.id]);
  const collect = (nodes: TreeNode[]) => {
    for (const n of nodes) { banned.add(n.id); collect(n.children); }
  };
  collect(page.children);

  const flat: { node: TreeNode; depth: number }[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      if (!banned.has(n.id)) flat.push({ node: n, depth });
      walk(n.children, depth + 1);
    }
  };
  walk(tree, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal move-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>移动「{page.title || '未命名笔记'}」到</span>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <button className="move-target root" onClick={() => onMove(null)}>
            <FileText size={14} /> （移至根级）
          </button>
          <div className="move-list">
            {flat.map(({ node: n, depth }) => (
              <button
                key={n.id}
                className="move-target"
                style={{ paddingLeft: 12 + depth * 16 }}
                onClick={() => onMove(n.id)}
              >
                {depth > 0 && <span className="move-indent" aria-hidden />}
                <FileText size={14} /> {n.title || '未命名笔记'}
              </button>
            ))}
            {flat.length === 0 && <div className="muted small">没有其他可用位置</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
