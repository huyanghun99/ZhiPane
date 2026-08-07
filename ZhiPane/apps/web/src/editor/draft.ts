/**
 * Local draft persistence (Phase 4 — task 8).
 *
 * Every edit is mirrored to localStorage (debounced by the caller) so that a
 * refresh or a crash never loses uncommitted work. On load we compare the
 * stored draft against the server version and, if they differ, surface a
 * recovery prompt in the editor.
 */
export interface LocalDraft {
  title: string;
  doc: unknown;
  savedAt: number;
}

const keyFor = (pageId: string) => `zhipane:draft:${pageId}`;

export function loadDraft(pageId: string): LocalDraft | null {
  try {
    const raw = localStorage.getItem(keyFor(pageId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LocalDraft;
    if (!parsed || typeof parsed !== 'object' || !('doc' in parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveDraft(pageId: string, draft: LocalDraft): void {
  try {
    localStorage.setItem(keyFor(pageId), JSON.stringify(draft));
  } catch {
    // Quota exceeded or storage disabled — drafts are best-effort.
  }
}

export function clearDraft(pageId: string): void {
  try {
    localStorage.removeItem(keyFor(pageId));
  } catch {
    // ignore
  }
}

export function draftEquals(draft: LocalDraft, title: string, doc: unknown): boolean {
  return draft.title === title && JSON.stringify(draft.doc) === JSON.stringify(doc);
}
