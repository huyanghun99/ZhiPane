# ZhiPane LLM Wiki 有机整合专项改造计划（Plan 04）

> 面向 Trae / Vibecoding Agent 的执行手册  
> 主题：解决 LLM Wiki 过度切碎、伪综合、重复 Topic、跨文档无法有机汇总和人工修正能力不足  
> 优先级：P0 质量止血 → P1 知识模型重构 → P2 跨文档持续演化  
> 执行规则：一次只完成一个 Phase；当前 Phase 的测试与 Gate 未通过，不得进入下一阶段。

---

## 0. 结论先行

用户给出的 DeepSeek 长文被整理成 4 个 Topic，且每个 Topic 的“定义 / 概述 / 要点”大量重复原文，这**不是目标状态，也不应被解释为正常的 LLM Wiki 行为**。

当前产物更接近：

```text
长文章
→ 截取前部文本
→ 生成 1～4 个标题
→ 每个标题绑定一个 Chunk
→ Chunk 截断内容被包装成 definition / overview / keyPoint
→ UI 显示为“已采纳 Topic”
```

目标应是：

```text
Page 原文
→ 结构化理解整篇文档
→ 识别主论题、章节 Facet、原子 Claim、实体与关系
→ 将 Facet/Claim 分配给已有 Topic，或保留为页面内部知识
→ 多篇来源达到建 Topic 门槛后创建/更新稳定 Topic
→ 从多来源证据中综合、去重、处理冲突并持续刷新
→ 用户可修正标题、正文、结构、来源与归属，AI 不覆盖人工修改
```

关键认知：

- LLM Wiki **仍然可以在底层使用 Chunk**。Chunk 是检索和引用单位，不应直接成为用户看到的知识结构。
- LLM Wiki 相比传统 RAG 的优势，不是“完全不切 Chunk”，而是增加一层持久化的知识编译层：
  - RAG：问题来了，再从 Chunk 中临时找答案。
  - LLM Wiki：长期把多个 Chunk、多个 Page 编译成稳定、可编辑、可追溯、可持续更新的 Topic。
- 一篇文章包含很多概念是正常的；把每个概念立即升级成全局 Topic 不正常。
- Page、Facet、Claim、Topic 必须是不同层级。当前实现把它们混成了同一种 Topic。

---

## 1. 本次真实样例的正确产品预期

### 1.1 输入文章的知识结构

这篇文章是围绕一个总论题展开的长篇观点综述：

> DeepSeek 以 AGI 为长期目标，通过克制、开源、合理利润、效率优先和技术路线取舍，提高实现 AGI 的概率。

文章内部包含多个章节 Facet：

1. 愿景驱动的组织与善意。
2. 合理利润和不争夺超级 App。
3. 开源与效率优势的商业逻辑。
4. Agent 之后的持续学习瓶颈。
5. 多模态、搜索、世界模型、视频生成和具身智能的优先级。
6. Scaling Law 与下一代模型的区分。
7. 中美 AI 差距、算力和国产芯片。
8. 模型竞争的成本、时间和体验。
9. 基础模型行业收敛。
10. 高质量数据瓶颈。
11. 对上述判断保留怀疑。

这些章节首先应是**同一 Page 下的 Facet**，而不是默认生成 10 个全局 Topic。

### 1.2 第一次导入该文章时的推荐结果

自动结果应控制为：

```text
Page Knowledge Map
├── 主论题：DeepSeek 的 AGI 优先战略与“克制”哲学
├── Facet：组织愿景与合理利润
├── Facet：开源与效率优势
├── Facet：持续学习和 AGI 技术路线
├── Facet：多模态、搜索、世界模型与具身智能排序
├── Facet：Scaling、算力与数据瓶颈
├── Facet：模型竞争和行业收敛
└── Claim：作者认为这些判断仍需长期验证
```

Topic 层建议：

- 自动创建最多 1 个 `single_source` Draft：
  - `DeepSeek 的 AGI 优先战略：克制、开源与效率`
- 其余章节保留为该 Page 的 Facet/Claim。
- 当后续出现其他关于“DeepSeek 开源战略”的文章时，再将对应 Facet 汇入稳定 Topic：
  - `DeepSeek 的开源战略与推理效率优势`
- 当后续出现多篇关于“持续学习”的资料时，再形成跨来源 Topic：
  - `持续学习：Agent 之后的关键技术瓶颈`

### 1.3 Topic 的理想内容形态

一个 Topic 不应重复原文，而应体现综合价值：

```text
标题
一句定义
综合概述
核心要点
不同来源之间的一致意见
不同来源之间的差异或冲突
时间线 / 版本变化（适用时）
开放问题
来源与逐条引用
最近更新时间、覆盖来源数、综合质量状态
```

对于本样例，首次生成的 Topic 可包含 6～8 个经过压缩与归并的要点，而不是复制某一个 Chunk。

---

## 2. 当前代码中的根因诊断

以下诊断基于当前仓库 `main` 分支。

### P0-1：候选提取只读取文章前 4000 字符

文件：

```text
apps/server/src/services/wiki.service.ts
```

当前 `aiTopics()` 将输入写成：

```ts
content: text.slice(0, 4000)
```

直接后果：

- 长文后半部分永远无法参与 Topic 候选生成。
- 本次文章中的 Scaling、算力、芯片、模型竞争、行业收敛、数据瓶颈等章节大概率未进入候选提取。
- 候选高度集中于文章开头，因此生成了“克制哲学、愿景、开源、AGI 路线”等前部主题。
- 这不是模型理解能力不足，而是输入覆盖率被代码主动限制。

不能简单把 `4000` 改成更大常数。长文必须使用结构化分段和 Map-Reduce。

### P0-2：候选 Prompt 默认要求“一篇文章拆出 1～4 个独立 Topic”

当前 Prompt：

```text
阅读用户笔记，提炼出 1-4 个可作为独立主题(Topic)的候选标题
```

问题：

- Prompt 没有区分：主论题、章节 Facet、原子 Claim、全局 Topic。
- 模型被明确引导去“拆出多个 Topic”。
- 没有要求判断文章是单主题深挖，还是多个互不相关主题的合集。
- 没有要求避免把同一论证链中的章节提升为平行 Topic。
- 没有输出 Topic 的 scope、granularity、parent、evidence coverage。

因此当前“过度切碎”不是偶然，而是 Prompt 和领域模型共同决定的结果。

