/**
 * URL builders for the ZhiPane client-side router (Phase 1).
 *
 * The app is URL-driven: every primary destination is a deep-linkable route so
 * the browser back/forward buttons, refresh, and copy-paste "just work". These
 * helpers centralise the route shape so views and the shell never hard-code
 * paths. See App.tsx / ShellLayout for the route table.
 */
import type { MainRoute } from './types';
export const urls = {
  /** Canonical "space view": sidebar tree + center dashboard. */
  spaceHome: (workspaceId: string, spaceId: string) => `/w/${workspaceId}/s/${spaceId}`,
  /** Open a single page (its space is resolved from the page itself). */
  page: (pageId: string) => `/p/${pageId}`,
  /** LLM Wiki (organize) view for a space. */
  wiki: (spaceId: string) => `/wiki/${spaceId}`,
  /** RAG Q&A view for a space. */
  ask: (spaceId: string) => `/ask/${spaceId}`,
  /** Knowledge graph view for a space. */
  map: (spaceId: string) => `/map/${spaceId}`,
  /** Unified search. `q` and `spaceId` are optional query params. */
  search: (q?: string, spaceId?: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (spaceId) p.set('spaceId', spaceId);
    const s = p.toString();
    return s ? `/search?${s}` : '/search';
  },
  settings: () => '/settings',
  archive: () => '/archive',
  tasks: () => '/tasks',
  nav: () => '/nav',
  home: () => '/'
};

/** Map a legacy `MainRoute` tab key to its URL (given the current context). */
export function routeToUrl(
  route: MainRoute,
  workspaceId: string | undefined,
  spaceId: string | undefined
): string {
  // Archive Center and Settings are fixed, space-independent destinations.
  if (route === 'archive') return urls.archive();
  if (route === 'settings') return urls.settings();
  if (route === 'tasks') return urls.tasks();
  if (route === 'nav') return urls.nav();
  if (!workspaceId || !spaceId) return urls.home();
  switch (route) {
    case 'home':
      return urls.spaceHome(workspaceId, spaceId);
    case 'organize':
      return urls.wiki(spaceId);
    case 'ask':
      return urls.ask(spaceId);
    case 'map':
      return urls.map(spaceId);
    case 'search':
      return urls.search(undefined, spaceId);
    case 'page':
      // `routeToUrl` only knows workspace/space, not which page — callers that
      // need a specific page should use `urls.page(id)` directly. Fall back to
      // the space home rather than building a bogus `/p/<spaceId>` URL.
      return urls.spaceHome(workspaceId, spaceId);
  }
}
