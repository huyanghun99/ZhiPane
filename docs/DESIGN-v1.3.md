# LLM Wiki 个人知识库设计文档 v1.3（修正版 / AI 编程工具可执行版）

> 版本：v1.3  
> 目标读者：AI 编程工具、架构师、全栈工程师、测试工程师  
> 项目定位：面向个人与小团队的一站式创作型知识库，提供传统笔记视图与 LLM Wiki 智能视图。  
> 本版重点：修正 v1.2 中的实现级矛盾，尤其是 embedding 维度与 pgvector 固定列、API Key 加密双方案、应用层中文分词 Windows 打包风险、RAG/Chat 请求级限流、knowledge_edges 索引不足等问题。v1.3 采用唯一且可执行的 MVP 方案：实例级固定 embedding 维度、ai_configs 内联加密、应用层中文分词 + PostgreSQL simple tsvector、PostgreSQL 持久化限流、图谱边完整索引。

---

## 0.0 v1.3 关键修正摘要

本节是 v1.3 相对 v1.2 的强制修正，AI 编程工具实现时必须以本节为准。

```text
1. Embedding 维度：MVP 改为实例级唯一维度，不支持 Workspace 级不同维度。
2. pgvector 表结构：document_chunks.embedding 维度与 app_settings 锁定值一致，默认 vector(1536)。
3. 多 embedding 维度：降级到 v2，通过 profile 分表或分区实现，不在 MVP 中伪支持。
4. API Key 加密：只保留 ai_configs.encrypted_api_key 内联方案，删除 encrypted_secrets 表。
5. 中文全文检索：MVP 不强依赖数据库 zhparser，改为应用层中文分词 + simple tsvector。
6. Windows 一键包：不需要打包 zhparser DLL；仅需标准 PostgreSQL + pgvector + 应用内分词器。
7. RAG/Chat 接口：增加 per-user、per-space、per-workspace 请求级滑动窗口限流。
8. knowledge_edges：补齐 source、target、scope、relation、status、evidence 索引。
```

---

## 0. 设计目标与不可妥协原则

本项目不是简单的 Notion-like + AI Chat，也不是企业协作 Wiki 的精简版。它的核心目标是：

1. **用户可控的传统笔记系统**：用户可以像使用印象笔记、Confluence 或 Docmost 一样，手动创建、编辑、归类、层级组织自己的笔记。
2. **LLM Wiki 第二组织层**：系统基于用户笔记生成 Topic、摘要、标签、关联、实体、图谱和 RAG 问答，但不直接改写用户原始笔记。
3. **一站式创作能力**：完整保留 Docmost 级别的编辑器体验，包括 Draw.io、Excalidraw、Mermaid、KaTeX、高级 Embed、图片、附件、表格、Callout、Toggle、Columns 等。
4. **中文搜索体验优先**：MVP 默认使用“应用层中文分词 + PostgreSQL simple tsvector”做中文全文检索，避免 应用层中文分词 Windows 打包风险；pgvector 做向量检索，RRF 做混合排序。
5. **普通用户可部署**：除了 Docker Compose，还必须支持 Windows 一键运行包，降低 Docker 门槛。
6. **AI 编程工具可落地**：文档必须分阶段、可测试、可验证，不能只描述愿景。

不可妥协原则：

```text
- AI 不直接移动、删除、覆盖用户原始 Page。
- RAG 默认必须严格基于知识库引用。
- local_only Space 不得调用云端 LLM 或云端 Embedding。
- API Key 不得明文落库。
- 备份恢复必须作为正式能力进入交付路线图。
- 编辑器复杂块可以先不进入 LLM Wiki 语义处理，但创作能力必须保留。
```

---

## 1. 产品形态

### 1.1 双视图模型

系统提供两个主工作区。

#### Notes 传统笔记视图

用于用户日常创作与手动组织知识。

核心能力：

```text
- Workspace / Space / Page Tree
- 富文本编辑器
- 附件、图片、视频、音频、PDF
- Draw.io / Excalidraw / Mermaid / KaTeX
- 高级 iframe Embed
- 标签、内部链接、Backlinks
- 自动保存、版本历史、冲突检测
- 导入、导出、打印 PDF
- Page / Topic 公开只读分享
```

设计原则：用户的目录结构、页面层级、归类方式由用户控制。

#### LLM Wiki 智能视图

用于 AI 辅助整理与知识发现。

核心能力：

```text
- LLM Inbox：新增或修改后尚未被 LLM 处理的页面
- Topic Center：AI 生成并由用户确认的主题页
- Review Center：AI 建议批量确认中心
- Graph View：知识图谱与证据卡片
- Ask：严格引用模式 RAG 问答
- Related：相关页面、Topic、实体、标签
```

设计原则：AI 生成第二组织层，用户确认后落库。

---

## 2. 核心概念

### 2.1 Workspace / Space / Group

保留但弱化企业概念。

```text
Workspace：大的知识库容器，例如「个人」「学习」「工作」「研究」。
Space：知识边界，例如「AI 学习」「课程笔记」「项目 A」。
Group：简单用户集合，用于 Space 权限分配。
```

### 2.2 Page 与 Topic

```text
Page：用户原始笔记，source of truth。
Topic：LLM Wiki 主题页，引用 Page / Chunk / Entity，不直接替代 Page。
```

规则：

```text
- Page 由用户直接创作。
- Topic 可由 AI 建议生成，也可由用户创建。
- AI 对 Topic 的后续刷新默认只生成更新建议。
- 用户手动编辑过的 Topic 不被后台任务静默覆盖。
```

### 2.3 LLM Inbox

LLM Inbox 是智能视图，不是页面主状态。

```text
LLM Inbox = 当前 Space 中 llm_process_status = pending 的 Page 集合。
```

页面状态拆分：

```text
page_status:
- normal
- archived
- deleted

llm_process_status:
- pending
- processing
- processed
- failed
- ignored
```

新增或修改 Page 后：

```text
page_status = normal
llm_process_status = pending
```

---

## 3. 技术栈

### 3.1 默认技术栈

```text
语言与工程：
- TypeScript 7，允许兼容性回退到 TypeScript 6.x
- pnpm workspace
- monorepo
- Vitest
- Playwright
- ESLint
- Prettier

前端：
- React
- Vite
- Tiptap / ProseMirror
- Mantine
- TanStack Query
- Zustand 或 Jotai
- React Router

后端：
- Hono
- Zod
- Drizzle ORM
- node-postgres
- SSE
- Multipart upload
- 内置 Job Runner

数据库：
- PostgreSQL
- pgvector
- 应用层中文分词
- JSONB
- GIN 中文全文索引
- HNSW 向量索引

AI：
- OpenAI-compatible Provider
- OpenAI Provider
- Ollama Provider
- Gemini Provider，可选
- Mock Provider，用于测试
```

### 3.2 不采用的默认技术

```text
- NestJS：过重，Decorator/DI 对 AI 编程工具不够友好。
- Next.js 全栈：SSR 和 Server Components 不是本项目核心。
- Prisma：pgvector VECTOR 类型建模不如 Drizzle + raw SQL 直接。
- SQLite：不作为默认数据库，中文全文检索和向量体验不够稳。
- Redis / BullMQ：MVP 删除，改用 PostgreSQL 持久化 jobs 表。
- 独立图数据库：MVP 不引入。
```

---

## 4. Monorepo 结构

```text
apps/
  web/
    src/
      editor/
      pages/
      routes/
      components/
      features/
      services/
      stores/

  server/
    src/
      app.ts
      routes/
      services/
      repositories/
      jobs/
      middlewares/
      sse/
      uploads/
      security/

packages/
  shared/
    schemas/
    types/
    constants/

  db/
    schema/
    migrations/
    sql/
    client.ts

  editor/
    extensions/
    contracts/
    components/
    utils/

  ai/
    providers/
    prompts/
    rag/
    embeddings/
    chunking/
    evals/

  jobs/
    runner/
    definitions/
```

---

## 5. 部署与分发模式

### 5.1 Docker Compose 模式

面向技术用户、服务器、NAS、自托管用户。

```text
services:
  app:
    image: llm-wiki/app
    ports:
      - "3000:3000"
    volumes:
      - ./data/uploads:/data/uploads
    environment:
      DATABASE_URL: postgresql://...
      APP_SECRET: ...

  db:
    image: llm-wiki/postgres-pgvector-应用层中文分词
    volumes:
      - ./data/postgres:/var/lib/postgresql/data
```

默认仍为两容器：

```text
- app：React 静态资源 + Hono API + Job Runner
- db：PostgreSQL + pgvector + 应用层中文分词
```

### 5.2 Windows Desktop Bundle 模式（新增，正式目标）

面向普通用户，避免 Docker 门槛。

用户体验：

```text
下载 LLM-Wiki-Setup.exe
→ 安装
→ 双击 LLM Wiki
→ 自动启动本地 PostgreSQL
→ 自动启动本地 Hono server
→ 自动打开浏览器或桌面窗口
→ 首次创建 Owner 账号
```

推荐目录：

```text
%LOCALAPPDATA%\LLM-Wiki\
  app\
    llm-wiki-launcher.exe
    server\
    web\
  postgres\
    bin\
    lib\
    share\
    extensions\
  data\
    postgres\
    uploads\
    backups\
    logs\
  config.json
```

### 5.3 Windows Launcher 责任

```text
1. 检查数据目录。
2. 首次运行时执行 initdb。
3. 生成随机数据库密码。
4. 写入 config.json。
5. 启动 PostgreSQL 子进程。
6. 等待 PostgreSQL ready。
7. 执行 migrations。
8. 执行 CREATE EXTENSION vector / application tokenizer。
9. 启动 Hono server。
10. 调用 /health 检查。
11. 打开 http://127.0.0.1:<port>。
12. 退出时优雅关闭 server 和 PostgreSQL 子进程。
```

### 5.4 Windows 子进程管理（新增）

#### 端口策略

```text
默认端口：
- App server: 127.0.0.1:39280
- PostgreSQL: 127.0.0.1:39281

若端口被占用：
- 自动扫描 39280-39380
- 写入 config.json
- 永不默认监听 0.0.0.0
```

#### PostgreSQL 启动策略

```text
- 只监听 127.0.0.1
- 使用随机生成的数据库密码
- 默认不注册 Windows Service
- Portable 模式下只作为当前用户子进程运行
- Launcher 维护 pid 文件
- 异常退出后提示用户重启或查看日志
```

#### 日志目录

```text
%LOCALAPPDATA%\LLM-Wiki\data\logs\
  launcher.log
  server.log
  postgres.log
  migration.log
  job-runner.log
```

#### 自动升级前保护

```text
Windows Bundle 每次应用升级前必须：
1. 检查数据库 migration 状态。
2. 创建升级前备份。
3. 执行 migration。
4. 启动应用。
5. 失败时提示恢复备份。
```

### 5.5 Portable Zip 模式，可选

```text
- 解压即用
- 数据存储在 ./data
- 不写注册表
- 不注册 Windows Service
- 适合单机试用、U 盘携带、学校电脑环境
```

---

## 6. 数据模型概览

### 6.1 用户与组织

```text
users
workspaces
workspace_members
spaces
space_members
groups
group_members
```

### 6.2 内容

```text
pages
page_revisions
attachments
page_tags
```

### 6.3 LLM Wiki

```text
page_ai_profiles
llm_suggestions
wiki_topics
topic_sources
entities
page_entities
knowledge_edges
```

### 6.4 检索

```text
document_chunks
search_events，可选
rag_sessions
rag_messages
rag_citations
```

### 6.5 系统

```text
jobs
ai_provider_configs
backups
schema_migrations
app_settings
```

---

## 7. 权限模型

### 7.1 简单 RBAC

不使用 CASL。

```text
WorkspaceRole:
- owner
- admin
- member

SpaceRole:
- admin
- writer
- reader
```

权限函数：

```ts
canViewPage(userId, pageId): Promise<boolean>
canEditPage(userId, pageId): Promise<boolean>
canManageSpace(userId, spaceId): Promise<boolean>
canManageWorkspace(userId, workspaceId): Promise<boolean>
canUseLlmWiki(userId, spaceId): Promise<boolean>
canAcceptLlmSuggestion(userId, suggestionId): Promise<boolean>
```

RAG 与搜索必须在 SQL 查询层前置过滤可访问 Space。

---

## 8. AI Provider 与密钥安全

### 8.1 AI 配置优先级

```text
1. User-level AI config，用户启用 personal override 时优先。
2. Workspace-level AI config。
3. 环境变量 fallback。
```

### 8.2 Space AI 隐私策略

