# Plan 05 — Agent 化改造：MCP 服务 / AI 管线外部化 / 日历标准服务

> 状态：**P0–P3 已实现**（2026-11-05），端到端验证通过。
> 已交付：测试库隔离、scoped Agent Token、云端 HTTP MCP（24 个工具）、全局配置（AI 模式 / embedding 接口 / MCP / CalDAV 开关）、external AI 作业协议、CalDAV 双向服务、WorkBuddy Skill 包。
> 已知边界：external 提交的 Wiki 结果目前落 agent_job_results + 合并 tags 到笔记 AI 档案；主题/论断写入正式 wiki 表需后续迭代（见 §3 P2.3）。
> 实现按 P0 → P3 分期推进，每期独立可回滚；验收标准见对应小节。
> 用户决策见 §0.4，覆盖了原 §0.3 的 A5 与 §7 的待确认项。

---

## 0. 目标、非目标与假设

### 0.1 用户诉求
1. **MCP 服务化**：提供 MCP 服务 + 可导入 WorkBuddy 及其他桌面智能体的技能包，让 AI 能对知识库、任务管理做「增 / 删 / 改 / 移动」。
2. **AI 管线外部化**：知识库向量化与 LLM Wiki 提取也能由 WorkBuddy 通过技能完成，降低对服务端外部大模型 API 的强依赖。
3. **日历标准服务**：任务的时间日程以标准协议对外，可同步到手机日历、Outlook 日历。

### 0.2 本计划的非目标
- 不重写现有 Hono API、不替换 Drizzle/Postgres、不改前端现有交互。
- 不做多租户 SaaS 化、不做公网托管（远程 MCP 仅给自建/内网部署的形态）。
- 不在本期实现「双向实时日历同步」（拆到可选 P4，理由见 §5.1）。
- 不改动已上线的鉴权模型语义；MCP 必须复用现有权限函数，不能绕过。

### 0.3 关键假设（若与实际不符，实现前需确认）
| 编号 | 假设 | 依据 |
| --- | --- | --- |
| A1 | WorkBuddy 桌面版通过 `~/.workbuddy/mcp.json` 配置连接器，支持 `stdio` / `http`(Streamable HTTP) / `sse`，远程 HTTP 可用 `headers` 传 Bearer Token | WorkBuddy CLI MCP 文档与接入实践 |
| A2 | Skill = `SKILL.md`（Markdown + YAML frontmatter：`name` / `description` / `version` / `author`），放在 `~/.workbuddy/skills/<name>/`，可导出为 zip 分发；项目级为 `<project>/.workbuddy/skills/` | WorkBuddy 开放平台「连接器」文档 |
| A3 | MCP 方案自带标准工具描述，Skill 属于「可选的使用指引」；CLI 方案才强依赖 Skill。故交付物 = MCP 端点 + Skill 包（含工作流与约束），不是二选一 | 同上 |
| A4 | 其他桌面智能体（Claude Desktop / Cursor / Trae 等）同样消费标准 MCP `mcpServers` 配置；Skill 文档中给出各自 skills 目录映射 | 通用 MCP 生态 |
| A5 | ~~只读订阅~~ → **用户决定直接实现 CalDAV**（双向、通用协议）；只读 `.ics` 订阅降级为可选的兼容补充 | 用户决策 §0.4 |
| A6 | MCP 以**云端 HTTP / Streamable HTTP 为主**，服务端部署在云上供多设备接入；stdio 仅作为本机开发备选 | 用户决策 §0.4 |
| A7 | embedding **保持默认接口配置**（沿用 `EMBEDDING_BASE_URL` / `AI_EMBEDDING_MODEL` / `EMBEDDING_DIMENSION`），不引入本地 ONNX / 确定性兜底作为主路径 | 用户决策 §0.4 |

### 0.4 用户决策（2026-11-05，覆盖上述假设）

