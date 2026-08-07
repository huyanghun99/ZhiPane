# ZhiPane 项目深度审视与提升计划 (plan03)

> 本文档在 plan02 执行落地的基础上，对**当前主干代码（main @ 9060727）**重新做了一次「挑剔工程师 + 极致产品体验 + 跨职能」三方视角的复审。
> 复审方法：在 WSL 中实拉仓库 → `pnpm install` → 真实运行 `pnpm typecheck && pnpm lint && pnpm build`（全绿）→ 逐文件阅读 server/services、routes、middleware、packages、web/features、editor、styles → 与 DESIGN-v1.3 / AGENTS.md / sprint.md / MILESTONES.md 对照。
> 执行原则不变：**一次只做一个 Phase，每 Phase 必须 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 全绿再进下一阶段。** 测试需 DB，可 `docker compose up -d db` 后再跑。

---

## 0. 现状复审：plan02 之后到底改了多少

先厘清哪些 plan02 里的硬伤已经修掉、哪些还在——避免重复劳动，把火力集中在「仍未解决」和「新冒出来」的问题上。

### 0.1 已确认修复（无需再做）

| plan02 编号 | 问题 | 现状证据 |
|---|---|---|
| T1 / T2 | lint 报错、`canManageSpace` 漏 import、typecheck 形同虚设 | 实跑 `pnpm lint` 与 `pnpm typecheck` 全绿，0 error |
| T3 | 聚类同步卡死 HTTP、无进度无取消 | `consolidateCandidates` 已改为 job 异步执行，带 `onProgress` 写回 `jobs.progress`；前端 `WikiView` 轮询 job 状态 |
| T4 | merge/split/undo 无事务 | `mergeTopics`(`wiki.service.ts:1557`)、`splitTopic`(`:1657`)、`undoTopicOperation`(`:1766`) 均包在 `db.transaction` 内 |
| T6 | Job runner 无优雅关闭、僵尸 job 无回收 | 新增 `recoverZombieJobs()`（启动时回收 running>5min 的 job）+ `stopJobRunner()`（清 timer + 等待 in-flight job≤15s） |
| T7 | `indexTopicForSearch` 删后写非事务 | `wiki.service.ts:531` 已用 `db.transaction` |
| U1 | Topic 前端无法人工修正 | `WikiView` 已接 rename / pin / archive / reactivate / delete / refresh / undo 全套 |
| U4 | Topic 详情用 `<pre>` 渲染纯文本 | 抽出 `<TopicContentView>` 结构化渲染 |
| U5 | WikiView 无 error 态 | Inbox / Suggestions / Topics 三 tab 均有 `ErrorState` + retry |
| 编辑器同步 | JSON.stringify 全量比较、外部更新丢光标 | `PageEditor` 改用 `seed` + `ek` remount 模式，本地编辑只动 live buffer |
| URL 路由 | 状态驱动、刷新丢视图 | `BrowserRouter` + `ShellLayout` 路由表（`/p/:id`、`/w/:wid/s/:sid`、`/wiki`、`/ask`、`/search`、`/share/:token`、`/settings`） |
| 版本冲突 | 裸 confirm | `ConflictModal`（覆盖 / 用最新版 / 另存副本） |

**结论：工程基本面已经从 plan02 时期的「带硬伤的脚手架」收敛到「可交付的可用产品」。** typecheck/lint/build 全绿，主流程（记录→编辑→保存→查找→AI 整理→回溯原文）闭环完整。

### 0.2 仍未解决（已在当前代码中复核确认）

下面每一条都在主干代码里重新定位到证据，**不是复述 plan02，是复审后确认仍然存在**。

---

## 1. 仍未解决的硬伤（按严重度）

### 🔴 S1. AI Key「加密」名实不符——加密工具存在但从未接入

- **证据**：`apps/server/src/services/ai.service.ts:100` 与 `:104` 直接 `apiKey = cfg.encryptedApiKey`，把字段当明文 Bearer token 发出。`utils/crypto.ts` 里 `encryptSecret` / `decryptSecret` 完整实现且有测试（`crypto.test.ts`、`crypto-edge.test.ts`），但全项目 grep 不到任何 `decryptSecret(encryptedApiKey)` 调用，也找不到任何 `ai_configs` 写入路径用 `encryptSecret` 加密。
- **根因**：加密能力造好了，但「设置入口→写入加密→读取解密→喂给 provider」这条链没接通。`ai_configs` 的 user override 分支实际是死路：没有任何 route 往里写数据。
- **影响**：AGENTS.md 明文规定「AI Key 只允许使用 `ai_configs.encrypted_api_key` 加密存储，不得明文保存」。当前要么这个功能根本没启用（用户无法配自己的 Key），要么将来一旦接入 settings 写入，会以明文落库——两种情况都不可接受。
- **位置**：`ai.service.ts:80-112`（读）、缺失的 settings 写入路由、`provider.ts` headers。

