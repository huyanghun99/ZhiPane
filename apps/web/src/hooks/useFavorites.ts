import { useCallback, useEffect, useState } from 'react';

/**
 * Client-side favorites (Phase 3).
 *
 * Phase 3 is a UI-architecture task with no new backend endpoints, so a page's
 * "收藏" flag is persisted in localStorage and kept in sync across every
 * mounted component via a custom window event.
 */
const KEY = 'zhipane.favorites.v1';
const EVENT = 'zhipane:favorites-changed';

function read(): Set<string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function write(set: Set<string>) {
  try {
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
  window.dispatchEvent(new Event(EVENT));
}

export function useFavorites() {
  const [ids, setIds] = useState<Set<string>>(() => read());

  useEffect(() => {
    const sync = () => setIds(read());
    window.addEventListener(EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback((id: string) => {
    const next = read();
    if (next.has(id)) next.delete(id);
    else next.add(id);
    write(next);
    return next.has(id);
  }, []);

  const remove = useCallback((id: string) => {
    const next = read();
    if (next.delete(id)) write(next);
  }, []);

  return { favorites: ids, isFavorite, toggle, remove };
}