| # | 决策 | 对计划的影响 |
| --- | --- | --- |
| D1 | **日历实现 CalDAV**，理由是通用 | P3 从「只读 iCal 订阅」改为 **CalDAV 双向服务**（OPTIONS / PROPFIND / REPORT / GET / PUT / DELETE），`.ics` 订阅保留为兼容补充；原 P4 双向同步阶段取消（已并入 P3） |
| D2 | **embedding 先默认配置接口** | 保留现有 `OpenAICompatibleProvider` 的 embedding 接口与 `EMBEDDING_*` 配置；P2 不再引入本地 embedding provider 或 `deterministicVector` 兜底作为主路径。外部 Agent 模式只接管 **LLM Wiki 推理**，向量化仍由服务端接口完成（详见 §3 P2.2 修订） |
| D3 | **AI 整理走系统接口还是 WorkBuddy，在全局配置里体现** | 新增实例级偏好 `ai_execution_mode = internal \| external`，在「全局设置」页可切换；`external` 时 LLM Wiki 作业交给桌面 Agent，`internal` 时保持现有服务端调用。可并存、可回退 |
| D4 | **MCP 跨设备，知识库部署在云端** | P0 优先验收 **HTTP / Streamable HTTP** 端点 `POST /mcp` + scoped Bearer Token + TLS/反代说明；stdio 代理降为可选。CORS、CSRF、Token 过期/撤销、审计按公网暴露标准设计 |

> 因 D2，§3 P2.2 的「聊天模型不能产出 embedding」风险不再需要通过 Agent 生成向量来规避：向量化保留在服务端接口，Agent 只负责文本推理与结构化结果回写。
> 因 D1，§7 中「日历是否必须双向」已确定；§8 的 P4 取消，实施顺序为 P0 → P1 → P2 → P3（CalDAV）。

---

## 1. 现状与架构约束（已核对代码）

### 1.1 服务端与鉴权
- `apps/server/src/app.ts:30-79`：`createApp()` 挂 19 个 route 模块 + 4 个公开 health 端点。**全局没有 `authMiddleware`**，各模块自己 `use('*', authMiddleware)`；新增模块必须显式挂鉴权，否则默认公开。
- `apps/server/src/middleware/auth.ts:135-143`：`authMiddleware` **已支持** `Authorization: Bearer <token>`（无 cookie 时回退到 header），token 为 `randomBytes(32).hex`，DB 只存 `sha256` hash，TTL 14 天、滑续期。→ **可直接复用为 MCP 的传输凭据，但不适合作长期 Agent 凭据**（无 scope、无独立撤销、无审计、随 session 过期）。
- `apps/server/src/middleware/csrf.ts`：`POST/PUT/PATCH/DELETE` 校验 `Origin`；**无 Origin 的请求放行**（测试/同源），开发模式放任意来源。MCP 客户端不发 Origin，因此天然可写；但生产需在 CORS allow-list 与允许头中显式加 `Authorization`。
- 唯一公开模块：`/api/public/shares/:shareToken`（`routes/public.ts`），`shares.share_token` 有 `is_enabled` / snapshot 语义，可作为「长期、可撤销、只读、范围受限」令牌的设计参考。
- 权限函数：`canEditPage` / `canEditSpace` / `canViewPage` / `canViewWorkspace` / `canManageWorkspace`（`services/permission.service.ts`）。**MCP 工具必须经这些函数**，禁止直接裸写 DB。

### 1.2 知识库与任务写操作（可映射的现成能力）
- 笔记：`POST /api/pages`、`PUT /api/pages/:id`（含乐观锁 `contentVersion` 冲突 409）、`DELETE /api/pages/:id`（软删 `status='deleted'`）、`PATCH` 移动/排序相关字段（`parentPageId` / `position` / `spaceId`）、`GET /api/pages/:id`、`GET /api/pages/tree`、归档/恢复（Plan 04 已加）、`/api/io` 导入导出。
- 空间：`/api/spaces` CRUD + `lifecycleStatus`（active/on_hold/completed/archived）；工作区 `/api/workspaces`。
- 任务：`apps/server/src/routes/tasks.ts` 的 CRUD、`/projects`、拖拽重排、`duplicate`；`taskInput` Zod schema 明确 `projectId` / `spaceId` 必须属于当前 workspace。
- **实现原则**：MCP 工具是「薄适配层」，优先通过 `app.request()` 复用现有路由（保证 Zod 校验、权限、软删、去重、invalidate 完全一致），避免第二套业务逻辑。若 `app.request()` 注入 auth 不便，则把路由 handler 抽成 service 函数，两端共用，仍不绕权限。