### P0-3：每个 Candidate 只绑定一个 Chunk

当前 `pickSupportingChunk()` 最终返回一个 `chunkId`，`topic_candidates` 也主要保存一个 `chunkId`。

直接后果：

- 一个跨多个章节的候选也只能携带一个证据块。
- 后续综合阶段拿不到完整论证链。
- Candidate 标题可能正确，但内容只能从一个局部 Chunk 中生成。
- Topic 3 从“开源章节结尾”串入“AGI 路线章节开头”，说明 Chunk 边界和 Topic 边界没有对齐。

Candidate 与 Chunk 应改为多对多关系，并标记证据角色。

### P0-4：结构化综合失败后，系统静默写入“伪综合”

当前 `generateTopicSynthesis()` 在 LLM 输出解析、Schema 校验或引用校验失败后，会返回：

```ts
buildDeterministicSynthesis(chunks)
```

`buildDeterministicSynthesis()` 的行为是：

- definition：取 Chunk 前部。
- overview：拼接 Chunk 前部。
- keyPoint.content：再次取同一 Chunk 前部。

这与用户看到的现象完全一致：

- 定义、概述、要点重复。
- 内容以半句话开头，如“起来，需要长期的工程积累”。
- 原始 Chunk 被包装为完整知识页面。

这是当前最严重的问题之一：**系统把 AI 综合失败伪装成了成功**。

确定性 fallback 可以用于内部预览或故障恢复，但不得：

- 标记为正常 TopicSynthesis。
- 显示为“已采纳”。
- 进入高质量 Topic 搜索索引。
- 参与后续跨文档综合而不携带降级标记。

### P0-5：综合输入仍被 `slice(0, 6000)` 截断

`generateTopicSynthesis()` 将多个支持 Chunk 拼接后执行：

```ts
ctx.slice(0, 6000)
```

问题：

- 后面的 Chunk 会被直接丢弃。
- 可能在 Chunk 中间截断，产生半句话。
- 来源多时，先排在前面的 Page 获得更高权重。
- 没有按来源配额、章节覆盖、语义新颖度选择证据。

应改成先做 Evidence Selection，再在明确 token budget 内选择完整 Chunk 或压缩后的 Evidence Unit。

### P0-6：同一 Page 的不同候选被无条件 union

当前 `consolidateCandidates()`：

```ts
const samePage = ...
if (samePage) {
  union(i, j)
  continue
}
```

同页不是“同一 Topic”的充分条件。

同一篇文章可同时讨论：

- 公司战略。
- 芯片生态。
- 数据瓶颈。
- 组织管理。

这些内容相关，但不一定应成为同一个全局 Topic。

当前规则可能在两个方向上产生问题：

- 用户逐个采纳 Candidate 时：一页生成多个薄 Topic。
- 自动 Consolidate 时：同页所有 Facet 被强行揉成一个过宽 Topic。

正确做法不是“同页全拆”或“同页全合”，而是引入 Page 主论题与 Facet 层。

### P0-7：人工 Promote 绕过 TopicCreationPolicy，且仍使用确定性单块综合

`promoteCandidate()` 当前只取“同页 + 同义归一标题”的 sibling Candidate，然后调用：

```ts
buildDeterministicSynthesis(support)
```

问题：

- Promote 不经过正常的 Evidence Selection 和 LLM Synthesis。
- 用户点击采纳后反而更容易得到薄 Topic。
- 它没有先搜索是否存在语义相同但标题不同的 Topic。
- 它没有提示“该 Candidate 更适合作为已有 Topic 的 Facet”。
- 它没有要求单来源 Topic 的显式确认。

### P0-8：已有 Topic 的匹配主要依赖标题和 alias

当前 `existingByNorm` 主要使用：

- normalizeTitle。
- alias。
- synonym map。

问题：

- `DeepSeek 的开源逻辑` 和 `开源模型为何不削弱商业护城河` 可能语义相同，但标题归一后不同。
- 新 Candidate 可能创建重复 Topic，而不是更新已有 Topic。
- Embedding 聚类主要发生在候选组之间，并没有形成稳定的“Candidate → Existing Topic Assignment”流程。

跨文档有机整合的核心，应该优先判断“新证据应加入哪个已有 Topic”，而不是每轮重新聚类一批标题。

### P0-9：聚类使用首个 Candidate 作为代表，且存在链式误合并风险

当前组代表通常是第一个可用 title embedding；并通过 union-find 做连通合并。

风险：

```text
A 与 B 相似
B 与 C 相似
A 与 C 不相似
```

union-find 仍可能把 A/B/C 放入同一组。

对知识 Topic 来说，这种 single-link chaining 很容易产生“越合越大”的语义漂移。

应改为：

- Candidate 优先分配到已有 Topic centroid。
- 新 Topic 聚类使用 average-link / complete-link 的 cohesion gate。
- 每次加入后重新计算 cluster cohesion。
- 任何成员与 Topic scope 冲突时拒绝自动加入。

### P0-10：没有 TopicSynthesis 质量门禁

当前 Schema 校验只保证字段形式正确，不保证内容质量。

缺少：

- definition 与 overview 重复率。
- overview 与 keyPoints 重复率。
- 是否以半句话开头或结尾。
- 信息压缩率。
- 来源覆盖率。
- 不同来源占比。
- KeyPoint 之间的去重。
- 标题和内容语义一致性。
- Topic scope 是否过宽或过窄。
- 是否只是复制来源。

因此“合法 JSON”会被误当成“合格知识”。

### P0-11：UI 状态给了错误的可信度

`WikiView.tsx` 将状态显示为：

```text
suggested → 待审阅
accepted → 已采纳
user_edited → 已编辑
```

但 UI 不知道：

- 是正常 LLM 综合还是 deterministic fallback。
- 是否只用了一个 Chunk。
- 是否覆盖整篇文章。
- 是否存在截断。
- 是否通过质量门禁。
- 是否是 single_source。

用户会自然理解“已采纳”为完整且可信的知识整理，而实际上只是接受了一个局部候选。

### P0-12：正文缺乏细粒度人工修正

当前 UI 已支持标题修改、置顶、归档、删除，但 Topic 正文仍主要是只读结构化展示。

至少需要支持：