```text
inherit_workspace：继承 Workspace 默认配置。
cloud_allowed：允许使用云端 LLM / Embedding。
local_only：只允许本地模型或本地 OpenAI-compatible endpoint。
disabled：禁用该 Space 的 AI 处理。
```

local_only 必须同时约束：

```text
- chat completion
- summary generation
- tag generation
- entity extraction
- embedding generation
- RAG answer generation
```

### 8.3 API Key 加密存储（v1.3 修正）

#### 设计裁决

MVP **只保留 `ai_configs.encrypted_api_key` 内联加密方案**。

```text
不创建 encrypted_secrets 表。
不维护“通用密钥表 + 业务表引用”双方案。
每条 AI 配置自己保存一份加密后的 API Key。
```

选择内联方案的原因：

```text
- 配置读取路径最短，AI 编程工具更容易实现。
- Workspace/User 两级 AI 配置数量有限，不需要密钥复用表。
- 避免 encrypted_secrets 与 ai_configs 两套格式并存。
- 备份、恢复、脱敏、更新都更直观。
```

#### 加密原则

```text
- API Key 不得明文存储。
- 数据库只保存 ai_configs.encrypted_api_key。
- UI 只显示 api_key_masked，例如 sk-****abcd。
- GET 配置接口永不返回明文 API Key。
- 导出备份默认不包含 encrypted_api_key。
- 恢复备份后用户需要重新填写 API Key，除非显式选择包含加密 secret。
```

#### 加密算法

```text
APP_SECRET：部署时生成，至少 32 bytes。
KEY_DERIVATION：HKDF-SHA256(APP_SECRET, salt="llm-wiki-ai-configs")。
ENCRYPTION：AES-256-GCM。
IV：每次加密随机生成 12 bytes。
AUTH_TAG：使用 GCM auth tag。
STORAGE_FORMAT：base64url(iv).base64url(ciphertext).base64url(authTag)。
```

#### ai_configs 字段

```sql
CREATE TABLE ai_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','user')),
  scope_id UUID NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT,
  completion_model TEXT,
  embedding_model TEXT,
  encrypted_api_key TEXT,
  api_key_masked TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_type, scope_id, provider)
);
```

#### API 返回示例

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "apiKeyMasked": "sk-****abcd",
  "hasApiKey": true
}
```

#### 测试要求

```text
- 数据库中不得出现明文 API Key。
- GET 配置接口不得返回明文 API Key。
- 更新 API Key 后旧密文被覆盖。
- APP_SECRET 缺失时服务不得启动。
- 备份默认导出时 encrypted_api_key 必须为空或被排除。
- encrypted_api_key 必须符合 iv.ciphertext.authTag 三段格式。
```

---

## 9. Embedding 维度与 pgvector 表结构（v1.3 修正）

### 9.1 设计裁决

MVP 阶段 **全实例只允许一种 embedding 维度**。

```text
不支持 WorkspaceA 使用 1536 维、WorkspaceB 使用 768 维。
不支持同一 document_chunks.embedding 列中混合不同维度。
不把 Workspace 级 embedding profile 作为 MVP 功能。
```

原因：pgvector 的 `vector(n)` 是列级固定维度，HNSW/IVFFlat 索引也要求同一列维度一致。如果一张 `document_chunks` 表的 `embedding vector(1536)` 同时写入 768 维向量，系统要么写入失败，要么索引语义错误。

### 9.2 MVP 实例级配置

实例首次初始化时锁定 embedding 维度。默认值：

```text
EMBEDDING_PROVIDER=openai-compatible
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSION=1536
```

锁定值写入 `app_settings`：

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings(key, value) VALUES
('embedding.active', jsonb_build_object(
  'provider', 'openai-compatible',
  'model', 'text-embedding-3-small',
  'dimension', 1536,
  'locked', true
));
```

### 9.3 document_chunks MVP 表结构

MVP 默认使用固定维度列：

```sql
embedding vector(1536)
```

如果项目初始化时允许修改 `EMBEDDING_DIMENSION`，则 migration 必须在创建表前生成对应维度，且创建后不可在 UI 中直接切换维度。为避免 AI 编程工具实现复杂度，MVP 推荐直接固定为 1536。

### 9.4 模型切换规则

```text
允许：
- 同维度模型切换，例如 1536 -> 1536。
- 切换后新 chunk 使用新模型。
- 用户可手动触发全量 re-embed。

禁止：
- 不同维度模型在线切换。
- Workspace 级不同 embedding dimension。
- 同表同列混用不同维度。
```

当用户尝试切换到不同维度模型：

```text
1. 后端拒绝保存配置。
2. 返回错误：当前实例 embedding 维度已锁定为 1536，目标模型维度为 768。
3. UI 提示：MVP 不支持不同维度切换；请新建实例或等待 v2 多 profile 支持。
```

### 9.5 v2 多维度方案

多维度切换降级为 v2。可选实现：

```text
方案 A：按维度分表
- document_chunks_1536
- document_chunks_768
- document_chunks_1024

方案 B：按 embedding_profile_id 分区
- document_chunks 主表不直接建全局 HNSW
- 每个 profile/dimension 对应一个 partition
- 每个 partition 建自己的 vector(n) 和 HNSW index

方案 C：每个 Workspace 独立 chunk table，不推荐 MVP
```

### 9.6 测试用例

```text
- 首次启动后 app_settings.embedding.active 写入 dimension=1536。
- document_chunks.embedding 为 vector(1536)。
- 同维度模型切换允许保存。
- 不同维度模型切换必须返回 400。
- RAG / vector search 不需要按 workspace embedding_profile 过滤。
- re-embed job 不改变 embedding dimension。
```

---

## 10. 页面内容存储与可索引性矩阵（新增）

### 10.1 主存储格式

```text
content_json = ProseMirror / Tiptap JSON，编辑器事实源。
text_content = 从 content_json 提取的纯文本，搜索和 LLM Wiki 输入。
content_markdown = 可选缓存，用于导出和调试，不作为事实源。
```

### 10.2 内容可索引性矩阵

| 内容类型 | 进入全文搜索 | 进入向量 | 进入 LLM Wiki | 进入导出 | 进入打印 |
|---|---|---|---|---|---|
| 普通文本 | 是 | 是 | 是 | 是 | 是 |
| 标题层级 | 是 | 是 | 是 | 是 | 是 |
| 标签 | 是 | 可选 | 是 | 是 | 是 |
| 内部 Page Mention | 是 | 可选 | 是 | 是 | 是 |
| Mermaid 源码 | 是 | 可选 | 可选 | 是 | 渲染图 |
| KaTeX 源码 | 是 | 可选 | 可选 | 是 | 渲染公式 |
| Draw.io | metadata | 否 | 否 | SVG / 附件 | SVG |
| Excalidraw | metadata | 否 | 否 | SVG / 附件 | SVG |
| 图片 | metadata | 否 | 否 | 附件 | 图片 |
| PDF 附件 | metadata | 否 | 否 | 附件 | 链接 / 预览 |
| 视频 / 音频 | metadata | 否 | 否 | 附件 | 链接 / 预览 |
| iframe Embed | URL / provider | 否 | 否 | 链接卡片 | 占位卡片 |
| 任意附件 | metadata | 否 | 否 | 附件 | 链接 |

### 10.3 text_content 提取规则

```text
- 普通文本节点：提取文本。
- heading：提取并保留标题层级标记。
- table：按行列提取文本。
- Mermaid：可选提取源码，前缀 [Mermaid Diagram]。
- KaTeX：可选提取公式源码，前缀 [Formula]。
- Draw.io / Excalidraw：只提取 title / file name。
- Embed：提取 provider + URL + title。
- Attachment：提取 file_name + mime_type。
```

---

## 11. 编辑器架构

### 11.1 实施里程碑拆分（新增）

原 M2 不得一次性实现。必须拆成三个阶段。

#### M2A：编辑器基础能力

```text
- Tiptap 初始化
- ProseMirror JSON 存储
- text_content 提取
- 标题 / 段落 / 加粗 / 斜体 / 删除线 / 行内代码
- 有序列表 / 无序列表 / 待办列表
- 引用块 / 代码块 / 分割线
- 表格
- 自动保存
- 版本历史
- 冲突检测
- 本地草稿恢复
```

#### M2B：媒体与附件

```text
- 图片上传
- 视频上传
- 音频上传
- PDF 上传
- 任意附件上传
- 本地存储 / S3 存储抽象
- 附件权限校验
- 附件导出打包
- 附件打印占位
```

#### M2C：高级创作块

```text
- Draw.io
- Excalidraw
- Mermaid
- KaTeX
- iframe Embed
- YouTube / Figma / Miro / Loom / Airtable / Typeform / Vimeo / Google Drive
- Columns
- Toggle
- Callout
- Subpages
- Status
- Date
```

M2C 不得阻塞 M1-M4。AI 编程工具应先确保 M2A/M2B 稳定，再进入 M2C。

### 11.2 编辑器扩展插件合同（新增）

所有编辑器扩展必须实现统一合同，避免显示、导出、搜索、打印、LLM 处理不一致。

```ts
export interface EditorBlockExtension {
  /** Extension name used by Tiptap */
  name: string;

  /** ProseMirror node type */
  nodeType: string;

  /** Slash command name or insert command */
  insertCommand: string;

  /** Extract text for search and LLM Wiki */
  toTextContent(node: unknown): string;

  /** Export to Markdown when supported */
  toMarkdown?(node: unknown): string;

  /** Export to HTML when supported */
  toHtml?(node: unknown): string;

  /** Return attachment references used by the node */
  getAttachments?(node: unknown): AttachmentRef[];

  /** Whether semantic content enters LLM Wiki */
  isIndexableByLlm: boolean;

  /** Print-friendly renderer */
  printRenderer?: React.ComponentType<any>;

  /** Read-only renderer */
  readonlyRenderer: React.ComponentType<any>;

  /** Editable renderer */
  editableRenderer: React.ComponentType<any>;
}

export interface AttachmentRef {
  attachmentId: string;
  role: 'image' | 'video' | 'audio' | 'pdf' | 'file' | 'diagram' | 'drawing';
}
```

### 11.3 每个扩展必须提供测试

```text
- 插入测试
- 保存为 content_json 测试
- text_content 提取测试
- 导出 HTML / Markdown 测试，可选
- 打印渲染测试
- 权限测试，若涉及附件
- 快照测试，确保渲染不回归
```

---

## 12. Job Runner

### 12.1 持久化 Job Queue

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID,
  space_id UUID,
  entity_type TEXT,
  entity_id UUID,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  priority INT NOT NULL DEFAULT 100,
  run_after TIMESTAMP NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_by TEXT,
  locked_at TIMESTAMP,
  error_message TEXT,
  cost_estimate_tokens INT,
  actual_prompt_tokens INT,
  actual_completion_tokens INT,
  provider_request_id TEXT,
  rate_limited_until TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
```

Worker 使用：

```sql
SELECT * FROM jobs
WHERE status = 'pending'
  AND run_after <= now()
ORDER BY priority ASC, created_at ASC
FOR UPDATE SKIP LOCKED
LIMIT 10;
```

---

## 13. AI 成本、节流与批量导入控制（新增）

### 13.1 为什么需要

LLM Wiki 会自动处理新增和修改页面。用户导入 ZIP 或批量编辑时，如果没有节流，会导致：

```text
- API 费用不可控
- Provider rate limit
- Job 队列堆积
- 用户误以为系统卡死
- 云端模型处理敏感 Space 的风险增加
```

### 13.2 Budget 配置

Workspace 级：

```text
monthly_token_budget，可选
monthly_cost_budget，可选
max_concurrent_ai_jobs
max_daily_processed_pages
embedding_batch_size
```

Space 级：

```text
auto_process_enabled
max_daily_ai_jobs
bulk_import_auto_process: ask | auto | never
```

User 级：

```text
personal_api_budget，可选
max_concurrent_user_ai_jobs
```

### 13.3 批量导入策略

ZIP 导入完成后：

```text
- 页面创建成功
- llm_process_status = pending
- 任务以 low priority 入队
- UI 提示：已导入 N 个页面，是否立即 AI 整理？
```

选项：

```text
1. 立即整理全部
2. 只生成 embedding
3. 只处理前 20 个页面
4. 稍后手动整理
5. 对该 Space 默认以后自动处理
```

### 13.4 Rate Limit 行为

```text
- Provider 返回 429：记录 rate_limited_until。
- 同 Provider 后续 Job 延迟。
- 指数退避 retry。
- UI 显示“AI Provider 限流，稍后自动重试”。
```

### 13.5 Cost Tracking

建议记录：

```sql
CREATE TABLE ai_usage_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  user_id UUID,
  space_id UUID,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  estimated_cost_usd NUMERIC(12,6),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