### 1.3 AI 管线（第 2 条的核心边界）
- `packages/ai/src/provider.ts:1-32`：`AiProvider` = `generateText / streamText / embed / embedBatch`；`DEFAULT_EMBEDDING_DIMENSION = 1536`。`MockAiProvider` 内有 `deterministicVector`（哈希式确定性向量），可用于无模型兜底。
- `packages/ai/src/prompts.ts:325-334`：`PROMPT_REGISTRY`，8 个带版本号的 `PromptSpec`（`page-map-v1`、`topic-extraction-v1`、`topic-routing-v1` …）。注释指出 `page_map / claim-extraction / quality-review` 主路径已是**确定性算法**，真正需 LLM 的是 `topic-routing / topic-synthesis / topic-repair / claim-relation / topic-extraction`。
- 落库：`document_chunks.embedding vector(1536)` + HNSW cosine 索引；`wiki_topics.evidenceCentroid`、`topic_candidates.titleEmbedding` 同为 1536 维。`apps/server/src/services/job-runner.ts` 的 `processPageLlm` 负责切块 → `embedBatch` → 批量写 `document_chunks` → `generateWikiArtifacts` 等。
- `jobs` 表（`schema.ts:490+`）**已具备队列所需几乎全部字段**：`status` / `priority` / `runAfter` / `attempts` / `maxAttempts` / `lockedBy` / `lockedAt` / `sourceVersion` / `dedupeKey` / `progress` / `errorMessage`。→ 外部 Agent「领取—租约—回写」不需要新建队列表，只需新增执行模式与结果校验层。
- 隐私策略 `aiPrivacyPolicy`（inherit_workspace / cloud_allowed / local_only / disabled）与「用户级 AI 配置」决定当前管线能否调用云端模型；外部化模式天然满足 `local_only`。

### 1.4 任务时间字段（第 3 条的数据基础）
`packages/db/src/schema.ts:733-775`：`dueDate` / `startDate` / `endDate` / `completedAt` / `isAllDay` / `recurrenceUnit` / `recurrenceInterval` / `recurrenceEndDate` / `estimatedDuration`（分钟），全部 `timestamptz`，**无 timezone 列**（统一 UTC 存储，展示时按客户端时区），有 `idx_tasks_range(workspaceId, startDate, endDate)` 适合按窗口查询。
**全仓无 ICS / iCal / CalDAV / Webhook / 订阅链接代码或依赖**，需从零新增。

### 1.5 工程结构
- `pnpm-workspace.yaml` 用 `apps/*`、`packages/*` 通配 → 新包自动纳入，无需改配置。
- 但 `package.json:12` 的 `build:packages` 是**硬编码 filter**，CI `.github/workflows/ci.yml` 用 `--frozen-lockfile`，Dockerfile 逐包手写 COPY，`tsconfig.base.json` 有 paths 映射 → 新增包需要同步这几处。
- `scripts/create-release-zip.mjs` 现有 zip 能力是整仓打包（输出到 `/mnt/data`），不适合分发 Skill，需另写轻量打包脚本。
- 文档习惯：`docs/plan02.md` / `plan03.md` / `plan04.md` / `docs/llmwiki.md`；本文件沿用 `docs/planXX-*.md`。

### 1.6 必须记住的前置风险
`apps/server` 的 vitest 套件**直连开发数据库且 hook 会清表**（本会话已发生过一次数据丢失）。本计划所有阶段的验收，禁止在未隔离测试库的情况下运行 `pnpm --filter @zhipane/server test`。**P0 前置项**：先给 server 测试接入独立 `TEST_DATABASE_URL`（或 testcontainers），否则新增的 token / 队列 / 日历测试无法安全编写。

---

## 2. 总体架构

```
┌─ 桌面智能体（WorkBuddy / Claude Desktop / Cursor / Trae）──────────┐
│  ~/.workbuddy/mcp.json  ──►  MCP 连接                              │
│  ~/.workbuddy/skills/zhipane/SKILL.md  ──►  工作流与约束指引        │
└───────────────┬───────────────────────────────────────────────────┘
                │ ① stdio 适配器（本地）或 ② HTTP /mcp（远程，Bearer）
                ▼
┌─ ZhiPane 服务端（单一真源）────────────────────────────────────────┐
│  POST /mcp            MCP JSON-RPC（initialize / tools/list / call） │
│  /api/agent/*         Agent Token、作业领取/回写、日历 feed          │
│  /api/{pages,tasks,…} 现有路由（Zod + 权限 + 软删 + 版本冲突）       │
│  ── 所有写操作经 app.request() 或共用 service 复用现有逻辑 ──        │
└───────┬──────────────────────────────┬────────────────────────────┘
        │                              │
  agent_tokens / audit / idempotency   │  jobs（已存在，新增 external 模式）
  calendar_tokens                      ▼
                           ┌─ 外部 AI 作业 ──────────────────────┐
                           │ 服务端：切块/排队/校验/落库          │
                           │ 桌面 Agent：用自己的模型产出结构化结果│
                           └────────────────────────────────────┘
```

