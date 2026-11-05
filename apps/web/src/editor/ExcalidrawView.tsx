import { lazy, memo, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { type NodeViewProps } from '@tiptap/react';
import { Pencil, Check } from 'lucide-react';
import { BlockFrame } from './BlockFrame';
import { BlockPreview } from './BlockPreview';
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

type SceneData = {
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
};

type SceneAPI = {
  getSceneElements: () => unknown[];
  getAppState: () => Record<string, unknown>;
  getFiles: () => Record<string, unknown>;
};

/**
 * AppState / files returned by Excalidraw carry runtime-only values
 * (`collaborators` is a Map, plus DOM geometry). Persisting them verbatim makes
 * JSON.stringify reshape them unpredictably and can restore a stale canvas
 * size on reopen, so normalise to plain JSON first.
 */
function cleanScene(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  let plain: Record<string, unknown>;
  try {
    plain = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return {};
  }
  for (const key of [
    'collaborators', 'offsetTop', 'offsetLeft', 'width', 'height', 'isLoading',
    'contextMenu', 'toast', 'draggingElement', 'resizingElement',
    'selectionElement', 'editingElement'
  ]) delete plain[key];
  return plain;
}

export const ExcalidrawView = memo(function ExcalidrawView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const elements = (node.attrs.elements as unknown[]) || [];
  const appState = (node.attrs.appState as object) || {};
  const files = (node.attrs.files as Record<string, unknown>) || {};
  const preview = (node.attrs.preview as string) || '';
  const width = (node.attrs.width as number | null) ?? null;
  const [edit, setEdit] = useState(false);
  const [api, setApi] = useState<SceneAPI | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);
  const staged = useRef<SceneData | null>(null);
  // Keep the onChange callback stable across NodeView re-renders.
  const updateRef = useRef(updateAttributes);
  updateRef.current = updateAttributes;
  const toast = useToast();

  useEffect(() => { prefetchExcalidraw(); }, []);

  useEffect(() => () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
  }, []);

  // Stop the page behind the full-screen board from scrolling underneath it.
  useEffect(() => {
    if (!edit) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [edit]);

  const startEdit = () => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    staged.current = null;
    setApi(null);
    setEdit(true);
  };

  // Debounced scene staging while drawing (no expensive PNG export here).
  // Excalidraw fires onChange on every pointer frame, so keep this path to a
  // plain reference assignment; the JSON normalisation only runs when the
  // debounce actually persists (once per 500ms), not on every drag frame.
  const handleChange = useCallback((els: readonly unknown[], appSt: object, f: Record<string, unknown>) => {
    staged.current = {
      elements: els as unknown[],
      appState: appSt as Record<string, unknown>,
      files: f
    };
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      const s = staged.current;
      if (s) updateRef.current({
        elements: s.elements,
        appState: cleanScene(s.appState),
        files: cleanScene(s.files)
      });
    }, 500);
  }, []);

  const commit = async () => {
    // Clear the debounce BEFORE reading the scene: its stale 500ms payload can
    // otherwise land after this commit and overwrite the new preview.
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    const scene: SceneData | null = api
      ? {
          elements: api.getSceneElements(),
          appState: cleanScene(api.getAppState()),
          files: cleanScene(api.getFiles())
        }
      : staged.current;
    if (!scene) { setEdit(false); return; }

    let nextPreview = preview;
    if (scene.elements.length === 0) {
      nextPreview = '';
    } else {
      try {
        // exportPreview lives in the lazily-loaded Excalidraw module. The old
        // code called api.exportToBlob(), which does not exist on the imperative
        // API — the TypeError was swallowed and every save stored preview: ''.
        const { exportPreview } = await import('./ExcalidrawCanvas');
        nextPreview = await exportPreview(scene.elements, scene.appState, scene.files);
      } catch (err) {
        toast.error(`白板预览导出失败：${err instanceof Error ? err.message : '未知错误'}，已保留绘图数据与旧预览`);
      }
    }
    updateAttributes({ ...scene, preview: nextPreview });
    setEdit(false);
  };

  const theme = getTheme() === 'dark' ? 'dark' : 'light';

  const actions = edit ? (
    <button type="button" className="ml-block-action primary" onMouseDown={(e) => { e.preventDefault(); void commit(); }}>
      <Check size={13} /> 完成
    </button>
  ) : (
    <button type="button" className="ml-block-action" onMouseDown={(e) => { e.preventDefault(); startEdit(); }}>
      <Pencil size={13} /> 编辑
    </button>
  );

  return (
    <BlockFrame label="白板（Excalidraw）" kind="excalidraw" id={node.attrs.id} selected={selected} onDelete={() => deleteNode?.()} actions={actions}>
      {edit ? null : (
        <div className="excalidraw-preview">
          <BlockPreview
            preview={preview}
            alt="whiteboard"
            emptyText="点击「编辑」打开 Excalidraw 白板自由绘制"
            width={width}
            updateAttributes={updateAttributes}
            onEdit={startEdit}
          />
        </div>
      )}

      {edit && createPortal(
        <div
          className="modal-backdrop"
          draggable={false}
          onDragStart={(e) => e.preventDefault()}
          onMouseDown={(e) => { if (e.target === e.currentTarget) void commit(); }}
        >
          {/* Portalled to <body>: the NodeView wrapper is a ProseMirror
              draggable (data-drag-handle). Keeping the modal inside it made the
              browser start a native HTML5 drag of the whole block whenever a
              shape or the pen was dragged, and let .center scroll under the
              canvas — the "window is being dragged" feeling. */}
          <div
            className="modal excalidraw-modal"
            style={{ width: '92vw', height: '90vh', display: 'flex', flexDirection: 'column' }}
            draggable={false}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>Excalidraw 白板</span>
              <div className="drawio-head-actions">
                <button type="button" className="primary sm"
                  onMouseDown={(e) => { e.preventDefault(); void commit(); }}>
                  完成
                </button>
                <button type="button" className="modal-close"
                  onMouseDown={(e) => { e.preventDefault(); void commit(); }}>
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
        </div>,
        document.body
      )}
    </BlockFrame>
  );
});
