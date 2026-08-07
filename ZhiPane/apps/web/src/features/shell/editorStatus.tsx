import { createContext, useContext, useMemo, useState } from 'react';

/**
 * Editor status bridge (Phase 3).
 *
 * The document editor lives in the center column, but its save state and its
 * primary actions (save / share / export / delete) need to surface in the
 * top bar. Rather than lifting the whole editor into App, the editor publishes
 * a small status object here and the top bar consumes it.
 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict';

export interface EditorStatus {
  hasPage: boolean;
  saveState: SaveState;
  pageTitle?: string;
  onSave?: () => void;
  onShare?: () => void;
  onExport?: () => void;
  onImport?: () => void;
  onDelete?: () => void;
  onPrint?: () => void;
}

const EMPTY: EditorStatus = { hasPage: false, saveState: 'idle' };

interface Ctx {
  status: EditorStatus;
  setStatus: (s: EditorStatus) => void;
}

const EditorStatusContext = createContext<Ctx | null>(null);

export function EditorStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<EditorStatus>(EMPTY);
  const value = useMemo(() => ({ status, setStatus }), [status]);
  return <EditorStatusContext.Provider value={value}>{children}</EditorStatusContext.Provider>;
}

export function useEditorStatus() {
  const ctx = useContext(EditorStatusContext);
  if (!ctx) throw new Error('useEditorStatus must be used within <EditorStatusProvider>');
  return ctx;
}