**单一真源决策**：MCP 协议层只实现一次，放在服务端 `POST /mcp`；`apps/mcp-server` 只做一个**极薄的 stdio → HTTP 代理**（读 `ZHIPANE_BASE_URL` / `ZHIPANE_AGENT_TOKEN`）。这样 stdio 与 HTTP 两种 WorkBuddy 配置共享同一套工具定义、鉴权与审计，避免两套实现漂移。

**传输降级**：优先用 `@modelcontextprotocol/sdk` 的 Web Standard Streamable HTTP 适配 Hono；若该版本 SDK 与 Hono 的 Request/Response 不兼容，则手写最小 MCP JSON-RPC（只需 `initialize`、`tools/list`、`tools/call`、`ping`），协议面很小，避免被依赖版本卡住。

---

## 3. 分期计划

### P0 — 基础：Agent Token + MCP 骨架 + 只读工具
**目标**：先能安全连上并只读，不引入任何写风险。

| 项 | 内容 |
| --- | --- |
| DB 迁移 | 新增 `agent_tokens`（`id, user_id, workspace_id nullable, name, token_hash sha256 unique, scopes text[], expires_at, last_used_at, revoked_at, created_at`）、`agent_audit_logs`（`token_id, tool, params_redacted jsonb, status, error, created_at`）、`idempotency_keys`（`key, token_id, result jsonb, created_at`）。迁移文件按现有最大编号顺延。 |
| 鉴权 | 扩展 `authMiddleware`：Bearer 命中 `agent_tokens` 时设置 `user` + `agentScopes` + 生效 workspace 约束；保留原 session 路径不变。新增 `requireScope('kb:read')` 等校验。 |
| 配置 | `env.ts` 增 `AGENT_MCP_ENABLED`、`AGENT_TOKEN_MAX_TTL_DAYS`、`CALENDAR_FEED_ENABLED`；CORS 允许 `Authorization` 头，并把 MCP 客户端来源纳入 `WEB_ORIGINS` 说明。 |
| MCP | `apps/server/src/routes/mcp.ts`（挂 `POST /mcp`）+ `packages/mcp-core`（工具注册表：name / description / Zod inputSchema / scope / handler）。首批只读工具：`kb_list_workspaces`、`kb_list_spaces`、`kb_get_tree`、`kb_get_page`、`kb_search_pages`、`tasks_list`、`tasks_get`、`tasks_list_projects`、`tasks_calendar`。 |
| 用户入口 | 全局设置新增「Agent 接入」卡片：创建/命名/撤销 Token、勾选 scope、设置有效期、一键生成 `mcp.json` 片段（stdio 与 HTTP 两种）。Token 明文**仅展示一次**。 |
| 工程 | 新增 `apps/mcp-server`（stdio 代理）并接入 `build:packages`、tsconfig paths、CI、Dockerfile；`pnpm-lock.yaml` 更新。 |
| 测试前置 | 先完成 §1.6 的测试库隔离，再写 token / scope / 审计的单测。 |
| **验收** | WorkBuddy 用 stdio 与 HTTP 两种方式均能 `tools/list` 成功；只读工具返回与 Web 一致的数据；无 scope 的 token 调写工具被拒；撤销 token 立即 401；每次调用有审计记录；前端全套 typecheck/lint/test/build 通过。 |

### P1 — 知识库与任务写操作（增 / 删 / 改 / 移动）
**目标**：满足诉求 1 的完整 CRUD。