### 🔴 S2. OpenAICompatibleProvider 无超时 / 无重试 / 无 AbortSignal

- **证据**：`packages/ai/src/provider.ts` 的 `generateText` / `streamText` / `embed` / `embedBatch` 全是裸 `fetch`，没有 `AbortSignal`、没有超时、没有瞬时重试。上游抖动或挂起时，fetch 会无限期挂住。
- **影响**：一次卡住的 embedding 会让 `processPageLlm` job 挂死，直到 5 分钟僵尸回收把它踹回 pending——然后再次挂死，形成**活锁**（见 S3）。RAG 流式问答挂住则直接拖垮 SSE 连接。
- **位置**：`provider.ts:83-128`（chat）、`streamText`、`embed/embedBatch`。

### 🟠 S3. 聚类 job 无超时，与 5 分钟僵尸回收冲突可能活锁

- **证据**：`consolidateCandidates` 虽加了 `MAX_CANDIDATES=500` 上限（`wiki.service.ts:602`），但 500 候选 → 最多 ~125k 对比较，每对可能调 `groupRepEmbedding` → `getChunkEmbedding`（DB 查询）。整体可能超过 5 分钟。而 `recoverZombieJobs` 把 `running` 超过 5 分钟的 job 重置为 `pending`（`job-runner.ts`）。
- **影响**：一次正常但耗时的聚类会被僵尸回收打断、重新入队、再被打断——永远跑不完，且每次都白做前半段。500 上限反而掩盖了问题（候选持续堆积却始终整合不完）。
- **位置**：`job-runner.ts` `recoverZombieJobs` + `wiki.service.ts:644-690` 双重循环。

### 🟠 S4. `topic_sources` 主键限制 chunk 级 provenance

- **证据**：`packages/db/src/schema.ts` 中 `topicSources` 主键为 `primaryKey({ columns: [t.topicId, t.pageId] })`，但表里已有 `chunkId`、`sourceContentVersion`、`evidenceExcerpt` 等字段。
- **影响**：同一 page 的多个 chunk 不能同时作为一个 Topic 的来源（插入第二行 `onConflictDoNothing` 被吞），引用粒度退化为「页级」。RAG-EVALUATION.md 要求的 `topic-source traceability` 在多 chunk 场景下失真。
- **位置**：`schema.ts` topicSources 定义 + `wiki.service.ts` 中 `onConflictDoNothing` 插入。

### 🟠 S5. WikiView 仍用浏览器原生 `confirm()`，违反 AGENTS.md 且体验不一致

- **证据**：`apps/web/src/features/wiki/WikiView.tsx` 归档/删除分支写的是 `if (confirm('归档后…'))` / `if (confirm('删除后…'))`。而同项目的 `PageEditor` 已经用 `useDialog().confirm({...})` 自定义弹窗。
- **影响**：AGENTS.md 明确「不使用浏览器原生 alert 或 confirm」。原生 confirm 样式不可控、无法定制危险态、移动端体验差，且与 PageEditor 的交互模式割裂。
- **位置**：`WikiView.tsx` 归档 / 删除两处。

### 🟡 S6. 搜索 query embedding 缓存：模块级、无 TTL、不随模型失效

- **证据**：`search.service.ts:28` `QUERY_EMBEDDING_CACHE` 是模块级 Map（已加 512 LRU 上限，比 plan02 进步），但：(1) 多 worker 进程各一份；(2) 无 TTL；(3) 切换 embedding 模型后旧向量仍命中缓存，搜出错误结果。
- **影响**：模型变更后需重启进程才能清缓存；多 worker 下缓存命中率低。
- **位置**：`search.service.ts:24-44`。

### 🟡 S7. 无结构化日志

- **证据**：server 端 18 处 `console.log/error/warn`，无 request id、无级别、无 JSON 输出。
- **影响**：生产排障困难，无法接 ELK/Loki，AI 调用链路无法串联。
- **位置**：全局（`job-runner.ts`、`wiki.service.ts`、`ai.service.ts` 等）。

### 🟡 S8. 前端 bundle 严重过大，无代码分割

