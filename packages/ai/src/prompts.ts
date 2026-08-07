/**
 * P0-6 (LLM wiki优化.md §五 提示词优化原则): 集中管理 7 个独立 Prompt。
 *
 * 每个常量携带：
 *   - `version`：Prompt 版本号（用于回归测试与模型参数记录）
 *   - `system`：系统消息模板
 *   - `buildUser`：用户消息构建器（接收上下文数据，返回字符串）
 *
 * 所有 Prompt 必须使用明确 JSON Schema、禁止补充来源不存在的内容、
 * 输出 Claim ID / Evidence ID / 变更类型、支持稳定回归测试。
 *
 * 注：page-map / claim-extraction / quality-review 的主路径仍是确定性
 * 算法（见 page-knowledge.service.ts / wiki.service.ts 的
 * evaluateSynthesisQuality），本模块为它们提供 LLM 增强版本与版本号记录，
 * 以便未来升级或对比评测时切换。topic-routing / topic-synthesis /
 * topic-repair / claim-relation 是 LLM 主路径。
 */

import type { RoutingAction } from './provider-prompts-types';

/** 单个 Prompt 的规范结构。 */
export interface PromptSpec<TContext> {
  /** Prompt 版本号，例如 'topic-synthesis-v1'。写入数据库 prompt_version 列。 */
  version: string;
  /** 推荐模型参数（temperature 等），供调用方记录。 */
  modelParams: { temperature: number };
  /** 系统消息内容。 */
  system: string;
  /** 用户消息构建器：接收上下文数据，返回用户消息字符串。 */
  buildUser: (ctx: TContext) => string;
}

// ---------------------------------------------------------------------------
// 1. page-map
// ---------------------------------------------------------------------------

export interface PageMapContext {
  pageTitle: string;
  /** 章节标题列表，已按文档顺序排列。 */
  sections: Array<{ heading: string; level: number; anchor: string; preview: string }>;
}

export const PAGE_MAP_PROMPT: PromptSpec<PageMapContext> = {
  version: 'page-map-v1',
  modelParams: { temperature: 0.2 },
  system:
    '你是页面结构分析助手（page-map）。根据提供的章节标题与预览，识别文档类型与 Facet（章节标签）。' +
    '只输出 JSON，严格符合结构：' +
    '{"schemaVersion":"page-knowledge-map-v1","documentType":"single_topic_essay"|"multi_topic_notes"|"note",' +
    '"primaryTopic":string,"facets":[{"id":string,"label":string,"sectionAnchor":string,"confidence":number}]。' +
    'documentType 判定：>=6 个章节且围绕同一主题为 single_topic_essay；3-5 个章节为 multi_topic_notes；<3 个章节为 note。' +
    'Facet 标签必须来自章节标题，不得编造；每个 facet 的 sectionAnchor 必须来自输入的 anchor。',
  buildUser: (ctx) => {
    const list = ctx.sections
      .map((s, i) => `${i + 1}. [anchor:${s.anchor}] (H${s.level}) ${s.heading}\n   预览：${s.preview.slice(0, 120)}`)
      .join('\n');
    return `页面标题：${ctx.pageTitle}\n\n章节列表：\n${list}`;
  }
};

// ---------------------------------------------------------------------------
// 2. claim-extraction
// ---------------------------------------------------------------------------

export interface ClaimExtractionContext {
  sectionHeading: string;
  sectionText: string;
  /** 该章节的可用 chunk ID 列表（LLM 引用必须来自此集合）。 */
  chunkIds: string[];
}

export const CLAIM_EXTRACTION_PROMPT: PromptSpec<ClaimExtractionContext> = {
  version: 'claim-extraction-v1',
  modelParams: { temperature: 0.3 },
  system:
    '你是知识提取助手（claim-extraction）。从给定章节文本中提取原子知识陈述（Claim）。' +
    '每个 Claim 必须是可独立验证的单一陈述，不得是章节标题或导航文字。' +
    '只输出 JSON，严格符合结构：' +
    '{"claims":[{"text":string,"sectionAnchor":string,"chunkId":string,"evidenceExcerpt":string}]}。' +
    'chunkId 必须来自输入的 chunkIds 集合；evidenceExcerpt 必须是 chunk 中的真实片段（<=240 字）。' +
    '不得编造来源不存在的 Claim；每个章节最多 5 个 Claim。',
  buildUser: (ctx) =>
    `章节标题：${ctx.sectionHeading}\n` +
    `可用 chunkId：${ctx.chunkIds.join(', ')}\n\n` +
    `章节文本：\n${ctx.sectionText.slice(0, 4000)}`
};

// ---------------------------------------------------------------------------
// 3. claim-relation
// ---------------------------------------------------------------------------

