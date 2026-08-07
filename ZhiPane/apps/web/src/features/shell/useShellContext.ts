import { useEffect, useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import type { MainRoute, PageDetail, Space, User, Workspace } from '../../types';

const LAST_SPACE_KEY = 'zhipane:last-space';

export function loadLastSpace(): { workspaceId: string; spaceId: string } | null {
  try {
    const raw = localStorage.getItem(LAST_SPACE_KEY);
    return raw ? (JSON.parse(raw) as { workspaceId: string; spaceId: string }) : null;
  } catch {
    return null;
  }
}

export function saveLastSpace(v: { workspaceId: string; spaceId: string }) {
  try {
    localStorage.setItem(LAST_SPACE_KEY, JSON.stringify(v));
  } catch {
    /* ignore quota / privacy-mode errors */
  }
}

interface Parsed {
  workspaceId?: string;
  spaceId?: string;
  pageId?: string;
}

/** Parse the current pathname/search into the route's explicit ids. */
export function parsePath(pathname: string, search: string): Parsed {
  let m: RegExpMatchArray | null;
  if ((m = pathname.match(/^\/w\/([^/]+)\/s\/([^/]+)/))) return { workspaceId: m[1], spaceId: m[2] };
  if ((m = pathname.match(/^\/p\/([^/]+)/))) return { pageId: m[1] };
  if ((m = pathname.match(/^\/(wiki|ask|map)\/([^/]+)/))) return { spaceId: m[2] };
  if (pathname === '/search') {
    const sp = new URLSearchParams(search).get('spaceId') ?? undefined;
    return { spaceId: sp };
  }
  if (pathname === '/tasks') return {};
  return {};
}

/** Map a URL to the legacy top-nav key (for sidebar active highlighting). */
export function activeRouteFromPath(pathname: string): MainRoute {
  if (/^\/wiki\//.test(pathname)) return 'organize';
  if (/^\/ask\//.test(pathname)) return 'ask';
  if (/^\/map\//.test(pathname)) return 'map';
  if (pathname === '/search') return 'search';
  if (pathname === '/archive') return 'archive';
  if (pathname === '/tasks') return 'tasks';
  if (/^\/p\//.test(pathname)) return 'page';
  return 'home';
}

/**
 * Resolve the "current workspace + space" purely from the URL.
 *
 * - `/w/:workspaceId/s/:spaceId` → both ids are explicit.
 * - `/p/:pageId` → the page detail API returns `spaceId` + `workspaceId`.
 * - `/wiki/:spaceId`, `/ask/:spaceId`, `/map/:spaceId`, `/search?spaceId=`
 *   → only the space is known, so we scan the user's workspaces to find which
 *   workspace owns it (no backend change needed; the spaces list is cached).
 *
 * The resolved pair is persisted to localStorage so `/` can deep-link back.
 */
export function useShellContext(me: User) {
  const location = useLocation();
  const parsed = useMemo(
    () => parsePath(location.pathname, location.search),
    [location.pathname, location.search]
  );

  const { data: wsData } = useQuery<{ workspaces: Workspace[] }>({
    queryKey: ['workspaces'],
    queryFn: () => api('/api/workspaces')
  });
  const workspaces = wsData?.workspaces ?? [];

  // `/p/:pageId` → resolve space + workspace from the page itself.
  const { data: pageData, isError: pageError } = useQuery<{ page: PageDetail }>({
    queryKey: ['page-detail', parsed.pageId],
    enabled: !!parsed.pageId,
    queryFn: () => api(`/api/pages/${parsed.pageId}`)
  });
  const pageSpaceId = pageData?.page?.spaceId;
  const pageWorkspaceId = pageData?.page?.workspaceId;

  // spaceId only (deep link) → scan workspaces to find the owning workspace.
  const { data: resolved, isError: resolveError } = useQuery<{ workspaceId: string; spaceId: string } | null>({
    queryKey: ['resolve-space', parsed.spaceId, workspaces.map((w) => w.id).join('|')],
    enabled: !!parsed.spaceId && !parsed.workspaceId && !pageWorkspaceId && workspaces.length > 0,
    queryFn: async () => {
      for (const w of workspaces) {
        const sp = await api<{ spaces: Space[] }>(`/api/spaces?workspaceId=${w.id}`);
        if (sp.spaces.some((s) => s.id === parsed.spaceId)) {
          return { workspaceId: w.id, spaceId: parsed.spaceId! };
        }
      }
      return null;
    }
  });

  // /tasks is a workspace-scoped route but carries no ids in the URL; default
  // to the first available workspace so the workbench can render immediately.
  const defaultWorkspaceId = location.pathname === '/tasks' && !parsed.workspaceId
    ? workspaces[0]?.id
    : undefined;

  const workspaceId = parsed.workspaceId ?? pageWorkspaceId ?? resolved?.workspaceId ?? defaultWorkspaceId;
  const spaceId = parsed.spaceId ?? pageSpaceId ?? resolved?.spaceId;

  const { data: spData } = useQuery<{ spaces: Space[] }>({
    queryKey: ['spaces', workspaceId],
    enabled: !!workspaceId,
    queryFn: () => api(`/api/spaces?workspaceId=${workspaceId}`)
  });
  const spaces = spData?.spaces ?? [];

  const workspace = workspaces.find((w) => w.id === workspaceId) ?? null;
  const space = spaces.find((s) => s.id === spaceId) ?? null;

  useEffect(() => {
    if (workspace?.id && space?.id) saveLastSpace({ workspaceId: workspace.id, spaceId: space.id });
  }, [workspace?.id, space?.id]);

  const activeRoute = activeRouteFromPath(location.pathname);

  const isResolving =
    (!!parsed.pageId && !pageData && !pageError) ||
    (!!parsed.spaceId && !parsed.workspaceId && !pageWorkspaceId && !resolved && !resolveError);

  return {
    me,
    workspaces,
    spaces,
    workspace,
    space,
    pageId: parsed.pageId ?? null,
    pageTitle: pageData?.page?.title,
    activeRoute,
    isResolving
  };
}
