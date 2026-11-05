import { memo, useEffect, useRef, useState } from 'react';
import { type NodeViewProps } from '@tiptap/react';
import { Pencil } from 'lucide-react';
import { BlockFrame } from './BlockFrame';
import { BlockPreview } from './BlockPreview';

const EMPTY_XML =
  '<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="800" pageHeight="600" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>';

const DRAWIO_URL =
  'https://embed.diagrams.net/?embed=1&ui=min&proto=json&noSaveBtn=0&noExitBtn=0&saveAndExit=1&spin=0&libraries=1';

export const DrawioView = memo(function DrawioView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const xml = (node.attrs.xml as string) || '';
  const preview = (node.attrs.preview as string) || '';
  const width = (node.attrs.width as number | null) ?? null;
  const [open, setOpen] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const xmlRef = useRef(xml);
  xmlRef.current = xml;
  const sentLoadRef = useRef(false);
  const pendingCloseRef = useRef(false);
  const [isDirty, setIsDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const sendLoad = () => {
    if (sentLoadRef.current) return;
    sentLoadRef.current = true;
    iframeRef.current?.contentWindow?.postMessage(
      JSON.stringify({ action: 'load', xml: xmlRef.current || EMPTY_XML }),
      '*'
    );
  };

  useEffect(() => {
    if (!open) return;
    sentLoadRef.current = false;
    const handler = (e: MessageEvent) => {
      let msg: { event?: string; xml?: string; data?: unknown; dirty?: boolean } | null = null;
      try {
        msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      switch (msg.event) {
        case 'init':
        case 'load':
          sendLoad();
          break;
        case 'dirty':
          setIsDirty(!!msg.dirty);
          break;
        case 'save': {
          const newXml = msg.xml ?? (typeof msg.data === 'string' ? msg.data : '') ?? '';
          updateAttributes({ xml: newXml });
          setSaving(true);
          iframeRef.current?.contentWindow?.postMessage(
            JSON.stringify({ action: 'export', format: 'xmlsvg', xml: newXml }),
            '*'
          );
          break;
        }
        case 'export': {
          if (typeof msg.data === 'string') updateAttributes({ preview: msg.data });
          setSaving(false);
          if (pendingCloseRef.current) {
            pendingCloseRef.current = false;
            setOpen(false);
          }
          break;
        }
        case 'exit':
          if (isDirty) {
            // draw.io requested exit while dirty → persist first, then close.
            iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: 'save' }), '*');
            pendingCloseRef.current = true;
          } else {
            setOpen(false);
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [open]);

  const handleSaveAndClose = () => {
    pendingCloseRef.current = true;
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: 'save' }), '*');
  };

  // Dirty-aware close: persist unsaved changes first (the export handler closes
  // the modal once the preview is written), otherwise close immediately.
  const requestClose = () => {
    if (isDirty) {
      pendingCloseRef.current = true;
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ action: 'save' }), '*');
    } else {
      setOpen(false);
    }
  };

  const actions = (
    <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); setOpen(true); }}>
      <Pencil size={13} /> 编辑图表
    </button>
  );

  return (
    <BlockFrame label="流程图（Draw.io）" kind="drawio" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      <div className="drawio-preview">
        <BlockPreview
          preview={preview}
          alt="diagram"
          emptyText="点击「编辑图表」打开 Draw.io 编辑器绘制流程图"
          width={width}
          updateAttributes={updateAttributes}
          onEdit={() => setOpen(true)}
        />
      </div>

      {open && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}
        >
          <div className="modal drawio-modal" style={{ position: 'relative' }}>
            <div className="modal-head">
              <span>Draw.io 编辑器</span>
              <div className="drawio-head-actions">
                <button
                  type="button"
                  className="primary sm"
                  onMouseDown={(e) => { e.preventDefault(); handleSaveAndClose(); }}
                >
                  保存并关闭
                </button>
                <button
                  type="button"
                  className="modal-close"
                  onMouseDown={(e) => { e.preventDefault(); requestClose(); }}
                >
                  ×
                </button>
              </div>
            </div>
            <iframe
              ref={iframeRef}
              className="drawio-frame"
              src={DRAWIO_URL}
              title="Draw.io"
              onLoad={() => setTimeout(sendLoad, 1200)}
            />
            {saving && (
              <div className="drawio-loading" style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,.35)', color: '#fff', fontSize: 14, borderRadius: 8 }}>
                正在保存…
              </div>
            )}
          </div>
        </div>
      )}
    </BlockFrame>
  );
});