- **证据**：`pnpm build` 产物 `index-DfWEz-cF.js` = **2,065 kB**（gzip 638 kB），另有 1.8MB chunk。Mermaid 把所有图表类型全量打进（`cynefin` 690kB、`percentages` 1.1MB、`cytoscape.esm` 443kB），Excalidraw 也整体入主包。Vite 明确警告「Some chunks are larger than 500 kB」。
- **影响**：首屏加载慢，尤其在 Windows 单机部署 / 弱网下明显。Mermaid 图表类型绝大多数用户用不到却必须下载。
- **位置**：`apps/web/src/editor/Mermaid.ts`、`ExcalidrawView.tsx`、`vite.config`。

### 🟡 S9. session 无滑动续期

- **证据**：`auth.ts` 只更新 `lastUsedAt`，不延长 `expiresAt`。14 天固定过期。
- **影响**：活跃用户也会被强制重登。轻微，但属于「产品感」细节。
- **位置**：`middleware/auth.ts:80`。

### 🟡 S10. 每次搜索都重查可读 Space 列表

- **证据**：`search.service.ts` `hybridSearch` 每次都 `await getReadableSpaceIds(userId, workspaceId)`。
- **影响**：高频搜索下的额外 DB 往返。当前规模无感，1000+ 页/多 Space 时累积。
- **位置**：`search.service.ts` hybridSearch。

---

## 2. 新发现的问题（plan02 未覆盖）

### 🟠 N1. RAG 评估集只是空计划

- `docs/RAG-EVALUATION.md` 列了 80 条评估数据集和 7 个指标，但仓库里找不到对应数据集与跑分脚本。`rag-eval.test.ts` 只是用 mock provider 跑通流程，不评估真实质量。这意味着切真实模型后**没有任何质量基线**，回归不可感知。

### 🟠 N2. 可观测性缺失

- 无 `/metrics` 端点（`job-metrics.ts` 是内存计数，进程重启即丢）；无 AI 成本/延迟追踪（`jobs` 表有 `costEstimateTokens` / `actualPromptTokens` / `actualCompletionTokens` 字段，但 worker 里看不到写入）。字段造了没用上。

### 🟡 N3. `rate_limit_events` 无清理任务

- sprint.md 第五阶段提过「增加定时清理 job 删除 7 天前记录」，但未见对应 job 类型。表会无限增长（已有 `idx_rate_cleanup` 索引但无清理者）。

### 🟡 N4. 移动端仍基本不可用

- `layout.css` 仍是少量 media query，三栏 Shell 在小屏无抽屉化/底部导航。plan02 U3 未做。

### 🟡 N5. 全量硬编码中文，无 i18n

- grep 不到任何 i18n 框架。所有文案中文写死。对海外/多语言团队不友好，也阻碍「个人 LLM Wiki」的定位扩展。

### 🟡 N6. CI 仅跑构建

- `.github/workflows/ci.yml` 只 1119 字节，从体量看大概率只跑 build，未跑 lint/typecheck/test。质量门禁未上 CI。

---

## 3. 产品体验差距（极致产品视角）

对标 docmost / Notion / 语雀，当前体验差距集中在「信任感」和「规模感」：

| 差距 | 现状 | 目标 |
|---|---|---|
| AI 信任 | Topic 可修正了，但「AI 改了什么」不可追溯——用户看不到一次 refresh 的 diff | refresh 前后 diff 可视化，stale 主题点击查看变更 |
| 首屏体感 | 2MB+ JS 阻塞，白屏明显 | 路由级 code-splitting，编辑器/图表懒加载，首屏 <300KB |
| 规模感 | 页面树未虚拟化（sprint 阶段五任务未落地），1000 页会卡 | 虚拟化 + 懒加载子节点 |
| 移动可用 | 桌面专属 | 抽屉化三栏 + 底部导航 |
| 协作 | 单人（U2，定位级差距，本计划不强行补） | 至少补「页面评论/批注」作为协作前奏 |
| 新手引导 | 有 `Onboarding` 组件（已部分落地） | 验证首次进入流程，补 Space kind 选择器（创建空间时无 kind 选择，U3.5 仍未做） |

---

## 4. 分阶段提升计划

> 每个 Phase 编码前输出：根因 → 拟改文件 → 迁移与兼容 → 风险回滚 → 测试计划 → 本 Phase 不做的事。
> 每个 Phase 编码后真实执行 `pnpm lint && pnpm typecheck && pnpm test && pnpm build` 并贴输出。

### Phase G：可信度止血——修掉「名实不符」与「会挂死」的链路（必做，无新功能）

