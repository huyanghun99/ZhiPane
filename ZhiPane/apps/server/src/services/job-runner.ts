import { and, eq, or, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { documentChunks, jobs } from '@zhipane/db';
import { env } from '../env';
import { createAiProviderForContext, isAiDisabledError, vectorToSqlLiteral, type AiProvider } from './ai.service';
import * as metrics from './job-metrics';
import { tokenizeChineseFriendly, segmentProseMirrorContent } from '../utils/text';
import { generateWikiArtifacts, markTopicsStaleForPage, refreshTopicSuggestions, buildPageProfile, consolidateCandidates } from './wiki.service';
import { generatePageKnowledgeArtifacts } from './page-knowledge.service';
import { evaluateLifecycle } from './lifecycle.service';
import { generateClosurePackage, storeClosurePackage } from './closure.service';
import { logger } from './logger';

export interface EnqueueInput {
  workspaceId?: string;
  spaceId?: string;
  entityType: string;
  entityId?: string;
  type: string;
  payload?: Record<string, unknown>;
  runAfterSeconds?: number;
  priority?: number;
  /** Page/content version captured at enqueue time. Lets the worker skip stale jobs. */
  sourceVersion?: number;
  /** Optional explicit dedupe key. Defaults to `${entityType}:${entityId}:${type}`. */
  dedupeKey?: string;
}

// The transaction client (PgTransaction) and the top-level `db` share the
// same query-builder surface, so we treat them interchangeably here.
type Executor = any;

/**
 * Enqueue a job. When `exec` (a transaction client) is supplied the insert
 * happens inside that transaction; otherwise a fresh transaction is opened.
 *
 * Dedupe: if a `dedupeKey` resolves (default = entity+type), any existing
 * *active* (pending/running) job with the same key is cancelled first, so only
 * the latest version of a page/topic stays queued. No Redis / BullMQ involved.
 */
export async function enqueueJob(input: EnqueueInput, exec: Executor = db): Promise<{ jobId: string }> {
  const dedupeKey =
    input.dedupeKey ?? (input.entityId ? `${input.entityType}:${input.entityId}:${input.type}` : undefined);

  const doEnqueue = async (tx: Executor): Promise<{ jobId: string }> => {
    if (dedupeKey) {
      await tx
        .update(jobs)
        .set({ status: 'cancelled', updatedAt: sql`now()` })
        .where(and(eq(jobs.dedupeKey, dedupeKey), or(eq(jobs.status, 'pending'), eq(jobs.status, 'running'))));
    }
    const payload: Record<string, unknown> = {
      ...(input.payload ?? {}),
      ...(input.sourceVersion != null ? { sourceVersion: input.sourceVersion } : {})
    };
    const [row] = await tx
      .insert(jobs)
      .values({
        workspaceId: input.workspaceId ?? null,
        spaceId: input.spaceId ?? null,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        type: input.type,
        payload,
        sourceVersion: input.sourceVersion ?? null,
        dedupeKey: dedupeKey ?? null,
        runAfter: sql`now() + (${input.runAfterSeconds ?? 0} || ' seconds')::interval`,
        priority: input.priority ?? 100
      })
      .returning({ id: jobs.id });
    return { jobId: row.id };
  };

  if (exec === db) {
    let jobId = '';
    await db.transaction(async (tx) => {
      ({ jobId } = await doEnqueue(tx));
    });
    return { jobId };
  }
  return doEnqueue(exec);
}

async function processPageLlm(job: any) {
  const rows = await db.execute<any>(sql`SELECT * FROM pages WHERE id = ${job.entity_id} LIMIT 1`);
  const page = rows.rows[0];
  if (!page) return;

  // Stale-version guard: if the page has been updated beyond the version this
  // job captured, skip it — a newer job with the correct version will run.
  const sourceVersion: number | undefined =
    job.source_version ?? (job.payload?.sourceVersion as number | undefined);
  if (sourceVersion != null && page.content_version > sourceVersion) {
    await db.execute(
      sql`UPDATE jobs SET status='cancelled', error_message='stale version', updated_at=now() WHERE id=${job.id}`
    );
    metrics.recordSkipped(`page ${page.id} stale version (job captured ${sourceVersion}, page at ${page.content_version})`);
    return;
  }

  let ai: AiProvider;
  try {
    ai = await createAiProviderForContext({ workspaceId: page.workspace_id, spaceId: page.space_id });
  } catch (err) {
    if (isAiDisabledError(err)) {
      // disabled space: never run AI / Embedding / Wiki. Mark the page ignored
      // and the job succeeded (nothing to do) so it is not retried.
      await db.execute(
        sql`UPDATE pages SET llm_process_status='ignored', llm_processed_at=now() WHERE id=${page.id}`
      );
      await db.execute(sql`UPDATE jobs SET status='succeeded', updated_at=now() WHERE id=${job.id}`);
      metrics.recordSuccess(job.type);
      return;
    }
    throw err;
  }

  await db.execute(sql`UPDATE pages SET llm_process_status = 'processing' WHERE id = ${page.id}`);
  await db.execute(sql`DELETE FROM document_chunks WHERE page_id = ${page.id}`);

  // P0-2 (LLM wiki优化.md): 结构化语义分段 — 优先按章节/段落切分,
  // 禁止从句子中间截断。保留标题层级用于 headingPath 上下文。
  const segments = segmentProseMirrorContent(page.content_json, page.text_content || '', 800);
  const chunks = segments.map((s) => s.text);

  // ---- Batch embedding (Phase 2 perf) ----
  // One network round-trip for the whole page instead of one-per-chunk.
  // Falls back to best-effort per-chunk embedding if the batch call fails.
  let embeddings: (number[] | null)[];
  try {
    embeddings = await ai.embedBatch(chunks);
  } catch (err) {
    logger.warn('batch embedding failed, falling back to per-chunk', {
      pageId: page.id,
      err: err instanceof Error ? err.message : String(err)
    });
    embeddings = await Promise.all(
      chunks.map(async (c): Promise<number[] | null> => {
        try {
          return await ai.embed(c);
        } catch (e) {
          logger.warn('embedding failed for chunk', { err: e instanceof Error ? e.message : String(e) });
          return null;
        }
      })
    );
  }

  const embeddingModel: string | null = env.AI_EMBEDDING_MODEL;
  const embeddingDim: number | null = env.EMBEDDING_DIMENSION;

  // ---- Batch INSERT (Phase 2 perf) ----
  // All chunks land in ONE insert statement, not N sequential writes.
  if (chunks.length > 0) {
    const values: any[] = chunks.map((content, i) => {
      const emb = embeddings[i];
      return {
        workspaceId: page.workspace_id,
        spaceId: page.space_id,
        pageId: page.id,
        chunkIndex: i,
        title: page.title,
        content,
        ftsTokens: tokenizeChineseFriendly(content),
        embedding: emb ? sql`${vectorToSqlLiteral(emb)}::vector` : null,
        embeddingModel,
        embeddingDimension: embeddingDim
      };
    });
    await db.insert(documentChunks).values(values);
  }

  await generatePageKnowledgeArtifacts(page.id);

  // Phase 2 (D3): structured Page Profile (summary + tags + keywords + entities).
  const profile = buildPageProfile(page.text_content || '', page.title);
  await db.execute(sql`
    INSERT INTO page_ai_profiles(page_id, workspace_id, space_id, summary, tags, keywords, entities, model)
    VALUES (
      ${page.id}, ${page.workspace_id}, ${page.space_id}, ${profile.summary},
      ${JSON.stringify(profile.tags)}::jsonb, ${JSON.stringify(profile.keywords)}::jsonb, ${JSON.stringify(profile.entities)}::jsonb, 'mock'
    )
    ON CONFLICT(page_id) DO UPDATE SET
      summary = excluded.summary, tags = excluded.tags,
      keywords = excluded.keywords, entities = excluded.entities, updated_at = now()
  `);

  await db.execute(sql`UPDATE pages SET llm_process_status = 'processed', llm_processed_at = now() WHERE id = ${page.id}`);

  // M5: derive candidate Topics + Suggestions from the processed page. Best
  // effort — never let a wiki-generation failure break the indexing pipeline.
  // BUT persist the failure on the page so it is visible in the UI (Phase 0
  // task 6): no silent "success". Cleared on success.
  try {
    await generateWikiArtifacts(page, ai);
    await db.execute(sql`UPDATE pages SET wiki_error_message = NULL, updated_at = now() WHERE id = ${page.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('wiki artifact generation failed', { pageId: page.id, err: message });
    await db.execute(sql`UPDATE pages SET wiki_error_message = ${message}, updated_at = now() WHERE id = ${page.id}`);
  }

  // M5-stale: a re-processed page may have changed the source material of
  // topics it backs. Flag those topics stale (do NOT silently overwrite)
  // so the user can refresh them deliberately.
  try {
    await markTopicsStaleForPage(page.id);
  } catch (err) {
    logger.warn('wiki stale marking failed', {
      pageId: page.id,
      err: err instanceof Error ? err.message : String(err)
    });
  }

  // Phase 3 (E1): after a page is indexed + artifacted, enqueue a Space
  // clustering job (deduped per space) that aggregates its candidates into
  // formal Topics. Lower priority than page jobs so it never starves indexing.
  try {
    await enqueueJob({
      workspaceId: page.workspace_id,
      spaceId: page.space_id,
      entityType: 'space',
      entityId: page.space_id,
      type: 'space.consolidate_topic_candidates',
      runAfterSeconds: 0,
      priority: 200,
      dedupeKey: `space:${page.space_id}:consolidate`
    });
  } catch (err) {
    logger.warn('consolidate enqueue failed', {
      spaceId: page.space_id,
      err: err instanceof Error ? err.message : String(err)
    });
  }

  // Phase H (N2): persist AI token usage if the provider reported it. We
  // capture the *last* generateText usage seen during this page's processing
  // (wiki artifacts / profile / stale marking). It is an approximation, not a
  // full ledger — but enough to spot cost anomalies and feed the metrics
  // endpoint without changing the AiProvider contract.
  const usage = typeof (ai as AiProvider).getLastUsage === 'function' ? (ai as AiProvider).getLastUsage?.() : null;
  if (usage) {
    await db.execute(sql`
      UPDATE jobs
      SET actual_prompt_tokens = ${usage.promptTokens},
          actual_completion_tokens = ${usage.completionTokens},
          updated_at = now()
      WHERE id = ${job.id}
    `);
  }

  metrics.recordSuccess(job.type);
}

// Exponential backoff: 5s, 10s, 20s, 40s, ... capped at 5 minutes.
const BACKOFF_BASE_SECONDS = 5;
const BACKOFF_MAX_SECONDS = 300;
function backoffSeconds(attempts: number): number {
  const exp = BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, BACKOFF_MAX_SECONDS);
}

export async function runOneJob(workerId = `worker-${process.pid}`): Promise<boolean> {
  const locked = await db.execute<any>(sql`
    WITH next_job AS (
      SELECT id FROM jobs
      WHERE status = 'pending' AND run_after <= now()
      ORDER BY priority ASC, created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
    SET status = 'running', locked_by = ${workerId}, locked_at = now(), attempts = attempts + 1
    WHERE id IN (SELECT id FROM next_job)
    RETURNING *
  `);
  const job = locked.rows[0];
  if (!job) return false;

  metrics.recordProcessed();
  try {
    if (job.type === 'page.process_llm') await processPageLlm(job);
    else if (job.type === 'topic.refresh_suggestions') {
      // A failed refresh must NOT be reported as success (Phase 0 task 2):
      // throw so the job is retried / ultimately marked failed, the topic
      // stays stale, and the stale suggestion remains for the user.
      const res = await refreshTopicSuggestions(job.entity_id);
      if (!res.refreshed) throw new Error(res.error ?? 'refresh failed');
    } else if (job.type === 'space.consolidate_topic_candidates') {
      // Phase 3 (E2): aggregate the space's candidates into Topics. A disabled
      // space yields no AI/embedding work — skip and mark succeeded (nothing to do).
      let ai: AiProvider;
      try {
        ai = await createAiProviderForContext({ workspaceId: job.workspace_id ?? '', spaceId: job.space_id ?? '', userId: '' });
      } catch (err) {
        if (isAiDisabledError(err)) {
          await db.execute(sql`UPDATE jobs SET status = 'succeeded', updated_at = now() WHERE id = ${job.id}`);
          return true;
        }
        throw err;
      }
      await consolidateCandidates(job.space_id!, ai, async (p) => {
        // Phase B (B1.3): surface clustering progress on the job for the UI to poll.
        // Phase G (S3): also refresh locked_at as a heartbeat so a long-running
        // clustering pass is NOT mistaken for a zombie and reset to pending
        // (which previously live-locked with the 5-minute reaper: reaped ->
        // re-enqueued -> reaped again, never finishing). A genuinely stuck pass
        // stops heartbeating and is still reaped, which is the desired behaviour
        // now that provider calls are bounded by a timeout (S2).
        await db.execute(
          sql`UPDATE jobs SET progress = ${JSON.stringify(p)}::jsonb, locked_at = now(), updated_at = now() WHERE id = ${job.id}`
        );
      });
    } else if (job.type === 'system.cleanup_rate_limits') {
      // Phase H (N3): trim api_rate_limit_events older than 7 days so the
      // table does not grow unbounded (the cleanup index already exists).
      // Idempotent + safe to retry: a failed run simply leaves older rows
      // until the next day's enqueue.
      const res = await db.execute(sql`
        DELETE FROM api_rate_limit_events
        WHERE created_at < now() - interval '7 days'
        RETURNING id
      `);
      logger.info('rate_limit cleanup done', { deleted: res.rows.length });
    } else if (job.type === 'knowledge.evaluate_lifecycle') {
      // Phase 5 (F4): daily lifecycle evaluation. Generates Suggestions only
      // (never archives), so failing mid-run is safe to retry.
      await evaluateLifecycle(job.workspace_id ?? undefined, job.space_id ?? undefined);
    } else if (job.type === 'project.generate_closure_package') {
      // Phase 6 (F1): generate a closure package. Suggestions ONLY — it never
      // moves/derives Topics, so a retry is always safe and idempotent.
      let ai: AiProvider | undefined;
      try {
        ai = await createAiProviderForContext({ workspaceId: job.workspace_id ?? '', spaceId: job.space_id ?? '', userId: '' });
      } catch (err) {
        if (isAiDisabledError(err)) ai = undefined;
        else throw err;
      }
      const pkg = await generateClosurePackage(job.space_id!, ai);
      await storeClosurePackage(job.space_id!, pkg, job.entity_id ?? null);
    }
    await db.execute(sql`UPDATE jobs SET status = 'succeeded', updated_at = now() WHERE id = ${job.id}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    metrics.recordFailure({ id: job.id, type: job.type, attempts: job.attempts }, err);
    await db.execute(sql`
      UPDATE jobs
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed'::job_status ELSE 'pending'::job_status END,
          error_message = ${message},
          run_after = now() + (${backoffSeconds(job.attempts)} || ' seconds')::interval,
          updated_at = now()
      WHERE id = ${job.id}
    `);
  }
  return true;
}

let timer: NodeJS.Timeout | null = null;
let runningJob: Promise<boolean> | null = null;

/**
 * Reset "running" jobs left behind by an interrupted process (SIGKILL / crash)
 * so they get picked up again on the next poll instead of blocking new work
 * (Gate: 僵尸 job 回收). A job is considered stuck once it has been "running"
 * longer than the 5-minute safety window.
 */
export async function recoverZombieJobs(): Promise<number> {
  const res = await db.execute<any>(sql`
    UPDATE jobs
    SET status = 'pending', locked_by = NULL, locked_at = NULL, updated_at = now()
    WHERE status = 'running' AND locked_at < now() - interval '5 minutes'
    RETURNING id
  `);
  return res.rows.length;
}

export function startJobRunner(): void {
  if (process.env.NODE_ENV === 'test') return;
  // Recover any jobs left "running" by a previous (crashed) process.
  void recoverZombieJobs()
    .then((n) => {
      if (n > 0) logger.info('zombie jobs recovered', { count: n });
    })
    .catch((err) => logger.error('zombie recovery failed', { err: err instanceof Error ? err.message : String(err) }));

  // Phase H (N3): self-schedule the daily rate_limit_events cleanup. The job
  // is deduped by `system:cleanup_rate_limits` so a restart never enqueues a
  // second one while the first is still pending/running.
  void enqueueCleanupRateLimits().catch((err) =>
    logger.warn('failed to enqueue rate_limit cleanup', { err: err instanceof Error ? err.message : String(err) })
  );

  timer = setInterval(() => {
    const job = runOneJob();
    runningJob = job;
    void job
      .catch((err) => logger.error('job runner error', { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => {
        runningJob = null;
      });
  }, 3000);
  timer.unref();
}

/**
 * Phase H (N3): enqueue the daily rate_limit_events cleanup job. Deduped by a
 * fixed dedupeKey so at most one pending/running instance exists at a time;
 * restarts are safe. Runs immediately if never queued, otherwise the job's
 * runAfter is updated to +24h on each completion (the worker does not yet
 * re-enqueue on success, so we rely on the daily server restart cycle of a
 * single-process deployment; for long-running processes a cron-style
 * re-enqueue should be added here later).
 */
async function enqueueCleanupRateLimits(): Promise<void> {
  await db.execute(sql`
    WITH existing AS (
      SELECT id FROM jobs
      WHERE dedupe_key = 'system:cleanup_rate_limits'
        AND status IN ('pending', 'running')
      LIMIT 1
    )
    INSERT INTO jobs (entity_type, type, status, priority, dedupe_key, run_after, payload)
    SELECT 'system', 'system.cleanup_rate_limits', 'pending', 300, 'system:cleanup_rate_limits', now(), '{}'::jsonb
    WHERE NOT EXISTS (SELECT 1 FROM existing)
  `);
}

/** Stop the poll loop and wait (bounded) for an in-flight job to finish. */
export async function stopJobRunner(): Promise<void> {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  // Give the currently-running job up to 15s to finish before we exit.
  const deadline = Date.now() + 15000;
  while (runningJob && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  runningJob = null;
}
