export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AiProvider {
  generateText(messages: AiMessage[]): Promise<string>;
  streamText(messages: AiMessage[]): AsyncGenerator<string>;
  embed(text: string): Promise<number[]>;
  /** Batch embedding. Default implementation falls back to per-item `embed`. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /**
   * Phase H (N2): the embedding model name used by this provider, so callers
   * can build model-aware cache keys. MockAiProvider returns 'mock-embedding'.
   */
  readonly embeddingModel?: string;
  /**
   * Phase H (N2): usage from the most recent generateText call, if the
   * upstream returned one. Used by the job worker to persist
   * actualPromptTokens / actualCompletionTokens for cost observability.
   * Returns null when the provider does not report usage (mock, or upstream
   * omitted the field).
   */
  getLastUsage?(): AiUsage | null;
}

export const DEFAULT_EMBEDDING_DIMENSION = 1536;

/**
 * Deterministic embedding vector derived from text content.
 * Used by the MockAiProvider so tests and local development
 * do not depend on a real embedding service.
 */
export function deterministicVector(text: string, dimension: number = DEFAULT_EMBEDDING_DIMENSION): number[] {
  const out = new Array<number>(dimension).fill(0);
  for (let i = 0; i < text.length; i++) {
    const idx = i % dimension;
    out[idx] += ((text.charCodeAt(i) % 97) / 97) - 0.5;
  }
  const norm = Math.sqrt(out.reduce((acc, n) => acc + n * n, 0)) || 1;
  return out.map((n) => Number((n / norm).toFixed(6)));
}

/**
 * Mock provider used by tests and local development.
 * All AI-related automated tests MUST use this provider
 * (per project constraint: no real LLM calls in CI).
 */
export class MockAiProvider implements AiProvider {
  readonly embeddingModel: string = 'mock-embedding';

  constructor(private readonly dimension: number = DEFAULT_EMBEDDING_DIMENSION) {}

  async generateText(messages: AiMessage[]): Promise<string> {
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    const last = messages[messages.length - 1]?.content ?? '';

    // P0-6: route by PROMPT_VERSION marker first (replaces fragile keyword
    // matching). The marker is injected by wiki.service.ts as
    // "[PROMPT_VERSION:<version>] <system message>".
    const versionMatch = system.match(/\[PROMPT_VERSION:([^\]]+)\]/);
    const promptVersion = versionMatch?.[1] ?? '';

