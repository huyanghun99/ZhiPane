// Lightweight bridge so a citation click can scroll the editor to the exact
// chunk it references, even though the click happens in a different panel.
// The click handler stashes the chunk text; the editor consumes it once its
// content is mounted.

let pending: string | null = null;

export function setPendingScroll(text: string): void {
  pending = text;
}

export function consumePendingScroll(): string | null {
  const t = pending;
  pending = null;
  return t;
}

/** Scroll the editor root to the first top-level block containing `text`. */
export function scrollEditorToText(root: HTMLElement | null, text: string): boolean {
  if (!root) return false;
  const norm = text.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!norm) return false;
  const needle = norm.slice(0, 80);
  const blocks = Array.from(root.querySelectorAll('.editor-content > *')) as HTMLElement[];
  for (const b of blocks) {
    const bt = (b.textContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
    if (bt.includes(needle)) {
      b.scrollIntoView({ behavior: 'smooth', block: 'center' });
      b.classList.add('ml-scroll-flash');
      window.setTimeout(() => b.classList.remove('ml-scroll-flash'), 1600);
      return true;
    }
  }
  return false;
}
