import { describe, expect, it } from 'vitest';
import {
  updateWorkspaceSchema,
  updateSpaceSchema,
  createGroupSchema,
  updateGroupSchema,
  addGroupMemberSchema,
  updatePageSchema,
  restoreRevisionSchema,
  createTopicSchema,
  updateTopicSchema,
  createShareSchema,
  patchEdgeSchema,
  importMarkdownSchema,
  createBackupSchema
} from './schemas';

describe('M1 schemas', () => {
  it('updateWorkspaceSchema accepts partial name', () => {
    const parsed = updateWorkspaceSchema.parse({ name: 'New Name' });
    expect(parsed.name).toBe('New Name');
  });

  it('updateWorkspaceSchema accepts empty object', () => {
    const parsed = updateWorkspaceSchema.parse({});
    expect(parsed.name).toBeUndefined();
  });

  it('updateSpaceSchema accepts partial fields', () => {
    const parsed = updateSpaceSchema.parse({ name: 'Updated Space', autoLlmProcessing: false });
    expect(parsed.name).toBe('Updated Space');
    expect(parsed.autoLlmProcessing).toBe(false);
  });

  it('createGroupSchema requires workspaceId and name', () => {
    const parsed = createGroupSchema.parse({ workspaceId: crypto.randomUUID(), name: 'Editors' });
    expect(parsed.name).toBe('Editors');
  });

  it('createGroupSchema rejects invalid workspaceId', () => {
    expect(() => createGroupSchema.parse({ workspaceId: 'not-a-uuid', name: 'Editors' })).toThrow();
  });

  it('updateGroupSchema accepts partial name', () => {
    const parsed = updateGroupSchema.parse({ name: 'Renamed' });
    expect(parsed.name).toBe('Renamed');
  });

  it('addGroupMemberSchema requires valid userId', () => {
    const uuid = crypto.randomUUID();
    const parsed = addGroupMemberSchema.parse({ userId: uuid });
    expect(parsed.userId).toBe(uuid);
  });

  it('updatePageSchema defaults autosave to false', () => {
    const parsed = updatePageSchema.parse({ contentVersion: 1 });
    expect(parsed.autosave).toBe(false);
  });

  it('updatePageSchema accepts autosave flag', () => {
    const parsed = updatePageSchema.parse({ contentVersion: 3, autosave: true });
    expect(parsed.autosave).toBe(true);
  });

  it('restoreRevisionSchema requires revisionId', () => {
    const uuid = crypto.randomUUID();
    const parsed = restoreRevisionSchema.parse({ revisionId: uuid });
    expect(parsed.revisionId).toBe(uuid);
  });

  it('restoreRevisionSchema rejects non-uuid revisionId', () => {
    expect(() => restoreRevisionSchema.parse({ revisionId: 'bad' })).toThrow();
  });
});

describe('M5 topic schemas', () => {
  it('createTopicSchema requires workspaceId, spaceId, title', () => {
    const ws = crypto.randomUUID();
    const sp = crypto.randomUUID();
    const parsed = createTopicSchema.parse({ workspaceId: ws, spaceId: sp, title: 'New Topic' });
    expect(parsed.title).toBe('New Topic');
    expect(parsed.aiSummary).toBeUndefined();
  });

  it('createTopicSchema rejects missing title', () => {
    expect(() => createTopicSchema.parse({ workspaceId: crypto.randomUUID(), spaceId: crypto.randomUUID() })).toThrow();
  });

  it('updateTopicSchema accepts partial updates', () => {
    const parsed = updateTopicSchema.parse({ status: 'accepted' });
    expect(parsed.status).toBe('accepted');
    expect(parsed.title).toBeUndefined();
  });

  it('updateTopicSchema accepts updatePolicy', () => {
    const parsed = updateTopicSchema.parse({ updatePolicy: 'auto_draft' });
    expect(parsed.updatePolicy).toBe('auto_draft');
  });

  it('updateTopicSchema rejects invalid status', () => {
    expect(() => updateTopicSchema.parse({ status: 'invalid_status' })).toThrow();
  });
});

describe('M6 graph edge schema', () => {
  it('patchEdgeSchema accepts partial confidence', () => {
    const parsed = patchEdgeSchema.parse({ confidence: 75 });
    expect(parsed.confidence).toBe(75);
    expect(parsed.relationType).toBeUndefined();
  });

  it('patchEdgeSchema rejects confidence out of range', () => {
    expect(() => patchEdgeSchema.parse({ confidence: 150 })).toThrow();
  });

  it('patchEdgeSchema accepts status enum', () => {
    const parsed = patchEdgeSchema.parse({ status: 'confirmed' });
    expect(parsed.status).toBe('confirmed');
  });

  it('patchEdgeSchema rejects invalid status', () => {
    expect(() => patchEdgeSchema.parse({ status: 'invalid' })).toThrow();
  });
});

describe('M7 share and import schemas', () => {
  it('createShareSchema requires targetType and targetId', () => {
    const ws = crypto.randomUUID();
    const target = crypto.randomUUID();
    const parsed = createShareSchema.parse({ workspaceId: ws, targetType: 'page', targetId: target });
    expect(parsed.shareMode).toBe('live');
  });

  it('createShareSchema rejects invalid targetType', () => {
    expect(() => createShareSchema.parse({ workspaceId: crypto.randomUUID(), targetType: 'invalid', targetId: crypto.randomUUID() })).toThrow();
  });

  it('createShareSchema accepts snapshot mode', () => {
    const parsed = createShareSchema.parse({ workspaceId: crypto.randomUUID(), targetType: 'topic', targetId: crypto.randomUUID(), shareMode: 'snapshot' });
    expect(parsed.shareMode).toBe('snapshot');
  });

  it('importMarkdownSchema requires title and content', () => {
    const ws = crypto.randomUUID();
    const sp = crypto.randomUUID();
    const parsed = importMarkdownSchema.parse({ workspaceId: ws, spaceId: sp, title: 'Imported', content: '# Hello' });
    expect(parsed.title).toBe('Imported');
    expect(parsed.sourceUrl).toBeUndefined();
  });

  it('importMarkdownSchema rejects missing content', () => {
    expect(() => importMarkdownSchema.parse({ workspaceId: crypto.randomUUID(), spaceId: crypto.randomUUID(), title: 'No content' })).toThrow();
  });
});

describe('M8 backup schema', () => {
  it('createBackupSchema defaults includeSecrets to false', () => {
    const parsed = createBackupSchema.parse({});
    expect(parsed.includeSecrets).toBe(false);
  });

  it('createBackupSchema accepts includeSecrets true', () => {
    const parsed = createBackupSchema.parse({ includeSecrets: true });
    expect(parsed.includeSecrets).toBe(true);
  });
});
