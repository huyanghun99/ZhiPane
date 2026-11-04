/**
 * F5: Image node view with resize handles and alignment controls.
 *
 * Replaces the default TipTap Image rendering with a NodeView that:
 *   - Shows resize handles on the corners when selected
 *   - Supports left/center/right alignment
 *   - Persists width + align as node attributes
 */
import { memo, useRef, useCallback } from 'react';
import { NodeViewWrapper, type NodeViewProps } from '@tiptap/react';
import { AlignLeft, AlignCenter, AlignRight } from 'lucide-react';

type Align = 'left' | 'center' | 'right';

export const ImageView = memo(function ImageView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const { src, alt, width, align } = node.attrs as {
    src: string; alt?: string; width?: number | null; align?: Align;
  };
  const containerRef = useRef<HTMLDivElement>(null);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startWidth = width ?? containerRef.current?.offsetWidth ?? 400;
    const containerWidth = containerRef.current?.parentElement?.offsetWidth ?? 800;

    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const newWidth = Math.max(80, Math.min(containerWidth, startWidth + dx));
      updateAttributes({ width: Math.round(newWidth) });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width, updateAttributes]);

  const setAlign = (a: Align) => {
    updateAttributes({ align: a });
  };

  const justify = align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start';
  const imgWidth = width ? `${width}px` : '100%';

  return (
    <NodeViewWrapper className={`ml-image-wrap${selected ? ' selected' : ''}`} style={{ justifyContent: justify }} data-drag-handle>
      <div className="ml-image-container" ref={containerRef} style={{ width: imgWidth, position: 'relative' }}>
        <img src={src} alt={alt ?? ''} className="ml-image" draggable={false} />

        {/* Resize handles — only when selected */}
        {selected && (
          <>
            <div className="ml-image-resize-handle br" onMouseDown={startResize} />
            <div className="ml-image-align-bar" contentEditable={false}>
              <button
                type="button"
                className={`ml-align-btn${(align ?? 'left') === 'left' ? ' active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); setAlign('left'); }}
                title="左对齐"
              ><AlignLeft size={13} /></button>
              <button
                type="button"
                className={`ml-align-btn${align === 'center' ? ' active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); setAlign('center'); }}
                title="居中"
              ><AlignCenter size={13} /></button>
              <button
                type="button"
                className={`ml-align-btn${align === 'right' ? ' active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); setAlign('right'); }}
                title="右对齐"
              ><AlignRight size={13} /></button>
              <span className="ml-align-sep" />
              <button
                type="button"
                className="ml-align-btn danger"
                onMouseDown={(e) => { e.preventDefault(); deleteNode(); }}
                title="删除图片"
              >✕</button>
            </div>
          </>
        )}
      </div>
    </NodeViewWrapper>
  );
});