- 修改 definition。
- 修改 overview。
- 修改、增加、删除、排序 keyPoint。
- 修改 keyPoint 标题。
- 添加或移除来源 Chunk/Page。
- 将某个 keyPoint 标记为错误或过时。
- 把 Candidate 指派给已有 Topic。
- 将 Topic 降级回 Page Facet。
- 合并 Topic。
- 拆分 Topic。

---

## 3. 目标知识模型：Page、Facet、Claim、Topic 四层分离

### 3.1 Page

Page 是用户原始内容和事实来源，不被 AI 覆盖。

### 3.2 Facet

Facet 是 Page 内部的章节级主题，是对 Page 的结构化理解。

特点：

- 可只属于一个 Page。
- 可以被检索和引用。
- 默认不出现在全局 Topic Center。
- 可在后续与其他 Page 的 Facet 汇总成 Topic。
- 可被用户手动晋升为 Topic。

示例：

```text
Page：梁文锋投资者交流解读
Facet：DeepSeek 的开源战略
Facet：持续学习技术路线
Facet：中美 AI 算力差距
```

### 3.3 Claim

Claim 是可引用的原子论断：

```text
“DeepSeek 将持续学习视为 Agent 之后的关键瓶颈。”
“模型开源不代表推理服务成本优势消失。”
```

特点：

- 必须绑定一个或多个 Chunk。
- 包含主语、谓语、宾语或完整命题。
- 可记录时间、立场、置信度、来源类型。
- 是 Topic 综合的基础证据单位。

### 3.4 Topic

Topic 是跨 Page、跨时间持续演化的知识对象。

特点：

- 有稳定 identity 和 scope。
- 汇总多个 Facet/Claim。
- 通常有多个来源。
- 单来源 Topic 必须显式标记 `single_source`。
- 用户可编辑。
- 新证据到来时生成 diff，而不是覆盖正文。
- 可合并、拆分、归档和恢复。

### 3.5 强制产品规则

1. 一个 Page 可以有多个 Facet，但不等于自动产生多个 Topic。
2. 默认每个 Page 最多自动提出 1 个 `single_source` Topic Draft。
3. Facet 只有满足跨来源或用户明确晋升条件时才成为 Topic。
4. Claim 永不直接显示为 Topic。
5. Topic 的正文必须由 Evidence Set 综合生成，不能直接由单个 Chunk 截取生成。
6. 任何降级产物必须显示降级状态，禁止伪装为正常综合。

---

## 4. 目标数据模型

### 4.1 `page_knowledge_maps`

```ts
interface PageKnowledgeMap {
  id: string;
  pageId: string;
  workspaceId: string;
  spaceId: string;
  contentVersion: number;
  documentType:
    | 'single_topic_essay'
    | 'multi_topic_collection'
    | 'meeting_notes'
    | 'project_document'
    | 'reference_material'
    | 'journal'
    | 'unknown';
  thesis: string;
  abstract: string;
  coverage: {
    totalSections: number;
    processedSections: number;
    coveredCharacterRatio: number;
  };
  model: string;
  promptVersion: string;
  status: 'ready' | 'degraded' | 'failed';
  diagnostics: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}
```

### 4.2 `knowledge_facets`

```ts
interface KnowledgeFacet {
  id: string;
  pageKnowledgeMapId: string;
  pageId: string;
  parentFacetId?: string;
  title: string;
  summary: string;
  scope: string;
  granularity: 'broad' | 'medium' | 'atomic';
  orderIndex: number;
  importance: number;
  independence: number;
  status: 'active' | 'dismissed' | 'promoted' | 'merged';
  promotedTopicId?: string;
}
```

### 4.3 `knowledge_claims`

```ts
interface KnowledgeClaim {
  id: string;
  pageId: string;
  facetId?: string;
  statement: string;
  normalizedStatement: string;
  subject?: string;
  predicate?: string;
  object?: string;
  stance: 'assertion' | 'opinion' | 'question' | 'prediction' | 'decision';
  temporalScope?: string;
  confidence: number;
  sourceChunkIds: string[];
  extractionModel: string;
  extractionVersion: string;
}
```

### 4.4 Candidate 重构

替换当前只有单个 `chunkId` 的模型：

```ts
interface TopicCandidateV2 {
  id: string;
  workspaceId: string;
  spaceId: string;
  sourcePageId: string;
  sourceFacetIds: string[];
  sourceClaimIds: string[];

  proposedTitle: string;
  normalizedTitle: string;
  aliases: string[];
  summary: string;
  scope: string;
  kind: 'document_topic' | 'facet_topic' | 'reference_topic';
  granularity: 'broad' | 'medium' | 'atomic';

  entities: string[];
  concepts: string[];
  semanticFingerprint: number[] | null;

  recommendation:
    | 'attach_existing'
    | 'create_single_source_draft'
    | 'keep_as_facet'
    | 'needs_review'
    | 'ignore';
  recommendedTopicId?: string;
  recommendationScore?: number;

  status: 'candidate' | 'assigned' | 'promoted' | 'dismissed' | 'failed';
  diagnostics: Record<string, unknown>;
}
```

### 4.5 `candidate_evidence`

```ts
interface CandidateEvidence {
  candidateId: string;
  chunkId: string;
  pageId: string;
  role:
    | 'definition'
    | 'thesis'
    | 'support'
    | 'example'
    | 'counterpoint'
    | 'background'
    | 'conclusion';
  relevanceScore: number;
  noveltyScore: number;
  sectionPath?: string[];
  excerpt?: string;
}
```

### 4.6 Topic 新增字段

```ts
interface WikiTopicV2 {
  synthesisStatus: 'ready' | 'degraded' | 'failed' | 'pending';
  qualityScore?: number;
  qualityIssues: string[];
  sourceMode: 'multi_source' | 'single_source' | 'manual';
  scope: string;
  granularity: 'broad' | 'medium';
  evidenceVersion: number;
  synthesisVersion: number;
  lastSuccessfulSynthesisAt?: Date;
}
```

### 4.7 字段级人工编辑保护

新增：

```ts
interface TopicFieldOverride {
  topicId: string;
  fieldPath: string; // overview, keyPoints.kp-1.content 等
  userValue: unknown;
  baseSynthesisVersion: number;
  editedById: string;
  editedAt: Date;
}
```

刷新时：

- AI 生成新的 base synthesis。
- 用户 override 按 fieldPath 重放。
- 冲突时生成 diff。
- 不得因为刷新而丢失人工内容。

---

## 5. 新的端到端流水线

