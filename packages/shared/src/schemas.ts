import { z } from 'zod';

export const emailSchema = z.string().email().max(320);
export const passwordSchema = z.string().min(8).max(200);

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: z.string().min(1).max(120)
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200)
});

export const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(120)
});

export const createSpaceSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  aiPrivacyPolicy: z.enum(['inherit_workspace', 'cloud_allowed', 'local_only', 'disabled']).default('inherit_workspace'),
  // Phase 1 (D1): Space kind / lifecycle. Defaults applied server-side if omitted.
  spaceKind: z.enum(['project', 'area', 'resource', 'inbox']).default('area'),
  lifecycleStatus: z.enum(['active', 'on_hold', 'completed', 'archived']).default('active'),
  archivePolicy: z.object({
    mode: z.enum(['manual', 'suggest', 'auto']).default('manual'),
    inactiveDays: z.number().int().min(0).default(180),
    completedGraceDays: z.number().int().min(0).default(30)
  }).optional()
});

export const createPageSchema = z.object({
  // workspaceId is intentionally NOT accepted from the client. The backend
  // resolves the real workspaceId from the provided spaceId to prevent
  // cross-workspace pollution (see AGENTS.md data-correctness rules).
  spaceId: z.string().uuid(),
  parentPageId: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(300),
  icon: z.string().max(100).nullable().optional(),
  contentJson: z.unknown().optional(),
  textContent: z.string().default('')
});

export const updatePageSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  icon: z.string().max(100).nullable().optional(),
  contentJson: z.unknown().optional(),
  textContent: z.string().optional(),
  contentVersion: z.number().int().positive().optional(),
  autosave: z.boolean().default(false),
  // Phase 6: lightweight move / reorder (no content-version bump, no LLM re-enqueue).
  parentPageId: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).optional()
});

export const searchSchema = z.object({
  workspaceId: z.string().uuid(),
  spaceId: z.string().uuid().optional(),
  query: z.string().min(1).max(1000),
  limit: z.number().int().min(1).max(50).default(10),
  mode: z.enum(['keyword', 'vector', 'hybrid']).default('hybrid'),
  // Phase 5 (F5): intent drives Search/RAG ordering. `current` (default) favours
  // fresh / active content and down-weights archived; `historical` raises the
  // weight of archived knowledge so old-but-relevant material surfaces.
  intent: z.enum(['current', 'historical']).default('current')
});

export const ragAskSchema = searchSchema.extend({
  extendedThinking: z.boolean().default(false),
  // When provided, RAG is scoped to a single page (used by the
  // right-panel "ask this page" feature).
  pageId: z.string().uuid().optional()
});

export const captureSchema = z.object({
  workspaceId: z.string().uuid(),
  spaceId: z.string().uuid(),
  title: z.string().min(1).max(300),
  content: z.string().default(''),
  sourceUrl: z.string().url().optional(),
  tags: z.array(z.string().min(1).max(80)).default([])
});

export const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(120).optional()
});

export const updateSpaceSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  aiPrivacyPolicy: z.enum(['inherit_workspace', 'cloud_allowed', 'local_only', 'disabled']).optional(),
  autoLlmProcessing: z.boolean().optional(),
  // Phase 1 (D1): Space kind / lifecycle editing.
  spaceKind: z.enum(['project', 'area', 'resource', 'inbox']).optional(),
  lifecycleStatus: z.enum(['active', 'on_hold', 'completed', 'archived']).optional(),
  startedAt: z.string().datetime().optional(),
  targetEndAt: z.string().datetime().optional(),
  archivePolicy: z.object({
    mode: z.enum(['manual', 'suggest', 'auto']),
    inactiveDays: z.number().int().min(0),
    completedGraceDays: z.number().int().min(0)
  }).optional()
});

export const createGroupSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120)
});

export const updateGroupSchema = z.object({
  name: z.string().min(1).max(120).optional()
});

export const addGroupMemberSchema = z.object({
  userId: z.string().uuid()
});

export const restoreRevisionSchema = z.object({
  revisionId: z.string().uuid()
});

export const createTopicSchema = z.object({
  workspaceId: z.string().uuid(),
  spaceId: z.string().uuid(),
  title: z.string().min(1).max(300),
  contentJson: z.unknown().optional(),
  aiSummary: z.string().max(2000).optional()
});

export const updateTopicSchema = z.object({
  title: z.string().min(1).max(300).optional(),
  contentJson: z.unknown().optional(),
  // Legacy single-axis status. 'archived' is mapped to lifecycleStatus='archived'.
  status: z.enum(['accepted', 'user_edited', 'archived']).optional(),
  // Phase 1 (D4): explicit lifecycle axis + pinning.
  lifecycleStatus: z.enum(['active', 'cooling', 'dormant', 'archived']).optional(),
  pinned: z.boolean().optional(),
  updatePolicy: z.enum(['suggest_only', 'auto_draft', 'auto_publish']).optional()
});

