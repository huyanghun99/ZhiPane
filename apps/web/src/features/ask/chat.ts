import type { StreamRagEvent } from '@zhipane/shared';

/** Minimal chat message shape — no new state layer, just view data for AskView. */
export type ChatRole = 'user' | 'assistant';
export type ChatStatus = 'retrieving' | 'streaming' | 'done' | 'error' | 'aborted';

export interface ChatCitation {
  chunkId?: string;
  pageId?: string;
  title?: string;
  excerpt?: string;
  score?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  citations: ChatCitation[];
  status: ChatStatus;
  error?: string;
}

/** Append one user question + its pending assistant reply. */
export function startTurn(messages: ChatMessage[], turnId: string, question: string): ChatMessage[] {
  return [
    ...messages,
    { id: `${turnId}:user`, role: 'user', content: question, citations: [], status: 'done' },
    { id: `${turnId}:assistant`, role: 'assistant', content: '', citations: [], status: 'retrieving' }
  ];
}

/** Immutably apply a stream event to the pending assistant message. */
export function applyRagEvent(messages: ChatMessage[], assistantId: string, ev: StreamRagEvent): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== assistantId) return m;
    switch (ev.type) {
      case 'sources':
        return { ...m, citations: ev.citations as ChatCitation[], status: 'streaming' };
      case 'token':
        return { ...m, content: m.content + ev.text, status: 'streaming' };
      case 'citation': {
        const citations = [...m.citations];
        const index = Math.max(0, ev.index - 1);
        citations[index] = ev.citation as ChatCitation;
        return { ...m, citations };
      }
      case 'done':
        return { ...m, content: m.content || ev.answer, status: 'done' };
      case 'error':
        return { ...m, status: 'error', error: ev.message };
      default:
        return m;
    }
  });
}

/** Mark a turn finished after the stream ends or is aborted by the user. */
export function finishTurn(messages: ChatMessage[], assistantId: string, status: 'done' | 'aborted' | 'error', error?: string): ChatMessage[] {
  return messages.map((m) => {
    if (m.id !== assistantId) return m;
    if (m.status === 'error') return m; // keep the real error message
    return { ...m, status, ...(error ? { error } : {}) };
  });
}