| 模块 | MCP 工具 | 映射 / 要点 |
| --- | --- | --- |
| 知识库 | `kb_create_page` | `POST /api/pages`，需 `spaceId`；返回 pageId |
| | `kb_update_page` | `PUT /api/pages/:id`，**必须传 `contentVersion`**，409 冲突时工具返回可读错误让 Agent 决定重读或放弃 |
| | `kb_delete_page` | `DELETE`（软删）；建议工具层先返回预览摘要，由 Skill 约束「删除前先确认」 |
| | `kb_archive_page` / `kb_unarchive_page` | Plan 04 新增的归档接口 |
| | `kb_move_page` | `parentPageId` / `spaceId` / `position`；跨空间移动需两端 `canEditSpace`，并校验目标 space 属于同一 workspace |
| | `kb_create_space` / `kb_rename_space` / `kb_archive_space` | `/api/spaces`；归档空间需提示「其下笔记会从侧栏隐藏」 |
| 任务 | `tasks_create` / `tasks_update` / `tasks_delete` | 复用 `taskInput` Zod；`projectId` 必须存在于当前 workspace（已有服务端校验） |
| | `tasks_move` | `status` / `projectId` / `position` / `startDate` / `endDate` / `isAllDay`，用于拖到日历或改期 |
| | `tasks_complete` / `tasks_duplicate` | 完成任务触发重复规则；`duplicate` 复用现有端点 |
| 通用 | 幂等 | 所有写工具接受可选 `idempotencyKey`，命中则直接返回上次结果，避免 Agent 重试造成重复创建 |
| 通用 | 审计 | 记录工具名、目标 id、脱敏参数、成功/失败；写操作 scope 为 `kb:write` / `tasks:write` |

**Skill 约束（写进 SKILL.md）**：删除与批量移动前必须先 `get/list` 复核；`update_page` 必须先读最新 `contentVersion`；不得跨 workspace 猜测 id；失败时把服务端错误原文回给用户而不是自动重试多次。

**验收**：Agent 能完成「新建笔记 → 改标题 → 移动到另一空间的父节点下 → 归档 → 恢复」和「新建任务 → 改期 → 移到项目 → 完成」两条端到端脚本；重复 idempotencyKey 不产生两条数据；越权（跨 workspace / scope 不足）全部被拒；Web 端数据同步可见（React Query invalidate 或服务端主动失效）。

### P2 — AI 管线外部化（诉求 2）
**目标**：让桌面智能体承担 LLM 推理，服务端只做「排队 / 切块 / 校验 / 落库」。

#### P2.1 模式与作业协议
- `env.ts` 新增 `AI_DRIVER` 取值 `agent`（或独立 `AI_EXECUTION_MODE=internal|external`，推荐后者以免破坏现有枚举语义）。`external` 模式下 `job-runner` 不再调用 `createAiProviderForContext`，只负责**入队与切块**；`internal` 模式保持现状，两种模式可按 workspace 覆盖。
- 复用 `jobs` 表，新增 `type` 取值：`external.embed_chunks`、`external.wiki_extract`、`external.wiki_route`、`external.wiki_synthesize`；`payload` 存 `contentVersion` / `promptVersion` / chunk 数 / 期望输出 schema 名。
- 新增 `/api/agent/jobs` 与对应 MCP 工具：
  - `ai_list_jobs`（按 workspace / type / status 过滤，默认只列 `pending`）
  - `ai_claim_job`（`FOR UPDATE SKIP LOCKED` 领取，写 `lockedBy`/`lockedAt`，租约 TTL，例如 10 分钟；超时自动回到 pending）
  - `ai_get_job_payload`（返回：原文/切块文本、`PROMPT_REGISTRY` 里的 `system` + `buildUser` + `version`、期望输出 JSON Schema、embedding 维度/模型要求）
  - `ai_submit_job_result`（服务端用 Zod 严格校验结构，校验失败 400 且不推进 job；成功后写库、更新 job `status=succeeded`、`progress`）
  - `ai_release_job` / `ai_fail_job`（带错误信息，按 `maxAttempts` 退避重试）
  - `ai_reindex_space`（批量对空间内未向量化/版本过期的笔记入队）
- 幂等与版本：结果必须带 `jobId` + `sourceVersion` + `promptVersion`；若页面 `contentVersion` 已变，结果作废并重新入队（复用现有 `sourceVersion` 跳过陈旧作业的语义）。