export const createShareSchema = z.object({
  workspaceId: z.string().uuid(),
  targetType: z.enum(['page', 'topic']),
  targetId: z.string().uuid(),
  shareMode: z.enum(['live', 'snapshot']).default('live')
});

export const patchEdgeSchema = z.object({
  relationType: z.string().min(1).max(120).optional(),
  confidence: z.number().int().min(0).max(100).optional(),
  status: z.enum(['suggested', 'confirmed', 'deleted']).optional()
});

export const importMarkdownSchema = z.object({
  workspaceId: z.string().uuid(),
  spaceId: z.string().uuid(),
  title: z.string().min(1).max(300),
  content: z.string().max(500000),
  sourceUrl: z.string().url().optional()
});

export const createBackupSchema = z.object({
  includeSecrets: z.boolean().default(false)
});

export const restoreBackupSchema = z.object({
  backupId: z.string().uuid()
});

/* ----------------------------------- Phase 3: TopicSynthesis --------------- */

// A citation references a *chunk the model actually received* (spec E4). It must
// never point at content the LLM was not given, so the synthesis validator
// strips any citation whose chunkId is not in the supplied allow-list.
export const citationRefSchema = z.object({
  chunkId: z.string().min(1),
  pageId: z.string().optional(),
  excerpt: z.string().default(''),
  statement: z.string().optional(),
  // P0-4 (LLM wiki优化.md): Claim-Evidence model — a citation may trace back
  // to a specific Claim (which itself owns its Evidence Blocks via
  // claim_evidence). Optional for backwards compatibility: legacy citations
  // produced by the chunk-only synthesis path have no claimId.
  claimId: z.string().optional()
});
export type CitationRef = z.infer<typeof citationRefSchema>;

export const topicSynthesisSchema = z.object({
  schemaVersion: z.literal('topic-synthesis-v1'),
  definition: z.string(),
  overview: z.string(),
  keyPoints: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        citations: z.array(citationRefSchema)
      })
    )
    // Gate: every keyPoint must carry at least one valid citation.
    .refine((kps) => kps.length > 0 && kps.every((kp) => kp.citations.length > 0), {
      message: 'every keyPoint must have at least one citation'
    }),
  subtopics: z
    .array(z.object({ title: z.string(), summary: z.string(), citations: z.array(citationRefSchema) }))
    .default([]),
  conflicts: z
    .array(
      z.object({
        description: z.string(),
        sides: z.array(z.object({ statement: z.string(), citations: z.array(citationRefSchema) }))
      })
    )
    .default([]),
  decisions: z
    .array(z.object({ decision: z.string(), rationale: z.string(), citations: z.array(citationRefSchema) }))
    .default([]),
  openQuestions: z.array(z.string()).default([]),
  relatedTopicIds: z.array(z.string()).default([]),
  generatedFromContentVersions: z
    .array(z.object({ pageId: z.string(), contentVersion: z.number() }))
    .default([])
});
export type TopicSynthesis = z.infer<typeof topicSynthesisSchema>;

/* ----------------------------------- Phase 4: refresh diff ----------------- */

// A structured, itemised diff produced when a *stale* Topic is refreshed. The
// user applies items one-by-one (spec E5 "用户逐项应用") instead of letting AI
// silently overwrite the body. Every item references REAL chunks (the fresh
// synthesis's citations), so applying it never invents citations.
export const topicRefreshDiffItemSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('add_key_point'),
    keyPoint: z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      citations: z.array(citationRefSchema)
    })
  }),
  z.object({
    kind: z.literal('modify_key_point'),
    keyPointId: z.string(),
    title: z.string(),
    oldContent: z.string(),
    newContent: z.string(),
    newCitations: z.array(citationRefSchema)
  }),
  z.object({
    kind: z.literal('remove_key_point'),
    keyPointId: z.string(),
    title: z.string()
  }),
  z.object({ kind: z.literal('add_source'), pageId: z.string(), pageTitle: z.string() }),
  z.object({ kind: z.literal('stale_source'), pageId: z.string(), reason: z.string() }),
  z.object({
    kind: z.literal('conflict'),
    description: z.string(),
    sides: z.array(z.object({ statement: z.string(), citations: z.array(citationRefSchema) }))
  })
]);
export type TopicRefreshDiffItem = z.infer<typeof topicRefreshDiffItemSchema>;