### 13.6 请求级限流（v1.3 新增）

Job 级 budget 只能控制后台任务，不能保护同步 AI 接口。MVP 必须为 RAG/Chat/Generate 接口增加请求级限流。

#### 限流范围

```text
必须限流：
- POST /api/rag/ask
- POST /api/ai/chat
- POST /api/ai/generate
- POST /api/ai/generate/stream
- POST /api/llm-wiki/process-now

不允许匿名调用：
- RAG / Chat / Generate 默认必须登录。
- 公开分享链接不能调用 RAG。
```

#### 默认限额

```text
per-user:
- RAG/Chat：20 requests / 10 minutes
- Generate：30 requests / 10 minutes
- concurrent streaming：2

per-space:
- RAG/Chat：100 requests / hour
- manual process-now：20 requests / hour

per-workspace:
- cloud LLM calls：500 requests / day，可配置
```

#### PostgreSQL 持久化滑动窗口

由于 MVP 不使用 Redis，限流使用 PostgreSQL 表实现。

```sql
CREATE TABLE api_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID,
  user_id UUID,
  route TEXT NOT NULL,
  cost_units INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rate_limit_user_route_time
  ON api_rate_limit_events(user_id, route, created_at DESC);

CREATE INDEX idx_rate_limit_space_route_time
  ON api_rate_limit_events(workspace_id, space_id, route, created_at DESC);

CREATE INDEX idx_rate_limit_workspace_time
  ON api_rate_limit_events(workspace_id, created_at DESC);
```

实现要求：

```text
- Hono middleware 在调用 LLM 前执行限流。
- 超限返回 429 Too Many Requests。
- 响应包含 retryAfterSeconds。
- streaming 请求开始时占用并发槽，结束或 abort 后释放。
- 定时清理 7 天前 api_rate_limit_events。
```

测试要求：

```text
- 同一用户 10 分钟内第 21 次 RAG 请求返回 429。
- 不同用户不互相影响。
- 同一 Space 超过小时限制返回 429。
- 公开分享页面不能调用 RAG。
- AbortController 中断 SSE 后并发计数释放。
```

---

## 14. 搜索与 RAG

### 14.1 混合检索

默认采用：

```text
- 应用层 ChineseTokenizer 对中文内容和查询进行预分词
- PostgreSQL simple tsvector / ts_rank 做关键词检索
- pgvector 做向量检索
- RRF 混合排序
```

### 14.2 RAG 默认严格引用

```text
strict_citation_mode = true
answer_requires_sources = true
no_context_response = "知识库中未找到相关信息。"
```

可选“扩展思考模式”：

```text
- 先回答知识库能确认的内容。
- 再单独标注“以下是模型基于通用知识的补充”。
- 通用知识部分不得显示为知识库引用。
```

---

## 15. RAG 质量评测集（新增）

### 15.1 目标

功能测试只能证明接口可用，不能证明 RAG 可信。必须加入 RAG 质量评测集。

### 15.2 Evaluation Set

```text
rag-eval/
  fixtures/
    workspace-seed.json
    pages/
      chinese-keyword.md
      semantic-paraphrase.md
      cross-page.md
      no-answer.md
      permission-private.md
  questions.jsonl
  expected.jsonl
```

问题类型：

```text
- 20 条中文精确事实问题
- 20 条语义改写问题
- 10 条无答案问题
- 10 条跨页面综合问题
- 10 条权限隔离问题
- 10 条 Topic 来源追溯问题
```

### 15.3 评价指标

```text
citation_precision：引用是否真的支持回答。
answer_groundedness：回答是否完全基于上下文。
no_answer_accuracy：无答案时是否拒答。
permission_leakage_rate：是否泄露无权限内容，必须为 0。
retrieval_recall@k：相关 chunk 是否进入 Top K。
Chinese_keyword_hit_rate：中文关键词搜索命中率。
```

### 15.4 自动化要求

```text
- CI 默认运行 mock RAG eval。
- 真实模型 eval 仅手动触发。
- Mock Provider 使用固定回答和固定 embedding。
- Evaluation result 输出 JSON 报告。
```

示例：

```json
{
  "question": "这份员工手册里年假规则是什么？",
  "expected_sources": ["page-employee-handbook"],
  "expected_answer_contains": ["年假", "工龄"],
  "mode": "strict"
}
```

---

## 16. LLM Wiki 与 Topic 生命周期（新增）

### 16.1 Topic 状态

```text
topic_status:
- suggested：AI 建议，还未接受
- accepted：用户已接受，正式 Topic
- user_edited：用户手动编辑过
- stale：来源 Page 更新后，Topic 可能过期
- archived：归档
```

### 16.2 状态流转

```text
AI 生成 Topic 建议
→ suggested

用户接受
→ accepted

用户编辑正文 / 标题 / 来源
→ user_edited

来源 Page 更新
→ stale
→ 生成 refresh suggestion

用户接受刷新建议
→ accepted 或 user_edited，取决于用户是否保留手动编辑
```

### 16.3 不覆盖原则

```text
- user_edited Topic 不被自动覆盖。
- stale 只提示，不自动改写。
- refresh suggestion 必须展示 diff。
```

---

## 17. 知识图谱与证据卡片（新增）

### 17.1 存储

MVP 使用 PostgreSQL，不引入 Neo4j。

```sql
CREATE TABLE knowledge_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID NOT NULL,
  source_type TEXT NOT NULL,
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  confidence NUMERIC(5,4),
  status TEXT NOT NULL DEFAULT 'suggested',
  evidence JSONB NOT NULL DEFAULT '[]',
  generated_by TEXT,
  prompt_version TEXT,
  user_confirmed_by UUID,
  confirmed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
```

### 17.2 证据结构

```json
{
  "sourcePageId": "uuid",
  "sourceChunkId": "uuid",
  "excerpt": "...",
  "reason": "为什么认为存在该关系",
  "model": "gpt-4.1-mini",
  "confidence": 0.82
}
```

### 17.3 Graph Evidence Card

用户点击图谱边时必须显示证据卡片：

```text
- 关系类型
- 置信度
- 来源页面
- 来源 Chunk 摘录
- AI 生成理由
- 是否用户确认
- 确认人和确认时间
- 接受 / 删除 / 修改关系
```

### 17.4 关系类型

```text
- mentions
- related_to
- references
- summarizes
- expands
- duplicates
- tagged_with
- belongs_to
- depends_on
- part_of
```

---

## 18. Review Center 与批量更新

默认使用 balanced 策略。

```text
conservative：所有建议都需确认。
balanced：低风险自动应用，中风险批量确认，高风险单独确认。
aggressive：更多建议自动应用，但高风险仍需确认。
```

风险分级：

```text
低风险：标签、摘要、关键词、mentions、embedding。
中风险：创建 Topic 草稿、增加 Topic 来源、强语义关系。
高风险：合并 Topic、删除内容、移动 Page、覆盖用户编辑正文。
```

---

## 19. 备份与恢复（新增）

### 19.1 为什么进入 MVP / M8

个人知识库最重要的是数据安全。导入导出不是完整备份，必须提供正式备份恢复。

### 19.2 备份内容

```text
完整备份包含：
- PostgreSQL 数据 dump 或 JSON dump
- uploads 附件目录
- app metadata
- schema version
- embedding profile 信息
- 可选 config

默认不包含：
- API Key 明文
- APP_SECRET
- session tokens
```

### 19.3 备份格式

```text
llm-wiki-backup-YYYYMMDD-HHMM.zip
  manifest.json
  database.dump 或 database.jsonl
  uploads/
  metadata/
    schema-version.json
    app-version.json
    embedding-profiles.json
```

`manifest.json`：

```json
{
  "app": "llm-wiki",
  "backupVersion": 1,
  "createdAt": "2026-07-14T00:00:00Z",
  "appVersion": "1.1.0",
  "schemaVersion": "2026071401",
  "containsSecrets": false,
  "uploadsIncluded": true
}
```

### 19.4 恢复规则

```text
- 恢复前检查 app version 和 schema version。
- 恢复到新实例时必须重新创建 Owner 或验证备份 Owner。
- 默认恢复后要求重新配置 AI Provider API Key。
- 若包含加密 secret，必须提供原 APP_SECRET，否则无法解密。
```

### 19.5 Windows 自动备份

Windows Bundle 推荐支持：

```text
- 每日自动备份，可关闭。
- 保留最近 7 份。
- 升级前强制创建 pre-upgrade backup。
- 备份失败时阻止破坏性 migration。
```

---

## 20. 数据库迁移与升级策略（新增）

### 20.1 Migration 规则

```text
- 所有 migration 必须有唯一 ID。
- 所有 migration 必须可重复检测。
- 禁止直接 drop 用户数据列。
- destructive migration 必须拆成两步。
- 每次启动先检查 migration 状态。
- Windows Bundle 自动 migration 前必须创建备份。
```

### 20.2 两阶段破坏性变更

错误做法：

```sql
ALTER TABLE pages DROP COLUMN old_content;
```

正确做法：

```text
版本 A：新增 new_content，双写 old_content + new_content。
版本 B：后台 job 验证迁移完成。
版本 C：停止读取 old_content。
版本 D：仅在明确安全后删除 old_content。
```

### 20.3 启动检查

应用启动顺序：

```text
1. 检查数据库连接。
2. 检查 schema_migrations。
3. 若有待执行 migration：
   - Docker 模式直接执行。
   - Windows 模式先创建 pre-upgrade backup。
4. 执行 migration。
5. 检查 extensions。
6. 启动 Job Runner。
7. 启动 API。
```

### 20.4 schema_migrations 表

```sql
CREATE TABLE schema_migrations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT now(),
  checksum TEXT NOT NULL,
  app_version TEXT
);
```

---

## 21. 分享、导入导出、打印

### 21.1 分享

MVP 支持 Page / Topic 公开只读分享。

```text
- share_token 随机生成。
- 可关闭分享。
- 可重新生成 token。
- 匿名用户不可编辑、不可调用 AI、不可访问其他 Space 内容。
```

### 21.2 导入导出

MVP：

```text
导入：Markdown / HTML / ZIP。
导出：单页 Markdown / HTML，Space ZIP。
```

v2：

```text
DOCX / Notion / Confluence 专用导入。
```

### 21.3 打印 PDF

MVP 使用浏览器打印。

```text
- Page 提供打印按钮。
- 使用 print CSS。
- 用户在浏览器中保存为 PDF。
- 不引入服务端 Chromium。
```

---

## 22. API 概览

### 22.1 Auth

```text
POST /api/auth/register
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

### 22.2 Workspace / Space / Group

```text
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:id
PATCH  /api/workspaces/:id

GET    /api/spaces?workspaceId=
POST   /api/spaces
PATCH  /api/spaces/:id
DELETE /api/spaces/:id

POST   /api/groups
PATCH  /api/groups/:id
POST   /api/groups/:id/members
DELETE /api/groups/:id/members/:userId
```

### 22.3 Pages

```text
GET    /api/pages/:id
POST   /api/pages
PATCH  /api/pages/:id
DELETE /api/pages/:id
GET    /api/pages/:id/revisions
POST   /api/pages/:id/restore-revision
```

### 22.4 LLM Wiki

```text
GET  /api/llm/inbox?spaceId=
POST /api/llm/pages/:pageId/process-now
POST /api/llm/spaces/:spaceId/pause
POST /api/llm/spaces/:spaceId/resume

GET  /api/topics?spaceId=
POST /api/topics
GET  /api/topics/:id
PATCH /api/topics/:id
POST /api/topics/:id/refresh-suggestions

