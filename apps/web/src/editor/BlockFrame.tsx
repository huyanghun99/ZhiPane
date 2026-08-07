import { type ReactNode } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { Trash2 } from 'lucide-react';

/**
 * Shared chrome for every advanced block (Phase4 — task 10).
 *
 * Renders the outer node wrapper (carrying `data-drag-handle` + a stable
 * `data-block-id`) plus a consistent top bar with the block label, any
 * block-specific actions, and a delete button. Advanced blocks no longer
 * each hand-roll their own toolbar / delete affordance.
 */
export function BlockFrame({
  label,
  selected,
  onDelete,
  actions,
  id,
  kind,
  children
}: {
  label: string;
  selected?: boolean;
  onDelete: () => void;
  actions?: ReactNode;
  id?: string | null;
  kind?: string;
  children: ReactNode;
}) {
  return (
    <NodeViewWrapper
      className={`ml-block${selected ? ' ml-block-selected' : ''}`}
      data-drag-handle
      data-block-id={id ?? undefined}
      data-kind={kind}
    >
      {selected && (
        <div className="ml-block-bar" contentEditable={false}>
          <span className="ml-block-badge">{label}</span>
          {actions ? <div className="ml-block-actions">{actions}</div> : <span className="ml-block-spacer" />}
          <button
            type="button"
            className="ml-block-del"
            title="删除"
            onMouseDown={(e) => {
              e.preventDefault();
              onDelete();
            }}
          >
            <Trash2 size={13} />
          </button>
        </div>
      )}
      {children}
    </NodeViewWrapper>
  );
}

export type { NodeViewProps };
