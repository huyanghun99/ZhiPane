/**
 * Table drag handles (row + column reorder) — self-contained, zero external
 * deps (no @docmost/editor-ext / pragmatic-dnd / mantine).
 *
 * Mirrors docmost's table-handle UX: on hover over a cell we show a grip on
 * the left of the row and on top of the column. Dragging a grip reorders the
 * row/column via a single ProseMirror transaction. Header pinning (sticky
 * `th`) lives in editor.css.
 *
 * Implementation notes:
 * - Hover detection uses `elementFromPoint` so it works on native tiptap
 *   table DOM (we don't need editor-ext's grip-selection state).
 * - Reorder is done by rebuilding the table node: splice the moved
 *   row/column out and back in at the target index, then `replaceWith`.
 *   This keeps cell attributes and is safe for our 1×1-cell tables.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';

interface HoverState {
  cellEl: HTMLElement;
  rowEl: HTMLTableRowElement;
  tableEl: HTMLTableElement;
  rowIndex: number;
  colIndex: number;
  tablePos: number;
}

type DragState = { type: 'row' | 'col'; from: number; over: number } | null;

/** Position just before the <table> node in the doc. */
function getTablePos(editor: Editor, tableEl: HTMLElement): number | null {
  try {
    const pos = editor.view.posAtDOM(tableEl, 0);
    if (pos == null) return null;
    const $pos = editor.state.doc.resolve(pos);
    for (let d = $pos.depth; d >= 0; d--) {
      if ($pos.node(d).type.name === 'table') return $pos.before(d);
    }
  } catch {
    /* node not yet in doc */
  }
  return null;
}

function moveRow(editor: Editor, tablePos: number, from: number, to: number) {
  const table = editor.state.doc.nodeAt(tablePos);
  if (!table) return;
  const rows: PMNode[] = [];
  table.forEach((r) => rows.push(r));
  if (from < 0 || from >= rows.length) return;
  const [moved] = rows.splice(from, 1);
  let target = to > from ? to - 1 : to;
  target = Math.max(0, Math.min(target, rows.length));
  rows.splice(target, 0, moved);
  const newTable = table.copy(Fragment.from(rows));
  editor.view.dispatch(editor.state.tr.replaceWith(tablePos, tablePos + table.nodeSize, newTable));
}

function moveColumn(editor: Editor, tablePos: number, from: number, to: number) {
  const table = editor.state.doc.nodeAt(tablePos);
  if (!table) return;
  const newRows: PMNode[] = [];
  table.forEach((row) => {
    const cells: PMNode[] = [];
    row.forEach((c) => cells.push(c));
    if (from < 0 || from >= cells.length) return;
    const [moved] = cells.splice(from, 1);
    let target = to > from ? to - 1 : to;
    target = Math.max(0, Math.min(target, cells.length));
    cells.splice(target, 0, moved);
    newRows.push(row.copy(Fragment.from(cells)));
  });
  const newTable = table.copy(Fragment.from(newRows));
  editor.view.dispatch(editor.state.tr.replaceWith(tablePos, tablePos + table.nodeSize, newTable));
}

function Grip() {
  return (
    <svg viewBox="0 0 10 10" width="12" height="12" aria-hidden>
      <path fill="currentColor" d="M3,2 A1,1 0 1 1 3,0 A1,1 0 0 1 3,2 Z M3,6 A1,1 0 1 1 3,4 A1,1 0 0 1 3,6 Z M3,10 A1,1 0 1 1 3,8 A1,1 0 0 1 3,10 Z M7,2 A1,1 0 1 1 7,0 A1,1 0 0 1 7,2 Z M7,6 A1,1 0 1 1 7,4 A1,1 0 0 1 7,6 Z M7,10 A1,1 0 1 1 7,8 A1,1 0 0 1 7,10 Z" />
    </svg>
  );
}

