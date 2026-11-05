import type { MouseEvent as ReactMouseEvent } from 'react';

/**
 * Shared width-resize behaviour for block previews (Draw.io / Excalidraw).
 *
 * The width is persisted as a node attribute (number of px); `null` means
 * "use the full available width". The same corner-drag interaction is used by
 * ImageView, so all embedded visuals are sized consistently in the document.
 */
export function startBlockResize(
  e: ReactMouseEvent,
  width: number | null,
  containerRef: { current: HTMLElement | null },
  updateAttributes: (attrs: Record<string, unknown>) => void
) {
  e.preventDefault();
  e.stopPropagation();
  const el = containerRef.current;
  const startX = e.clientX;
  const maxWidth = el?.parentElement?.offsetWidth ?? 800;
  const startWidth = width ?? el?.offsetWidth ?? maxWidth;

  const onMove = (ev: MouseEvent) => {
    const next = Math.max(120, Math.min(maxWidth, startWidth + (ev.clientX - startX)));
    updateAttributes({ width: Math.round(next) });
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

/** Width presets shown next to the drag handle. */
export const WIDTH_PRESETS = [50, 75, 100] as const;
