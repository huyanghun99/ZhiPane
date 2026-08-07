/* Light/dark/system theme handling.
   - "system"  → follow OS preference (no data-theme attribute, so the
                prefers-color-scheme media query in themes/dark.css applies)
   - "light"  → force light
   - "dark"   → force dark
   Choice is persisted in localStorage. */

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'zhipane:theme';
const ORDER: ThemeMode[] = ['system', 'light', 'dark'];

export function getTheme(): ThemeMode {
  const v = localStorage.getItem(KEY);
  return v === 'light' || v === 'dark' || v === 'system' ? v : 'system';
}

export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

export function setTheme(mode: ThemeMode): void {
  localStorage.setItem(KEY, mode);
  applyTheme(mode);
}

export function initTheme(): void {
  applyTheme(getTheme());
}

/** Cycle system → light → dark → system. Returns the next mode. */
export function cycleTheme(current: ThemeMode): ThemeMode {
  const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
  setTheme(next);
  return next;
}