## 5.1 Stage A：文档结构解析

新增：

```text
apps/server/src/services/wiki/document-parser.service.ts
```

输出完整 Section Tree：

```ts
interface DocumentSection {
  id: string;
  heading?: string;
  level: number;
  text: string;
  startOffset: number;
  endOffset: number;
  chunkIds: string[];
  children: DocumentSection[];
}
```

规则：

- Markdown Heading 是强边界。
- ProseMirror heading 节点是强边界。
- 空行、编号标题、列表是弱边界。
- 禁止按固定字符数在句子中间硬切。
- 底层检索 Chunk 可保留 800/150，但知识理解使用 Section/Evidence Unit。
- 每个 Section 必须可映射回完整 Chunk 集合。

## 5.2 Stage B：全篇 Page Understanding（Map-Reduce）

新增：

```text
apps/server/src/services/wiki/page-understanding.service.ts
```

### 短文

低于模型安全 token budget 时，整篇一次输入，但仍要求输出结构化 PageKnowledgeMap。

### 长文

使用两阶段：

```text
Map：每个 Section 提取 section summary、claims、entities、local facets
Reduce：读取所有 section outputs，识别全篇 thesis、document type、facet hierarchy
```

禁止：

```ts
text.slice(0, N)
```

允许：

- 对每个完整 Section 做 token-aware 截断。
- 超长 Section 再按段落做子 Map。
- Reduce 输入使用 section summaries + 代表 Claims，不使用原文头部偏置。

### Page Understanding Schema

```ts
const pageKnowledgeMapSchema = z.object({
  documentType: z.enum([...]),
  thesis: z.string().min(20),
  abstract: z.string().min(40),
  primaryTopic: z.object({
    title: z.string(),
    scope: z.string(),
    evidenceSectionIds: z.array(z.string())
  }).nullable(),
  facets: z.array(z.object({
    title: z.string(),
    summary: z.string(),
    scope: z.string(),
    granularity: z.enum(['broad', 'medium', 'atomic']),
    independence: z.number().min(0).max(1),
    importance: z.number().min(0).max(1),
    evidenceSectionIds: z.array(z.string())
  })),
  claims: z.array(...),
  entities: z.array(...)
});
```

### Prompt 核心约束

必须加入：

```text
你不是在把文章尽可能拆成多个 Wiki Topic。
先判断文章是围绕单一主论题展开，还是多个互不相关主题的合集。
章节标题通常是同一主论题下的 Facet，不默认视为全局 Topic。
只有能脱离本文、在未来与其他资料持续汇总的概念，才可提出 Topic Candidate。
```

## 5.3 Stage C：生成 Candidate，但不直接创建 Topic

新增：

```text
apps/server/src/services/wiki/candidate-generation.service.ts
```

规则：

- `single_topic_essay`：默认 0～1 个 document-level Candidate。
- `multi_topic_collection`：允许多个 Candidate，但每个必须有独立 scope 和证据集合。
- `reference_material`：优先标记为资料来源，不主动制造 Topic。
- Facet 的 `independence < 0.65`：只保留为 Facet。
- atomic granularity：只保留为 Claim。
- 每个 Candidate 至少绑定 2 个完整 Evidence Unit；不足则 `keep_as_facet`。

## 5.4 Stage D：Candidate → Existing Topic Assignment

新增：

```text
apps/server/src/services/wiki/topic-assignment.service.ts
```

这是跨文档有机整合的核心。

流程：

1. 使用 candidate semantic fingerprint 检索 Top-K 已有 Topic。
2. 同时做 normalized title、alias、entity、concept 检索。
3. 对 Top-K 计算组合分数。
4. 高置信度自动附加证据。
5. 中置信度产生人工建议。
6. 低置信度保留 Candidate 或创建 Draft。

建议初始分数：

```ts
assignmentScore =
  0.40 * semanticSimilarity +
  0.20 * conceptOverlap +
  0.15 * entityOverlap +
  0.15 * scopeCompatibility +
  0.10 * titleAliasScore;
```

初始阈值仅作为启动值，必须通过评测校准：

```text
>= 0.84：自动附加到已有 Topic
0.70～0.84：生成“建议加入已有 Topic”
< 0.70：不附加
```

硬性阻断条件：

- granularity 不兼容。
- scope 明显不同。
- 时间版本互斥但 Topic 不支持时间线。
- 同名异义。
- entity 主体不同。

LLM 只对中间模糊区间做判断，输入必须包含：

- Existing Topic title/scope/overview。
- Candidate title/scope/claims。
- 双方代表 Evidence。

输出：

```ts
{
  decision: 'attach' | 'separate' | 'facet_of' | 'uncertain';
  confidence: number;
  reason: string;
}
```

## 5.5 Stage E：新 Topic Creation Policy

创建新 Topic 必须满足下列之一：

### 普通 Topic

- 至少 2 个不同 Page。
- 至少 3 个有效 Evidence Unit。
- Topic scope 清晰。
- Assignment 未命中已有 Topic。
- 质量 Gate 通过。

### Single-source Draft

- Page 为高质量长文。
- 文档类型为 `single_topic_essay`。
- 主论题覆盖 >= 70% 有效章节。
- 至少 4 个完整 Evidence Unit。
- 用户看到明确的“单一来源”标签。
- 默认状态为 Draft，不是“已采纳”。

### 不得创建

- 只有一个 Chunk。
- 仅有标题，无完整命题。
- 内容只是文章章节名。
- Candidate 仅是人名、公司名或泛词。
- definition/overview 只能通过复制来源得到。

## 5.6 Stage F：Evidence Selection

新增：

```text
apps/server/src/services/wiki/evidence-selection.service.ts
```

不要直接把 `group.map(chunkId)` 全部拼起来。

步骤：

1. 获取 Candidate/Topic 的全部 Claim 和 Evidence。
2. 去除近重复 Evidence。
3. 每个 Page 设置上限，避免单一来源垄断。
4. 优先覆盖不同 Facet。
5. 保留冲突证据。
6. 按完整 Evidence Unit 计算 token budget。
7. 不允许在字符串中间 `slice()`。

建议策略：

```text
每来源最多 30% token
每个核心 Facet 至少 1 条 Evidence
相似度 > 0.92 的 Evidence 只保留信息更完整者
同一 Claim 的多来源证据可合并为 citation group
```

输出：