    // P0-6: topic-routing mock. Returns a 7-action routing decision for each
    // incoming Claim. Default strategy: route the first Claim to
    // create_emerging (so tests can verify new Topic creation), and remaining
    // Claims to keep_as_facet (chapter-level content). If existing Topics are
    // provided, route to update_existing instead.
    // P0-7: topic-extraction mock. Aggregates facets into 1-2 core candidate
    // topics (instead of one-per-heading) so consolidateCandidates has enough
    // evidence (multi-chunk, multi-claim) to create a formal Topic.
    if (promptVersion === 'topic-extraction-v1') {
      const titleLine = last.match(/页面标题：(.+)/);
      let pageTitle = titleLine ? titleLine[1].trim() : '知识主题';
      // P0-7: strip common copy/import suffixes so a re-import of the same
      // article produces the same candidate title and matches the existing
      // Topic's normalized title (idempotency).
      pageTitle = pageTitle.replace(/\s*[（(][^）)]*[）)]\s*$/g, '').trim();
      // Return the page title as the single core candidate topic.
      return JSON.stringify({
        topics: [
          { title: pageTitle.slice(0, 80), summary: `围绕「${pageTitle}」的核心知识概念，综合多个章节的证据形成可审阅的主题。` }
        ]
      });
    }

    if (promptVersion === 'topic-routing-v1') {
      const claimMatches = [...last.matchAll(/\[([^\]]+)\] \(section[^)]*\) (.+)/g)];
      const existingTopicMatches = [...last.matchAll(/\[([^\]]+)\] .+?（别名：/g)];
      const existingTopicId = existingTopicMatches[0]?.[1];
      const decisions = claimMatches.map((m, i) => {
        const claimId = m[1];
        const claimText = m[2];
        if (i === 0 && existingTopicId) {
          return { claimId, routingAction: 'update_existing', targetTopicId: existingTopicId, reason: '与已有 Topic 高度匹配，优先更新' };
        }
        if (i === 0) {
          return { claimId, routingAction: 'create_emerging', newTopicTitle: claimText.slice(0, 40), reason: '边界清晰，具有长期复用价值' };
        }
        return { claimId, routingAction: 'keep_as_facet', reason: '章节性内容，保留为页面 Facet' };
      });
      return JSON.stringify({ decisions });
    }

    // P0-6: claim-relation mock. Returns supports/unrelated for pairs.
    if (promptVersion === 'claim-relation-v1') {
      const claimMatches = [...last.matchAll(/\[([^\]]+)\] \(section[^)]*\) (.+)/g)];
      const relations: Array<{ claimAId: string; claimBId: string; relation: string; note: string }> = [];
      for (let i = 0; i < claimMatches.length; i++) {
        for (let j = i + 1; j < claimMatches.length; j++) {
          relations.push({
            claimAId: claimMatches[i][1],
            claimBId: claimMatches[j][1],
            relation: i === 0 && j === 1 ? 'supports' : 'unrelated',
            note: i === 0 && j === 1 ? '两个 Claim 描述同一概念的互补方面' : '两个 Claim 主题不同'
          });
        }
      }
      return JSON.stringify({ relations });
    }

    // P0-5: topic-repair mock. Detected by the "知识综合修复助手" marker.
    // The repair prompt's user message carries the original synthesis JSON
    // plus the source material with [CID:...] (and optionally [CLID:...])
    // tokens. We return a clean synthesis that satisfies every quality gate
    // (no HTML, no redundancy, grounded citations) so the repair loop can
    // converge in tests.
    if (system.includes('知识综合修复助手')) {
      // Parse [CID:...] blocks with their following content so the repaired
      // keyPoints stay grounded in the source (avoids off_topic_drift).
      // The chunk repair prompt uses "[CID:id]\ncontent"; the claim repair
      // prompt uses "[CID:id][CLID:id]\ncontent". Match both.
      const cidBlocks = [...last.matchAll(/\[CID:([^\]]+)\](?:\[CLID:([^\]]+)\])?\n([\s\S]*?)(?=\n\n\[CID:|$)/g)];
      const clidTokens = [...last.matchAll(/\[CLID:([^\]]+)\]/g)].map((m) => m[1]);
      const citations = cidBlocks.slice(0, 3).map((b, i) => {
        const chunkId = b[1];
        const inlineClaimId = b[2]; // from [CID:...][CLID:...] if present
        const rawContent = b[3].replace(/\s+/g, ' ').trim();
        const snippet = rawContent.slice(0, 80);
        const claimId = inlineClaimId ?? clidTokens[i] ?? clidTokens[0];
        return { chunkId, claimId, excerpt: snippet, content: rawContent };
      });
      return JSON.stringify({
        schemaVersion: 'topic-synthesis-v1',
        definition: '修复后的主题定义：基于资料中可追溯的证据形成可审阅的结论，避免与概述重复。',
        overview: '修复后的概述：综合过程保留引用边界、区分已证实信息与待验证假设，并避免把局部段落直接当作主题正文。所有内容均来自资料，未引入无关主题。',
        keyPoints: citations.map((c, i) => ({
          id: `mock-repair-${i + 1}`,
          title: `修复要点 ${i + 1}`,
          // P0-5: paraphrase instead of copying source verbatim — a >=120 char
          // verbatim run trips the source_copy_too_long quality gate.
          content: `基于资料中关于「${c.content.slice(0, 30).trim()}」的证据，可归纳为修复后的要点 ${i + 1}，强调可追溯的结论与独立分析。`,
          citations: [{ chunkId: c.chunkId, claimId: c.claimId, excerpt: c.excerpt }]
        })),
        subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [], generatedFromContentVersions: []
      });
    }
    // P0-3: facet-based topic routing prompt.
    if (system.includes('主题路由助手')) {
      const facetMatch = last.match(/\[Facet\]\s*(.+)/);
      const title = facetMatch ? facetMatch[1].trim().slice(0, 40) : '知识主题';
      return JSON.stringify({ topics: [{ title, summary: '从 Facet 派生的候选主题' }] });
    }
    // P0-4: Claim-Evidence synthesis mock. Detected by the 'Claim-Evidence 模型'
    // marker in the system prompt. Returns a valid topic-synthesis-v1 whose
    // keyPoint citations include both chunkId (CID) and claimId (CLID) parsed
    // from the input context, so tests can validate the Claim-Evidence flow.
    if (system.includes('Claim-Evidence 模型')) {
      const claimBlocks = [...last.matchAll(/\[CLID:([^\]]+)\][^\n]*\n([^\n]+)\nEvidence:\n([\s\S]*?)(?=\n\n\[CLID:|$)/g)];
      const citations = claimBlocks.slice(0, Math.max(1, Math.min(3, claimBlocks.length))).map((b) => {
        const claimId = b[1];
        const claimText = b[2];
        const evMatch = b[3].match(/\[CID:([^\]]+)\]/);
        const chunkId = evMatch ? evMatch[1] : 'unknown-chunk';
        // Extract a real snippet from the evidence block so the citation
        // excerpt and keyPoint content stay grounded in the source (avoids
        // off_topic_drift and citation_not_supporting in P0-5 quality gate).
        const evSnippet = b[3].replace(/\[CID:[^\]]+\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return { claimId, chunkId, title: claimText.slice(0, 60), content: claimText, excerpt: evSnippet };
      });
      return JSON.stringify({
        schemaVersion: 'topic-synthesis-v1',
        definition: '该主题由多个 Claim-Evidence 捆绑包综合形成可审阅的结论，聚焦资料的核心理念。',
        overview: '基于多个 Claim 的独立证据，综合过程保留引用边界、区分已证实信息与待验证假设，避免把局部段落直接当作主题正文。',
        // P0-5: paraphrase keyPoint content so it does not verbatim-copy the
        // source claim text (avoids source_copy_too_long quality gate). The
        // citation excerpt still carries the grounding snippet.
        keyPoints: citations.map((c, i) => ({
          id: `mock-ce-${i + 1}`,
          title: c.title,
          content: `围绕「${c.title.slice(0, 20)}」这一要点，资料提供了可追溯的证据链，综合后形成独立分析结论（要点 ${i + 1}）。`,
          citations: [{ chunkId: c.chunkId, claimId: c.claimId, excerpt: c.excerpt }]
        })),
        subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [], generatedFromContentVersions: []
      });
    }
    if (system.includes('topic-synthesis-v1')) {
      const blocks = [...last.matchAll(/\[CID:([^\]]+)\][^\n]*\n([\s\S]*?)(?=\n\n\[CID:|$)/g)];
      const citations = blocks.slice(0, Math.max(1, Math.min(3, blocks.length))).map((block) => {
        const raw = block[2];
        // Extract the heading from the RAW content (before whitespace
        // collapsing) so "# Alpha\n..." yields title "Alpha", not the whole
        // collapsed line. This keeps diff title-matching working.
        const heading = raw.match(/^#{1,3}\s+(.+)$/m)?.[1]?.trim();
        const content = raw.replace(/\s+/g, ' ').trim();
        return {
          chunkId: block[1],
          title: heading || '证据要点',
          content: content.slice(0, 160),
          excerpt: content.slice(0, 100)
        };
      });
      return JSON.stringify({
        schemaVersion: 'topic-synthesis-v1',
        definition: '该主题围绕资料中的主要知识对象与证据关系形成可审阅的结论，聚焦核心理念。',
        overview: '资料显示，不同来源提供了互补线索。综合过程应保留引用边界、区分已证实信息与待验证假设，并避免把局部段落直接当作主题正文。',
        keyPoints: citations.map((citation, index) => ({ id: `mock-${index + 1}`, title: citation.title, content: citation.content, citations: [{ chunkId: citation.chunkId, excerpt: citation.excerpt }] })),
        subtopics: [], conflicts: [], decisions: [], openQuestions: [], relatedTopicIds: [], generatedFromContentVersions: []
      });
    }
    return `Mock answer based on local context. Query: ${last.slice(0, 240)}`;
  }

  async *streamText(messages: AiMessage[]): AsyncGenerator<string> {
    const text = await this.generateText(messages);
    for (const part of text.match(/.{1,32}/g) ?? []) {
      yield part;
    }
  }

  async embed(text: string): Promise<number[]> {
    return deterministicVector(text, this.dimension);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => deterministicVector(t, this.dimension));
  }
}

