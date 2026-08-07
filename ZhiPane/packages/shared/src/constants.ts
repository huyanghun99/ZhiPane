export const DEFAULT_EMBEDDING_DIMENSION = 1536;
export const RRF_K = 60;

export const LLM_PROCESS_STATUSES = [
  'pending',
  'processing',
  'processed',
  'failed',
  'ignored'
] as const;

export const TOPIC_STATUSES = [
  'suggested',
  'accepted',
  'user_edited',
  'stale',
  'archived'
] as const;

export const SPACE_AI_PRIVACY_POLICIES = [
  'inherit_workspace',
  'cloud_allowed',
  'local_only',
  'disabled'
] as const;
