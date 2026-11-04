import { Excalidraw } from '@excalidraw/excalidraw';
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
