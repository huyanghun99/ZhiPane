import { lazy, memo, Suspense, useEffect, useRef, useState } from 'react';
import { type NodeViewProps } from '@tiptap/react';
import { Pencil, Check } from 'lucide-react';
import { BlockFrame } from './BlockFrame';
import { ExcalidrawErrorBoundary } from './ExcalidrawErrorBoundary';
import { getTheme } from '../theme';
import { useToast } from '../components/Toast';

const ExcalidrawCanvas = lazy(() => import('./ExcalidrawCanvas'));

let excalidrawPrefetched = false;
function prefetchExcalidraw() {
  if (excalidrawPrefetched) return;
  excalidrawPrefetched = true;
  import('./ExcalidrawCanvas').catch(() => {});
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

export const ExcalidrawView = memo(function ExcalidrawView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const elements = (node.attrs.elements as unknown[]) || [];
  const appState = (node.attrs.appState as object) || {};
  const files = (node.attrs.files as Record<string, unknown>) || {};
  const preview = (node.attrs.preview as string) || '';
  const [edit, setEdit] = useState(false);
  const [api, setApi] = useState<unknown>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => { prefetchExcalidraw(); }, []);

  const startEdit = () => {
    setApi(null);
    setEdit(true);
  };

  // Phase 3: persist the diagram (scene data) on close — also refresh the SVG/PNG
  // preview card so the document-flow view stays in sync.
  const commit = async () => {
    const a = api as {
      getSceneElements: () => unknown[];
      getAppState: () => object;
      getFiles: () => Record<string, unknown>;
      exportToBlob: (opts: Record<string, unknown>) => Promise<Blob>;
    } | null;
    if (!a) {
      setEdit(false);
      return;
    }
    const els = a.getSceneElements();
    const appSt = a.getAppState();
    const f = a.getFiles();
    let png = '';
    try {
      const blob = await a.exportToBlob({
        elements: els,
        appState: { ...appSt, exportBackground: true, exportWithDarkMode: false },
        files: f,
        mimeType: 'image/png'
      });
      png = await blobToDataURL(blob);
    } catch {
      // Export may fail on an empty scene; keep the diagram data but surface it.
      toast.error('白板预览导出失败，已保留绘图数据');
    }
    updateAttributes({ elements: els, appState: appSt, files: f, preview: png });
    setEdit(false);
  };

  // Phase 3: debounced live staging of drawing changes (500ms) without the
  // heavier PNG export — keeps the editor responsive while drawing.
  const handleChange = (els: readonly unknown[], appSt: object, f: Record<string, unknown>) => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      updateAttributes({ elements: els, appState: appSt, files: f });
    }, 500);
  };

  const theme = getTheme() === 'dark' ? 'dark' : 'light';
  const toast = useToast();

  const actions = edit ? (
    <button type="button" className="ml-block-action primary" onMouseDown={(e) => { e.preventDefault(); commit(); }}>
      <Check size={13} /> 完成
    </button>
  ) : (
    <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); startEdit(); }}>
      <Pencil size={13} /> 编辑
    </button>
  );

  return (
    <BlockFrame label="白板（Excalidraw）" kind="excalidraw" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      {edit ? null : preview ? (
        <div className="excalidraw-preview" contentEditable={false} onDoubleClick={startEdit}>
          <img src={preview} alt="whiteboard" />
        </div>
      ) : (
        <div className="excalidraw-empty" contentEditable={false} onDoubleClick={startEdit}>
          点击「编辑」打开 Excalidraw 白板自由绘制
        </div>
      )}

      {edit && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => { if (e.target === e.currentTarget) commit(); }}
        >
          {/* Phase 3: fullscreen 92vw×90vh modal; isolate pointer/keyboard so the
              canvas never steals events from the surrounding editor. */}
          <div
            className="modal excalidraw-modal"
            style={{ width: '92vw', height: '90vh', display: 'flex', flexDirection: 'column' }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>Excalidraw 白板</span>
              <div className="drawio-head-actions">
                <button
                  type="button"
                  className="primary sm"
                  onMouseDown={(e) => { e.preventDefault(); commit(); }}
                >
                  完成
                </button>
                <button
                  type="button"
                  className="modal-close"
                  onMouseDown={(e) => { e.preventDefault(); commit(); }}
                >
                  ×
                </button>
              </div>
            </div>
            <div className="excalidraw-canvas" style={{ flex: 1, minHeight: 0 }}>
              <ExcalidrawErrorBoundary onReset={startEdit}>
                <Suspense fallback={<div className="excalidraw-loading">加载白板编辑器…</div>}>
                  <ExcalidrawCanvas
                    initialElements={elements}
                    initialAppState={appState}
                    initialFiles={files}
                    onApiReady={setApi}
                    onChange={handleChange}
                    theme={theme === 'dark' ? 'dark' : 'light'}
                  />
                </Suspense>
              </ExcalidrawErrorBoundary>
            </div>
          </div>
        </div>
      )}
    </BlockFrame>
  );
});
