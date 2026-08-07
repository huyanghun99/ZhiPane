import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { ChevronRight, FileText, MoreHorizontal } from 'lucide-react';
import type { TreeNode } from '../../types';

const ROW_H = 30;

interface FlatRow { node: TreeNode; depth: number; parentPageId: string | null }

function flatten(tree: TreeNode[], expanded: Set<string>, parentId: string | null = null): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TreeNode[], depth: number, pid: string | null) => {
    for (const n of nodes) {
      out.push({ node: n, depth, parentPageId: pid });
      if (n.children.length > 0 && expanded.has(n.id)) walk(n.children, depth + 1, n.id);
    }
  };
  walk(tree, 0, parentId);
  return out;
}

/**
 * Virtualised page tree with drag-to-reorder + a per-row "⋯" / right-click
 * action menu (Phase 6 — tasks 3 & 4).
 *
 * The flat visible list is windowed (only rows in the viewport are mounted).
 * Each row is draggable; dropping onto another row inserts the dragged page as
 * a sibling right after it (same parent). A footer drop zone moves it to root.
 */
export function PageTree({
  tree,
  selectedId,
  onSelect,
  statusLabel,
  onContextMenu,
  onMore,
  onReorder
}: {
  tree: TreeNode[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  statusLabel: (s: string) => string;
  onContextMenu?: (node: TreeNode, x: number, y: number) => void;
  onMore?: (node: TreeNode, x: number, y: number) => void;
  onReorder?: (dragId: string, targetId: string | null, position: number, mode: 'child' | 'sibling') => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(tree.map((n) => n.id)));
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const [dragId, setDragId] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; zone: 'before' | 'child' | 'after'; depth: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const n of tree) if (!next.has(n.id)) next.add(n.id);
      return next;
    });
  }, [tree]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setViewport(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const flat = useMemo(() => flatten(tree, expanded), [tree, expanded]);
  const total = flat.length * ROW_H;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 6);
  const end = Math.min(flat.length, Math.ceil((scrollTop + viewport) / ROW_H) + 6);
  const slice = flat.slice(start, end);

  // C2.1-fix: compute the insertion caret (position + indent + label) for the
  // current drop zone so the outcome is always visible while dragging.
  const caret = useMemo(() => {
    if (!over || !dragId) return null;
    const idx = flat.findIndex((r) => r.node.id === over.id);
    if (idx < 0) return null;
    const indent = (over.zone === 'child' ? over.depth + 1 : over.depth) * 14 + 10;
    const top = idx * ROW_H + (over.zone === 'after' || over.zone === 'child' ? ROW_H - 2 : 0);
    const label = over.zone === 'child' ? '成为子页面' : over.zone === 'before' ? '同级 · 上方' : '同级 · 下方';
    return { indent, top, label, zone: over.zone };
  }, [over, dragId, flat]);

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  const blockedIds = useMemo(() => {
    if (!dragId) return null;
    const set = new Set<string>([dragId]);
    const find = (nodes: TreeNode[]): TreeNode | null => {
      for (const n of nodes) {
        if (n.id === dragId) return n;
        const f = find(n.children);
        if (f) return f;
      }
      return null;
    };
    const walk = (nodes: TreeNode[]) => nodes.forEach((n) => { set.add(n.id); walk(n.children); });
    const root = find(tree);
    if (root) walk(root.children);
    return set;
  }, [dragId, tree]);

  const doReorder = (targetId: string | null, position: number, mode: 'child' | 'sibling') => {
    if (targetId && blockedIds?.has(targetId)) return;
    if (dragId && dragId !== targetId) {
      if (mode === 'child' && targetId) {
        setExpanded((prev) => new Set(prev).add(targetId));
      }
      onReorder?.(dragId, targetId, position, mode);
    }
    setDragId(null);
    setOver(null);
  };

  const zoneOf = (e: DragEvent<HTMLDivElement>): 'before' | 'child' | 'after' => {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientY - rect.top) / rect.height;
    return rel < 0.3 ? 'before' : rel > 0.7 ? 'after' : 'child';
  };

  const handleDragOver = (e: DragEvent<HTMLDivElement>, id: string, depth: number) => {
    if (!dragId || blockedIds?.has(id)) return;
    e.preventDefault();
    setOver({ id, zone: zoneOf(e), depth });
  };

  const handleDragLeave = (e: DragEvent<HTMLDivElement>, id: string) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setOver((prev) => (prev && prev.id === id ? null : prev));
  };

  const handleDrop = (e: DragEvent<HTMLDivElement>, node: TreeNode) => {
    e.preventDefault();
    if (!dragId || dragId === node.id || blockedIds?.has(node.id)) return;
    const zone = zoneOf(e);
    if (zone === 'child') doReorder(node.id, 1e9, 'child');
    else {
      const pos = zone === 'before' ? (node.position ?? 0) : (node.position ?? 0) + 1;
      doReorder(node.id, pos, 'sibling');
    }
  };

  const handleRootDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (dragId) e.preventDefault();
  };

  const handleRootDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    doReorder(null, 1e9, 'sibling');
  };

  return (
    <div className="pages-list" ref={ref} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
      <div style={{ height: total, position: 'relative' }}>
        {slice.map(({ node, depth }, i) => {
          const idx = start + i;
          const selected = node.id === selectedId;
          const open = expanded.has(node.id);
          const dragging = dragId === node.id;
          const isOver = !!over && over.id === node.id && !dragging;
          const rowClass = isOver ? (over!.zone === 'child' ? ' drop-child' : ' drop-target') : '';
          const guides = depth > 0
            ? Array.from({ length: depth }, () => 'linear-gradient(var(--border), var(--border))')
            : [];
          return (
            <div
              key={node.id}
              role="button"
              tabIndex={0}
              className={`tree-item${selected ? ' active' : ''}${dragging ? ' dragging' : ''}${rowClass}`}
              style={{
                position: 'absolute',
                top: idx * ROW_H,
                left: 0,
                right: 0,
                height: ROW_H,
                paddingLeft: 10 + depth * 14,
                ...(guides.length
                  ? {
                      backgroundImage: guides.join(', '),
                      backgroundPosition: guides.map((_, k) => `${10 + (k + 1) * 14 - 7}px 0`).join(', '),
                      backgroundSize: '1px 100%',
                      backgroundRepeat: 'no-repeat'
                    }
                  : {})
              }}
              draggable
              onClick={() => onSelect(node.id)}
              onKeyDown={(e) => { if (e.key === 'Enter') onSelect(node.id); }}
              onContextMenu={(e) => { e.preventDefault(); onContextMenu?.(node, e.clientX, e.clientY); }}
              onDragStart={(e) => {
                setDragId(node.id);
                e.dataTransfer.effectAllowed = 'move';
                try { e.dataTransfer.setData('text/plain', node.id); } catch { /* ignore */ }
              }}
              onDragEnd={() => { setDragId(null); setOver(null); }}
              onDragOver={(e) => handleDragOver(e, node.id, depth)}
              onDragLeave={(e) => handleDragLeave(e, node.id)}
              onDrop={(e) => handleDrop(e, node)}
            >
              {node.hasChildren ? (
                <span
                  className={`tree-caret${open ? ' open' : ''}`}
                  onClick={(e) => { e.stopPropagation(); toggle(node.id); }}
                >
                  <ChevronRight size={13} />
                </span>
              ) : (
                <span className="tree-caret" />
              )}
              {node.icon ? <span className="row-icon-emoji">{node.icon}</span> : <FileText size={14} />}
              <span className="tree-title">{node.title || '未命名笔记'}</span>
              <span className={`dot status-${node.llmProcessStatus}`} title={statusLabel(node.llmProcessStatus)} />
              {onMore && (
                <button
                  className="tree-more"
                  title="更多操作"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    onMore(node, r.right, r.bottom);
                  }}
                >
                  <MoreHorizontal size={14} />
                </button>
              )}
            </div>
          );
        })}
        {caret && (
          <div className={`tree-caret-line zone-${caret.zone}`} style={{ top: caret.top, left: caret.indent }}>
            <span className="tree-caret-badge">{caret.label}</span>
          </div>
        )}
      </div>
      {dragId && (
        <div
          className="tree-drop-root"
          onDragOver={(e) => handleRootDragOver(e)}
          onDrop={(e) => handleRootDrop(e)}
        >
          拖到此处移动到根级
        </div>
      )}
    </div>
  );
}