export interface ClaimRelationContext {
  claims: Array<{ id: string; text: string; sectionAnchor: string }>;
}

export const CLAIM_RELATION_PROMPT: PromptSpec<ClaimRelationContext> = {
  version: 'claim-relation-v1',
  modelParams: { temperature: 0.2 },
  system:
    '你是知识关系分析助手（claim-relation）。分析给定 Claim 集合中陈述之间的语义关系。' +
    '只输出 JSON，严格符合结构：' +
    '{"relations":[{"claimAId":string,"claimBId":string,"relation":"supports"|"contradicts"|"refines"|"unrelated","note":string}]}。' +
    'relation 取值：supports（A 支持 B）、contradicts（A 与 B 矛盾）、refines（A 细化 B）、unrelated（无关）。' +
    'claimAId / claimBId 必须来自输入的 Claim ID 集合；不得编造关系；只输出明确的语义关系。',
  buildUser: (ctx) => {
    const list = ctx.claims.map((c) => `[${c.id}] (section ${c.sectionAnchor}) ${c.text}`).join('\n');
    return `Claim 列表：\n${list}`;
  }
};

// ---------------------------------------------------------------------------
// 3b. topic-extraction (facet -> candidate topic aggregation)
// ---------------------------------------------------------------------------

export interface TopicExtractionContext {
  pageTitle: string;
  facets: Array<{ label: string; sectionAnchor: string }>;
  claims: Array<{ text: string; sectionAnchor: string }>;
}

/**
 * P0-7: 从 Page Map 的 Facets/Claims 派生候选 Topic。
 *
 * 与 topic-routing（7-action 路由决策）不同：本 prompt 用于页面导入阶段，
 * 将多个相关 Facet 聚合为少量核心候选 Topic（而非每个 Facet 一个 Topic）。
 * 这避免了"一篇文章出很多 thin Topic"的问题，让 consolidateCandidates
 * 有足够的证据（多 chunk、多 claim）创建正式 Topic。
 */
export const TOPIC_EXTRACTION_PROMPT: PromptSpec<TopicExtractionContext> = {
  version: 'topic-extraction-v1',
  modelParams: { temperature: 0.3 },
  system:
    '你是知识库候选主题提取助手（topic-extraction）。给定页面的 Facets（章节）与 Claims（知识陈述），' +
    '将相关 Facet 聚合为少量核心候选 Topic（1-3 个），每个 Topic 必须有清晰边界与长期复用价值。' +
    '优先以页面主标题作为第一个候选 Topic（如果它代表一个独立知识概念）。' +
    '不得为每个 Facet 单独创建 Topic（章节性内容应聚合）。' +
    '只输出 JSON，严格符合结构：' +
    '{"topics":[{"title":string,"summary":string}]}。' +
    'title 长度 2-80 字符；summary 长度 <=500 字符，简述该候选的知识边界。',
  buildUser: (ctx) => {
    const facetList = ctx.facets.map((f, i) => `${i + 1}. [Facet] ${f.label}`).join('\n');
    const claimList = ctx.claims.slice(0, 30).map((c, i) => `${i + 1}. [Claim] ${c.text}`).join('\n');
    return `页面标题：${ctx.pageTitle}\n\nFacets（章节）：\n${facetList}\n\nClaims（知识陈述）：\n${claimList}`;
  }
};

// ---------------------------------------------------------------------------
// 4. topic-routing
// ---------------------------------------------------------------------------

export interface TopicRoutingContext {
  /** 新进入的 Claim 集合（待路由）。 */
  incomingClaims: Array<{ id: string; text: string; sectionAnchor: string }>;
  /** 已有 Topic 集合（用于匹配 update_existing / attach_as_example）。 */
  existingTopics: Array<{ id: string; title: string; aliases: string[]; normalizedTitle: string }>;
  /** 当前页面标题，用于判断是否仅为本页 Facet。 */
  pageTitle: string;
}

export interface TopicRoutingDecision {
  claimId: string;
  routingAction: RoutingAction;
  /** routingAction 为 update_existing / attach_as_example 时必须填写。 */
  targetTopicId?: string;
  /** routingAction 为 create_emerging 时必须填写（新 Topic 标题）。 */
  newTopicTitle?: string;
  /** 路由理由（用于审计与回归测试）。 */
  reason: string;
}

