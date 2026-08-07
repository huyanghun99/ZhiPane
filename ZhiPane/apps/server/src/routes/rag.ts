import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { eq, desc } from 'drizzle-orm';
import { ragAskSchema } from '@zhipane/shared';
import { authMiddleware, type AppEnv } from '../middleware/auth';
import { rateLimitMiddleware } from '../middleware/rate-limit';
import { askRag, streamRag } from '../services/rag.service';
import { isAiDisabledError, createAiProviderForContext } from '../services/ai.service';
import { db } from '../db/client';
import { ragSessions } from '@zhipane/db';
import { recordActivity } from '../services/activity.service';

export const ragRoutes = new Hono<AppEnv>();
ragRoutes.use('*', authMiddleware);
ragRoutes.post('/ask', rateLimitMiddleware('rag.ask'), zValidator('json', ragAskSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');
  let answer;
  try {
    answer = await askRag({ userId: user.id, ...input });
  } catch (err) {
    if (isAiDisabledError(err)) return c.json({ error: 'AI is disabled for this space' }, 403);
    throw err;
  }
  const [session] = await db.insert(ragSessions).values({
    workspaceId: input.workspaceId, spaceId: input.spaceId ?? null, userId: user.id,
    query: input.query, answer: answer.answer, citations: answer.citations
  }).returning();
  // Phase 5 (F3): a RAG answer that finally cites a Topic is genuine activity.
  if (input.spaceId) {
    for (const cit of answer.citations) {
      if (cit.topicId) {
        await recordActivity({ workspaceId: input.workspaceId, spaceId: input.spaceId, entityType: 'topic', entityId: cit.topicId, eventType: 'rag_citation', userId: user.id }).catch(() => {});
      }
    }
  }
  return c.json({ ...answer, sessionId: session.id });
});

// Real Server-Sent-Events stream. Events arrive in this order:
//   sources -> token* -> citation* -> done (with sessionId) | error
// so the client can show provenance *before* the answer text.
ragRoutes.post('/ask/stream', rateLimitMiddleware('rag.ask.stream'), zValidator('json', ragAskSchema), async (c) => {
  const user = c.get('user');
  const input = c.req.valid('json');

  // Pre-check the space policy. A disabled space must not even open the stream.
  try {
    await createAiProviderForContext({ workspaceId: input.workspaceId, spaceId: input.spaceId, userId: user.id });
  } catch (err) {
    if (isAiDisabledError(err)) return c.json({ error: 'AI is disabled for this space' }, 403);
    throw err;
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));

      let citations: unknown[] = [];
      let answer = '';
      let sessionId: string | undefined;
      try {
        for await (const ev of streamRag({ userId: user.id, ...input })) {
          if (ev.type === 'sources') citations = ev.citations;
          if (ev.type === 'done') {
            answer = ev.answer;
            // Persist the session so it shows up in history.
            const [session] = await db.insert(ragSessions).values({
              workspaceId: input.workspaceId, spaceId: input.spaceId ?? null, userId: user.id,
              query: input.query, answer, citations
            }).returning();
            sessionId = session?.id;
            send({ type: 'done', answer, sessionId });
            continue;
          }
          send(ev);
        }
      } catch (err) {
        send({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    }
  });
});

ragRoutes.get('/sessions', async (c) => {
  const user = c.get('user');
  const rows = await db.select().from(ragSessions).where(eq(ragSessions.userId, user.id)).orderBy(desc(ragSessions.createdAt)).limit(50);
  return c.json({ sessions: rows });
});

ragRoutes.get('/sessions/:id', async (c) => {
  const user = c.get('user');
  const [session] = await db.select().from(ragSessions).where(eq(ragSessions.id, c.req.param('id'))).limit(1);
  if (!session) return c.json({ error: 'Not found' }, 404);
  if (session.userId !== user.id) return c.json({ error: 'Forbidden' }, 403);
  return c.json({ session });
});
