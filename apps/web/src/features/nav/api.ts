import { api, post, patch, del } from '../../api';

// ---------------------------------------------------------------- types
export interface NavLink {
  id: string;
  groupId: string;
  name: string;
  url: string;
  iconChar: string | null;
  position: number;
  openCount: number;
  lastOpenedAt: string | null;
}

export interface NavGroup {
  id: string;
  workspaceId: string;
  title: string;
  position: number;
  links: NavLink[];
}

export interface SearchEngine {
  id: string;
  workspaceId: string;
  name: string;
  urlTemplate: string;
  isDefault: boolean;
}

// ---------------------------------------------------------------- api
export async function listNav(): Promise<{ groups: NavGroup[] }> {
  return api('/api/nav');
}

export async function createGroup(title: string, position?: number): Promise<{ group: NavGroup }> {
  return post('/api/nav/groups', { title, position });
}

export async function updateGroup(id: string, body: { title?: string; position?: number }): Promise<{ group: NavGroup }> {
  return patch(`/api/nav/groups/${id}`, body);
}

export async function deleteGroup(id: string): Promise<{ ok: true }> {
  return del(`/api/nav/groups/${id}`);
}

export async function createLink(groupId: string, body: { name: string; url: string; iconChar?: string | null; position?: number }): Promise<{ link: NavLink }> {
  return post(`/api/nav/groups/${groupId}/links`, body);
}

export async function updateLink(id: string, body: { name?: string; url?: string; iconChar?: string | null; position?: number; groupId?: string }): Promise<{ link: NavLink }> {
  return patch(`/api/nav/links/${id}`, body);
}

export async function deleteLink(id: string): Promise<{ ok: true }> {
  return del(`/api/nav/links/${id}`);
}

export async function recordOpen(id: string): Promise<{ link: NavLink }> {
  return post(`/api/nav/links/${id}/open`, {});
}

export async function reorderNav(body: {
  groups?: { id: string; position: number }[];
  links?: { id: string; groupId: string; position: number }[];
}): Promise<{ ok: true }> {
  return post('/api/nav/reorder', body);
}

export async function getSearchEngines(): Promise<{ engines: SearchEngine[] }> {
  return api('/api/nav/search-engine');
}

export async function setSearchEngine(body: { id?: string; name: string; urlTemplate: string; isDefault?: boolean }): Promise<{ engine: SearchEngine }> {
  return api('/api/nav/search-engine', { method: 'PUT', body: JSON.stringify(body) });
}

export async function exportNav(): Promise<{ groups: { id: string; title: string; links: { id: string; name: string; url: string; iconChar: string | null }[] }[] }> {
  return api('/api/nav/export');
}

export async function importNav(groups: { title: string; links: { name: string; url: string; iconChar?: string }[] }[]): Promise<{ imported: number }> {
  return post('/api/nav/import', { groups });
}

/** Build a search URL from a saved engine template. */
export function buildSearchUrl(template: string, query: string): string {
  return template.replace('%s', encodeURIComponent(query));
}

/** Extract the first character as a CSS text-icon (PersonalNav behavior). */
export function firstChar(name: string): string {
  return name ? name.trim().charAt(0).toUpperCase() : '?';
}
