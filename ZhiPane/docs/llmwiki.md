# ZhiPane 智能整理 / LLM Wiki：执行手册

> 一次只执行一个 Phase。当前 Phase 的测试和 Gate 未通过，禁止进入下一阶段。

## A. 任务目标

把当前：

```text
单篇 Page → 提取 1～4 个标题 → 立即创建 Topic → 只有一句摘要
```

改为：

```text
Page/Chunk
→ 语义信号
→ Topic Candidate
→ Space 内聚类
→ Topic Draft
→ 用户审阅
→ 正式 Topic
→ 刷新/合并/拆分/晋升/归档/再激活
```

不要通过“让 Prompt 写得更长”解决问题。必须调整领域模型和处理流程。

## B. 强制产品规则

1. Page 是事实源，AI 不自动删除、移动或覆盖 Page。
2. Candidate 不是 Topic；单篇 Page 的主题只能先成为候选。
3. 正式 Topic 应综合多个 Page/Chunk；单一来源必须标记 `single_source`。
4. `aiSummary` 只做列表预览；正式正文写入 `contentJson`，纯文本写入 `textContent`。
5. Topic 每个关键结论必须引用真实 Chunk。
6. 发布状态、新鲜度、生命周期必须拆分。
7. Project 是 `kind=project` 的 Space，不新增平行 Project 主模型。
8. `stale` 表示来源变化；`inactive` 表示长期未使用，两者不得混淆。
9. 项目完成后先提炼可复用知识，再归档。
10. 归档不是删除；归档内容默认降权，但仍可搜索、引用和恢复。
11. 合并、拆分、移动、晋升、覆盖用户正文、归档必须人工确认并可撤销。
12. LLM 负责提取、综合、解释；权限、门槛、状态机和归档资格由确定性规则负责。

## C. 重点代码范围

先阅读：

- `apps/server/src/services/wiki.service.ts`
- `apps/server/src/services/job-runner.ts`
- `apps/server/src/routes/llm-wiki.ts`
- `apps/server/src/services/search.service.ts`
- `apps/server/src/services/rag.service.ts`
- `apps/web/src/features/wiki/WikiView.tsx`
- `packages/db/src/schema.ts`
- 相关 migrations、tests、`docs/DESIGN-v1.3.md`

## D. 目标数据模型

### D1. Space

扩展现有 Space：

```ts
spaceKind: 'project' | 'area' | 'resource' | 'inbox';
lifecycleStatus: 'active' | 'on_hold' | 'completed' | 'archived';
startedAt?: Date;
targetEndAt?: Date;
completedAt?: Date;
archivedAt?: Date;
archivePolicy: {
  mode: 'manual' | 'suggest' | 'auto';
  inactiveDays: number;
  completedGraceDays: number;
};
```

规则：

- Project：有目标和结束时间。
- Area：长期领域，默认不自动归档整个 Space。
- Resource：长期可复用资料。
- Inbox：待分类内容，只提示整理。

### D2. Topic Candidate

Page 处理阶段只生成 Candidate，MVP 可存入 `llm_suggestions.payload`：

```ts
interface TopicCandidatePayload {
  proposedTitle: string;
  normalizedTitle: string;
  aliases: string[];
  shortSummary: string;
  concepts: string[];
  claims: Array<{ text: string; sourceChunkIds: string[] }>;
  sourcePageId: string;
  sourceChunkIds: string[];
  confidence: number;
  reason: string;
  promptVersion: string;
  model: string;
}
```

不得在 Candidate 阶段创建空正文 `wiki_topics`。

### D3. 正式 Topic

```ts
interface TopicSynthesis {
  schemaVersion: 'topic-synthesis-v1';
  definition: string;
  overview: string;
  keyPoints: Array<{
    id: string;
    title: string;
    content: string;
    citations: CitationRef[];
  }>;
  subtopics: Array<{
    title: string;
    summary: string;
    citations: CitationRef[];
  }>;
  conflicts: Array<{
    description: string;
    sides: Array<{ statement: string; citations: CitationRef[] }>;
  }>;
  decisions: Array<{
    decision: string;
    rationale: string;
    citations: CitationRef[];
  }>;
  openQuestions: string[];
  relatedTopicIds: string[];
  generatedFromContentVersions: Array<{
    pageId: string;
    contentVersion: number;
  }>;
}
```

存储：

```text
aiSummary   = 一句话预览
contentJson = TopicSynthesis
textContent = 从 contentJson 提取的纯文本
```

### D4. Topic 状态

```ts
publicationStatus: 'suggested' | 'draft' | 'accepted' | 'user_edited';
freshnessStatus: 'fresh' | 'stale' | 'refresh_failed';
lifecycleStatus: 'active' | 'cooling' | 'dormant' | 'archived';

lastMeaningfulActivityAt?: Date;
inactiveSince?: Date;
archiveCandidateAt?: Date;
archivedAt?: Date;
archivedById?: string;
archiveReason?: string;
pinned: boolean;
keepActiveUntil?: Date;
promotedFromTopicId?: string;
originSpaceId?: string;
```