GET  /api/suggestions?spaceId=&status=
POST /api/suggestions/:id/accept
POST /api/suggestions/:id/ignore
POST /api/suggestions/bulk-accept
```

### 22.5 Search / RAG

```text
POST /api/search
POST /api/search/hybrid
POST /api/rag/ask
GET  /api/rag/sessions
GET  /api/rag/sessions/:id
```

### 22.6 Backup

```text
POST /api/backups
GET  /api/backups
GET  /api/backups/:id/download
POST /api/backups/restore
```

---

## 23. 实施路线图 v1.1

### M0：项目骨架

```text
- pnpm monorepo
- React/Vite
- Hono server
- Drizzle
- PostgreSQL docker-compose
- health check
- APP_SECRET 检查
```

### M1：账号 / Workspace / Space / Page

```text
- 本地账号
- 首个用户为 Owner
- Workspace / Space / Group
- 简单 RBAC
- Page CRUD
- Page Tree
- 自动保存
- 版本历史
- 冲突检测
```

### M2A：编辑器基础能力

见第 11.1 节。

### M2B：媒体与附件

见第 11.1 节。

### M2C：高级创作块

见第 11.1 节。

### M3：中文全文检索

```text
- text_content 提取
- 应用层中文分词
- GIN index
- Page / Topic 搜索
```

### M4：向量与 RAG

```text
- app_settings.embedding.active
- chunking
- pgvector
- HNSW index
- hybrid search
- RRF
- RAG SSE
- citations
```

### M5：LLM Wiki

```text
- llm_process_status
- LLM Inbox
- page_ai_profiles
- suggestions
- Topic Center
- Review Center
- balanced 批量策略
```

### M6：知识图谱

```text
- entities
- knowledge_edges
- evidence card
- Graph View
```

### M7：导入导出 / 分享 / 打印

```text
- Markdown / HTML / ZIP 导入导出
- 附件打包
- Page / Topic 公开分享
- 浏览器打印 PDF
```

### M8：质量加固

```text
- 单元测试
- 集成测试
- E2E 测试
- RAG Eval
- API Key 加密测试
- 备份恢复
- migration 安全策略
- 性能测试
```

### M9：Windows 一键运行包

```text
- Launcher
- bundled server
- bundled PostgreSQL
- bundled pgvector / 应用层中文分词
- initdb
- migrations
- pre-upgrade backup
- log viewer
```

### M10：桌面增强，可选

```text
- 系统托盘
- 自动更新
- 开机启动
- Portable zip
- 本地通知
```

---

## 24. 测试矩阵 v1.1

### 24.1 Unit Tests

```text
- RBAC 权限函数
- content_json → text_content
- EditorBlockExtension contract
- chunking
- RRF 排序
- suggestion risk 分类
- Topic 生命周期状态机
- API Key 加密 / 解密
- embedding dimension 锁定与不同维度拒绝
- local_only endpoint 判定
```

### 24.2 SQL / Repository Tests

```text
- 应用层中文分词 + PostgreSQL simple tsvector 全文检索
- pgvector 向量检索
- RRF 混合检索
- document_chunks 固定 embedding_dimension 与 HNSW 索引
- jobs FOR UPDATE SKIP LOCKED
- knowledge_edges evidence JSONB 查询
- backups metadata 写入
```

### 24.3 API Integration Tests

```text
- Auth
- Workspace / Space / Group
- Page CRUD
- Editor autosave
- Attachment upload
- Search
- RAG SSE
- LLM Suggestions
- Review Center bulk accept
- Topic stale refresh
- Graph evidence card
- Backup create / restore
- AI config masked response
```

### 24.4 Job Runner Tests

```text
- 页面保存后 enqueue
- 同页面任务去重
- 延迟执行
- rate limit 后延迟重试
- Space pause 后不执行 AI job
- local_only 未配置本地模型时保持 pending
- 重启后 pending jobs 不丢失
```

### 24.5 E2E Tests

```text
- 首次启动创建 Owner
- 创建 Workspace / Space / Page
- 插入 Mermaid / KaTeX / 图片 / 附件
- 自动保存并恢复草稿
- 中文搜索命中
- RAG 回答带引用
- 无答案时拒答
- 创建 Topic 并接受建议
- Topic 来源 Page 更新后变 stale
- 图谱边证据卡片可打开
- Page 分享只读可访问
- 备份并恢复到新实例
```

### 24.6 RAG Eval Tests

```text
- citation_precision >= 0.9
- no_answer_accuracy >= 0.95
- permission_leakage_rate = 0
- Chinese_keyword_hit_rate >= 0.9
- retrieval_recall@5 >= 0.85
```

### 24.7 Windows Bundle Tests

```text
- 首次运行自动 initdb
- 端口占用时自动切换端口
- PostgreSQL 只监听 127.0.0.1
- Launcher 关闭时子进程退出
- 升级前创建备份
- migration 失败可恢复
- 无 Docker 环境也可运行
```

---

## 25. 性能与规模目标

### 25.1 MVP 目标规模

```text
小型个人库：1k pages，必须流畅。
中型知识库：10k pages，搜索和 RAG 可接受。
大型知识库：100k pages，允许后台任务变慢，但检索不能崩溃。
```

### 25.2 性能预算

```text
页面保存 API：p95 < 500ms，不等待 AI。
全文搜索：p95 < 800ms at 10k pages。
Hybrid Search：p95 < 1500ms at 10k pages。
RAG 首 token：p95 < 5s，取决于 Provider。
Job Runner：批量导入后不阻塞主 API。
```

---

## 26. AI 编程工具执行规则

AI 编程工具必须遵守：

```text
1. 按 M0 → M10 顺序实现，不得跳阶段。
2. 每个 Milestone 完成后必须运行对应测试。
3. 不得真实调用外部 LLM 作为自动化测试依赖。
4. 不得明文存储 API Key。
5. 不得让 RAG 返回无引用的知识库答案。
6. 不得让 local_only Space 调用云端 Provider。
7. 不得让 AI 自动覆盖用户编辑过的 Page 或 Topic。
8. 不得在 Windows Bundle 升级前跳过备份。
9. 不得把 Draw.io / Excalidraw 内容强行进入 LLM Wiki 语义处理。
10. MVP 不允许不同 embedding dimension 进入同一实例；不同维度配置必须被拒绝。
```

---

## 27. 本版变更摘要

v1.1 相对 v1.0 新增：

```text
1. Windows 一键运行包 / Desktop Bundle。
2. M2 编辑器里程碑拆分为 M2A / M2B / M2C。
3. 编辑器扩展插件合同 EditorBlockExtension。
4. Embedding Profile 与维度迁移策略。
5. RAG 质量评测集。
6. AI 成本、节流与批量导入控制。
7. API Key 加密存储。
8. 完整备份与恢复。
9. 数据库 migration / 升级策略。
10. Topic 生命周期状态机。
11. 知识图谱证据卡片。
12. 内容可索引性矩阵。
13. Windows 子进程、端口、日志、升级前备份管理。
```

---

## 28. 最终产品验收标准

MVP 到 M8 完成后，用户必须可以：

```text
1. 通过 Docker Compose 启动系统。
2. 创建首个 Owner 账号。
3. 创建 Workspace / Space / Group。
4. 写富文本笔记，并插入图片、附件、Mermaid、KaTeX。
5. 使用自动保存、版本历史、冲突检测。
6. 搜索中文内容。
7. 使用 pgvector + RRF 混合检索。
8. 使用 RAG 问答并看到引用。
9. 让 AI 生成标签、摘要、实体、关联建议。
10. 接受建议创建 Topic。
11. 查看 Topic 来源与图谱证据卡片。
12. 导入 Markdown / HTML / ZIP。
13. 导出 Space ZIP。
14. 打印单页 PDF。
15. 创建公开只读分享链接。
16. 创建完整备份并恢复。
```

M9 完成后，普通 Windows 用户必须可以：

```text
1. 不安装 Docker。
2. 不安装 PostgreSQL。
3. 不安装 Node.js。
4. 下载并运行安装包。
5. 完成首次初始化。
6. 正常创建、编辑、搜索、RAG、备份。
```


---

# 附录 A：v1.2 完整需求与工程规格展开

> 本附录是 v1.2 的关键修正：上一版 v1.1 更像“评审建议整合版”，没有把所有新增项展开成可直接实现的工程规格。本附录将这些内容补成完整实现合同。AI 编程工具必须把主文档与本附录一起视为同一份需求，不得只实现摘要部分。

## A1. 产品边界与角色场景详述

### A1.1 目标用户

```text
Primary User：个人知识工作者
- 学生
- 研究者
- 产品经理
- 工程师
- 独立开发者
- 内容创作者
- 需要长期沉淀知识的普通用户

Secondary User：小团队
- 2-10 人项目组
- 课程小组
- 家庭/朋友共享知识库
- 非企业级协作团队
```

### A1.2 典型用户旅程

#### Journey 1：普通用户首次使用 Windows 版

```text
1. 用户下载 LLM-Wiki-Setup.exe。
2. 双击安装。
3. 安装完成后自动启动 LLM Wiki。
4. Launcher 检查本地数据目录。
5. 首次运行时自动初始化 PostgreSQL、pgvector、应用层中文分词、migrations。
6. 浏览器自动打开 http://127.0.0.1:<appPort>。
7. 用户创建首个账号，该账号成为 instance owner。
8. 系统自动创建默认 Workspace 和默认 Space。
9. 用户进入 Notes 视图，创建第一篇笔记。
10. 页面保存后进入 LLM Inbox。
11. 后台任务生成摘要、标签、实体、相关页面建议。
12. 用户进入 LLM Wiki 视图查看建议。
```

验收标准：普通用户无需安装 Docker、Node.js、PostgreSQL，也无需命令行操作。

#### Journey 2：技术用户部署 Docker 版

```text
1. 用户复制 docker-compose.yml。
2. 设置 APP_SECRET、POSTGRES_PASSWORD、LLM Provider 环境变量。
3. 执行 docker compose up -d。
4. app 容器等待 db 健康检查通过。
5. app 启动 migration。
6. 用户访问 Web UI 创建首个 owner。
7. 后续通过 Web UI 配置 Workspace AI Provider。
```

验收标准：技术用户能在 NAS、云服务器、本地 Docker Desktop 中部署。

#### Journey 3：传统笔记 + LLM Wiki

```text
1. 用户在 Notes 视图中按自己的习惯创建 Space 与页面树。
2. 用户写课程笔记，插入 Mermaid、KaTeX、图片、附件。
3. 页面保存后，text_content 被提取。
4. Job Runner 生成 page_ai_profile、document_chunks、suggestions。
5. LLM Wiki 的 Inbox 显示待处理页面。
6. 用户在 Review Center 批量接受低/中风险建议。
7. 系统生成 Topic 草稿。
8. 用户确认 Topic，并手动编辑 Topic 正文。
9. Topic 进入知识图谱，可用于 RAG 问答。
```

验收标准：原始 Page 不被 AI 移动、删除、重写；Topic 与 Page 关系可追溯。

#### Journey 4：严格引用 RAG 问答

```text
1. 用户在当前 Space 中询问一个问题。
2. 系统执行权限过滤。
3. 系统执行 应用层中文分词全文检索。
4. 系统执行 pgvector 向量检索。
5. 系统用 RRF 融合结果。
6. 系统构建上下文。
7. LLM 只能基于上下文回答。
8. 答案附带 citations。
9. 用户点击 citation 打开来源 Page / Topic / chunk excerpt。
10. 如果没有足够上下文，系统回答“知识库中未找到相关信息”。
```

验收标准：RAG 不泄露无权限内容，不伪造引用。

---

# 附录 B：详细数据模型与 DDL

> DDL 是 AI 编程工具实现数据库 schema 的核心合同。Drizzle schema 可以与此 DDL 等价，但不得删减字段语义。所有表必须包含 `created_at`、`updated_at`；软删除表必须包含 `deleted_at`。

## B1. users

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  avatar_url TEXT,
  instance_role TEXT NOT NULL DEFAULT 'user', -- owner | user
  is_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

约束：

```text
- 首个注册用户 instance_role = owner。
- 后续用户 instance_role = user。
- is_disabled=true 时禁止登录。
```

## B2. sessions

```sql
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  user_agent TEXT,
  ip_address TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
```

## B3. workspaces

```sql
CREATE TABLE workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  default_ai_config_id UUID,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);
```

## B4. workspace_members

```sql
CREATE TABLE workspace_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','admin','member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, user_id)
);
```

## B5. groups 与 group_members

```sql
CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(workspace_id, name)
);

CREATE TABLE group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(group_id, user_id)
);
```

## B6. spaces

```sql
CREATE TABLE spaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  ai_privacy_policy TEXT NOT NULL DEFAULT 'inherit_workspace'
    CHECK (ai_privacy_policy IN ('inherit_workspace','cloud_allowed','local_only','disabled')),
  llm_update_policy TEXT NOT NULL DEFAULT 'balanced'
    CHECK (llm_update_policy IN ('conservative','balanced','aggressive')),
  auto_llm_processing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(workspace_id, slug)
);
```

## B7. space_members 与 group_space_roles

```sql
CREATE TABLE space_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','writer','reader')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(space_id, user_id)
);