```ts
interface EvidenceSet {
  topicId?: string;
  units: Array<{
    evidenceId: string;
    pageId: string;
    chunkIds: string[];
    sectionPath: string[];
    claim: string;
    excerpt: string;
    role: string;
  }>;
  coverage: {
    sourceCount: number;
    facetCount: number;
    selectedUnits: number;
    droppedDuplicateUnits: number;
  };
}
```

## 5.7 Stage G：真正的 Topic Synthesis

新增：

```text
apps/server/src/services/wiki/topic-synthesis.service.ts
```

输出 Schema 升级为：

```ts
interface TopicSynthesisV2 {
  schemaVersion: 'topic-synthesis-v2';
  canonicalTitle: string;
  definition: string;
  overview: string;
  keyPoints: Array<{
    id: string;
    title: string;
    content: string;
    citations: CitationRef[];
    provenance: 'ai' | 'user' | 'mixed';
  }>;
  consensus: Array<{
    statement: string;
    citations: CitationRef[];
  }>;
  conflicts: Array<{
    question: string;
    positions: Array<{
      statement: string;
      citations: CitationRef[];
    }>;
  }>;
  timeline: Array<{
    date?: string;
    event: string;
    citations: CitationRef[];
  }>;
  openQuestions: string[];
  sourceCoverage: {
    pageCount: number;
    evidenceCount: number;
    singleSource: boolean;
  };
}
```

Prompt 强制要求：

- 不复制长段原文。
- definition 与 overview 功能不同。
- definition 回答“它是什么”。
- overview 回答“为什么重要、结构是什么”。
- keyPoints 必须互不重复。
- 不能从一个 Evidence 推导出超出原文的事实。
- 多来源一致时合并表述。
- 来源冲突时保留冲突，不强行求同。
- 每个事实性 KeyPoint 至少一个 citation。

## 5.8 Stage H：质量门禁

新增：

```text
apps/server/src/services/wiki/synthesis-quality.service.ts
```

### 必须实现的确定性检查

1. Schema 合法。
2. 所有 citation 指向模型实际接收的 Evidence。
3. 每个 keyPoint 至少一个 citation。
4. definition、overview、keyPoint 不能以明显半句开头。
5. definition 与 overview 字符 n-gram 相似度 < 0.65。
6. overview 与任一 keyPoint 相似度 < 0.75。
7. 任意两个 keyPoint 相似度 < 0.80。
8. 最长连续原文复制不得超过配置阈值，例如 80 个中文字符。
9. 单来源 Topic 必须标记 `singleSource=true`。
10. Page Section coverage 达到对应门槛。
11. Topic 标题与 overview embedding 相似度达到最低值。
12. 输出不能包含未完成句、孤立编号、被截断标题。

### 质量结果

```ts
interface SynthesisQualityResult {
  passed: boolean;
  score: number;
  issues: Array<{
    code: string;
    severity: 'error' | 'warning';
    message: string;
  }>;
}
```

### 失败策略

禁止继续使用当前静默 deterministic fallback。

改为：

```text
LLM 失败
→ 最多重试一次（修复 Prompt / structured output）
→ 仍失败：synthesisStatus = failed
→ 保留 Candidate / Evidence
→ UI 显示“综合失败，可重试”
→ 不创建可被误认为完成的 Topic 正文
```

允许生成“证据预览”，但必须：

- 单独字段 `evidencePreview`。
- 显示“这是原始证据，不是综合结果”。
- 不进入正式 TopicSynthesis。

---

## 6. 聚类与合并算法调整

## 6.1 删除“同页无条件合并”

立即删除：

```ts
if (samePage) {
  union(i, j);
  continue;
}
```

替换为关系分类：

```text
same_topic
facet_of_same_document
related_but_distinct
unrelated
```

同页只作为以下信号：

- 共享文档上下文。
- 可能属于同一主论题。
- 不能证明属于同一全局 Topic。

## 6.2 不再用 union-find single-link 作为最终 Topic 聚类

建议采用：

### 优先路径

```text
Candidate → Existing Topic Assignment
```

大部分跨文档整理应通过“加入已有 Topic”完成。

### 新 Candidate 聚类

仅对未匹配 Candidate 做：

- blocking：实体、概念、scope、granularity。
- Top-K nearest neighbor，不全量两两比较。
- average-link 或 complete-link cohesion。
- 每次加入 Candidate 后重新计算 cluster centroid 和最小成员相似度。

Gate：

```text
cluster average similarity >= calibrated threshold
cluster minimum similarity >= lower bound
scope compatibility = true
```

## 6.3 Existing Topic 维护 semantic centroid

为 Topic 保存：

- title embedding。
- scope embedding。
- synthesis embedding。
- evidence centroid。

新 Evidence 加入后异步更新 centroid，不要只依赖标题 embedding。

## 6.4 合并建议必须展示原因

UI 展示：

```text
建议把“开源的战略逻辑”加入“DeepSeek 的开源战略”
原因：核心实体相同；3 个概念重合；语义相似度 0.87；scope 一致
差异：新资料增加了第三方部署成本和生态合作的论据
```

用户操作：

- 加入已有 Topic。
- 保持独立。
- 作为 Facet。
- 创建别名。
- 永不再次建议此配对。

---

## 7. 人工修正与可控演化

## 7.1 Topic 编辑器

前端新增：

```text
apps/web/src/features/wiki/TopicEditor.tsx
apps/web/src/features/wiki/TopicKeyPointEditor.tsx
apps/web/src/features/wiki/TopicSourcesPanel.tsx
```

支持：

- 标题内联编辑。
- definition 编辑。
- overview 编辑。
- keyPoint 增删改排序。
- citation 查看与替换。
- 来源 Page/Chunk 添加和移除。
- 将 AI KeyPoint 标记为“不正确”。
- 将 KeyPoint 固定，后续刷新不得删除。
- 添加纯人工 KeyPoint。

## 7.2 Candidate 审阅界面

不要只显示“采纳 / 忽略”。

增加：

- 加入已有 Topic。
- 新建 Topic。
- 保留为页面 Facet。
- 修改候选标题和 scope。
- 与另一个 Candidate 合并。
- 永久忽略此类 Candidate。

## 7.3 Topic 拆分

用户可勾选 KeyPoint/来源，创建新 Topic：

```text
原 Topic：DeepSeek 的 AGI 战略
拆出：DeepSeek 的国产算力路线
```

保留 operation log，可撤销。