旧 `status` 暂不物理删除，先兼容迁移一个发布周期。

### D5. Topic 来源

来源必须支持 Chunk 级证据：

```ts
topicId;
pageId;
chunkId?;
sourceContentVersion;
sourceType: 'page' | 'chunk' | 'manual' | 'topic';
relevanceScore?;
evidenceExcerpt?;
addedBy: 'ai' | 'user';
contributionType:
  | 'definition'
  | 'key_point'
  | 'conflict'
  | 'decision'
  | 'example'
  | 'background';
```

## E. 核心流水线

### E1. Page 保存

```text
Page 保存
→ 生成稳定 Chunk
→ 完成索引
→ 提取 Page Profile/Candidate
→ 入队 Space 聚类任务
```

重构 `generateWikiArtifacts()`：不再直接 `findOrCreateTopic()`。

### E2. Space 聚类

新增 Job：

```text
space.consolidate_topic_candidates
```

顺序：

1. 标题规范化。
2. 别名匹配。
3. 概念/关键词重叠。
4. Embedding 相似度。
5. 仅对模糊区间调用 LLM。
6. 输出：关联已有 Topic、创建 Draft、建议合并、证据不足。

禁止让 LLM 对所有候选两两比较。

### E3. Topic 创建门槛

建立独立 `TopicCreationPolicy`：

- 单篇短 Page：只保留 Candidate。
- 单篇高质量长 Page：可创建 `single_source` Draft。
- 两篇以上相关 Page 或足够多有效 Chunk：可创建普通 Draft。
- 证据不足：不生成正式 Topic，不填充空泛正文。

### E4. Topic 综合

- 按 Topic 查询相关 Chunk，不得拼页面全文后 `slice()`。
- 每篇来源设置 Chunk 配额。
- 去除高度重复 Chunk。
- 每个 keyPoint 至少一个 citation。
- citation 只能引用模型真实接收的 Chunk。
- 使用 Zod 校验；校验失败不得写库。
- 保存成功后将 Topic 写入全文和向量索引。

### E5. Topic 刷新

来源版本变化：

```text
fresh → stale → 生成 refresh diff → 用户逐项应用
```

Diff 包含：新增、修改、删除、冲突、新来源、失效引用。

规则：

- 不自动覆盖 `user_edited` 正文。
- AI/校验失败时保持 stale。
- 失败时不得清除 stale suggestion。
- UI 显示失败原因和重试入口。

## F. 项目结项与生命周期

### F1. 项目完成

Project 标记 `completed` 后不立即归档。

新增 Job：

```text
project.generate_closure_package
```

输出并引用 Chunk：

- 项目目标和结果。
- 关键决策及依据。
- 成功/失败经验。
- 技术债和未完成事项。
- 可复用知识候选。
- 项目专属归档知识。
- 推荐晋升到 Area/Resource 的 Topic。

AI 只能建议，不自动移动资料。

### F2. 知识晋升

用户确认后可移动或派生 Topic，必须保留：

- `promotedFromTopicId`。
- `originSpaceId`。
- 原项目历史和引用。
- 操作审计记录。

### F3. 活跃度

记录真实活动：编辑、打开、搜索点击、RAG 最终引用、citation 打开、加入 Topic 来源、被活跃项目引用。

不计入活动：后台索引、AI 自动摘要、定时任务更新、普通轮询。

新增：

```text
knowledge_activity_events
knowledge_activity_stats
```

统计至少包含：

```text
lastEditedAt / lastViewedAt / lastRetrievedAt / lastLinkedAt
lastMeaningfulActivityAt
views30d / citations30d / ragCitations30d / activeUsers30d
activityScore / calculatedAt
```

### F4. 生命周期评估

新增每日 Job：

```text
knowledge.evaluate_lifecycle
```

初始策略：

- Project completed 且 30 天无活动：归档建议。
- Topic 90 天无活动：cooling/dormant 建议。
- Topic 180 天无活动且不被活跃项目引用：归档建议。
- Area 不自动归档整个 Space。
- Resource 使用更长阈值。
- Inbox 只提示分类。

保护条件：

- pinned。
- keepActiveUntil 未到期。
- 被活跃项目引用。
- 最近被 RAG 最终引用。
- 存在未处理 stale。
- user_edited Topic 默认不自动归档。
- 项目有未完成事项。

Job 只生成 Suggestion，不直接归档。

### F5. Search/RAG

默认排序：

```text
活跃当前 Space
→ 活跃 Area/Resource
→ completed 未归档 Project
→ archived 降权回退
```

规则：

- archived 不完全排除。
- 历史意图提高 archived 权重。
- 当前/最新意图提高 fresh/active 权重。
- 引用 archived 内容时显示项目名、归档时间和历史警告。
- 归档知识被新项目频繁引用时生成再激活建议。

## G. 前端工作区

“智能整理”分为：

1. 待处理：失败任务、异常状态、重试。
2. 候选主题：创建、重命名、合并、忽略、查看依据。
3. 知识主题：正式 Topic 浏览和编辑。
4. 待更新：stale Topic、refresh diff。
5. 生命周期：低活跃、归档建议、已归档、恢复。