export const topicRefreshDiffSchema = z.object({
  schemaVersion: z.literal('topic-refresh-diff-v1'),
  topicId: z.string(),
  // Content versions of the sources the fresh synthesis was generated from.
  generatedFromContentVersions: z.array(z.object({ pageId: z.string(), contentVersion: z.number() })).default([]),
  items: z.array(topicRefreshDiffItemSchema).default([])
});
export type TopicRefreshDiff = z.infer<typeof topicRefreshDiffSchema>;

/* ----------------------------------- Phase 5: activity -------------------- */

// A single real user activity event (spec F3). Only genuine user actions are
// recorded here — background jobs never emit these (gate: 后台任务不伪造活跃度).
export const activityEventTypeSchema = z.enum([
  'edit',
  'view',
  'search_click',
  'rag_citation',
  'citation_open',
  'added_to_source',
  'project_reference'
]);
export type ActivityEventType = z.infer<typeof activityEventTypeSchema>;

export const recordActivitySchema = z.object({
  workspaceId: z.string().uuid(),
  spaceId: z.string().uuid(),
  entityType: z.enum(['topic', 'page']),
  entityId: z.string().uuid(),
  eventType: activityEventTypeSchema,
  metadata: z.record(z.unknown()).optional()
});
export type RecordActivityInput = z.infer<typeof recordActivitySchema>;

// Rolled-up activity statistics for an entity (spec F3 "统计至少包含").
export const activityStatsSchema = z.object({
  id: z.string().uuid().optional(),
  workspaceId: z.string().uuid(),
  spaceId: z.string().uuid(),
  entityType: z.enum(['topic', 'page']),
  entityId: z.string().uuid(),
  lastEditedAt: z.string().nullable().optional(),
  lastViewedAt: z.string().nullable().optional(),
  lastRetrievedAt: z.string().nullable().optional(),
  lastLinkedAt: z.string().nullable().optional(),
  lastMeaningfulActivityAt: z.string().nullable().optional(),
  views30d: z.number().int().default(0),
  citations30d: z.number().int().default(0),
  ragCitations30d: z.number().int().default(0),
  activeUsers30d: z.number().int().default(0),
  activityScore: z.number().int().default(0),
  calculatedAt: z.string().optional()
});
export type ActivityStats = z.infer<typeof activityStatsSchema>;

/* ----------------------------------- Phase 6: closure / promotion ---------- */

// A structured, citation-backed project closure package (spec F1). Every
// conclusion (goals, decisions, lessons, reusable-knowledge candidates) carries
// REAL chunk citations so the archive wizard never presents an unsourced claim.
export const closurePackageSchema = z.object({
  schemaVersion: z.literal('project-closure-v1'),
  projectTitle: z.string(),
  goalsAndResults: z.object({ summary: z.string(), citations: z.array(citationRefSchema) }),
  keyDecisions: z.array(z.object({
    decision: z.string(),
    rationale: z.string(),
    citations: z.array(citationRefSchema)
  })),
  lessons: z.array(z.object({
    lesson: z.string(),
    kind: z.enum(['success', 'failure']),
    citations: z.array(citationRefSchema)
  })),
  techDebtAndUnfinished: z.array(z.object({ item: z.string(), citations: z.array(citationRefSchema) })),
  reusableKnowledgeCandidates: z.array(z.object({
    topicId: z.string(),
    topicTitle: z.string(),
    reason: z.string(),
    suggestedTargetKind: z.enum(['area', 'resource']),
    citations: z.array(citationRefSchema)
  })),
  recommendedPromotions: z.array(z.object({
    topicId: z.string(),
    topicTitle: z.string(),
    targetSpaceId: z.string().optional(),
    suggestedTargetKind: z.enum(['area', 'resource']),
    reason: z.string()
  }))
});
export type ClosurePackage = z.infer<typeof closurePackageSchema>;

// Phase 6 (F2): user-confirmed Topic derivation into another Space.
export const deriveTopicSchema = z.object({
  targetSpaceId: z.string().uuid(),
  newTitle: z.string().min(1).max(300).optional()
});
export type DeriveTopicInput = z.infer<typeof deriveTopicSchema>;

// Phase G (S1): user-level AI provider override. The client sends the API key
// in plaintext over HTTPS; the server encrypts it before persisting and never
// returns the plaintext or ciphertext back (only a masked preview).
export const saveAiConfigSchema = z.object({
  driver: z.enum(['mock', 'openai', 'openai-compatible', 'ollama', 'gemini']),
  baseUrl: z.string().max(500).optional().or(z.literal('')),
  apiKey: z.string().max(500).optional().or(z.literal('')),
  completionModel: z.string().min(1).max(200),
  embeddingModel: z.string().min(1).max(200),
  embeddingDimension: z.number().int().positive().default(1536),
  personalOverrideEnabled: z.boolean().default(true)
});
export type SaveAiConfigInput = z.infer<typeof saveAiConfigSchema>;
