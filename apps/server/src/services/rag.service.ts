import { Citation, RagAnswer, StreamRagEvent } from '@zhipane/shared';
import { createAiProviderForContext, isAiDisabledError } from './ai.service';
import { hybridSearch } from './search.service';

const NO_ANSWER_SPACE = '知识库中未找到相关信息。';
const NO_ANSWER_PAGE = '当前页面中未找到相关内容。';

export async function askRag(params: {
  userId: string;
  workspaceId: string;
  spaceId?: string;
  query: string;
  limit: number;
  extendedThinking: boolean;
  pageId?: string;
}): Promise<RagAnswer> {
  const results = await hybridSearch({ ...params });
  if (results.length === 0) {
    return { answer: params.pageId ? NO_ANSWER_PAGE : NO_ANSWER_SPACE, citations: [], usedExtendedThinking: false };
  }

  const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join('\n\n');
  // Every RAG call goes through the context-aware provider so the Space AI
  // policy (local_only / disabled) is always honoured.
  const ai = await createAiProviderForContext({
    workspaceId: params.workspaceId,
    spaceId: params.spaceId,
    userId: params.userId
  });
  const answer = await ai.generateText([
    { role: 'system', content: 'You answer strictly from the provided knowledge base context. Cite sources using [1], [2]. If context is insufficient, say so clearly.' },
    { role: 'user', content: `Context:\n${context}\n\nQuestion:\n${params.query}` }
  ]);

  const citations: Citation[] = results.map((r) => ({
    pageId: r.pageId,
    topicId: r.topicId,
    chunkId: r.id,
    title: r.title,
    excerpt: r.content.slice(0, 260),
    score: r.score
  }));

  return { answer, citations, usedExtendedThinking: params.extendedThinking };
}

/**
 * True streaming RAG. Yields Server-Sent-Events in this order so the UI can
 * show provenance *before* the answer text:
 *
 *   1. `sources`   — the full citation list (what the answer is built from)
 *   2. `token`     — answer text, chunk by chunk, as it is generated
 *   3. `citation`  — emitted the moment a `[n]` marker is first seen, so a
 *                      referenced source surfaces exactly when it is used
 *   4. `done`      — final answer + persisted session id
 *   5. `error`     — only on failure (e.g. AI disabled for the space)
 *
 * The function never throws: failures are surfaced as an `error` event so the
 * SSE stream can close gracefully.
 */
export async function* streamRag(params: {
  userId: string;
  workspaceId: string;
  spaceId?: string;
  query: string;
  limit: number;
  extendedThinking: boolean;
  pageId?: string;
}): AsyncGenerator<StreamRagEvent> {
  let citations: Citation[] = [];
  try {
    const results = await hybridSearch({ ...params });
    citations = results.map((r) => ({
      pageId: r.pageId,
      topicId: r.topicId,
      chunkId: r.id,
      title: r.title,
      excerpt: r.content.slice(0, 260),
      score: r.score
    }));
    // Provenance first: the user sees where the answer comes from before any text.
    yield { type: 'sources', citations };

    if (results.length === 0) {
      const refusal = params.pageId ? NO_ANSWER_PAGE : NO_ANSWER_SPACE;
      for (const part of refusal.match(/.{1,32}/g) ?? [refusal]) {
        yield { type: 'token', text: part };
      }
      yield { type: 'done', answer: refusal };
      return;
    }

    const context = results.map((r, i) => `[${i + 1}] ${r.title}\n${r.content}`).join('\n\n');
    const ai = await createAiProviderForContext({
      workspaceId: params.workspaceId,
      spaceId: params.spaceId,
      userId: params.userId
    });

    let answer = '';
    const seen = new Set<number>();
    for await (const token of ai.streamText([
      { role: 'system', content: 'You answer strictly from the provided knowledge base context. Cite sources using [1], [2]. If context is insufficient, say so clearly.' },
      { role: 'user', content: `Context:\n${context}\n\nQuestion:\n${params.query}` }
    ])) {
      answer += token;
      yield { type: 'token', text: token };
      // Surface a citation the moment its [n] marker first appears.
      const refs = answer.match(/\[(\d+)\]/g) ?? [];
      for (const ref of refs) {
        const idx = Number(ref.slice(1, -1));
        if (!seen.has(idx) && idx >= 1 && idx <= citations.length) {
          seen.add(idx);
          yield { type: 'citation', index: idx, citation: citations[idx - 1] };
        }
      }
    }
    yield { type: 'done', answer };
  } catch (err) {
    if (isAiDisabledError(err)) {
      yield { type: 'error', message: 'AI is disabled for this space' };
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    yield { type: 'error', message };
  }
}