## 7.4 Topic 降级

错误创建的单来源薄 Topic 可执行：

```text
降级为 Page Facet
```

效果：

- Topic 不再出现在全局 Topic Center。
- 内容和引用不丢失。
- 后续有新来源时可再次建议晋升。

## 7.5 刷新策略

新来源加入时：

```text
Evidence Set vN
→ 生成 Synthesis vN+1
→ 与当前 base synthesis 做结构化 diff
→ 重放用户 field overrides
→ 用户审阅冲突项
```

Diff 类型：

- 新增 KeyPoint。
- 更新 KeyPoint。
- 来源增强但正文不变。
- 观点冲突。
- 引用失效。
- 建议拆分。
- 建议合并。

---

## 8. UX 调整

## 8.1 LLM Inbox 完成后先展示“本页理解”，不是直接 Topic

页面处理完成后的卡片：

```text
已理解本文
主论题：DeepSeek 的 AGI 优先战略与克制哲学
文档类型：单主题长篇观点综述
章节覆盖：11/11
识别到：7 个 Facet、28 条 Claim
建议：创建 1 个单来源 Topic 草稿
```

用户可展开 Facet。

## 8.2 Topic Center 状态重命名

建议状态：

- `candidate`：候选。
- `facet`：页面知识。
- `draft`：Topic 草稿。
- `confirmed`：已确认。
- `degraded`：降级结果。
- `synthesis_failed`：综合失败。
- `stale`：来源已变化。
- `archived`：已归档。

避免把“用户接受了候选”直接写成“已采纳知识”。

## 8.3 Topic 卡片增加质量与来源信息

```text
DeepSeek 的 AGI 优先战略
已确认 · 单一来源 · 8 个要点 · 11 个章节证据
质量 86/100 · 更新于 2 小时前
```

多来源时：

```text
4 篇来源 · 18 条证据 · 2 个观点差异
```

## 8.4 降级结果必须显眼

当综合失败时：

```text
综合失败
已保留 5 条原始证据，但尚未生成可靠 Topic 正文。
[重试] [查看错误] [手动整理]
```

不得继续渲染“定义 / 概述 / 要点”的假结构。

## 8.5 Citation 体验

点击引用：

- 打开来源 Page。
- 滚动到对应 Chunk/段落。
- 高亮证据。
- 显示该证据贡献给哪个 KeyPoint。

## 8.6 Page 与 Topic 双向导航

Page 侧边栏显示：

```text
本页贡献给 3 个 Topic
- DeepSeek 的开源战略：2 条 Claim
- 持续学习：1 条 Claim
- 中国 AI 算力路线：3 条 Claim
```

Topic 侧显示来源分组和新增贡献。

---

## 9. 工程结构重构

当前 `wiki.service.ts` 约 1900 行，职责过多。拆分：

```text
apps/server/src/services/wiki/
├── document-parser.service.ts
├── page-understanding.service.ts
├── facet.service.ts
├── claim-extraction.service.ts
├── candidate-generation.service.ts
├── candidate-evidence.service.ts
├── topic-assignment.service.ts
├── topic-creation-policy.ts
├── evidence-selection.service.ts
├── topic-synthesis.service.ts
├── synthesis-quality.service.ts
├── topic-refresh.service.ts
├── topic-operations.service.ts
├── topic-index.service.ts
├── topic-lifecycle.service.ts
└── types.ts
```

`wiki.service.ts` 最终仅作为兼容 facade 或删除。

Job 拆分：

```text
page.parse_document
page.extract_knowledge_map
page.generate_candidates
space.assign_candidates
space.create_topic_drafts
topic.synthesize
topic.refresh
topic.evaluate_quality
```

每个 Job：

- 幂等。
- 记录 input version。
- 记录 prompt version。
- 记录模型与 token 使用。
- 可重试。
- 不因后续失败破坏前序成功产物。

---

## 10. 分阶段执行计划

# Phase 0：建立真实基线与固定复现样例

### 任务

1. 将用户提供的 DeepSeek 长文加入测试 fixture：

```text
apps/server/src/tests/fixtures/deepseek-long-essay.md
```

2. 保存当前产物快照：

- Candidate 数量。
- Candidate 标题。
- 覆盖章节。
- Topic 数量。
- definition/overview/keyPoint 重复率。
- 综合是否走 fallback。

3. 增加运行诊断：

```ts
{
  inputCharacterCount,
  inputTokenEstimate,
  processedCharacterCount,
  sectionCount,
  candidateCount,
  evidenceCount,
  usedFallback,
  qualityScore,
  qualityIssues,
  promptVersion,
  model
}
```

### Gate

- 测试可稳定复现当前错误。
- 能明确看出只处理前 4000 字符。
- 能明确记录 synthesis 是否走 deterministic fallback。
- 失败原因不再只出现在 console。

---

# Phase 1：P0 止血修复

这是必须最先上线的一轮。

### 1.1 禁止伪综合

修改 `generateTopicSynthesis()` 返回：

```ts
type SynthesisResult =
  | { status: 'ready'; synthesis: TopicSynthesisV2; diagnostics: ... }
  | { status: 'failed'; error: string; evidencePreview: ... };
```

删除“失败后返回 buildDeterministicSynthesis 并按成功写库”的路径。

### 1.2 添加质量 Gate

最少实现：

- definition/overview 重复检测。
- 半句检测。
- 原文长复制检测。
- keyPoint 去重。
- citation 合法性。

### 1.3 UI 展示真实状态

- fallback/failed 不显示“已采纳”。
- 显示“综合失败”。
- 显示重试和错误详情。

### 1.4 修复 source filter

当前前端 AI 来源筛选使用：

```ts
t.source === 'ai'
```

数据库实际为：

```text
ai_generated
```

统一为共享 enum，禁止前端硬编码。

### 1.5 修复轮询条件

当前 `topics.length > 0` 会让 `hasActivity` 长期为 true。

改为只在以下情况轮询：

- 有 processing inbox。
- 有 running job。
- 有 pending refresh。
- 用户刚发起操作。

### Phase 1 Gate

使用 DeepSeek fixture：

- 不再出现 definition、overview、keyPoint 完全相同。
- 综合失败时不会创建“看起来正常”的 Topic。
- 不出现以“起来，需要……”开头的半句。
- 前端能明确展示失败原因。
- Topic 页面空闲时不持续轮询。

---

