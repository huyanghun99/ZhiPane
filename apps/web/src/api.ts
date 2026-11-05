import type { StreamRagEvent, AiProfile } from '@zhipane/shared';
import type { WikiSuggestion, PageDetail, TopicCandidate } from './types';

export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    ...options
  });
  if (!res.ok) {
    let message = res.statusText;
    let data: unknown = null;
    try {
      data = await res.json();
      message = (data as { error?: string; message?: string })?.error
        ?? (data as { error?: string; message?: string })?.message
        ?? message;
    } catch {
      // non-JSON error body
    }
    throw new ApiError(message, res.status, data);
  }
  return res.json() as Promise<T>;
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function get<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'GET' });
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PUT', body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

export function del<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' });
}

/* ----------------------------------------------- streaming RAG (SSE) ----- */

/**
 * POST /api/rag/ask/stream and consume the Server-Sent-Events stream.
 * Events are delivered in this order: sources -> token* -> citation* -> done | error.
 * The caller renders provenance first, then the progressively streamed answer.
 * Returns the persisted session id (from the final `done` event).
 */
export async function streamRag(
  body: { workspaceId: string; spaceId?: string; query: string; limit?: number; extendedThinking?: boolean; pageId?: string },
  onEvent: (e: StreamRagEvent) => void,
  signal?: AbortSignal
): Promise<{ sessionId?: string }> {
  const res = await fetch('/api/rag/ask/stream', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: 5, extendedThinking: false, ...body }),
    signal
  });
  if (!res.ok || !res.body) {
    let message = res.statusText;
    try {
      const d = (await res.json()) as { error?: string };
      message = d.error ?? message;
    } catch {
      /* non-JSON error body */
    }
    onEvent({ type: 'error', message });
    return {};
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let sessionId: string | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      try {
        const ev = JSON.parse(payload) as StreamRagEvent;
        if (ev.type === 'done') sessionId = ev.sessionId;
        onEvent(ev);
      } catch {
        /* ignore malformed keep-alive chunks */
      }
    }
  }
  return { sessionId };
}

/* ------------------------------------------------- AI panel helpers ----- */

export function getAiProfile(pageId: string): Promise<{ profile: AiProfile | null }> {
  return api(`/api/pages/${pageId}/ai-profile`);
}

export function getPageSuggestions(pageId: string): Promise<{ suggestions: WikiSuggestion[] }> {
  return api(`/api/pages/${pageId}/suggestions`);
}

export function undoSuggestion(id: string): Promise<{ suggestion: unknown }> {
  return post(`/api/llm-wiki/suggestions/${id}/undo`, {});
}

export function undoTopic(id: string): Promise<{ topic: unknown }> {
  return post(`/api/llm-wiki/topics/${id}/undo`, {});
}

/* ----------------------------------- candidates (Phase 2) ---------------- */

export function getCandidates(spaceId: string, pageId?: string): Promise<{ candidates: TopicCandidate[] }> {
  const q = pageId ? `?spaceId=${spaceId}&pageId=${pageId}` : `?spaceId=${spaceId}`;
  return api(`/api/llm-wiki/candidates${q}`);
}

export function promoteCandidate(id: string): Promise<{ topic: unknown }> {
  return post(`/api/llm-wiki/candidates/${id}/promote`, {});
}

export function dismissCandidate(id: string): Promise<{ ok: boolean }> {
  return post(`/api/llm-wiki/candidates/${id}/dismiss`, {});
}

/* ----------------------------------- consolidation (Phase 3 / B1.3) ------ */

// Phase B (B1.3): clustering is asynchronous. The endpoint enqueues a
// `space.consolidate_topic_candidates` job and returns its id; poll `getJob`
// for progress, then refresh topics once it succeeds.
export function consolidateSpace(spaceId: string): Promise<{ ok: boolean; jobId: string }> {
  return post(`/api/llm-wiki/spaces/${spaceId}/consolidate`, {});
}

