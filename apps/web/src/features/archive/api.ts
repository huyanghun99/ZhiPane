import { getArchivedSpaces, getArchivedTopics, reactivateTopic, deleteTopic } from '../../api';

export interface ArchiveItem {
  id: string;
  title: string;
  kind: 'deleted' | 'history' | 'versions';
  deletedAt: string;
  spaceId: string;
  spaceName?: string;
}

interface RawTopic {
  id: string;
  title: string;
  archivedAt?: string;
  archiveReason?: string;
  spaceId: string;
}

/** B3.3: gather archived (incl. soft-deleted) Topics across the workspace's archived spaces. */
export async function listArchive(workspaceId: string): Promise<ArchiveItem[]> {
  const { spaces } = await getArchivedSpaces(workspaceId);
  const items: ArchiveItem[] = [];
  for (const sp of spaces ?? []) {
    const { topics } = await getArchivedTopics(sp.id);
    for (const t of (topics as RawTopic[]) ?? []) {
      items.push({
        id: t.id,
        title: t.title,
        kind: t.archiveReason === 'deleted' ? 'deleted' : 'history',
        deletedAt: t.archivedAt ?? new Date().toISOString(),
        spaceId: sp.id,
        spaceName: sp.name,
      });
    }
  }
  return items;
}

/** Reactivate an archived Topic (recovery path). */
export async function restoreArchiveItem(_workspaceId: string, topicId: string): Promise<void> {
  await reactivateTopic(topicId);
}

/** Permanently delete an archived Topic. */
export async function deleteArchiveItem(_workspaceId: string, topicId: string): Promise<void> {
  await deleteTopic(topicId);
}