**目标**：让 AI Key 真正加密、让 provider 不会挂死、让聚类不会活锁。这是上线前必须清零的信任债。

**任务**：

1. **S1 — 接通 AI Key 加密链路**
   - 新增/补全 settings 写入路由：`PUT /api/settings/ai-config`，写入 `ai_configs` 时 `apiKey = encryptSecret(plaintext)`；`personalOverrideEnabled` 开关。
   - `ai.service.ts:100/104` 读取时 `apiKey = decryptSecret(cfg.encryptedApiKey)`，`decryptSecret('')` 返回 `''` 兼容旧数据。
   - 返回前端时用 `maskSecret` 脱敏，永不回传明文/密文。
   - 迁移：旧 `encryptedApiKey` 字段若已有明文数据，写一次性脚本尝试 `decryptSecret` 失败则视为明文→加密回填（容错）。
   - 测试：扩展 `crypto.test.ts` 覆盖「写入加密→读取解密→provider 拿到明文」端到端（mock provider）。

2. **S2 — provider 超时 + 瞬时重试**
   - `OpenAICompatibleProvider` 所有 fetch 加 `AbortSignal.timeout(30_000)`（embedding 可 60s）；streamText 用可读超时（无 token 30s 则 abort）。
   - 对 5xx / 429 / 网络错误做 1 次瞬时重试（指数退避 500ms→1s），4xx 不重试。
   - 抽公共 `fetchWithRetry`，测试用 mock fetch 覆盖超时与重试分支。

3. **S3 — 聚类 job 超时 + 心跳**
   - `consolidateCandidates` 接受 `jobId`，每完成一个 group 刷新 `locked_at = now()`（心跳），把僵尸回收阈值从「固定 5 分钟」改为「`locked_at` 超过 N 分钟无更新」。
   - 或：给聚类 job 单独的 `maxRuntimeMs`（如 8 分钟），超时主动 abort 并标记 `failed`（而非回收重跑）。
   - 降低 `MAX_CANDIDATES` 或分批：超 500 时按 `createdAt` 分片，每批 200，串行入队多个 job。

**验收**：加密链路端到端测试通过；provider 超时/重试测试通过；聚类 job 超时后标记 failed 不再活锁。
**限制**：不改 AI 抽象接口契约，不改数据库核心模型，不加新 AI 功能。

### Phase H：数据正确性与可观测性（工程加固）

**目标**：补上「AI 改了什么可追溯」和「系统能被运维」的基础。

**任务**：

1. **S4 — topic_sources 主键升级**
   - 迁移：`topic_sources` 主键改为 `(topicId, pageId, chunkId)` 或加 `id` 主键 + `(topicId, pageId, chunkId)` 唯一索引。保留旧数据兼容（chunkId 为 null 的旧行不动）。
   - 修改 `onConflictDoNothing` 的冲突目标。

2. **N2 — 可观测性**
   - job worker 写入 `actualPromptTokens` / `actualCompletionTokens`（provider 返回 usage 时透传）。
   - 新增 `GET /api/health/metrics`：job 队列深度、成功率、AI 调用次数/延迟分位（从 jobs 表聚合，不依赖内存）。
   - 引入轻量结构化日志（pino），带 request id 中间件；18 处 console.* 替换。

3. **N3 — rate_limit_events 清理**
   - 新增 job 类型 `system.cleanup_rate_limits`，每日删除 7 天前记录；`recoverZombieJobs` 之外加定时入队。

4. **S6 — 搜索缓存失效**
   - `QUERY_EMBEDDING_CACHE` 加 TTL（10 分钟）+ 把 `embeddingModel` 纳入 cache key（模型变更自动失效）。

**验收**：多 chunk 来源可写入；metrics 端点返回真实数据；日志为 JSON 且带 request id；rate_limit 表可收缩。
**限制**：不引入 Redis；metrics 用 PG 聚合实现。

### Phase J：性能与规模（1000+ 页流畅）

**目标**：首屏快、大空间不卡。

**任务**：

1. **S8 / N 首屏 — 代码分割**
   - Mermaid 改为按需：仅当文档含 mermaid 块时动态 `import('mermaid')`，且按图表类型动态注册（不全量加载 cynefin/percentages 等）。
   - Excalidraw / Drawio 改路由级懒加载（`React.lazy`）。
   - `vite.config` 配 `manualChunks`：把 react/tiptap/@tanstack 分到稳定 vendor chunk。
   - 目标：首屏 JS < 350KB（gzip < 120KB）。