export const TOPIC_ROUTING_PROMPT: PromptSpec<TopicRoutingContext> = {
  version: 'topic-routing-v1',
  modelParams: { temperature: 0.2 },
  system:
    '你是知识库主题路由助手（topic-routing）。给定新进入的 Claim 集合与已有 Topic 列表，' +
    '为每个 Claim 决定路由动作。只允许以下 7 种动作：\n' +
    '  update_existing      - 更新已有 Topic（必须填 targetTopicId）\n' +
    '  create_emerging      - 创建新兴 Topic（必须填 newTopicTitle，仅当边界清晰且无法归入已有 Topic）\n' +
    '  keep_as_facet        - 仅保留为页面 Facet（文章章节性内容，无长期复用价值）\n' +
    '  attach_as_example    - 作为案例加入已有 Topic（必须填 targetTopicId）\n' +
    '  keep_as_reference    - 保存为参考资料（背景信息，不构成独立知识）\n' +
    '  ignore_duplicate     - 忽略重复内容（与已有 Claim 或 Topic 高度重复）\n' +
    '  request_review       - 冲突或边界不明确，需人工复核\n' +
    '默认优先 update_existing 而非 create_emerging。只输出 JSON，严格符合结构：' +
    '{"decisions":[{"claimId":string,"routingAction":string,"targetTopicId"?:string,"newTopicTitle"?:string,"reason":string}]}。' +
    'claimId 必须来自输入；targetTopicId 必须来自已有 Topic 列表；不得编造来源不存在的 Topic。',
  buildUser: (ctx) => {
    const claimList = ctx.incomingClaims
      .map((c, i) => `${i + 1}. [${c.id}] (section ${c.sectionAnchor}) ${c.text}`)
      .join('\n');
    const topicList = ctx.existingTopics.length
      ? ctx.existingTopics.map((t) => `[${t.id}] ${t.title}（别名：${t.aliases.join(', ') || '无'}）`).join('\n')
      : '（无已有 Topic）';
    return `页面标题：${ctx.pageTitle}\n\n新进入的 Claim：\n${claimList}\n\n已有 Topic：\n${topicList}`;
  }
};

// ---------------------------------------------------------------------------
// 5. topic-synthesis
// ---------------------------------------------------------------------------

export interface TopicSynthesisContext {
  /** Claim-Evidence 捆绑包（每条 Claim 携带自己的 Evidence chunks）。 */
  claims: Array<{
    claimId: string;
    text: string;
    sectionAnchor: string;
    evidence: Array<{ chunkId: string; pageId: string; content: string }>;
  }>;
}

export const TOPIC_SYNTHESIS_PROMPT: PromptSpec<TopicSynthesisContext> = {
  version: 'topic-synthesis-v1',
  modelParams: { temperature: 0.4 },
  system:
    '你是知识综合助手（topic-synthesis，Claim-Evidence 模型）。根据提供的 Claim 与各自 Evidence Block 撰写压缩、去重的主题综合。' +
    '只输出 JSON，严格符合结构：' +
    '{"schemaVersion":"topic-synthesis-v1","definition":string,"overview":string,' +
    '"keyPoints":[{"id":string,"title":string,"content":string,"citations":[{"chunkId":string,"claimId":string,"excerpt":string}]}],' +
    '"subtopics":[],"conflicts":[],"decisions":[],"openQuestions":[],"relatedTopicIds":[],"generatedFromContentVersions":[]}。' +
    'definition 和 overview 不得重复；不得复制原文长段；不得出现 HTML 标签；' +
    '每个 keyPoint 必须有真实引用，citations 中 chunkId 必须来自输入的 CID，claimId 必须来自输入的 CLID；' +
    '同一条 keyPoint 可引用多个 Claim，但不能引用未在 Evidence 中出现的内容。',
  buildUser: (ctx) => {
    const sections = ctx.claims.map((claim) => {
      const evBlocks = claim.evidence
        .map((ev) => `  [CID:${ev.chunkId}] (page ${ev.pageId})\n  ${ev.content.replace(/\s+/g, ' ').trim().slice(0, 600)}`)
        .join('\n');
      return `[CLID:${claim.claimId}] (section ${claim.sectionAnchor || '-'})\n${claim.text}\nEvidence:\n${evBlocks}`;
    });
    return sections.join('\n\n').slice(0, 8000);
  }
};

// ---------------------------------------------------------------------------
// 6. quality-review
// ---------------------------------------------------------------------------

export interface QualityReviewContext {
  synthesis: unknown;
  /** 参与综合的证据 chunks（用于检查引用支持性）。 */
  chunks: Array<{ chunkId: string; content: string }>;
}