CREATE TABLE group_space_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('admin','writer','reader')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(space_id, group_id)
);
```

## B8. pages

```sql
CREATE TABLE pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  parent_page_id UUID REFERENCES pages(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT 'Untitled',
  slug TEXT NOT NULL,
  icon TEXT,
  position TEXT NOT NULL,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  text_content TEXT NOT NULL DEFAULT '',
  content_markdown TEXT,
  content_version INT NOT NULL DEFAULT 1,
  page_status TEXT NOT NULL DEFAULT 'normal'
    CHECK (page_status IN ('normal','archived','deleted')),
  llm_process_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (llm_process_status IN ('pending','processing','processed','failed','ignored')),
  llm_dirty_reason TEXT,
  llm_processed_at TIMESTAMPTZ,
  llm_error_message TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  UNIQUE(space_id, slug)
);

CREATE INDEX idx_pages_workspace_space ON pages(workspace_id, space_id);
CREATE INDEX idx_pages_parent ON pages(parent_page_id);
CREATE INDEX idx_pages_llm_status ON pages(space_id, llm_process_status);
CREATE INDEX idx_pages_text_fts ON pages USING GIN (to_tsvector('simple', search_text));
```

实现要求：

```text
- content_json 是编辑器唯一事实源。
- text_content 是从 content_json 派生的纯文本缓存。
- content_version 每次成功保存递增。
- 保存 API 必须携带 expected_content_version。
- 版本不匹配时返回 409 conflict。
```

## B9. page_revisions

```sql
CREATE TABLE page_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  content_version INT NOT NULL,
  title TEXT NOT NULL,
  content_json JSONB NOT NULL,
  text_content TEXT NOT NULL,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(page_id, content_version)
);
```

版本策略：

```text
- 每次显式保存或自动保存达到 debounce 条件时可生成 revision。
- 对连续自动保存可做压缩，例如 5 分钟内只保留最后一个自动保存 revision。
- 用户手动命名版本时必须保留。
```

## B10. attachments

```sql
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  uploader_id UUID REFERENCES users(id),
  file_name TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  storage_driver TEXT NOT NULL CHECK (storage_driver IN ('local','s3')),
  storage_key TEXT NOT NULL,
  checksum_sha256 TEXT,
  width INT,
  height INT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX idx_attachments_page ON attachments(page_id);
CREATE INDEX idx_attachments_workspace ON attachments(workspace_id);
```

## B11. ai_configs 与密钥加密（v1.3 唯一方案）

```sql
CREATE TABLE ai_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace','user')),
  scope_id UUID NOT NULL,
  provider TEXT NOT NULL,
  base_url TEXT,
  completion_model TEXT,
  embedding_model TEXT,
  encrypted_api_key TEXT,
  api_key_masked TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(scope_type, scope_id, provider)
);

CREATE INDEX idx_ai_configs_scope ON ai_configs(scope_type, scope_id);
```

密钥加密规则：

```text
- 只使用 ai_configs.encrypted_api_key。
- 不创建 encrypted_secrets 表。
- encrypted_api_key 使用 APP_SECRET 派生密钥加密。
- 算法：AES-256-GCM。
- 格式：base64url(iv).base64url(ciphertext).base64url(authTag)。
- UI 只显示 api_key_masked。
- API 永不返回明文 API Key。
- 备份默认不包含 encrypted_api_key。
```

## B12. app_settings 与实例级 Embedding 锁定

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_settings(key, value) VALUES
('embedding.active', '{
  "provider": "openai-compatible",
  "model": "text-embedding-3-small",
  "dimension": 1536,
  "locked": true
}'::jsonb);
```

规则：

```text
- MVP 只允许实例级单一 embedding dimension。
- 不允许 Workspace 级不同维度。
- document_chunks.embedding 的 vector(n) 必须与 app_settings.embedding.active.dimension 一致。
- 不同维度切换属于 v2。
```

## B13. document_chunks

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  topic_id UUID,
  chunk_index INT NOT NULL,

  -- 原始文本，用于显示、RAG 引用和 prompt context
  content TEXT NOT NULL,

  -- 应用层中文分词后的文本，例如 "员工 手册 请假 流程"。
  -- PostgreSQL simple config 基于空格 token 工作，避免依赖 zhparser。
  search_text TEXT NOT NULL,
  search_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', search_text)) STORED,

  heading TEXT,
  heading_level INT,
  token_count INT,

  -- MVP 固定全实例 1536 维。不得混入其他维度。
  embedding vector(1536),
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dimension INT NOT NULL DEFAULT 1536 CHECK (embedding_dimension = 1536),
  embedding_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (embedding_status IN ('pending','ready','failed','stale')),

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(page_id, chunk_index)
);