#### P2.2（按 D2 修订）向量化与推理的分工
- **向量化留在服务端**：保留 `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `AI_EMBEDDING_MODEL` / `EMBEDDING_DIMENSION` 默认接口配置，在全局设置页可编辑；`job-runner` 的切块 → `embedBatch` → 写 `document_chunks` 链路两种模式都执行，不受 `ai_execution_mode` 影响。
- **LLM Wiki 推理可外包**：`external` 模式下，服务端只把「原文 + prompt spec（`PROMPT_REGISTRY` 版本） + 输出 JSON Schema」交给 Agent；Agent 用自己的模型产出结构化结果，服务端 Zod 校验后落库。
- **禁止**：让对话模型生成 embedding 浮点数组后入库（聊天模型无法稳定产出 1536 维可用向量）。此风险因 D2 已从主路径移除。
- `MockAiProvider.deterministicVector` 仅保留给 `AI_DRIVER=mock` 的本地开发/测试场景，不作为生产兜底。

#### P2.3 避免双写逻辑
把 `job-runner.processPageLlm` 中「拿到 AI 结果之后的落库部分」抽成纯函数 `applyAiArtifacts(result, ctx)`，内部 provider 路径与外部 Agent 路径共用同一写入器；`generateWikiArtifacts` 的结构化结果 schema 显式化并放入 `packages/shared`，供 Zod 校验与 Skill 文档共用。

**验收**：`AI_EXECUTION_MODE=external` 时，写一个新笔记不触发任何外部 LLM HTTP 请求（可用 mock server 断言零调用）；Agent 走完 `claim → get_payload → submit_result` 后，`document_chunks` 行数/维度正确、Wiki 产物与 internal 模式对同一输入结构一致；`contentVersion` 变化导致陈旧结果被拒；租约超时作业可被重新领取；失败重试达到 `maxAttempts` 后标记失败并可在 UI 看到。

### P3 — CalDAV 服务（诉求 3，按 D1 改为双向）
**目标**：iOS / Android / Thunderbird / Outlook（经 CalDAV 客户端）能**读写**任务日程；只读 `.ics` 订阅作为兼容补充。

| 项 | 内容 |
| --- | --- |
| 端点 | `GET /api/calendar/:token/feed.ics` → `Content-Type: text/calendar; charset=utf-8`，`Cache-Control` 建议 15 分钟；公开但**token 范围限定**到单个 workspace + `calendar:read` scope |
| Token | 复用 `agent_tokens`（scope=`calendar:read`）或独立 `calendar_tokens`；支持撤销/重置（重置后旧订阅 URL 立即失效）、只读、可设置过期 |
| ICS 生成 | `VEVENT`：`UID` 用稳定的 task id；`DTSTAMP` 用 `updatedAt`；`DTSTART/DTEND` 取 `startDate/endDate`，缺失时用 `dueDate` + `estimatedDuration`（分钟）兜底；`isAllDay` → `DTSTART;VALUE=DATE`；`STATUS`/`COMPLETED` 映射 `completedAt`/`status=done`；`SUMMARY`=title、`DESCRIPTION`=notes、`CATEGORIES`=tags、`URL` 指向任务页 |
| 重复规则 | `recurrenceUnit + recurrenceInterval + recurrenceEndDate` → `RRULE:FREQ=DAILY/WEEKLY/MONTHLY/YEARLY;INTERVAL=n;UNTIL=...`；无重复字段则不输出 RRULE |
| 时区 | 现有字段全为 `timestamptz` 且无 timezone 列 → 输出 UTC（`Z` 结尾）；如需本地时区展示，在设置里增加 `calendar_timezone`（IANA 字符串）并输出 `VTIMEZONE`（P3.1 可选项） |
| 按窗口查询 | `?from=&to=` 用 `idx_tasks_range`；默认返回未来 6 个月 + 过去 1 个月，避免 feed 过大 |
| UI | 全局设置「日历订阅」卡片：一键复制 `https://…` 与 `webcal://…`、重置 token、按项目/状态筛选订阅范围、说明「订阅为只读，刷新间隔由日历客户端决定」 |
| MCP | `calendar_get_feed_url`、`calendar_list_events`（返回与 ICS 相同的标准化事件 JSON，便于 Agent 直接回答「我下周有什么安排」） |
| 附加 | `GET /api/calendar/tasks/:id.ics` 单任务导出；Skill 中给出「添加到日历」的操作指引 |