# Phase 2：文档结构与 PageKnowledgeMap

### 任务

1. 实现 Section Tree。
2. 实现 token-aware Map-Reduce。
3. 新增 PageKnowledgeMap、Facet、Claim Schema 和 migration。
4. 将旧 `aiTopics(text.slice(0, 4000))` 替换成 Page Understanding。
5. 保存完整覆盖诊断。

### Phase 2 Gate

DeepSeek fixture：

- 识别全部 `#01`～`#10` 和结尾反思章节。
- `processedCharacterCount / inputCharacterCount >= 0.95`。
- 文档类型识别为 `single_topic_essay` 或等价类型。
- 生成 1 个主论题。
- 生成 6～10 个 Facet。
- Facet 覆盖后半篇 Scaling、算力、行业收敛、数据。
- 不自动把全部 Facet 建成 Topic。

---

# Phase 3：Candidate Evidence 多对多与新建门槛

### 任务

1. 新增 `candidate_evidence`。
2. Candidate 从单 `chunkId` 迁移为多 Evidence。
3. 每个 Candidate 记录 scope/granularity/kind。
4. 改写 TopicCreationPolicy。
5. Promote Candidate 必须经过 Policy 与 Evidence Selection。

### Phase 3 Gate

- 任一正式 Topic 至少 2 个 Evidence Unit。
- 自动创建 single-source Draft 时，至少覆盖 70% 主论题相关章节。
- 用户点击晋升时，UI 明确显示来源数与单来源风险。
- 单 Chunk Candidate 只能保留为 Facet/Claim，不能自动成为正式 Topic。

---

# Phase 4：Existing Topic Assignment 与跨文档汇总

### 任务

1. 为 Topic 建 semantic centroid。
2. 实现 Candidate → Existing Topic Top-K 检索。
3. 实现组合 assignment score。
4. 模糊区间使用 LLM adjudication。
5. 去掉 same-page unconditional union。
6. 新 Candidate 聚类改为 cohesion gate。

### 测试场景

依次加入三篇资料：

1. 当前 DeepSeek 长文。
2. 一篇专门分析 DeepSeek 开源模型与 API 成本的文章。
3. 一篇讨论开源模型商业模式、但主体不是 DeepSeek 的文章。

预期：

- 第 2 篇相关 Facet 加入 `DeepSeek 的开源战略` Topic。
- 第 3 篇不应因为都有“开源”二字而错误合并；可进入更泛的上层 Topic 或保持独立。
- Topic 来源数从 1 增长到 2，触发 refresh diff。

### Phase 4 Gate

在人工标注评测集上：

- 自动 attach precision >= 0.90。
- duplicate Topic rate <= 0.10。
- same-name different-meaning false merge <= 0.03。
- 新来源能更新已有 Topic，而不是普遍新建重复 Topic。

---

# Phase 5：TopicSynthesis V2 与质量评分

### 任务

1. 实现 Evidence Selection。
2. 实现 TopicSynthesisV2。
3. 实现 SynthesisQualityResult。
4. 质量失败不写正式正文。
5. Topic 索引仅索引通过 Gate 的正文；失败状态只索引标题和 Evidence metadata。

### Phase 5 Gate

DeepSeek 单来源 Topic：

- definition 1～3 句，非原文复制。
- overview 覆盖愿景、开源、技术路线、效率/算力等主线。
- 6～8 个互不重复 KeyPoint。
- 每个 KeyPoint 有有效引用。
- definition 与 overview 相似度 < 0.65。
- 任意 KeyPoint 间相似度 < 0.80。
- 不出现超过阈值的连续原文复制。

加入第二篇来源后：

- overview 能体现跨文档综合。
- 不只是把两篇摘要串联。
- 新增信息通过 diff 展示。

---

# Phase 6：人工编辑、合并、拆分、降级

### 任务

1. Topic 正文编辑器。
2. Candidate 指派已有 Topic。
3. Topic 合并和拆分。
4. Topic 降级为 Facet。
5. 字段级 override。
6. 操作日志与撤销。

### Phase 6 Gate

- 用户修改标题后刷新不回退。
- 用户删除 KeyPoint 后 AI 不自动恢复，除非 diff 中明确建议。
- 用户新增人工 KeyPoint 永久保留。
- Topic 合并和拆分可撤销。
- 被移除的来源不会继续出现在 citation 中。

---

# Phase 7：迁移旧数据

### 任务

编写：

```text
scripts/migrate-wiki-v1-to-v2.ts
```

分类旧 Topic：

1. 结构完整且质量通过：迁移为 V2。
2. 单来源且正文重复：标记 `degraded`，重新综合。
3. 只有一个 Chunk：建议降级为 Facet。
4. 重复 Topic：生成合并建议。
5. 用户编辑 Topic：保留正文，建立 field override 快照。

### 强制规则

- 不自动删除旧 Topic。
- 不自动覆盖用户编辑内容。
- 迁移前备份。
- 所有迁移动作有 report 和 rollback。

### Phase 7 Gate

- 旧 Topic 数量、来源、用户编辑无丢失。
- 迁移报告能列出每个 Topic 的处理方式。
- rollback 可恢复迁移前状态。

---

# Phase 8：性能、成本和可观测性

### 任务

记录每个 Stage：

- token 输入/输出。
- 模型耗时。
- embedding 次数。
- 重试次数。
- Candidate 数量。
- Assignment 命中率。
- Synthesis 通过率。
- 用户接受/修改/忽略率。

缓存：

- Section understanding 按 `pageId + contentVersion + promptVersion`。
- Claim embedding。
- Topic centroid。
- Assignment result。

增量更新：

- Page 只改一个 Section 时，仅重算受影响 Section。
- 重用未变化 Claim。
- 只刷新受影响 Topic。

### Phase 8 Gate

- 长文修改单章节时，不重跑整篇所有 LLM 调用。
- 相同版本 Job 幂等。
- 失败重试不会重复创建 Candidate/Facet/Topic。
- 500 Candidate Space 不进行全量 O(n²) LLM 比较。

---

## 11. 评测体系

建立：

```text
apps/server/src/tests/wiki-evaluation/
├── fixtures/
├── gold/
├── extraction.eval.test.ts
├── assignment.eval.test.ts
├── synthesis.eval.test.ts
├── refresh.eval.test.ts
└── human-overrides.eval.test.ts
```

## 11.1 指标

### 文档覆盖率

