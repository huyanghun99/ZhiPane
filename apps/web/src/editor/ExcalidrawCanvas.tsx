import { Excalidraw, exportToBlob, exportToSvg } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

export default function ExcalidrawCanvas({
  initialElements,
  initialAppState,
  initialFiles,
  onApiReady,
  onChange,
  theme
}: {
  initialElements: any[];
  initialAppState: any;
  initialFiles: any;
  onApiReady: (api: any) => void;
  onChange?: (elements: readonly any[], appState: any, files: any) => void;
  theme?: 'light' | 'dark';
}) {
  return (
    <Excalidraw
      excalidrawAPI={onApiReady}
      onChange={onChange}
      theme={theme}
      initialData={{
        elements: initialElements,
        appState: { ...initialAppState, isLoading: false },
        files: initialFiles
      }}
      langCode="zh-CN"
    />
  );
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/**
 * Build the document-flow preview from a scene. `exportToBlob` / `exportToSvg`
 * are named exports of the package — they are NOT methods on the imperative
 * API returned by `excalidrawAPI`. Calling `api.exportToBlob()` used to throw,
 * get swallowed by a catch, and persist an empty `preview` (which is why saved
 * whiteboards rendered as an empty placeholder).
 *
 * SVG is a second chance when PNG rasterisation fails (e.g. font loading or a
 * canvas tainted by an image file). Both live in this lazily-loaded module so
 * the editor entry chunk stays small.
 */
export async function exportPreview(elements: any[], appState: any, files: any): Promise<string> {
  const opts = {
    elements,
    appState: {
      ...appState,
      exportBackground: true,
      exportWithDarkMode: false,
      viewBackgroundColor: appState?.viewBackgroundColor || '#ffffff'
    },
    files,
    exportPadding: 16
  };
  try {
    const blob = await exportToBlob({ ...opts, mimeType: 'image/png' });
    return await blobToDataURL(blob);
  } catch {
    const svg = await exportToSvg(opts);
    const markup = new XMLSerializer().serializeToString(svg);
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  }
}