**验收**：生成的 `.ics` 通过常用校验器（如 `icalendar` 解析无错）；iOS「添加订阅日历」、Outlook「从 Web 订阅」能显示事件并随服务端改动在刷新后更新；全天/重复/已完成/无 endDate 四类任务字段映射正确；token 撤销后返回 401/404 且不带数据泄露。

### P4 — 已取消（并入 P3）
用户决定直接实现 CalDAV，双向读写在 P3 一并交付。原「只读订阅 / Graph OAuth / 轻量回写」三选一评估不再需要。

---

## 4. Skill 包与分发（贯穿 P0–P3）

```
skills/zhipane/
├── SKILL.md                 # frontmatter + 角色/工作流/约束/错误处置
├── references/
│   ├── tools.md             # 每个 MCP tool 的参数表与返回示例
│   ├── ai-pipeline.md       # claim/get/submit 的完整流程、输出 schema、维度要求
│   └── calendar.md          # 订阅 URL、字段映射、重复规则说明
├── config/
│   ├── mcp.workbuddy.json   # {"mcpServers":{"zhipane":{"type":"http","url":".../mcp","headers":{"Authorization":"Bearer ${ZHIPANE_AGENT_TOKEN}"}}}}
│   ├── mcp.stdio.json       # 本地 stdio 适配器的等价配置
│   └── mcp.generic.json     # Claude Desktop / Cursor 通用格式
└── README.md                # 安装：复制目录到 ~/.workbuddy/skills/ 或导入 zip
```

- `SKILL.md` frontmatter 按 A2：`name: zhipane`、`description`（简明能力范围）、`version`、`author`。
- 正文按 WorkBuddy 建议写「角色定义 / 执行流程 / 输出格式 / 约束规则」，并逐一说明工具用途与参数；重点写清 §3 P1 的删除复核、版本冲突处理，以及 §3 P2 的「不得用聊天模型生成 embedding 数组」。
- 新增 `scripts/build-skill-zip.mjs`：只打包 `skills/zhipane/` 为 `dist/zhipane-skill-<version>.zip`（不含源码/密钥），复用现有 zip 思路但独立输出路径。
- 每期实现完成后同步更新 `tools.md` 与 `version`，保证 Skill 文档与工具注册表不漂移（建议加一个 CI 检查：工具名集合与文档一致）。

---

## 5. 安全与可靠性横切设计

1. **最小权限**：scope 分 `kb:read / kb:write / tasks:read / tasks:write / ai:claim / ai:submit / calendar:read`；token 绑定 workspace，跨 workspace 一律拒绝。
2. **不绕权限**：所有写工具经现有路由/service，保留 `canEdit*` 校验、Zod 校验、软删、乐观锁。
3. **凭据**：只存 sha256 hash；明文仅创建时展示一次；支持撤销、过期、`lastUsedAt`；审计日志不记录 token 原文与笔记正文。
4. **幂等**：写工具 `idempotencyKey`；AI 结果用 `(jobId, sourceVersion, promptVersion)` 三重校验。
5. **限流**：复用现有 RAG 限流思路为 MCP 增加按 token 的速率限制，防止 Agent 循环调用打爆 DB。
6. **破坏性操作**：删除/批量移动/清空类操作在 Skill 中要求「先列后确认」；服务端可考虑对超过 N 条的批量移动要求显式 `confirm=true`。
7. **测试隔离**：见 §1.6，列为 P0 前置；CI 中 server 测试必须连独立库。
8. **可回滚**：每期一个独立提交；`AGENT_MCP_ENABLED=false` 可完全关闭 MCP 端点；`AI_EXECUTION_MODE=external` 可切回 internal；日历 `CALENDAR_FEED_ENABLED=false` 关闭订阅。

---

## 6. 依赖与工程改动清单（实现时逐项落地）