2. **页面树虚拟化**
   - `PageTree.tsx` 接 `@tanstack/react-virtual` 或 `react-arborist`；子节点懒加载（`hasChildren` 展开时才请求）。
   - 后端 `/api/pages/tree` 已是轻量 DTO（符合 AGENTS.md），确认不返回 contentJson。

3. **S10 — 权限缓存**
   - `getReadableSpaceIds` 结果按 `userId+workspaceId` 缓存 60s，或随 space 成员变更失效。

**验收**：首屏 gzip < 120KB；1000 节点树渲染 < 100ms；搜索响应 < 500ms（非 AI）。
**限制**：不改 API 契约。

### Phase K：产品感收口（体验对齐）

**目标**：消除交互不一致，补齐创建/移动/移动端。

**任务**：

1. **S5 — WikiView 去原生 confirm**
   - 归档/删除改用 `useDialog().confirm`（与 PageEditor 一致），危险态加红色确认按钮 + 影响范围说明。

2. **Space kind 选择器**
   - 创建 Space 时暴露 `spaceKind: project|area|resource|inbox` 选择（后端已支持，前端 `NewSpaceDialog` 未暴露）。LeftSidebar Space 列表按 kind 分组。

3. **N4 — 移动端**
   - 三栏 Shell 在 <768px 改为：左栏抽屉化（汉堡按钮唤起）、右栏底部 Sheet、底部导航栏切换 Notes/Wiki/Ask/Me。

4. **S9 — session 滑动续期**
   - `lastUsedAt` 更新时，若距过期不足 1/3 TTL 则延长 `expiresAt`（设上限 30 天）。

5. **stale Topic diff**
   - stale 主题点击「来源已更新」时，展示来源页新旧版本 diff（复用 revision 数据），而非直接 refresh。

**验收**：全项目 0 处原生 alert/confirm；移动端三栏可用；活跃用户不被频繁踢登。
**限制**：不新增后端 API（除 session 续期）。

### Phase L：质量门禁与评估基线（发布前必做）

**任务**：

1. **N6 — CI 质量门禁**
   - `.github/workflows/ci.yml` 增加 `lint` / `typecheck` / `test`（test 起 pgvector service）job，任一失败阻断合并。

2. **N1 — RAG 评估集落地**
   - 按RAG-EVALUATION.md建 80 条数据集（seed 脚本）+ 评估脚本，输出 7 个指标。先以 mock 跑通管线，真实模型评估作为 release 前人工 gate。

3. **N5 — i18n 骨架（可选）**
   - 引入 `react-i18next`，抽取高频文案为 `zh` 语料；暂不翻译，只建立机制，为后续留口。

**验收**：CI 跑 lint/typecheck/test；RAG 评估脚本可执行并输出指标。
**限制**：i18n 只搭骨架不批量翻译。

---

## 5. 优先级矩阵

| Phase | 价值 | 紧迫度 | 风险 | 建议顺序 |
|---|---|---|---|---|
| G 可信度止血 | 🔴 高 | 🔴 上线前必做 | 中（加密/超时改动核心链路） | **1** |
| H 数据正确性+可观测 | 🔴 高 | 🟠 高 | 低（多为新增） | **2** |
| J 性能与规模 | 🟠 高 | 🟠 中（规模上来才痛） | 中（bundle 重构） | **3** |
| K 产品感收口 | 🟠 中 | 🟡 中 | 低 | **4** |
| L 质量门禁+评估 | 🔴 高 | 🔴 上线前必做 | 低 | 与 G 并行，优先 1.5 |

> 协作（U2 实时协同）是定位级差距，但工程量大且偏离 MVP，本计划不纳入，留待产品定位明确后单独立项。

---

## 6. 给执行 agent 的硬约束（沿用 plan02 + 补充）

1. 禁止只改 Prompt 解决问题——必须调整领域模型与流程。
2. 禁止一次性重写大文件——最小靶向修改。
3. 每个 Phase 编码前后真实执行 `pnpm lint && pnpm typecheck && pnpm test && pnpm build`，贴真实输出。
4. 迁移必须可回滚、兼容旧数据，保存 Schema 版本。
5. 高风险操作（合并/拆分/归档/删除）必须人工确认并可撤销——且不得用原生 `confirm`。
6. **新增**：provider 改动必须保持 mock provider 路径不变，测试永不触网。
7. **新增**：bundle 优化不得改变运行时行为，仅改 import 方式与 chunk 配置。

完成后输出：修改摘要 / 涉及文件 / 数据库迁移 / 测试命令与结果 / 性能影响 / 安全影响 / 尚未解决的问题。
