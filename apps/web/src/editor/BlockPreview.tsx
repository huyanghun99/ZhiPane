import { useRef, type MouseEvent as ReactMouseEvent } from 'react';
import { startBlockResize, WIDTH_PRESETS } from './blockResize';

/**
 * Shared preview surface for diagram blocks (Draw.io / Excalidraw).
 * Adds a corner drag handle + percentage presets so embedded visuals can be
 * sized in the document; the chosen width is persisted as a node attribute.
 */
export function BlockPreview({
  preview, alt, emptyText, width, updateAttributes, onEdit
}: {
  preview: string;
  alt: string;
  emptyText: string;
  width: number | null;
  updateAttributes: (attrs: Record<string, unknown>) => void;
  onEdit: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const setPreset = (pct: number) => (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const full = ref.current?.parentElement?.offsetWidth ?? 800;
    updateAttributes({ width: Math.round(full * pct / 100) });
  };

  return (
    <div
      ref={ref}
      className="ml-block-preview"
      style={width ? { width: `${width}px` } : undefined}
      contentEditable={false}
      onDoubleClick={onEdit}
    >
      {preview
        ? <img src={preview} alt={alt} draggable={false} />
        : <div className="excalidraw-empty">{emptyText}</div>}

      {preview && (
        <>
          <div className="ml-size-bar">
            {WIDTH_PRESETS.map((p) => (
              <button key={p} type="button" title={`宽度 ${p}%`} onMouseDown={setPreset(p)}>{p}%</button>
            ))}
            {width && (
              <button type="button" title="恢复全宽" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); updateAttributes({ width: null }); }}>全宽</button>
            )}
          </div>
          <div
            className="ml-resize-handle"
            title="拖动调整宽度"
            onMouseDown={(e) => startBlockResize(e, width, ref, updateAttributes)}
          />
        </>
      )}
    </div>
  );
}