export const QUALITY_REVIEW_PROMPT: PromptSpec<QualityReviewContext> = {
  version: 'quality-review-v1',
  modelParams: { temperature: 0.1 },
  system:
    '你是知识综合质量审查助手（quality-review）。审查给定的主题综合是否满足质量要求。' +
    '检查项：definition 与 overview 不得高度重复；不得出现 HTML 残片；不得从残句开始；' +
    '不得长段复制原文；每条 keyPoint 必须有有效引用且引用必须支持该结论；' +
    '不得混入明显无关主题。只输出 JSON，严格符合结构：' +
    '{"passed":boolean,"issues":[string],"suggestions":[string]}。' +
    'issues 使用预定义代码：definition_too_short | overview_too_short | definition_overview_redundant | ' +
    'sentence_fragment | source_copy_too_long | key_points_redundant | citation_missing | ' +
    'citation_not_supporting | html_fragment | off_topic_drift。' +
    'suggestions 是针对每个 issue 的具体修复建议（中文，<=120 字）。',
  buildUser: (ctx) =>
    `综合结果：\n${JSON.stringify(ctx.synthesis)}\n\n证据 chunks：\n${ctx.chunks.map((c) => `[CID:${c.chunkId}] ${c.content.slice(0, 200)}`).join('\n')}`.slice(0, 6000)
};

// ---------------------------------------------------------------------------
// 7. topic-repair
// ---------------------------------------------------------------------------

export interface TopicRepairContext {
  /** 待修复的综合结果。 */
  synthesis: unknown;
  /** 触发修复的质量问题代码列表。 */
  issues: string[];
  /** Claim-Evidence 捆绑包（与 topic-synthesis 同结构）。 */
  claims: Array<{
    claimId: string;
    text: string;
    sectionAnchor: string;
    evidence: Array<{ chunkId: string; content: string }>;
  }>;
}

export const TOPIC_REPAIR_PROMPT: PromptSpec<TopicRepairContext> = {
  version: 'topic-repair-v1',
  modelParams: { temperature: 0.3 },
  system:
    '你是知识综合修复助手（topic-repair，Claim-Evidence 模型）。先前生成的综合未通过质量门禁。' +
    '请根据 Claim-Evidence 修复综合，只输出 JSON，结构同 topic-synthesis-v1。' +
    '修复要求：definition 与 overview 不得重复；不得出现 HTML 标签；不得从残句开始；' +
    '不得长段复制原文；每个 keyPoint 的 citations 必须同时包含有效的 chunkId 和 claimId；' +
    '不得引入未在 Evidence 中出现的内容；所有内容必须来自资料，不得引入无关主题。',
  buildUser: (ctx) => {
    const sections = ctx.claims.map((claim) => {
      const evBlocks = claim.evidence
        .map((ev) => `  [CID:${ev.chunkId}][CLID:${claim.claimId}]\n  ${ev.content.replace(/\s+/g, ' ').trim().slice(0, 600)}`)
        .join('\n');
      return `${claim.text}\nEvidence:\n${evBlocks}`;
    });
    return `原始综合：\n${JSON.stringify(ctx.synthesis)}\n\n质量问题：${ctx.issues.join('、')}\n\nClaim-Evidence：\n${sections.join('\n\n')}`.slice(0, 8000);
  }
};

// ---------------------------------------------------------------------------
// 汇总：所有 Prompt 的注册表（供版本审计与回归测试枚举）
// ---------------------------------------------------------------------------

export const ALL_PROMPTS = [
  PAGE_MAP_PROMPT,
  CLAIM_EXTRACTION_PROMPT,
  CLAIM_RELATION_PROMPT,
  TOPIC_ROUTING_PROMPT,
  TOPIC_SYNTHESIS_PROMPT,
  QUALITY_REVIEW_PROMPT,
  TOPIC_REPAIR_PROMPT
] as const;

export type PromptName =
  | 'page-map'
  | 'claim-extraction'
  | 'claim-relation'
  | 'topic-extraction'
  | 'topic-routing'
  | 'topic-synthesis'
  | 'quality-review'
  | 'topic-repair';

/** 按 name 查找 PromptSpec（用于审计与测试）。 */
export const PROMPT_REGISTRY: Record<PromptName, PromptSpec<unknown>> = {
  'page-map': PAGE_MAP_PROMPT as PromptSpec<unknown>,
  'claim-extraction': CLAIM_EXTRACTION_PROMPT as PromptSpec<unknown>,
  'claim-relation': CLAIM_RELATION_PROMPT as PromptSpec<unknown>,
  'topic-extraction': TOPIC_EXTRACTION_PROMPT as PromptSpec<unknown>,
  'topic-routing': TOPIC_ROUTING_PROMPT as PromptSpec<unknown>,
  'topic-synthesis': TOPIC_SYNTHESIS_PROMPT as PromptSpec<unknown>,
  'quality-review': QUALITY_REVIEW_PROMPT as PromptSpec<unknown>,
  'topic-repair': TOPIC_REPAIR_PROMPT as PromptSpec<unknown>
};
