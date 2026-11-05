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

/** Human-readable LLM processing state, shared by the editor and the kb toolbar. */
export const LLM_STATUS_LABEL: Record<string, string> = {
  pending: '待整理', processing: '整理中', done: '已整理', processed: '已整理',
  failed: '整理失败', skipped: '已跳过', ignored: '未整理'
};

export interface EditorStatus {
  hasPage: boolean;
  saveState: SaveState;
  pageTitle?: string;
  /** Extra read-only page info consumed by the kb toolbar. */
  pageId?: string;
  contentVersion?: number;
  llmStatus?: string;
  favorite?: boolean;
  onSave?: () => void;
  onShare?: () => void;
  onExport?: () => void;
  onImport?: () => void;
  onDelete?: () => void;
  onPrint?: () => void;
  onToggleFavorite?: () => void;
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