正式 Topic 详情展示：definition、overview、keyPoints、conflicts、openQuestions、Chunk 来源、相关 Topic、新鲜度、生命周期。

项目完成向导：

```text
确认完成 → 查看结项总结 → 审阅未完成事项
→ 处理可复用知识 → 确认归档
```

## H. 分阶段执行

### Phase 0：修复当前正确性

任务：

- 修复 `markTopicsStaleForPage()` 重复 `WHERE`。
- 修复刷新失败仍变 accepted、仍清除 stale。
- Topic 默认查询排除 archived，并支持显式筛选。
- 用户修改标题、正文或来源时标记 `user_edited`。
- 创建 Topic 草稿的 Suggestion 风险改为 medium。
- Wiki 生成失败持久化并在 UI 显示。
- 先补失败测试。

Gate：AI 失败无成功假象；失败刷新不破坏状态；lint/typecheck/test/build 通过。

### Phase 1：状态模型与 Space 语义

任务：Space kind/lifecycle、Topic 三维状态、兼容迁移、Active/Completed/Archived 查询。

Gate：旧数据无损；stale 与 archived 可同时存在；Project 完成不立即归档；权限测试通过。

### Phase 2：Candidate 与 Topic 解耦

任务：Page 只生成 Candidate；结构化 Page Profile；Candidate UI；兼容旧 summary-only Topic。

Gate：单篇短 Page 不创建多个正式 Topic；Candidate 有 Chunk 引用；AI 失败不制造正式 Topic。

### Phase 3：聚类与 Topic 综合

任务：聚类 Job、别名/Embedding/LLM 模糊判定、TopicCreationPolicy、TopicSynthesis、citations、Topic 索引。

Gate：同义可聚合；同名异义不误合并；Topic 有 overview/keyPoints/citations；非法 JSON 不写库；RAG 可检索 Topic。

### Phase 4：刷新、合并、拆分

任务：freshness、refresh diff、user_edited 保护、合并/拆分建议、重定向和撤销。

Gate：用户正文不被覆盖；Diff 可逐项应用；合并后可追溯和恢复。

### Phase 5：活动与生命周期

任务：activity events/stats、lifecycle Job、归档中心、Search/RAG 排序、恢复和再激活。

Gate：后台任务不伪造活跃度；保护规则生效；archived 降权但可查；历史查询正确。

### Phase 6：项目结项与晋升

任务：closure package、可复用知识识别、Topic 派生/移动、归档向导、derived_from 和审计。

Gate：结论都有 citation；AI 不自动移动；原项目历史完整；目标 Space 权限正确。

## I. 最低测试集

1. 单篇短 Page 只生成 Candidate。
2. 两篇相关 Page 聚合成一个 Topic。
3. 同义别名可聚合，同名异义不合并。
4. 每个 keyPoint 有有效 citation。
5. 非法 JSON 不写库，AI 失败不创建正式 Topic。
6. 来源变化后 Topic 变 stale；刷新失败仍保持 stale。
7. user_edited 正文不被覆盖；archived Topic 不自动刷新。
8. 后台索引不更新 `lastMeaningfulActivityAt`。
9. 搜索点击、打开和 RAG citation 更新活动。
10. pinned、活跃项目引用、keepActiveUntil 能阻止归档建议。
11. lifecycle Job 幂等。
12. archived 默认降权但可搜索；历史查询提高其权重。
13. archived citation 显示历史警告；恢复后重新进入活跃检索。
14. Project completed 后不立即归档。
15. closure package 结论有 citation；晋升保留原项目历史。
16. 无权限用户不能读取 Candidate、Topic 和 Archive。
17. 跨 Space 混搭 ID 被拒绝。
18. cancelled Job 不会被覆盖为 succeeded；索引失败时旧索引仍可用。
19. 合并、晋升、归档写审计记录并可撤销。

## J. 工程限制

禁止：

- 只改 Prompt。
- 一次性重写整个 Wiki。
- 无必要引入 Prisma、Redis、BullMQ 或新前端框架。
- 吞异常、删除测试、放宽类型换取通过。
- 使用 LLM 替代 Domain Policy。
- 自动执行高风险操作。
- 丢失 Topic 来源。
- 让 archived 永久不可搜索。
- AI 覆盖用户正文。
- 未运行命令却声称完成。

迁移必须可回滚、兼容旧数据，并保存 Prompt/Schema 版本。

## K. Trae 每阶段输出格式

编码前输出：

1. 当前数据流和根因。
2. 拟修改文件。
3. 数据库迁移和 API 兼容性。
4. 风险与回滚。
5. 测试计划。
6. 本 Phase 不处理的内容。

编码后真实执行：

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

涉及 UI 时增加 Playwright E2E。

最终报告：修改摘要、文件、迁移、Prompt/Schema 版本、真实命令结果、性能/AI 成本、权限/UX 影响、回滚、剩余问题、Gate 结果。