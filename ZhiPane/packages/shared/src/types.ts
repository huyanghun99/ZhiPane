export type Id = string;

export type WorkspaceRole = 'owner' | 'admin' | 'member';
export type SpaceRole = 'admin' | 'writer' | 'reader';
export type PageStatus = 'normal' | 'archived' | 'deleted';
export type LlmProcessStatus = 'pending' | 'processing' | 'processed' | 'failed' | 'ignored';
export type TopicStatus = 'suggested' | 'accepted' | 'user_edited' | 'stale' | 'archived';
export type SpaceAiPrivacyPolicy = 'inherit_workspace' | 'cloud_allowed' | 'local_only' | 'disabled';
export type AiDriver = 'mock' | 'openai' | 'openai-compatible' | 'ollama' | 'gemini';

export interface Citation {
  pageId?: string;
  topicId?: string;
  chunkId?: string;
  title: string;
  excerpt: string;
  score?: number;
}

export interface RagAnswer {
  answer: string;
  citations: Citation[];
  usedExtendedThinking: boolean;
}

export interface HybridSearchResult {
  id: string;
  pageId: string;
  spaceId: string;
  topicId?: string;
  title: string;
  content: string;
  excerpt?: string;
  source: 'bm25' | 'vector' | 'both';
  score: number;
  rank?: number;
  // Phase 5 (F5): lifecycle-aware metadata attached so the UI can surface a
  // historical warning when an archived source is cited.
  lifecycleStatus?: string;
  archivedAt?: string;
  spaceName?: string;
  spaceKind?: string;
}

export interface KnowledgeEdgeEvidence {
  sourcePageId?: string;
  sourceChunkId?: string;
  excerpt: string;
  generatedBy: 'ai' | 'user' | 'import';
  promptVersion?: string;
  confidence?: number;
}

/**
 * Server-Sent-Events emitted by the streaming RAG endpoint
 * (`POST /api/rag/ask/stream`). The client renders `sources` first
 * (so the user sees where the answer comes from), then the answer
 * tokens arrive progressively, with `citation` events surfacing a
 * referenced source the moment it is first cited.
 */
export type StreamRagEvent =
  | { type: 'sources'; citations: Citation[] }
  | { type: 'token'; text: string }
  | { type: 'citation'; index: number; citation: Citation }
  | { type: 'done'; answer: string; sessionId?: string }
  | { type: 'error'; message: string };

/** Per-page AI profile powering the right-panel summary / tags. */
export interface AiProfile {
  summary: string;
  tags: string[];
  keywords: string[];
}
