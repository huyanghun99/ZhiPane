-- P0-4 (LLM wiki优化.md): Claim-Evidence 模型
-- 每个 Topic 由多个 Claim 组成，每个 Claim 有独立引用（Claim → 多 Evidence Block）。
-- 本表是 Topic 与 Claim 的多对多绑定，替代旧的单点引用。
-- routing_action 字段为后续 P0 路由规则（7 种动作）预留：本 P0-4 仅写入
-- attach_as_example / create_emerging / update_existing 三种已绑定到 Topic 的动作；
-- 其余 4 种动作表示 Claim 未绑定到任何 Topic，由后续路由规则 todo 记录。
CREATE TABLE IF NOT EXISTS topic_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  topic_id uuid NOT NULL REFERENCES wiki_topics(id) ON DELETE CASCADE,
  claim_id uuid NOT NULL REFERENCES knowledge_claims(id) ON DELETE CASCADE,
  routing_action text CHECK (routing_action IN (
    'update_existing', 'create_emerging', 'attach_as_example',
    'keep_as_facet', 'keep_as_reference', 'ignore_duplicate', 'request_review'
  )),
  contribution_type text NOT NULL DEFAULT 'key_point',
  added_by text NOT NULL DEFAULT 'ai',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(topic_id, claim_id)
);
CREATE INDEX IF NOT EXISTS idx_topic_claims_scope ON topic_claims(workspace_id, space_id);
CREATE INDEX IF NOT EXISTS idx_topic_claims_topic ON topic_claims(topic_id);
CREATE INDEX IF NOT EXISTS idx_topic_claims_claim ON topic_claims(claim_id);