export interface OpenAICompatibleOptions {
  baseUrl: string;
  apiKey: string;
  completionModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDimension: number;
}

/**
 * Provider that talks to any OpenAI-compatible Chat Completions + Embeddings
 * HTTP API (e.g. OpenAI, LongCat, Qwen embeddings via ModelScope, Ollama, etc.).
 * The embedding endpoint may differ from the completion endpoint, which is why
 * `embeddingBaseUrl` / `embeddingApiKey` are separate from the chat settings.
 */
/**
 * fetch with a hard timeout and one transient retry.
 *
 * Why: a bare `fetch` to an OpenAI-compatible upstream can hang forever when
 * the upstream is degraded, pinning the calling job until the zombie reaper
 * kicks in (and then re-enqueuing into a live-lock). The timeout aborts the
 * whole request (including a streaming body) once the deadline passes; the
 * single retry covers transient 5xx / 429 / network blips.
 *
 * 4xx is NEVER retried — auth / bad-request failures will not succeed on retry.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { timeoutMs: number; retries?: number }
): Promise<Response> {
  const retries = options.retries ?? 1;
  for (let attempt = 0; ; attempt++) {
    // AbortSignal.timeout is available on Node 18+ / modern browsers and
    // aborts the fetch (incl. the streaming body) once the deadline passes.
    const signal = AbortSignal.timeout(options.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal });
      // Retry only transient failures: 5xx (server) and 429 (rate limit).
      if ((res.status >= 500 || res.status === 429) && attempt < retries) {
        await sleep(500 * 2 ** attempt); // 500ms, then 1s
        continue;
      }
      return res;
    } catch (err) {
      // Network error or timeout abort -> retry once before surfacing.
      if (attempt < retries) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      throw err;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAICompatibleProvider implements AiProvider {
  private lastUsage: AiUsage | null = null;
  readonly embeddingModel: string;

  constructor(private readonly opts: OpenAICompatibleOptions) {
    this.embeddingModel = opts.embeddingModel;
  }

  getLastUsage(): AiUsage | null {
    return this.lastUsage;
  }

  private headers(apiKey: string): Record<string, string> {
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` };
  }

  async generateText(messages: AiMessage[]): Promise<string> {
    const res = await fetchWithRetry(
      `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { method: 'POST', headers: this.headers(this.opts.apiKey), body: JSON.stringify({ model: this.opts.completionModel, messages, temperature: 0.3 }) },
      { timeoutMs: 30_000 }
    );
    if (!res.ok) {
      throw new Error(`LLM 请求失败 (${res.status}): ${await res.text().catch(() => res.statusText)}`);
    }
    const data = await res.json();
    // Phase H (N2): capture usage from the upstream response so the job worker
    // can persist actualPromptTokens / actualCompletionTokens. Most OpenAI-
    // compatible APIs return { usage: { prompt_tokens, completion_tokens } }.
    const u = data?.usage;
    if (u && typeof u.prompt_tokens === 'number' && typeof u.completion_tokens === 'number') {
      this.lastUsage = { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens };
    } else {
      this.lastUsage = null;
    }
    return data?.choices?.[0]?.message?.content ?? '';
  }

  async *streamText(messages: AiMessage[]): AsyncGenerator<string> {
    const res = await fetchWithRetry(
      `${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`,
      { method: 'POST', headers: this.headers(this.opts.apiKey), body: JSON.stringify({ model: this.opts.completionModel, messages, temperature: 0.3, stream: true }) },
      { timeoutMs: 30_000 }
    );
    if (!res.ok) {
      throw new Error(`LLM 流式请求失败 (${res.status}): ${await res.text().catch(() => res.statusText)}`);
    }
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json?.choices?.[0]?.delta?.content;
          if (delta) yield delta as string;
        } catch {
          /* ignore keep-alive / partial chunks */
        }
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    const res = await fetchWithRetry(
      `${this.opts.embeddingBaseUrl.replace(/\/$/, '')}/embeddings`,
      { method: 'POST', headers: this.headers(this.opts.embeddingApiKey), body: JSON.stringify({ model: this.opts.embeddingModel, input: text, dimensions: this.opts.embeddingDimension, encoding_format: 'float' }) },
      { timeoutMs: 60_000 }
    );
    if (!res.ok) {
      throw new Error(`向量化请求失败 (${res.status}): ${await res.text().catch(() => res.statusText)}`);
    }
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding as number[] | undefined;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('向量化响应缺少 embedding 向量');
    }
    return normalizeVector(vec, this.opts.embeddingDimension);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await fetchWithRetry(
      `${this.opts.embeddingBaseUrl.replace(/\/$/, '')}/embeddings`,
      { method: 'POST', headers: this.headers(this.opts.embeddingApiKey), body: JSON.stringify({ model: this.opts.embeddingModel, input: texts, dimensions: this.opts.embeddingDimension, encoding_format: 'float' }) },
      { timeoutMs: 60_000 }
    );
    if (!res.ok) {
      throw new Error(`批量向量化请求失败 (${res.status}): ${await res.text().catch(() => res.statusText)}`);
    }
    const data = await res.json();
    const list = data?.data as { embedding?: number[] }[] | undefined;
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('批量向量化响应缺少 embedding 向量');
    }
    // Preserve input order; the API returns embeddings in the same order.
    return list.map((d) => normalizeVector(d.embedding ?? [], this.opts.embeddingDimension));
  }
}

/** Ensure the returned vector exactly matches the configured DB dimension. */
function normalizeVector(vec: number[], dimension: number): number[] {
  if (vec.length === dimension) return vec;
  if (vec.length > dimension) return vec.slice(0, dimension);
  const out = vec.slice();
  while (out.length < dimension) out.push(0);
  return out;
}

export function vectorToSqlLiteral(vector: number[]): string {
  return `[${vector.join(',')}]`;
}
