import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

export default function ExcalidrawCanvas({
  initialElements,
  initialAppState,
  initialFiles,
  onApiReady
}: {
  initialElements: any[];
  initialAppState: any;
  initialFiles: any;
  onApiReady: (api: any) => void;
}) {
  return (
    <Excalidraw
      excalidrawAPI={onApiReady}
      initialData={{
        elements: initialElements,
        appState: { ...initialAppState, isLoading: false },
        files: initialFiles
      }}
      langCode="zh-CN"
    />
  );
}