export interface JobStatus {
  id: string;
  type: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: { done?: number; total?: number; stage?: string };
  entityId: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export function getJob(jobId: string): Promise<JobStatus> {
  return get(`/api/jobs/${jobId}`);
}

/* ----------------------------------- Phase 4: refresh / merge / split ------- */

import type { TopicRefreshDiff, TopicOperation } from './types';

/** Generate an itemised refresh diff for a (stale) Topic without overwriting it. */
export function generateRefreshDiff(topicId: string): Promise<{ ok: boolean; diff: TopicRefreshDiff }> {
  return post(`/api/llm-wiki/topics/${topicId}/refresh-diff`, {});
}

/** Fetch the stored refresh diff (if any) for a Topic. */
export function getRefreshDiff(topicId: string): Promise<{ diff: TopicRefreshDiff | null }> {
  return api(`/api/llm-wiki/topics/${topicId}/refresh-diff`);
}

/** Apply selected items of a refresh diff to a Topic, item-by-item. */
export function applyRefreshDiff(topicId: string, itemIndexes: number[]): Promise<{ ok: boolean; applied: number; topic: unknown }> {
  return post(`/api/llm-wiki/topics/${topicId}/apply-refresh`, { itemIndexes });
}

/** Merge a Topic INTO another (the merged topic becomes a redirect stub). */
export function mergeTopic(topicId: string, targetTopicId: string): Promise<{ ok: boolean; operationId: string; survivor: unknown; merged: unknown }> {
  return post(`/api/llm-wiki/topics/${topicId}/merge`, { targetTopicId });
}

/** Split selected keyPoints of a Topic into a new Topic. */
export function splitTopic(topicId: string, title: string, keyPointIds: string[]): Promise<{ ok: boolean; operationId: string; topic: unknown; parent: unknown }> {
  return post(`/api/llm-wiki/topics/${topicId}/split`, { title, keyPointIds });
}

/** List reversible operations (merge / split) for a Topic. */
export function getTopicOperations(topicId: string): Promise<{ operations: TopicOperation[] }> {
  return api(`/api/llm-wiki/topics/${topicId}/operations`);
}

/** Undo a recorded merge / split operation. */
export function undoTopicOperation(opId: string): Promise<{ ok: boolean }> {
  return post(`/api/llm-wiki/topics/operations/${opId}/undo`, {});
}

/* ----------------------------------- Phase 5: activity / lifecycle --------- */

import type { ActivityStats, LifecycleSuggestion } from './types';

/** Record a real user activity event (search click, citation open, ...). */
export function recordActivity(body: {
  spaceId: string;
  entityType: 'topic' | 'page';
  entityId: string;
  eventType: string;
  metadata?: Record<string, unknown>;
}): Promise<{ ok: boolean }> {
  return post(`/api/llm-wiki/activity`, body);
}

/** Fetch rolled-up activity stats + recent events for a Topic. */
export function getTopicActivity(topicId: string): Promise<{ stats: ActivityStats | null; events: unknown[] }> {
  return api(`/api/llm-wiki/topics/${topicId}/activity`);
}

/** Archive a Topic (deliberate user action — the archive center). */
export function archiveTopic(topicId: string, reason?: string): Promise<{ topic: unknown }> {
  return post(`/api/llm-wiki/topics/${topicId}/archive`, { reason });
}

/** Reactivate an archived Topic (recovery path). */
export function reactivateTopic(topicId: string): Promise<{ topic: unknown }> {
  return post(`/api/llm-wiki/topics/${topicId}/reactivate`, {});
}

/** Phase B (B2.3): soft-delete a Topic (archived with reason 'deleted'). */
export function deleteTopic(topicId: string): Promise<{ ok: boolean }> {
  return del(`/api/llm-wiki/topics/${topicId}`);
}

/** Phase B (B2.1): edit a Topic — rename, edit body, pin, or set lifecycle. */
export function updateTopic(
  topicId: string,
  body: { title?: string; contentJson?: unknown; pinned?: boolean; lifecycleStatus?: string }
): Promise<{ topic: unknown }> {
  return patch(`/api/llm-wiki/topics/${topicId}`, body);
}

/** Phase B (B2.1): toggle pin on a Topic. */
export function pinTopic(topicId: string, pinned: boolean): Promise<{ topic: unknown }> {
  return updateTopic(topicId, { pinned });
}

/** Run the lifecycle evaluation job for a Space (or whole workspace). */
export function evaluateLifecycle(body: { workspaceId?: string; spaceId?: string }): Promise<{ ok: boolean; suggestions: LifecycleSuggestion[] }> {
  return post(`/api/llm-wiki/lifecycle/evaluate`, body);
}

/** List pending lifecycle Suggestions for a Space. */
export function getLifecycleSuggestions(spaceId: string): Promise<{ suggestions: LifecycleSuggestion[] }> {
  return api(`/api/llm-wiki/lifecycle/suggestions?spaceId=${spaceId}`);
}

/* ----------------------------------- Phase B3: archive center ------------------- */

import type { Space } from './types';

/** Update a Space (rename / set lifecycle / kind). */
export function updateSpace(spaceId: string, body: { name?: string; lifecycleStatus?: string; spaceKind?: string }): Promise<{ space: Space }> {
  return patch(`/api/spaces/${spaceId}`, body);
}
/** Dismiss a lifecycle (or any) suggestion — sets status='ignored'. */
export function ignoreSuggestion(id: string): Promise<{ suggestion: WikiSuggestion }> {
  return post(`/api/llm-wiki/suggestions/${id}/ignore`, {});
}
/** B3.3: list archived Topics for a Space (soft-deleted / archived). */
export function getArchivedTopics(spaceId: string): Promise<{ topics: unknown[] }> {
  return api(`/api/llm-wiki/topics?spaceId=${spaceId}&lifecycle=archived`);
}
/** B3.3: list archived Spaces for a Workspace. */
export function getArchivedSpaces(workspaceId: string): Promise<{ spaces: Space[] }> {
  return api(`/api/spaces?workspaceId=${workspaceId}&lifecycle=archived`);
}

/* ----------------------------------- Phase 6: closure / promotion --------- */

import type { ClosurePackage } from './types';

/** Generate + store a project closure package (archive wizard step). */
export function generateClosure(spaceId: string): Promise<{ ok: boolean; closure: ClosurePackage }> {
  return post(`/api/llm-wiki/projects/${spaceId}/closure`, {});
}

/** Fetch the stored closure package for a project. */
export function getClosure(spaceId: string): Promise<{ closure: ClosurePackage | null }> {
  return api(`/api/llm-wiki/projects/${spaceId}/closure`);
}

/** Confirm a recommended promotion — derive a Topic into the target Space. */
export function promoteClosureTopic(
  spaceId: string,
  topicId: string,
  targetSpaceId: string,
  newTitle?: string
): Promise<{ ok: boolean; topicId: string; operationId: string; topic: unknown }> {
  return post(`/api/llm-wiki/projects/${spaceId}/closure/promote`, { topicId, targetSpaceId, newTitle });
}

/** Archive the project Space (final step of the archive wizard). */
export function archiveProject(spaceId: string): Promise<{ space: unknown }> {
  return post(`/api/llm-wiki/projects/${spaceId}/archive`, {});
}

/** Derive (copy) a Topic into another Space; original history is preserved. */
export function deriveTopic(
  topicId: string,
  targetSpaceId: string,
  newTitle?: string
): Promise<{ ok: boolean; topicId: string; operationId: string; topic: unknown }> {
  return post(`/api/llm-wiki/topics/${topicId}/derive`, { targetSpaceId, newTitle });
}

/* ----------------------------------- tag / inbox helpers (Phase 4) -------- */

/** Persist the user-managed tag list on a page's AI profile. */
export function updatePageTags(pageId: string, tags: string[]): Promise<{ ok: boolean; tags: string[] }> {
  return api(`/api/pages/${pageId}/ai-profile`, { method: 'PATCH', body: JSON.stringify({ tags }) });
}

/** Dismiss a page from the LLM inbox (mark as not-to-be-processed). */
export function skipPageLlm(pageId: string): Promise<{ ok: boolean }> {
  return post(`/api/pages/${pageId}/skip-llm`, {});
}

/* ------------------------------- page ops (Phase 6) --------------------- */

/** Rename a page (lightweight — no content-version bump). */
export function renamePage(pageId: string, title: string): Promise<{ page: PageDetail }> {
  return put(`/api/pages/${pageId}`, { title });
}

/** Change a page's icon from the directory tree (same PUT channel as the editor). */
export function updatePageIcon(pageId: string, icon: string | null): Promise<{ page: PageDetail }> {
  return put(`/api/pages/${pageId}`, { icon });
}

/** Move / reorder a page within the tree (lightweight — see backend). */
export function movePage(
  pageId: string,
  body: { parentPageId?: string | null; position?: number }
): Promise<{ page: PageDetail }> {
  return put(`/api/pages/${pageId}`, body);
}

/** Duplicate a page into a new page with the same content. */
export function copyPage(input: {
  spaceId: string;
  title: string;
  contentJson: unknown;
  textContent: string;
}): Promise<{ page: PageDetail }> {
  return post(`/api/pages`, input);
}

/* ------------------------------- settings (Phase G S1) ------------------ */
// User-level AI provider override. The API key is encrypted server-side and
// only a masked preview is ever returned to the client.

export interface AiConfigDTO {
  driver: string;
  baseUrl: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  completionModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  personalOverrideEnabled: boolean;
}

export function getAiConfig(): Promise<{ config: AiConfigDTO | null }> {
  return get('/api/settings/ai-config');
}

export function saveAiConfig(input: {
  driver: string;
  baseUrl?: string;
  apiKey?: string;
  completionModel: string;
  embeddingModel: string;
  embeddingDimension: number;
  personalOverrideEnabled: boolean;
}): Promise<{ ok: boolean }> {
  return put('/api/settings/ai-config', input);
}

export function getAppSettings(): Promise<{ hour: number }> {
  return get('/api/settings/app');
}

export function saveAppSettings(hour: number): Promise<{ ok: boolean; hour: number }> {
  return put('/api/settings/app', { hour });
}