export function TableHandles({ editor }: { editor: Editor }) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const [drag, setDrag] = useState<DragState>(null);
  const dragRef = useRef<DragState>(null);
  dragRef.current = drag;

  const clearHover = useCallback(() => {
    if (!dragRef.current) setHover(null);
  }, []);

  useEffect(() => {
    const dom = editor.view.dom as HTMLElement;
    if (!dom) return;

    const onMove = (e: MouseEvent) => {
      if (dragRef.current) return;
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el) return clearHover();
      // Keep the current hover while the pointer is over one of our handles
      // (they sit outside the cells, so elementFromPoint would otherwise
      // resolve to the handle and hide it).
      if (el.closest('[data-table-handle]')) return;
      const cell = el.closest('td, th') as HTMLElement | null;
      if (!cell || !dom.contains(cell)) return clearHover();
      const tableEl = cell.closest('table') as HTMLTableElement | null;
      const rowEl = cell.closest('tr') as HTMLTableRowElement | null;
      if (!tableEl || !rowEl) return clearHover();
      const rows = Array.from(tableEl.querySelectorAll('tr'));
      const rowIndex = rows.indexOf(rowEl);
      const colIndex = Array.from(rowEl.children).indexOf(cell);
      const tablePos = getTablePos(editor, tableEl);
      if (tablePos == null || !editor.state.doc.nodeAt(tablePos)) return clearHover();
      setHover((prev) => (prev && prev.cellEl === cell ? prev : { cellEl: cell, rowEl, tableEl, rowIndex, colIndex, tablePos }));
    };

    dom.addEventListener('mousemove', onMove);
    dom.addEventListener('mouseleave', clearHover);
    window.addEventListener('scroll', clearHover, true);
    return () => {
      dom.removeEventListener('mousemove', onMove);
      dom.removeEventListener('mouseleave', clearHover);
      window.removeEventListener('scroll', clearHover, true);
    };
  }, [editor, clearHover]);

  // Drag: window-level pointer tracking so it survives DOM reflow mid-drag.
  useEffect(() => {
    if (!drag) return;
    const onPointerMove = (e: PointerEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
      if (!el || !hover?.tableEl) return;
      if (drag.type === 'row') {
        const tr = el.closest('tr') as HTMLTableRowElement | null;
        if (!tr || !hover.tableEl.contains(tr)) return;
        const idx = Array.from(hover.tableEl.querySelectorAll('tr')).indexOf(tr);
        if (idx >= 0) setDrag((d) => (d ? { ...d, over: idx } : d));
      } else {
        const td = el.closest('td, th') as HTMLElement | null;
        if (!td || !hover.tableEl.contains(td)) return;
        const row = td.closest('tr');
        if (!row) return;
        const idx = Array.from(row.children).indexOf(td);
        if (idx >= 0) setDrag((d) => (d ? { ...d, over: idx } : d));
      }
    };
    const onPointerUp = () => {
      const d = dragRef.current;
      if (d && hover && d.over !== d.from) {
        if (d.type === 'row') moveRow(editor, hover.tablePos, d.from, d.over);
        else moveColumn(editor, hover.tablePos, d.from, d.over);
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [drag, editor, hover]);

  if (!editor.isEditable || !hover) return null;

  const startDrag = (type: 'row' | 'col') => (e: React.PointerEvent) => {
    e.preventDefault();
    setDrag({ type, from: type === 'row' ? hover.rowIndex : hover.colIndex, over: type === 'row' ? hover.rowIndex : hover.colIndex });
  };

  const rows = Array.from(hover.tableEl.querySelectorAll('tr'));
  const rowIdx = drag?.type === 'row' ? drag.over : hover.rowIndex;
  const colIdx = drag?.type === 'col' ? drag.over : hover.colIndex;

  const rowRect = (() => {
    const tr = rows[rowIdx];
    if (!tr) return null;
    const r = tr.getBoundingClientRect();
    return { left: r.left - 20, top: r.top + r.height / 2 - 8, height: 16 };
  })();
  const colRect = (() => {
    const cell = rows[0]?.children[colIdx] as HTMLElement | undefined;
    if (!cell) return null;
    const c = cell.getBoundingClientRect();
    const t = hover.tableEl.getBoundingClientRect();
    return { left: c.left + c.width / 2 - 8, top: t.top - 20, width: 16 };
  })();

  return (
    <>
      {rowRect && (
        <div
          data-table-handle
          className="th-handle"
          style={rowRect}
          title="拖动以移动该行"
          onPointerDown={startDrag('row')}
        >
          <Grip />
        </div>
      )}
      {colRect && (
        <div
          data-table-handle
          className="th-handle"
          style={colRect}
          title="拖动以移动该列"
          onPointerDown={startDrag('col')}
        >
          <Grip />
        </div>
      )}
    </>
  );
}