```text
被 Evidence/Facet 覆盖的有效 Section 数 / 总有效 Section 数
```

目标：>= 0.90。

### Fragmentation Rate

```text
由单 Page 自动创建的正式 Topic 数 / Page 主论题数
```

对 `single_topic_essay`：目标 <= 1.0。

### Topic Duplication Rate

语义等价但并存的 Topic 占比。

目标：<= 0.10，稳定后 <= 0.05。

### Assignment Precision / Recall

新 Candidate 是否正确加入已有 Topic。

优先保证 Precision，自动操作目标 >= 0.90。

### Synthesis Copy Ratio

输出中与任一来源连续重合内容比例。

目标：不能出现大段原文替代综合。

### Field Redundancy

- definition vs overview。
- overview vs keyPoints。
- keyPoint vs keyPoint。

### Citation Validity

目标：100% 指向模型真实接收且仍存在的 Evidence。

### Human Override Preservation

目标：100%。

## 11.2 必测语料类型

1. 单主题长文。
2. 多主题周报合集。
3. 会议纪要。
4. 项目复盘。
5. 技术论文笔记。
6. 多篇同主题观点文章。
7. 同名异义资料。
8. 时间演化资料。
9. 中英混合资料。
10. 很短的临时笔记。

---

## 12. 针对当前样例的自动化验收用例

```ts
describe('DeepSeek long essay organic wiki', () => {
  it('processes the full document instead of the first 4000 chars');
  it('detects sections 01 through 10 and the final caveat section');
  it('classifies the document as a single-topic essay');
  it('creates one primary document topic candidate');
  it('keeps chapter themes as facets before cross-document promotion');
  it('does not create four accepted thin topics automatically');
  it('never exposes deterministic evidence excerpts as successful synthesis');
  it('rejects duplicated definition overview and key points');
  it('does not begin synthesis fields with sentence fragments');
  it('preserves citations to all selected evidence units');
});
```

Gold 约束：

```json
{
  "documentType": "single_topic_essay",
  "expectedPrimaryTopicCount": 1,
  "expectedFacetCountRange": [6, 10],
  "mustCoverConcepts": [
    "愿景",
    "合理利润",
    "开源",
    "持续学习",
    "多模态与搜索",
    "Scaling Law",
    "算力与国产芯片",
    "模型竞争",
    "行业收敛",
    "高质量数据"
  ],
  "maxAutoCreatedFormalTopics": 1,
  "allowSuccessfulFallback": false
}
```

---

## 13. Trae 第一轮必须执行的 Sprint

不要一次性实现全部 Plan。第一轮只完成以下内容，先解决用户眼前最明显的错误。

### Sprint 04-A：质量止血

1. 加入 DeepSeek fixture 和回归测试。
2. 为 `aiTopics()` 增加 input coverage diagnostics。
3. 停止将 `buildDeterministicSynthesis()` 当成正常成功结果。
4. 新增 `synthesisStatus` 和 `qualityIssues` 字段。
5. 实现 definition/overview/keyPoint 重复检测。
6. 实现半句和长原文复制检测。
7. 综合失败时保存 Evidence Preview，Topic 状态设为 `synthesis_failed`。
8. 前端显示“综合失败”，不显示“已采纳”。
9. 修复 `ai` / `ai_generated` 来源枚举不一致。
10. 修复 Topic 存在时长期轮询。

### Sprint 04-A 验收

必须提供：

- migration。
- 单元测试。
- 集成测试。
- DeepSeek fixture 前后对比截图或 JSON snapshot。
- 失败路径截图。
- `pnpm test`、`pnpm lint`、`pnpm build` 结果。

未达到以下标准不得进入下一 Sprint：

```text
不再把重复原文显示为成功综合
不再把半句话显示为 definition
用户能看到真实失败原因
当前四个错误 Topic 可被识别为 degraded/failed 并重新处理
```

### Sprint 04-B：全篇理解

Sprint 04-A 完成后再执行：

1. Section Tree。
2. Map-Reduce PageKnowledgeMap。
3. 主论题 + Facet + Claim。
4. Candidate 多 Evidence。
5. 单主题长文最多自动创建一个 Topic Draft。

### Sprint 04-C：跨文档有机汇总

Sprint 04-B 完成后再执行：

1. Candidate → Existing Topic Assignment。
2. Topic centroid。
3. Evidence Selection。
4. TopicSynthesisV2。
5. 增量 refresh diff。

---

## 14. 禁止事项

Trae 执行时禁止以下“看似快速”的修复：

1. 只把 `slice(0, 4000)` 改成 `slice(0, 16000)`。
2. 只修改 Prompt，让模型“少生成几个 Topic”。
3. 继续让一个 Candidate 只绑定一个 Chunk。
4. 继续把 LLM 失败降级成复制原文并标记成功。
5. 仅通过降低 embedding threshold 来合并更多 Topic。
6. 仅通过提高 embedding threshold 来阻止拆分。
7. 让同一 Page 的所有 Candidate 无条件合并。
8. 让同一 Page 的所有 Candidate 无条件分开。
9. 自动覆盖用户编辑正文。
10. 为了演示效果而隐藏 quality diagnostics。
11. 用 UI 文案掩盖后端知识模型问题。
12. 在没有评测集的情况下凭感觉调整阈值。

---

## 15. 最终完成标准

Plan 04 完成后，ZhiPane 的 LLM Wiki 应表现为：

1. 用户导入长文后，系统先理解整篇文章，而不是只读开头。
2. 文章章节被识别为 Facet，不再默认全部升级为 Topic。
3. 一个 Topic 可以有多个 Page、多个 Facet、多个 Claim 和多个 Chunk 证据。
4. 相似的新资料优先补充已有 Topic。
5. Topic 内容体现压缩、归纳、去重、比较和冲突处理，而不是复制原文。
6. AI 失败会诚实显示失败，不再伪装成完成。
7. 用户可以修正标题、定义、概述、要点、来源和 Topic 归属。
8. AI 后续更新不覆盖人工修改。
9. Topic 可以持续吸收新来源，形成版本化 diff。
10. Page、Facet、Claim、Topic 的层级在产品界面和代码中都清晰存在。

最终产品心智应从：

```text
AI 帮我把一篇笔记切成几个卡片
```

转变为：

```text
AI 持续阅读我的资料，把散落在不同页面里的证据组织成可编辑、可追溯、会演化的知识体系
```
