/**
 * Table controls: row/column reorder grips + a floating toolbar with insert /
 * delete row / column actions and a row-density switch.
 *
 * Self-contained, zero external deps. Hover detection uses elementFromPoint so
 * it works on native tiptap table DOM. Reorder rebuilds the table node in one
 * ProseMirror transaction; insert/delete delegate to the official table
 * commands after placing the caret in the hovered cell.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { type Editor } from '@tiptap/react';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import {
  ArrowDownToLine, ArrowRightToLine, ArrowUpToLine, Columns3, Minus, Plus, Rows3
} from 'lucide-react';

interface HoverState {
  cellEl: HTMLElement;
  rowEl: HTMLTableRowElement;
  tableEl: HTMLTableElement;
  rowIndex: number;
  colIndex: number;
  tablePos: number;
}

type DragState = { type: 'row' | 'col'; from: number; over: number } | null;
type Density = 'compact' | 'normal' | 'relaxed';
type TableCommand =
  | 'addRowBefore' | 'addRowAfter' | 'deleteRow'
  | 'addColumnBefore' | 'addColumnAfter' | 'deleteColumn';

const DENSITY_KEY = 'zp.tableDensity';

function readDensity(): Density {
  try {
    const v = localStorage.getItem(DENSITY_KEY);
    return v === 'compact' || v === 'relaxed' ? v : 'normal';
  } catch { return 'normal'; }
}

function applyDensity(editor: Editor, d: Density) {
  const root = (editor.view.dom as HTMLElement).closest('.editor-content') as HTMLElement | null;
  if (root) root.dataset.tableDensity = d;
}

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
  const [density, setDensity] = useState<Density>(readDensity);
  const dragRef = useRef<DragState>(null);
  dragRef.current = drag;

  useEffect(() => { applyDensity(editor, density); }, [editor, density]);

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
      // Keep the current hover while the pointer is over one of our controls.
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

  /** Resolve the hovered cell against the LIVE DOM (rows may have been inserted). */
  const liveCell = () => {
    if (!hover) return null;
    const table = hover.tableEl.isConnected
      ? hover.tableEl
      : (editor.view.dom.querySelector('table') as HTMLTableElement | null);
    const row = table?.querySelectorAll('tr')[hover.rowIndex] as HTMLTableRowElement | undefined;
    const cell = row?.children[hover.colIndex] as HTMLElement | undefined;
    return table && row && cell ? { table, row, cell } : null;
  };

  /** Place the caret in the hovered cell, then run a native table command. */
  const runCommand = (name: TableCommand) => {
    if (!hover) return;
    const live = liveCell();
    let pos: number | null = null;
    if (live) {
      try { pos = editor.view.posAtDOM(live.cell, 0); } catch { /* detached */ }
    }
    // Fallback: just inside the first cell of the first row.
    if (pos == null) pos = hover.tablePos + 3;
    editor.chain().focus().setTextSelection(pos).run();
    switch (name) {
      case 'addRowBefore': editor.commands.addRowBefore(); break;
      case 'addRowAfter': editor.commands.addRowAfter(); break;
      case 'deleteRow': editor.commands.deleteRow(); break;
      case 'addColumnBefore': editor.commands.addColumnBefore(); break;
      case 'addColumnAfter': editor.commands.addColumnAfter(); break;
      case 'deleteColumn': editor.commands.deleteColumn(); break;
    }
    // Keep the toolbar in place for consecutive edits: ProseMirror may replace
    // cell DOM nodes, so refresh the hover references on the next frame.
    requestAnimationFrame(() => {
      const next = liveCell();
      if (next && hover) {
        setHover({ ...hover, cellEl: next.cell, rowEl: next.row, tableEl: next.table });
      } else {
        setHover(null);
      }
    });
  };

  const changeDensity = (d: Density) => {
    setDensity(d);
    try { localStorage.setItem(DENSITY_KEY, d); } catch { /* ignore */ }
    applyDensity(editor, d);
  };

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
  const tableRect = hover.tableEl.getBoundingClientRect();
  const toolbarStyle = {
    left: Math.max(8, tableRect.left),
    top: Math.max(8, tableRect.top - 34)
  };

  return (
    <>
      <div data-table-handle className="th-toolbar" style={toolbarStyle} contentEditable={false}>
        <span className="th-group-label"><Rows3 size={12} /> 行</span>
        <button title="在上方插入行" onClick={() => runCommand('addRowBefore')}><ArrowUpToLine size={13} /><Plus size={10} /></button>
        <button title="在下方插入行" onClick={() => runCommand('addRowAfter')}><ArrowDownToLine size={13} /><Plus size={10} /></button>
        <button title="删除当前行" className="danger" onClick={() => runCommand('deleteRow')}><Minus size={13} /></button>
        <span className="th-sep" />
        <span className="th-group-label"><Columns3 size={12} /> 列</span>
        <button title="在左侧插入列" onClick={() => runCommand('addColumnBefore')}><ArrowUpToLine size={13} className="rotate-90" /><Plus size={10} /></button>
        <button title="在右侧插入列" onClick={() => runCommand('addColumnAfter')}><ArrowRightToLine size={13} /><Plus size={10} /></button>
        <button title="删除当前列" className="danger" onClick={() => runCommand('deleteColumn')}><Minus size={13} /></button>
        <span className="th-sep" />
        <select title="单元格行高" value={density} onChange={(e) => changeDensity(e.target.value as Density)}>
          <option value="compact">紧凑</option>
          <option value="normal">标准</option>
          <option value="relaxed">宽松</option>
        </select>
      </div>
      {rowRect && (
        <div data-table-handle className="th-handle" style={rowRect}
          title="拖动以移动该行" onPointerDown={startDrag('row')}>
          <Grip />
        </div>
      )}
      {colRect && (
        <div data-table-handle className="th-handle" style={colRect}
          title="拖动以移动该列" onPointerDown={startDrag('col')}>
          <Grip />
        </div>
      )}
    </>
  );
}