CREATE INDEX idx_document_chunks_scope ON document_chunks(workspace_id, space_id);
CREATE INDEX idx_document_chunks_page ON document_chunks(page_id);
CREATE INDEX idx_document_chunks_topic ON document_chunks(topic_id);
CREATE INDEX idx_document_chunks_search_tsv ON document_chunks USING GIN (search_tsv);
CREATE INDEX idx_document_chunks_embedding_hnsw ON document_chunks USING hnsw (embedding vector_cosine_ops);
```

查询规则：

```text
- 关键词查询先经同一个 ChineseTokenizer 分词，得到 tokenized_query。
- BM25/ts_rank 使用 plainto_tsquery('simple', tokenized_query)。
- 向量查询使用 document_chunks.embedding。
- RRF 融合全文结果和向量结果。
```

## B14. page_ai_profiles

```sql
CREATE TABLE page_ai_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id UUID NOT NULL UNIQUE REFERENCES pages(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  summary TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  keywords TEXT[] NOT NULL DEFAULT '{}',
  entities JSONB NOT NULL DEFAULT '[]'::jsonb,
  suggested_topic_titles TEXT[] NOT NULL DEFAULT '{}',
  suggested_related_page_ids UUID[] NOT NULL DEFAULT '{}',
  prompt_version TEXT,
  model TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## B15. wiki_topics

```sql
CREATE TABLE wiki_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  content_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  text_content TEXT NOT NULL DEFAULT '',
  ai_summary TEXT,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested','accepted','user_edited','stale','archived')),
  source TEXT NOT NULL DEFAULT 'ai_generated'
    CHECK (source IN ('ai_generated','user_created','mixed')),
  update_policy TEXT NOT NULL DEFAULT 'suggest_only'
    CHECK (update_policy IN ('suggest_only','auto_update_ai_fields')),
  ai_version TEXT,
  user_edited_at TIMESTAMPTZ,
  last_ai_refresh_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ,
  UNIQUE(space_id, slug)
);

CREATE INDEX idx_wiki_topics_scope ON wiki_topics(workspace_id, space_id);
CREATE INDEX idx_wiki_topics_status ON wiki_topics(space_id, status);
```

Topic 生命周期：

```text
suggested：AI 生成草稿，用户尚未接受。
accepted：用户确认成为正式 Topic。
user_edited：用户手动编辑过正文或结构。
stale：来源 Page 更新后，Topic 可能过期，需要刷新建议。
archived：用户归档，不再默认显示。
```

## B16. topic_sources

```sql
CREATE TABLE topic_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  topic_id UUID NOT NULL REFERENCES wiki_topics(id) ON DELETE CASCADE,
  page_id UUID REFERENCES pages(id) ON DELETE CASCADE,
  chunk_id UUID REFERENCES document_chunks(id) ON DELETE SET NULL,
  source_type TEXT NOT NULL DEFAULT 'page'
    CHECK (source_type IN ('page','chunk','manual')),
  relevance_score NUMERIC,
  evidence_excerpt TEXT,
  added_by TEXT NOT NULL DEFAULT 'ai'
    CHECK (added_by IN ('ai','user')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(topic_id, page_id, chunk_id)
);
```

## B17. llm_suggestions

```sql
CREATE TABLE llm_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  suggestion_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','accepted','rejected','ignored','auto_applied')),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  confidence NUMERIC,
  generated_by_job_id UUID,
  accepted_by UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_suggestions_review ON llm_suggestions(space_id, status, risk_level);
```

## B18. entities

```sql
CREATE TABLE entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(space_id, normalized_name, entity_type)
);
```

## B19. knowledge_edges

```sql
CREATE TABLE knowledge_edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('page','topic','entity','tag')),
  source_id UUID NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('page','topic','entity','tag')),
  target_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  confidence NUMERIC,
  status TEXT NOT NULL DEFAULT 'suggested'
    CHECK (status IN ('suggested','accepted','rejected','auto_applied')),
  evidence JSONB NOT NULL DEFAULT '[]'::jsonb,
  generated_by TEXT NOT NULL DEFAULT 'ai'
    CHECK (generated_by IN ('ai','user','system')),
  prompt_version TEXT,
  model TEXT,
  confirmed_by UUID REFERENCES users(id),
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Graph View 常用：按当前 Space 和状态过滤
CREATE INDEX idx_knowledge_edges_scope_status
  ON knowledge_edges(workspace_id, space_id, status);

-- 从某节点展开一跳邻居
CREATE INDEX idx_knowledge_edges_source_lookup
  ON knowledge_edges(workspace_id, space_id, source_type, source_id, status);

-- 查询指向某节点的反向关系
CREATE INDEX idx_knowledge_edges_target_lookup
  ON knowledge_edges(workspace_id, space_id, target_type, target_id, status);

-- 按关系类型过滤，例如 related_to / depends_on / summarizes
CREATE INDEX idx_knowledge_edges_relation_lookup
  ON knowledge_edges(workspace_id, space_id, relation_type, status);

-- 防止同一 Space 中重复创建同一条同类型边
CREATE UNIQUE INDEX idx_knowledge_edges_unique_active
  ON knowledge_edges(workspace_id, space_id, source_type, source_id, target_type, target_id, relation_type)
  WHERE status IN ('suggested','accepted','auto_applied');

-- 证据卡片需要按 evidence JSON 查询时使用
CREATE INDEX idx_knowledge_edges_evidence_gin
  ON knowledge_edges USING GIN (evidence jsonb_path_ops);
```

查询要求：

```text
- Graph View 读取某节点邻居必须走 source_lookup / target_lookup。
- Review Center 按 Space + status 读取建议必须走 scope_status。
- Evidence Card 展开证据时不得全表扫描。
- 10k 页面、100k edges 下，一跳展开应在 300ms 内完成。
```

证据格式：证据格式：

```json
[
  {
    "sourcePageId": "uuid",
    "sourceChunkId": "uuid",
    "excerpt": "支持该关系的原文片段",
    "reason": "为什么这段证据支持该关系",
    "confidence": 0.82
  }
]
```

## B20. jobs

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  space_id UUID REFERENCES spaces(id) ON DELETE CASCADE,
  entity_type TEXT,
  entity_id UUID,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  priority INT NOT NULL DEFAULT 100,
  run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  max_attempts INT NOT NULL DEFAULT 3,
  locked_by TEXT,
  locked_at TIMESTAMPTZ,
  error_message TEXT,
  cost_estimate_tokens INT,
  actual_prompt_tokens INT,
  actual_completion_tokens INT,
  provider_request_id TEXT,
  rate_limited_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_pending ON jobs(status, run_after, priority);
CREATE INDEX idx_jobs_entity ON jobs(entity_type, entity_id, type);
CREATE INDEX idx_jobs_space ON jobs(space_id, status);
```

Job 抢占 SQL：

```sql
WITH picked AS (
  SELECT id FROM jobs
  WHERE status = 'pending'
    AND run_after <= now()
  ORDER BY priority ASC, created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs
SET status = 'running', locked_by = $1, locked_at = now(), attempts = attempts + 1
WHERE id IN (SELECT id FROM picked)
RETURNING *;
```

## B21. shares

```sql
CREATE TABLE shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('page','topic')),
  target_id UUID NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  share_mode TEXT NOT NULL DEFAULT 'live' CHECK (share_mode IN ('live','snapshot')),
  snapshot_title TEXT,
  snapshot_content_json JSONB,
  snapshot_text_content TEXT,
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at TIMESTAMPTZ
);
```

MVP 可以只实现 live，但表结构预留 snapshot。

## B22. backups

```sql
CREATE TABLE backups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by UUID REFERENCES users(id),
  backup_type TEXT NOT NULL CHECK (backup_type IN ('manual','auto','pre_migration')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','failed')),
  storage_key TEXT,
  size_bytes BIGINT,
  include_secrets BOOLEAN NOT NULL DEFAULT FALSE,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
```

---

# 附录 C：API 契约详述

所有 API 返回 JSON，除 SSE 外统一错误格式：

```json
{
  "error": {
    "code": "PAGE_NOT_FOUND",
    "message": "Page not found",
    "details": {}
  }
}
```

## C1. Auth API

### POST /api/auth/bootstrap

用途：检查是否已有用户。

Response:

```json
{
  "needsInitialOwner": true,
  "allowSignup": false
}
```

### POST /api/auth/register-initial-owner

仅当系统无用户时可用。

Request:

```json
{
  "email": "user@example.com",
  "password": "strong-password",
  "displayName": "Mason"
}
```

Response:

```json
{
  "user": {"id":"uuid","email":"user@example.com","displayName":"Mason"},
  "defaultWorkspaceId": "uuid"
}
```

### POST /api/auth/login

Request:

```json
{"email":"user@example.com","password":"strong-password"}
```

Response:

```json
{"user":{"id":"uuid","email":"user@example.com","displayName":"Mason"}}
```

Cookie：

```text
Set-Cookie: session=...; HttpOnly; SameSite=Lax; Path=/
```

### POST /api/auth/logout

撤销当前 session。

## C2. Workspace API

```text
GET    /api/workspaces
POST   /api/workspaces
GET    /api/workspaces/:workspaceId
PATCH  /api/workspaces/:workspaceId
DELETE /api/workspaces/:workspaceId
```

创建 Workspace Request：

```json
{
  "name": "个人知识库",
  "slug": "personal"
}
```

权限：

```text
- instance owner 可创建 Workspace。
- workspace owner/admin 可修改 Workspace。
```

## C3. Space API

```text
GET    /api/workspaces/:workspaceId/spaces
POST   /api/workspaces/:workspaceId/spaces
GET    /api/spaces/:spaceId
PATCH  /api/spaces/:spaceId
DELETE /api/spaces/:spaceId
```

Space 设置 Request：

```json
{
  "name": "AI 学习",
  "aiPrivacyPolicy": "local_only",
  "llmUpdatePolicy": "balanced",
  "autoLlmProcessingEnabled": true
}
```

## C4. Group 与权限 API

```text
GET    /api/workspaces/:workspaceId/groups
POST   /api/workspaces/:workspaceId/groups
PATCH  /api/groups/:groupId
DELETE /api/groups/:groupId
POST   /api/groups/:groupId/members
DELETE /api/groups/:groupId/members/:userId
POST   /api/spaces/:spaceId/members
PATCH  /api/spaces/:spaceId/members/:userId
DELETE /api/spaces/:spaceId/members/:userId
POST   /api/spaces/:spaceId/group-roles
```

权限：workspace owner/admin 管理 group；space admin 管理 space member。

## C5. Page API

```text
GET    /api/spaces/:spaceId/pages/tree
POST   /api/spaces/:spaceId/pages
GET    /api/pages/:pageId
PATCH  /api/pages/:pageId
DELETE /api/pages/:pageId
POST   /api/pages/:pageId/restore
GET    /api/pages/:pageId/revisions
GET    /api/pages/:pageId/revisions/:revisionId
POST   /api/pages/:pageId/revisions/:revisionId/restore
```

创建 Page：

```json
{
  "parentPageId": null,
  "title": "第一篇笔记",
  "contentJson": {"type":"doc","content":[{"type":"paragraph"}]},
  "position": "a0"
}
```

更新 Page：

```json
{
  "title": "更新后的标题",
  "contentJson": {"type":"doc","content":[]},
  "expectedContentVersion": 12
}
```

成功 Response：

```json
{
  "page": {
    "id": "uuid",
    "contentVersion": 13,
    "llmProcessStatus": "pending"
  }
}
```

冲突 Response：HTTP 409

```json
{
  "error": {
    "code": "PAGE_VERSION_CONFLICT",
    "message": "Page has been modified by another session",
    "details": {"currentContentVersion": 14}
  }
}
```

## C6. Editor Draft API

MVP 草稿默认存在浏览器 localStorage / IndexedDB，不需要后端 Draft API。后端只处理正式保存。

本地草稿 key：

```text
llmwiki:draft:{userId}:{pageId}:{contentVersion}
```

打开页面时：

```text
- 如果本地 draft 存在且比服务端 version 新，提示恢复。
- 如果恢复草稿后服务端 version 已变化，进入冲突解决界面。
```

## C7. Attachment API

```text
POST /api/files/upload
GET  /api/files/:attachmentId/:fileName
POST /api/files/info
DELETE /api/files/:attachmentId
```

Upload multipart fields：

```text
file: binary
pageId: uuid
attachmentId: optional uuid，用于覆盖 Draw.io / Excalidraw 保存结果
```

权限：

```text
- 上传需要 canEditPage。
- 下载需要 canViewPage。
- 分享页下载只允许该分享页面显式引用的附件。
```

## C8. Search API

### POST /api/search

Request：

```json
{
  "query": "中文关键词",
  "workspaceId": "uuid",
  "spaceId": "uuid-optional",
  "mode": "hybrid",
  "limit": 20
}
```

mode：

```text
keyword：只走 应用层中文分词 全文搜索
vector：只走向量搜索
hybrid：RRF 融合
```

Response：

```json
{
  "items": [
    {
      "type": "page",
      "id": "uuid",
      "title": "页面标题",
      "excerpt": "...",
      "score": 0.123,
      "source": "both"
    }
  ]
}
```

## C9. RAG API

### POST /api/rag/ask

SSE endpoint。

Request：

```json
{
  "query": "这门课的考试重点是什么？",
  "scope": {
    "type": "space",
    "spaceId": "uuid"
  },
  "mode": "strict_citation",
  "history": []
}
```

SSE events：

```text
event: sources
data: {"sources":[...]}

event: token
data: {"content":"根据"}

event: done
data: {"citations":[...]}
```

无结果：

```text
event: done
data: {"content":"知识库中未找到相关信息。","citations":[]}
```

扩展思考模式：

```json
{"mode":"extended_reasoning"}
```

规则：

```text
- strict_citation：只基于 context。
- extended_reasoning：先回答有引用部分，再显示“模型基于通用知识的补充”。
```

## C10. LLM Wiki API

```text
GET  /api/spaces/:spaceId/llm-inbox
POST /api/pages/:pageId/llm/reprocess
POST /api/spaces/:spaceId/llm/pause
POST /api/spaces/:spaceId/llm/resume
GET  /api/spaces/:spaceId/suggestions
POST /api/suggestions/:suggestionId/accept
POST /api/suggestions/:suggestionId/reject
POST /api/suggestions/bulk-accept
POST /api/suggestions/bulk-ignore
```

Bulk Accept Request：

```json
{
  "spaceId": "uuid",
  "riskLevels": ["low", "medium"],
  "suggestionTypes": ["tag", "entity", "related_page"],
  "ids": ["uuid1", "uuid2"]
}
```

## C11. Topic API

```text
GET    /api/spaces/:spaceId/topics
POST   /api/spaces/:spaceId/topics
GET    /api/topics/:topicId
PATCH  /api/topics/:topicId
DELETE /api/topics/:topicId
POST   /api/topics/:topicId/accept
POST   /api/topics/:topicId/refresh-suggestions
GET    /api/topics/:topicId/sources
POST   /api/topics/:topicId/sources
DELETE /api/topics/:topicId/sources/:sourceId
```

## C12. Graph API

```text
GET  /api/graph/around-page/:pageId
GET  /api/graph/around-topic/:topicId
GET  /api/graph/around-entity/:entityId
GET  /api/spaces/:spaceId/graph
POST /api/graph/edges/:edgeId/accept
POST /api/graph/edges/:edgeId/reject
PATCH /api/graph/edges/:edgeId
```

Graph response：

```json
{
  "nodes": [
    {"id":"uuid","type":"page","label":"标题"}
  ],
  "edges": [
    {
      "id":"uuid",
      "source":"uuid",
      "target":"uuid",
      "relationType":"related_to",
      "confidence":0.82,
      "status":"suggested",
      "evidence":[{"excerpt":"..."}]
    }
  ]
}
```

## C13. AI Config API

```text
GET   /api/workspaces/:workspaceId/ai-config
PATCH /api/workspaces/:workspaceId/ai-config
GET   /api/me/ai-config
PATCH /api/me/ai-config
POST  /api/ai-config/test
```

更新 key Request：

```json
{
  "provider": "openai-compatible",
  "baseUrl": "https://api.example.com/v1",
  "completionModel": "gpt-4.1-mini",
  "embeddingModel": "text-embedding-3-small",
  "embeddingDimension": 1536,
  "apiKey": "sk-..."
}
```

Response 不返回 `apiKey`，只返回：

```json
{"apiKeyMasked":"sk-****abcd"}
```

## C14. Import / Export / Print API

```text
POST /api/import/markdown
POST /api/import/html
POST /api/import/zip
POST /api/export/page/:pageId
POST /api/export/space/:spaceId
```

PDF 打印不需要服务端 API：前端进入 print route 并调用 `window.print()`。

## C15. Share API

```text
POST   /api/shares
GET    /api/public/shares/:shareToken
DELETE /api/shares/:shareId
POST   /api/shares/:shareId/regenerate-token
```

Create share：

```json
{
  "targetType": "page",
  "targetId": "uuid",
  "shareMode": "live"
}
```

---

# 附录 D：编辑器架构完整合同

## D1. 编辑器分层

```text
Editor Shell:
- 页面加载
- 自动保存
- 冲突检测
- 本地草稿恢复
- 版本历史

Editor Core:
- Tiptap / ProseMirror 初始化
- schema / extensions 注册
- command palette
- slash menu

Editor Extensions:
- 基础块
- 媒体块
- 高级创作块
- 内部链接块
- AI 操作块

Editor Integrations:
- Attachment upload
- Print renderer
- Export renderer
- text_content extractor
- LLM indexability matrix
```

## D2. EditorBlockExtension 合同

```ts
export interface EditorBlockExtension {
  name: string;
  nodeType: string;
  displayName: string;
  category: 'basic' | 'media' | 'diagram' | 'embed' | 'ai' | 'structure';
  insertCommand: string;
  isEnabledByDefault: boolean;
  isIndexableByLlm: boolean;
  isPrintable: boolean;
  isExportable: boolean;

  toTextContent(node: unknown): string;
  toMarkdown?: (node: unknown, ctx: ExportContext) => string;
  toHtml?: (node: unknown, ctx: ExportContext) => string;
  getAttachments?: (node: unknown) => AttachmentRef[];
  getExternalUrls?: (node: unknown) => string[];

  editableRenderer: React.ComponentType<any>;
  readonlyRenderer: React.ComponentType<any>;
  printRenderer?: React.ComponentType<any>;

  validateAttrs?: (attrs: unknown) => ValidationResult;
  migrateAttrs?: (attrs: unknown, fromVersion: number, toVersion: number) => unknown;
}
```

## D3. 基础块 MVP

```text
- paragraph
- heading h1/h2/h3
- bullet list
- ordered list
- task list
- blockquote
- code block
- inline code
- divider
- table
- callout
- toggle
- columns
- subpages
- status
- date
```

## D4. 媒体与附件块

```text
- image
- video
- audio
- pdf
- attachment
```

要求：

```text
- 所有媒体块必须通过 attachments 表管理。
- 节点 attrs 中只保存 attachmentId、src、fileName、mime、size、width、height。
- src 必须是受权限保护的 /api/files/... URL。
- 导出 ZIP 时替换为相对路径。
- 打印时图片直接渲染，视频/音频/PDF 显示链接或预览卡片。
```

## D5. Draw.io

MVP 行为：

```text
- 用户插入 Draw.io 块。
- 前端打开 diagrams.net embed 或配置的 DRAWIO_URL。
- 保存时导出 xmlsvg。
- 上传为 attachment。
- 节点保存 attachmentId、src、title、width、height。
- 页面 readonly 和 print 渲染 SVG。
- LLM Wiki 不解析图形内容，只索引 title / metadata。
```

失败处理：

```text
- DRAWIO_URL 无法访问时显示错误卡片。
- 保存失败时保留本地未保存提示。
- attachment 覆盖保存失败时不能更新节点 src。
```

## D6. Excalidraw

MVP 行为：

```text
- 用户插入 Excalidraw 块。
- 打开 Excalidraw 编辑器。
- 保存时导出 SVG，同时可在 metadata 中保存 excalidraw JSON。
- 上传为 attachment。
- readonly / print 渲染 SVG。
- LLM Wiki 不解析图形语义。
```

## D7. Mermaid

MVP 行为：

```text
- 使用 code block language=mermaid。
- 编辑态显示源码 + 预览。
- readonly 和 print 显示渲染图。
- Mermaid 源码可以进入 text_content，但默认只作为普通文本，不做图语义理解。
```

## D8. KaTeX

MVP 行为：

```text
- 支持 inline math。
- 支持 block math。
- readonly 和 print 渲染公式。
- 公式源码可进入 text_content。
```

## D9. Embed Provider

支持：

```text
- YouTube
- Figma
- Miro
- Loom
- Airtable
- Typeform
- Vimeo
- Google Drive
- Google Sheets
- 通用 iframe
```

安全要求：

```text
- URL 必须 sanitize。
- iframe 必须设置 sandbox。
- 不抓取外部网页正文。
- LLM Wiki 只记录 provider、url、title。
```

## D10. AI 编辑器操作

选中文本后可执行：

```text
- 润色
- 修正拼写语法
- 变短
- 扩写
- 简化
- 改变语气
- 总结
- 解释
- 续写
- 翻译
- 自定义 prompt
```

规则：

```text
- AI 生成结果默认以 suggestion 形式展示。
- 用户可选择替换选区、插入到下方、复制。
- 不得自动覆盖用户内容。
```

---

# 附录 E：内容可索引性矩阵

| 内容类型 | 进入传统全文搜索 | 进入向量索引 | 进入 LLM Wiki | 进入导出 | 进入打印 | 说明 |
|---|---|---|---|---|---|---|
| 标题 | 是 | 是 | 是 | 是 | 是 | 高权重 |
| 普通文本 | 是 | 是 | 是 | 是 | 是 | 主要知识来源 |
| 列表/待办 | 是 | 是 | 是 | 是 | 是 | 提取纯文本 |
| 表格 | 是 | 是 | 是 | 是 | 是 | 转成文本行 |
| Callout | 是 | 是 | 是 | 是 | 是 | 保留 callout 类型 metadata |
| Toggle | 是 | 是 | 是 | 是 | 默认展开 | 隐藏内容也索引 |
| Columns | 是 | 是 | 是 | 是 | 是 | 按列顺序提取 |
| 内部链接 | 是 | 是 | 是 | 是 | 是 | 作为 graph signal |
| 标签 | 是 | 是 | 是 | 是 | 是 | 高权重 |
| Mermaid 源码 | 是 | 可选 | 可选 | 是 | 渲染图 | 默认作为代码文本 |
| KaTeX 源码 | 是 | 可选 | 可选 | 是 | 渲染公式 | 默认作为公式文本 |
| Draw.io | metadata | 否 | 否 | SVG/附件 | SVG | 不解析图形语义 |
| Excalidraw | metadata | 否 | 否 | SVG/附件 | SVG | 不解析图形语义 |
| 图片 | metadata | 否 | 否 | 附件 | 图片 | OCR v2 |
| PDF | metadata | 否 | 否 | 附件 | 预览/链接 | PDF 解析 v2 |
| 视频 | metadata | 否 | 否 | 附件 | 链接 | 转录 v2 |
| 音频 | metadata | 否 | 否 | 附件 | 链接 | 转录 v2 |
| iframe Embed | URL/provider/title | 否 | 否 | 链接卡片 | 占位卡片 | 不抓外部内容 |

实现要求：

```text
- text_content extractor 必须按此矩阵实现。
- 每种 EditorBlockExtension 必须声明 isIndexableByLlm。
- LLM Wiki pipeline 只能消费允许进入 LLM Wiki 的内容。
```

---

# 附录 F：LLM Wiki Pipeline 详细设计

## F1. 页面保存后的事件链

```text
Page Save Success
  ↓
extractTextContent(content_json)
  ↓
update pages.text_content
  ↓
content_version += 1
  ↓
llm_process_status = pending
  ↓
enqueue page.process_llm job with debounce 30-60s
```

## F2. page.process_llm Job

步骤：

```text
1. 检查 page 是否存在、未删除、Space AI 未 disabled。
2. 检查 Space AI privacy policy。
3. 选择 Provider：User override → Workspace config → env fallback。
4. 如果 local_only，验证 provider endpoint 是本地或可信私有地址。
5. 重新提取 text_content，确保最新。
6. chunking。
7. 生成 embeddings。
8. 写 document_chunks。
9. 生成 page_ai_profile。
10. 生成 suggestions：tags、entities、related pages、topic candidates、graph edges。
11. 按 Space llm_update_policy 自动应用低风险建议或写入 Review Center。
12. 更新 pages.llm_process_status = processed。
```

## F3. Chunking 策略

默认：

```text
maxChunkChars = 1200
chunkOverlapChars = 180
preferHeadingBoundary = true
minChunkChars = 200
```

规则：

```text
- 优先按 H1/H2/H3 切分。
- 保留 heading path metadata。
- 表格转成 markdown-like 文本。
- 代码块如果超过阈值可单独成 chunk。
- 附件块只写 metadata，不生成正文 chunk。
```

chunk metadata：

```json
{
  "title": "页面标题",
  "headingPath": ["第一章", "关键概念"],
  "blockTypes": ["paragraph", "table"],
  "contentVersion": 13
}
```

## F4. Suggestion 风险分类

低风险：

```text
- 新增 LLM 标签
- 更新页面摘要
- 更新关键词
- 新增 entity mentions
- 更新 related page 排序
- mentions / related_to graph edge
```

中风险：

```text
- 创建 Topic 草稿
- 给 Topic 增加来源 Page
- 新增 depends_on / part_of / expands 等强关系
- 更新 Topic AI 摘要区块
```

高风险：

```text
- 合并 Topic
- 标记重复页面
- 从 Topic 移除来源
- 覆盖用户编辑过的 Topic 正文
- 移动 Page
- 删除 Page / Topic / Edge
```

应用策略：

```text
conservative：全部进入确认。
balanced：低风险自动应用，中风险批量确认，高风险单独确认。
aggressive：低/部分中风险自动应用，高风险单独确认。
```

## F5. Topic 生命周期

```text
suggested
  → accepted：用户确认
  → user_edited：用户修改正文/标题/来源
  → stale：来源 Page 更新
  → accepted/user_edited：用户接受刷新建议
  → archived：用户归档
```

规则：

```text
- 当 topic_sources 中任一 Page content_version 变化，Topic 标记 stale。
- stale Topic 不自动改写，只生成 refresh suggestion。
- user_edited Topic 的正文不得被自动覆盖。
- auto_update_ai_fields 只允许更新 ai_summary、suggested links、entity list，不更新 content_json。
```

---

# 附录 G：搜索、RAG 与质量评测

## G1. 混合检索流程

```text
Input query
  ↓
权限过滤：可访问 workspace/space/page/topic/chunk
  ↓
BM25 / ts_rank with 应用层中文分词
  ↓
Vector search with pgvector cosine distance
  ↓
RRF fusion
  ↓
Deduplicate by page/chunk
  ↓
Return topK with source metadata
```

RRF：

```text
score = Σ weight_i / (k + rank_i)
k = 60
bm25Weight = 0.45
vectorWeight = 0.55
```

## G2. RAG Prompt 合同

System Prompt 必须包含：

```text
你是用户个人知识库的问答助手。
你只能根据提供的知识库上下文回答。
如果上下文中没有足够信息，回答：“知识库中未找到相关信息。”
不要编造引用。
每个关键结论都必须附带引用编号。
引用编号必须来自提供的 sources。
```

扩展思考模式必须分区显示：

```text
## 知识库中可确认的内容
...

## 基于通用知识的补充
...
```

## G3. Citation 数据结构

```ts
interface Citation {
  sourceType: 'page' | 'topic' | 'chunk';
  pageId?: string;
  topicId?: string;
  chunkId?: string;
  title: string;
  excerpt: string;
  score: number;
  url: string;
}
```

## G4. RAG Evaluation Set

测试集目录：

```text
tests/fixtures/rag-eval/
  corpus/
    pages.json
    topics.json
  questions.json
  expected.json
```

questions.json 示例：

```json
[
  {
    "id": "cn_keyword_001",
    "type": "chinese_keyword",
    "question": "员工手册里关于请假的规定是什么？",
    "expectedSourcePageIds": ["page-employee-handbook"],
    "mustContain": ["请假", "审批"],
    "noAnswer": false
  },
  {
    "id": "no_answer_001",
    "type": "no_answer",
    "question": "我的知识库里有没有火星移民计划预算？",
    "expectedSourcePageIds": [],
    "mustContain": ["知识库中未找到相关信息"],
    "noAnswer": true
  }
]
```

指标：

```text
retrieval_recall_at_5 >= 0.85
citation_precision >= 0.95
no_answer_accuracy >= 0.95
permission_leakage_rate = 0
answer_groundedness >= 0.90
chinese_keyword_hit_rate >= 0.90
```

Mock 评测：

```text
- 自动化测试默认使用 Mock LLM。
- Mock LLM 根据 context 生成确定性回答。
- 真实 Provider 只用于手动 smoke test。
```

---

# 附录 H：AI 成本、节流与隐私策略

## H1. AI Budget 表示法

Workspace settings：

```json
{
  "aiBudget": {
    "monthlyTokenLimit": 1000000,
    "dailyJobLimitPerSpace": 500,
    "maxConcurrentJobs": 3,
    "embeddingBatchSize": 16,
    "importAutoProcess": "ask"
  }
}
```

## H2. Job Rate Limit

规则：

```text
- 单个 Space 同时运行 LLM jobs <= 2。
- 单个 Workspace 同时运行 LLM jobs <= 5。
- 用户手动“立即整理”优先级高于导入批处理。
- ZIP 导入产生的页面默认低优先级。
- 大批量导入后弹窗询问：立即整理 / 稍后整理 / 仅索引全文。
```

## H3. Token 计量

每次 Provider 调用记录：

```text
- provider
- model
- prompt_tokens
- completion_tokens
- total_tokens
- estimated_cost
- job_id
- user_id
- workspace_id
- space_id
```

可选表：

```sql
CREATE TABLE ai_usage_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL,
  space_id UUID,
  user_id UUID,
  job_id UUID,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  operation TEXT NOT NULL,
  prompt_tokens INT,
  completion_tokens INT,
  total_tokens INT,
  estimated_cost NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## H4. Space AI Privacy Policy

```text
inherit_workspace：继承 Workspace 默认配置。
cloud_allowed：允许云端 Provider。
local_only：仅允许本地 Provider。
disabled：禁用 LLM Wiki 自动处理和 RAG。
```

local_only endpoint 判定：

```text
允许：
- localhost
- 127.0.0.1
- ::1
- 可配置允许的私有网段，例如 10.0.0.0/8、172.16.0.0/12、192.168.0.0/16

默认禁止：
- 公网 HTTPS endpoint
- 未标记 trusted_local 的域名
```

要求：

```text
local_only 同时约束 completion 和 embedding。
如果 completion 是本地但 embedding 是云端，也必须拒绝。
```

---

# 附录 I：Windows 一键运行包详细设计

## I1. 目标

```text
普通 Windows 用户无需 Docker、Node.js、PostgreSQL、命令行。
下载安装包后直接运行。
```

## I2. 目录结构

```text
%LOCALAPPDATA%\LLM-Wiki\
  app\
    llm-wiki.exe
    server\
    web\
  postgres\
    bin\
    lib\
    share\
    extensions\
  data\
    postgres\
    uploads\
    backups\
    logs\
    config.json
```

## I3. Launcher 启动流程

```text
1. acquireSingleInstanceLock()
2. ensureDataDirectories()
3. readOrCreateConfig()
4. findAvailablePorts()
5. ensurePostgresInitialized()
6. startPostgresSubprocess()
7. waitForPostgresReady()
8. runMigrations()
9. startAppServer()
10. waitForHealthCheck()
11. openBrowserOrDesktopWindow()
12. monitorChildProcesses()
```

## I4. 端口管理

默认：

```text
App: 127.0.0.1:39280
Postgres: 127.0.0.1:39281
```

如果端口被占用：

```text
- 在 39280-39380 范围内寻找可用端口。
- 写入 config.json。
- 下次启动优先使用 config 中端口。
```

## I5. config.json

```json
{
  "appPort": 39280,
  "postgresPort": 39281,
  "postgresPassword": "random-generated",
  "dataDir": "C:\\Users\\user\\AppData\\Local\\LLM-Wiki\\data",
  "createdAt": "2026-07-14T00:00:00Z",
  "version": 1
}
```

## I6. PostgreSQL 子进程管理

要求：

```text
- PostgreSQL 只监听 127.0.0.1。
- 使用随机密码。
- data directory 独立保存。
- app 退出时优雅停止 PostgreSQL。
- 崩溃后下次启动自动恢复。
- 日志写入 data/logs/postgres.log。
```

启动命令示意：

```text
postgres.exe -D <dataDir> -p <postgresPort> -h 127.0.0.1
```

首次初始化：

```text
initdb.exe -D <dataDir> -U llmwiki --encoding=UTF8 --locale=C
```

## I7. pgvector 与中文全文检索策略（v1.3 修正）

### I7.1 设计裁决

Windows 一键包的 MVP **不依赖数据库中文分词扩展**。

```text
MVP 默认：
- PostgreSQL 标准发行版
- pgvector
- 应用层 ChineseTokenizer
- PostgreSQL simple tsvector

MVP 不要求：
- zhparser DLL
- SCWS 词库编译
- Windows 版 PostgreSQL 中文分词扩展编译流水线
```

原因：数据库中文分词扩展会显著增加 Windows 一键包的编译、升级和排障成本。中文分词下沉到应用层后，Windows 包只需要标准 PostgreSQL + pgvector，部署可行性更高。

### I7.2 应用层分词流程

```text
页面保存 / Job 处理：
1. 从 content_json 提取 raw text_content。
2. ChineseTokenizer.segment(text_content) 得到 token list。
3. search_text = tokens.join(' ')。
4. 写入 pages.search_text 和 document_chunks.search_text。
5. PostgreSQL 使用 to_tsvector('simple', search_text) 建索引。

用户搜索：
1. ChineseTokenizer.segment(query) 得到 tokenized_query。
2. 使用 plainto_tsquery('simple', tokenized_query)。
3. 使用 ts_rank(search_tsv, query) 排序。
```

### I7.3 Tokenizer Adapter

```ts
interface ChineseTokenizer {
  name: string;
  segment(input: string): string[];
  normalizeToken(token: string): string;
}
```

实现要求：

```text
- Tokenizer 必须在 Windows Bundle 中可用。
- Tokenizer 失败时降级为字符 bigram/trigram fallback。
- 搜索写入和查询必须使用同一个 tokenizer。
- tokenizer version 必须写入 app_settings，便于未来重建 search_text。
```

### I7.4 可选 Spike：数据库中文分词扩展

如果后续仍希望支持数据库内中文分词，可以作为 v2 spike：

```text
目标：验证是否能稳定产出可分发的 Windows PostgreSQL 中文分词扩展二进制。
验收：
- clean Windows VM 可安装。
- CREATE EXTENSION 成功。
- 词库路径稳定。
- 自动升级不破坏扩展。
- 与 pgvector 同时工作。
```

该 spike 不阻塞 MVP。


## I8. 日志

```text
%LOCALAPPDATA%\LLM-Wiki\data\logs\launcher.log
%LOCALAPPDATA%\LLM-Wiki\data\logs\server.log
%LOCALAPPDATA%\LLM-Wiki\data\logs\postgres.log
%LOCALAPPDATA%\LLM-Wiki\data\logs\jobs.log
```

UI 提供：

```text
Settings → Diagnostics → Export Logs
```

## I9. 备份与升级

Windows 版启动迁移前：

```text
1. 检查当前 app version 与 db schema version。
2. 如果需要 migration，先创建 pre_migration backup。
3. backup 成功后执行 migration。
4. migration 失败则提示用户恢复备份。
```

## I10. Installer 与 Portable

```text
M9A：安装包模式
- Tauri/Electron + NSIS/MSI
- 写入开始菜单快捷方式
- 数据放 %LOCALAPPDATA%

M9B：Portable Zip
- 解压即用
- 数据默认放程序目录 data/
- 适合 U 盘和测试
```

---

# 附录 J：备份、恢复与升级策略

## J1. 备份范围

完整备份必须包含：

```text
- PostgreSQL 数据 dump
- uploads 附件目录
- app config，默认不含 secrets
- backup manifest
```

manifest 示例：

```json
{
  "appVersion": "1.2.0",
  "schemaVersion": 42,
  "createdAt": "2026-07-14T00:00:00Z",
  "includeSecrets": false,
  "files": [
    {"path":"database.dump","sha256":"..."},
    {"path":"uploads.zip","sha256":"..."}
  ]
}
```

## J2. 备份类型

```text
manual：用户手动创建。
auto：系统定期创建。
pre_migration：升级前自动创建。
```

## J3. 恢复流程

```text
1. 用户选择备份文件。
2. 系统校验 manifest 与 checksum。
3. 提示当前数据将被覆盖。
4. 停止 Job Runner。
5. 停止 App 写入。
6. 恢复 PostgreSQL dump。
7. 恢复 uploads。
8. 执行必要 migration。
9. 重启 App。
10. 执行 health check。
```

## J4. Migration 规则

```text
- 所有 schema change 必须用 migration 文件。
- migration 文件不可修改历史版本。
- 禁止直接 drop 用户数据列。
- destructive migration 必须分两步：先 deprecate，后续版本再 remove。
- Windows 版 migration 前必须创建 pre_migration backup。
- migration 失败必须保留错误日志。
```

## J5. Schema Version

```sql
CREATE TABLE schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

# 附录 K：知识图谱 Evidence Card

## K1. 目标

知识图谱不是“看起来很炫的图”，而是可解释的知识导航系统。每条边都必须能回答：

```text
为什么系统认为 A 与 B 有关系？
证据来自哪里？
这条关系是否由用户确认？
置信度是多少？
```

## K2. Evidence Card UI

点击边后显示：

```text
Relation: A depends_on B
Status: suggested / accepted
Confidence: 0.82
Generated by: AI / User / System
Model: gpt-4.1-mini
Prompt Version: graph-edge-v1

Evidence:
1. Page: xxx
   Chunk: xxx
   Excerpt: “……”
   Reason: “这段内容说明 A 的实现依赖 B。”

Actions:
- Accept
- Reject
- Edit relation type
- Open source page
- Open target page/topic/entity
```

## K3. Graph View 范围

```text
Page Graph：当前 Page 周边一跳/二跳关系。
Topic Graph：Topic 来源、相关 Topic、实体。
Entity Graph：实体出现在哪些 Page / Topic。
Space Graph：当前 Space 局部图谱。
```

MVP 不做：

```text
- 全局复杂图算法
- 自动 ontology
- 图数据库
- 实时布局增量计算
```

---

# 附录 L：实施路线图 v1.2 详细验收

## M0：项目骨架

交付物：

```text
- pnpm workspace
- apps/web React + Vite
- apps/server Hono
- packages/db Drizzle
- PostgreSQL docker-compose
- health check
- CI: lint/typecheck/test
```

验收：

```text
pnpm install
pnpm dev
curl /api/health 返回 ok
pnpm test 通过
```

## M1：账号 / Workspace / Space / RBAC / Page CRUD

交付物：

```text
- 首个 owner 初始化
- 登录登出
- Workspace CRUD
- Space CRUD
- Group CRUD
- Space member role
- Page Tree
- Page CRUD
- 自动保存
- 版本历史
- 冲突检测
```

验收：

```text
- reader 不能编辑。
- writer 可以编辑。
- admin 可以管理 Space。
- 保存版本冲突返回 409。
```

## M2A：编辑器基础能力

```text
- Tiptap 初始化
- ProseMirror JSON 存储
- text_content extractor
- paragraph / heading / list / quote / code / table
- slash menu
- Markdown paste
```

## M2B：媒体与附件

```text
- image / video / audio / pdf / attachment
- 本地 /data/uploads
- S3 抽象预留
- 附件权限
- ZIP 导出附件
```

## M2C：高级创作块

```text
- Draw.io
- Excalidraw
- Mermaid
- KaTeX
- iframe Embed
- Columns
- Toggle
- Callout
```

验收：

```text
- 每个块可插入、保存、重新打开、只读渲染、打印渲染。
- 每个块实现 EditorBlockExtension 合同。
```

## M3：中文全文搜索

```text
- 应用层中文分词 extension
- pages.text_content GIN index
- document_chunks GIN index
- Search UI
```

验收：

```text
中文关键词可命中页面正文和标题。
无权限 Space 不返回。
```

## M4：向量索引与 RAG

```text
- embedding profile
- chunking
- pgvector HNSW
- hybrid search
- RRF
- RAG SSE
- citations
```

## M5：LLM Wiki

```text
- LLM Inbox
- page_ai_profiles
- llm_suggestions
- Topic Center
- Review Center
- 批量确认策略
```

## M6：知识图谱

```text
- entities
- knowledge_edges
- evidence card
- Graph View
```

## M7：导入导出 / 分享 / 打印

```text
- Markdown import/export
- HTML import/export
- ZIP import/export
- Page/Topic public share
- browser print PDF
```

## M8：质量加固

```text
- 备份恢复
- migration 安全
- RAG evaluation
- 性能测试
- 安全测试
- 诊断日志
```

## M9：Windows 一键包

```text
- Launcher
- bundled server
- bundled PostgreSQL
- initdb
- migration
- port management
- logs
- setup.exe
```

---

# 附录 M：详细测试矩阵补充

## M1. 权限测试

| ID | 场景 | 步骤 | 预期 |
|---|---|---|---|
| RBAC-001 | reader 编辑页面 | reader 调 PATCH /pages/:id | 403 |
| RBAC-002 | writer 编辑页面 | writer 调 PATCH /pages/:id | 200 |
| RBAC-003 | 无 Space 权限搜索 | 用户搜索无权限 Space | 结果为空 |
| RBAC-004 | RAG 越权 | 问题只在无权限页面中有答案 | 返回未找到 |
| RBAC-005 | 分享越权附件 | 匿名访问未引用附件 | 403/404 |

## M2. 编辑器测试

| ID | 场景 | 步骤 | 预期 |
|---|---|---|---|
| EDIT-001 | 自动保存 | 编辑段落等待 debounce | content_version 增加 |
| EDIT-002 | 冲突检测 | 两窗口同时编辑 | 后保存窗口得到 409 |
| EDIT-003 | 本地草稿恢复 | 断网编辑后刷新 | 提示恢复草稿 |
| EDIT-004 | Mermaid 保存重开 | 插入 Mermaid 保存重开 | 源码和预览存在 |
| EDIT-005 | Draw.io 保存 | 插入图并保存 | attachment 创建，节点 src 更新 |
| EDIT-006 | 打印 | 打开 print view | Mermaid/KaTeX 渲染，附件显示链接 |

## M3. Job Runner 测试

| ID | 场景 | 预期 |
|---|---|---|
| JOB-001 | 页面保存后入队 | jobs 有 page.process_llm |
| JOB-002 | app 重启 | pending job 不丢失 |
| JOB-003 | SKIP LOCKED | 双 worker 不重复执行同 job |
| JOB-004 | 失败重试 | attempts 增加，最终 failed |
| JOB-005 | Space 暂停 | 不执行该 Space LLM job |

## M4. RAG 评测测试

| ID | 场景 | 预期 |
|---|---|---|
| RAG-001 | 中文精确关键词 | 召回正确 chunk |
| RAG-002 | 语义改写 | 向量召回正确 chunk |
| RAG-003 | 无答案 | 返回固定未找到 |
| RAG-004 | 权限隔离 | permission_leakage_rate=0 |
| RAG-005 | 引用支持 | citation_precision >= 0.95 |

## M5. Windows Bundle 测试

| ID | 场景 | 预期 |
|---|---|---|
| WIN-001 | 首次启动 | 自动 initdb + migration |
| WIN-002 | 端口占用 | 自动选择新端口 |
| WIN-003 | 异常退出 | 下次启动可恢复 |
| WIN-004 | migration 前备份 | 创建 pre_migration backup |
| WIN-005 | 导出日志 | 生成 zip logs |

---

# 附录 N：AI 编程工具执行约束

AI 编程工具必须遵守：

```text
1. 不得一次性实现所有 Milestone。
2. 每个 Milestone 完成后必须运行 lint/typecheck/test。
3. 任何数据库 schema 修改必须生成 migration。
4. 任何 AI Provider 测试必须使用 Mock，除非明确是 manual smoke test。
5. RAG 答案必须有 citations。
6. local_only Space 的 completion 和 embedding 都不得调用云端。
7. API Key 不得明文存储或返回。
8. 编辑器块必须实现 EditorBlockExtension 合同。
9. Windows Bundle migration 前必须备份。
10. 任何高风险 LLM suggestion 不得自动应用。
```

---

# 附录 O：v1.2 相对 v1.1 的修正说明

v1.1 的问题：

```text
- 将评审建议压缩合并，导致文档像摘要版。
- 没有把新增项全部展开成 API、DDL、测试和验收细节。
- Windows 一键包、编辑器插件合同、RAG 评测、备份恢复等内容篇幅不足。
```

v1.2 修正：

```text
- 保留 v1.1 主体。
- 增加完整 DDL。
- 增加完整 API 契约。
- 增加编辑器扩展合同。
- 增加 Windows Bundle 工程细节。
- 增加备份恢复与 migration 规则。
- 增加 RAG evaluation set。
- 增加 AI 成本与隐私细则。
- 增加知识图谱证据卡片。
- 增加详细测试矩阵。
```
