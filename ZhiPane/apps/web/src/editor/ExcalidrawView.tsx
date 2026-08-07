import { lazy, Suspense, useState } from 'react';
import { type NodeViewProps } from '@tiptap/react';
import { Pencil, Check } from 'lucide-react';
import { BlockFrame } from './BlockFrame';
import { ExcalidrawErrorBoundary } from './ExcalidrawErrorBoundary';

const ExcalidrawCanvas = lazy(() => import('./ExcalidrawCanvas'));

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

function ExcalidrawView({ node, updateAttributes, selected, deleteNode }: NodeViewProps) {
  const elements = (node.attrs.elements as unknown[]) || [];
  const appState = (node.attrs.appState as object) || {};
  const files = (node.attrs.files as Record<string, unknown>) || {};
  const preview = (node.attrs.preview as string) || '';
  const [edit, setEdit] = useState(false);
  const [api, setApi] = useState<unknown>(null);

  const startEdit = () => {
    setApi(null);
    setEdit(true);
  };

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
      // Export may fail on an empty scene; keep the diagram data regardless.
    }
    updateAttributes({ elements: els, appState: appSt, files: f, preview: png });
    setEdit(false);
  };

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
      {edit ? (
        <div className="excalidraw-canvas">
          <ExcalidrawErrorBoundary onReset={startEdit}>
            <Suspense fallback={<div className="excalidraw-loading">加载白板编辑器…</div>}>
              <ExcalidrawCanvas
                initialElements={elements}
                initialAppState={appState}
                initialFiles={files}
                onApiReady={setApi}
              />
            </Suspense>
          </ExcalidrawErrorBoundary>
        </div>
      ) : preview ? (
        <div className="excalidraw-preview" contentEditable={false} onDoubleClick={startEdit}>
          <img src={preview} alt="whiteboard" />
        </div>
      ) : (
        <div className="excalidraw-empty" contentEditable={false} onDoubleClick={startEdit}>
          点击「编辑」打开 Excalidraw 白板自由绘制
        </div>
      )}
    </BlockFrame>
  );
}

export { ExcalidrawView };