| 类别 | 内容 |
| --- | --- |
| 新依赖 | `@modelcontextprotocol/sdk`（MCP，若手写协议则不需要）、`icalendar` 或手写 ICS 生成器 + `rrule`（重复规则，可自己拼 RRULE 以避免依赖）、测试用 `vitest` 沿用现有 |
| 新包 | `apps/mcp-server`（stdio 薄代理）、`packages/mcp-core`（工具注册表，供 server 与文档生成器共用） |
| 新迁移 | `agent_tokens` / `agent_audit_logs` / `idempotency_keys` / （可选）`calendar_timezone` app_setting；按现有最大编号顺延 |
| 新路由 | `POST /mcp`、`/api/agent/*`（token 管理、jobs 领取/回写、reindex）、`GET /api/calendar/:token/feed.ics`、`/api/calendar/tasks/:id.ics` |
| 现有文件改动 | `app.ts`（挂路由）、`middleware/auth.ts`（Agent token）、`middleware/csrf.ts` / `app.ts` CORS（Authorization、来源）、`env.ts`、`services/job-runner.ts`（external 模式）、`services/wiki.service.ts`（抽出 `applyAiArtifacts`）、`packages/shared/src/schemas.ts`（AI 结果 schema）、设置页 UI |
| 工程配置 | 根 `package.json` 的 `build:packages`、`tsconfig.base.json` paths、`.github/workflows/ci.yml`、`Dockerfile`、`pnpm-lock.yaml`、`start-dev.sh`（可选启动 stdio 说明） |
| 文档 | 本计划、`skills/zhipane/*`、`docs/` 下 API 补充说明 |

---

## 7. 风险登记与待确认

| 风险 / 问题 | 影响 | 建议处置 |
| --- | --- | --- |
| **聊天模型无法产出可用 embedding** | 直接毁掉语义检索且不易察觉 | P2.2 三档策略，默认本地 embedding provider + 确定性兜底，服务端强制维度/数值校验 |
| WorkBuddy 具体版本的 MCP 传输支持与配置字段可能变化 | 连不上 | P0 同时提供 stdio 与 HTTP 两份配置；实现前用目标版本实测一次 `tools/list` |
| `app.request()` 内部调用注入 auth 上下文是否可靠 | 可能无法复用现有路由 | P0 先做技术验证（spike），不行则抽 service 层，仍不绕权限 |
| MCP SDK 与 Hono 的 Web Standard 适配 | 集成返工 | 保留「手写最小 JSON-RPC」降级路径 |
| 外部 Agent 结果质量不可控 | Wiki 产物污染 | 严格 Zod 校验 + promptVersion 固定 + 保留 internal 模式可回退 + 结果落审计 |
| 日历订阅是单向且有缓存 | 用户可能误以为实时双向 | P3 UI 明确说明；P4 评估后再承诺 |
| ICS 无 timezone 列 | 跨时区显示偏差 | 统一 UTC 输出；P3.1 增加可选 `calendar_timezone` |
| **server 测试会清开发库** | 数据事故复发 | P0 前置：独立测试库；在此之前所有验证只用 typecheck/lint/build + 前端测试 + 手工 API |
| 现有 `health/diagnostics` 公开输出环境信息 | 暴露面 | 不在本计划范围，建议顺手评估是否加鉴权 |

### 原待确认项（已由 §0.4 决策关闭，保留作为决策记录）
1. **部署形态**：MCP 主要给「本机 WorkBuddy 通过 stdio 连本地服务」还是「远程 HTTP 连自建服务」？两者都会做，但决定 P0 先验收哪条。
2. **AI 外部化的强度**：是「完全替代服务端 LLM（external 为默认）」还是「作为可选模式并存」？建议并存，风险低。
3. **日历是否必须双向**：若手机/Outlook 上修改日程也要回写，P4 需提前到 P3 一并设计（工作量和 OAuth 依赖显著增加）。

---

## 8. 建议的实施顺序与交付节奏

| 期 | 主要交付 | 状态 |
| --- | --- | --- |
| P0 | 测试库隔离 + Agent Token + **云端 HTTP MCP** + 只读工具 + 全局配置 + Skill 包 | ✅ 已完成 |
| P1 | 知识库/任务全部写工具 + 幂等/审计 + Skill 工作流文档 | ✅ 已完成（24 tools） |
| P2 | `ai_execution_mode` 切换 + external 作业协议（仅 LLM Wiki）+ 结果校验 | ✅ 已完成（结果落库见顶部边界） |
| P3 | **CalDAV 双向服务** + `.ics` 兼容订阅 + 设置页 | ✅ 已完成 |

每期结束后跑：`pnpm -r typecheck`、`pnpm -r lint`、`pnpm --filter @zhipane/web test`、`pnpm -r build`、服务 health 与 web 冒烟；**server 测试仅在测试库隔离完成后才加入**。

---

*实施已启动：P0 从「测试库隔离」前置项开始；本文件随实现进度更新。*
