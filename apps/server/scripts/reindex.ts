/**
 * Backfill script: (re)index every page that has text content into
 * `document_chunks` so the search / RAG features have data to work with.
 *
 * Run with:  npx tsx scripts/reindex.ts   (from apps/server)
 *
 * Embedding is best-effort: if the vectorization endpoint is unreachable the
 * chunk is still indexed with BM25 tokens, so keyword/FTS search keeps working.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadEnv() {
  const p = resolve(process.cwd(), '../../.env');
  try {
    const text = readFileSync(p, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    /* no .env found, rely on existing process.env */
  }
  // also try cwd .env
  try {
    const text = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    }
  } catch {}
}
loadEnv();

async function main() {
  const { db } = await import('../src/db/client');
  const { tokenizeChineseFriendly, chunkText } = await import('../src/utils/text');
  const { createAiProvider, vectorToSqlLiteral } = await import('../src/services/ai.service');
  const { env } = await import('../src/env');
  const { sql } = await import('drizzle-orm');

  const ai = createAiProvider();

  const pagesRes = await db.execute<any>(sql`
    SELECT id, workspace_id, space_id, title, text_content
    FROM pages
    WHERE text_content IS NOT NULL AND length(text_content) > 0
  `);
  const pages = pagesRes.rows;
  console.log(`[reindex] found ${pages.length} pages with text content`);

  let pageCount = 0;
  let chunkCount = 0;
  let embeddedCount = 0;

  for (const page of pages) {
    await db.execute(sql`DELETE FROM document_chunks WHERE page_id = ${page.id}`);
    const chunks = chunkText(page.text_content || '', 800, 150);
    for (let i = 0; i < chunks.length; i++) {
      const content = chunks[i];
      let embeddingExpr: unknown = null;
      let embeddingModel: string | null = env.AI_EMBEDDING_MODEL;
      let embeddingDim: number | null = env.EMBEDDING_DIMENSION;
      try {
        const embedding = await ai.embed(content);
        embeddingExpr = sql`${vectorToSqlLiteral(embedding)}::vector`;
        embeddedCount++;
      } catch (err) {
        console.warn(`[reindex] embedding skipped for page ${page.id} chunk ${i}:`, err instanceof Error ? err.message : err);
      }
      await db.execute(sql`
        INSERT INTO document_chunks(workspace_id, space_id, page_id, chunk_index, title, content, fts_tokens, embedding, embedding_model, embedding_dimension)
        VALUES (${page.workspace_id}, ${page.space_id}, ${page.id}, ${i}, ${page.title}, ${content}, ${tokenizeChineseFriendly(content)}, ${embeddingExpr}, ${embeddingModel}, ${embeddingDim})
      `);
      chunkCount++;
    }
    pageCount++;
  }

  console.log(`[reindex] done: ${pageCount} pages, ${chunkCount} chunks (${embeddedCount} embedded, ${chunkCount - embeddedCount} BM25-only)`);
}

main().catch((err) => {
  console.error('[reindex] failed:', err);
  process.exit(1);
});
