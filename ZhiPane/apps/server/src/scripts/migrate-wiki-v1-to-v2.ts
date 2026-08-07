import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sql } from 'drizzle-orm';
import { db, pool } from '../db/client';
import { classifyLegacyTopic, type LegacyTopicSnapshot } from '../services/wiki-migration.service';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const rollbackPath = args[args.indexOf('--rollback') + 1];
const outputDir = resolve(process.cwd(), '../../backups/wiki-v1-v2');

type ReportItem = LegacyTopicSnapshot & { disposition: string; reasons: string[] };
type Report = { generatedAt: string; mode: 'dry-run' | 'applied'; topics: ReportItem[] };

async function rollback(reportFile: string) {
  const report = JSON.parse(await readFile(resolve(reportFile), 'utf8')) as Report;
  for (const topic of report.topics) {
    await db.execute(sql`UPDATE wiki_topics SET status = ${topic.status}, content_json = ${JSON.stringify(topic.contentJson)}::jsonb, text_content = ${topic.textContent}, synthesis_status = ${topic.synthesisStatus ?? 'ready'}, updated_at = now() WHERE id = ${topic.id}::uuid`);
  }
  process.stdout.write(JSON.stringify({ rolledBack: report.topics.length, reportFile }) + '\n');
}

async function main() {
  if (rollbackPath) return rollback(rollbackPath);
  const rows = await db.execute<any>(sql`
    SELECT t.*, COUNT(ts.id)::int AS source_count, COUNT(ts.chunk_id)::int AS chunk_source_count
    FROM wiki_topics t LEFT JOIN topic_sources ts ON ts.topic_id = t.id
    GROUP BY t.id
    ORDER BY t.created_at
  `);
  const topics: ReportItem[] = rows.rows.map((row: any) => {
    const snapshot: LegacyTopicSnapshot = { id: row.id, title: row.title, status: row.status, source: row.source, contentJson: row.content_json, textContent: row.text_content, userEditedAt: row.user_edited_at, synthesisStatus: row.synthesis_status, sourceCount: row.source_count, chunkSourceCount: row.chunk_source_count };
    return { ...snapshot, ...classifyLegacyTopic(snapshot) };
  });
  const report: Report = { generatedAt: new Date().toISOString(), mode: apply ? 'applied' : 'dry-run', topics };
  await mkdir(outputDir, { recursive: true });
  const reportFile = join(outputDir, `wiki-migration-${Date.now()}.json`);
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  if (apply) {
    for (const topic of topics) {
      if (topic.disposition === 'degrade_and_resynthesize') await db.execute(sql`UPDATE wiki_topics SET status = 'synthesis_failed', synthesis_status = 'failed', quality_issues = ${JSON.stringify(topic.reasons)}::jsonb, updated_at = now() WHERE id = ${topic.id}::uuid`);
      if (topic.disposition === 'suggest_degrade_to_facet') await db.execute(sql`UPDATE wiki_topics SET lifecycle_status = 'archived', status = 'archived', archive_reason = 'migration_single_chunk_facet_candidate', updated_at = now() WHERE id = ${topic.id}::uuid`);
    }
  }
  const counts = topics.reduce<Record<string, number>>((out, topic) => ({ ...out, [topic.disposition]: (out[topic.disposition] ?? 0) + 1 }), {});
  process.stdout.write(JSON.stringify({ reportFile, mode: report.mode, counts }) + '\n');
}

main().finally(() => pool.end());
