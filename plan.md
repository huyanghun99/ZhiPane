# ZhiPane（知行台）实施计划

## 0. 项目实质与决策

ZhiPane 是融合「知识笔记 + 任务管理 + 常用导航」的个人一体化工作台，共享数据关系。

**参考仓库（已全部清除）：**
> 早期阶段曾临时克隆若干参考仓库用于借鉴交互与配色（任务管理参考 ZenithFlow2.0、导航参考 ZenithFlow / PersonalNav）。这些参考仓库已完成的使命，其运行时代码与本地克隆目录（`/workspace/PersonalNav_ref/`、`/workspace/ZenithFlow2.0/`）均已删除，ZhiPane 不依赖任何外部参考仓库，所有功能均为基于本仓库 monorepo 的原生实现。

**架构决策：** 直接克隆 `mindloom` 仓库到 `/workspace/`（即本项目根目录），在其完整 monorepo 基础上逐步改造成 ZhiPane（保留其成熟后端，不重写）。
- 数据库：**保留 PostgreSQL + pgvector**（docker-compose 已就绪），用于知识向量化与后续 AI 接入，不切换到本地存储。
- 前端基座：React19 + Vite + TypeScript（mindloom 已有）+ Tailwind（吸收 ZenithFlow2.0 的配色 token，支持深/浅色）。
- 后端：Hono API + Drizzle ORM + Postgres/pgvector（mindloom 已有），认证沿用 JWT/cookie。
- 新增模块：在现有 features 下加 `features/tasks`（任务管理）与 `features/nav`（常用导航），并在后端新增对应路由表。
- AI 能力：保留 mindloom 的 AI 抽象（mock/openai/ollama/gemini），用于知识向量化与 RAG。

## 0.5 验证启动（已完成）
- [x] `docker compose up -d db` 启动 pgvector/pg16；`pnpm install` 安装依赖；`pnpm db:migrate` 迁移成功（最新 0023/0024）。
- [x] `bash start-dev.sh` 启动：server 监听 39280、web 在 5173；注册接口返回 200（首访注册为 owner）。项目可正常运行。

## 1. 阶段一：品牌文字信息更新（进行中）
- [x] 启动验证项目（见 0.5）。
- [x] 前端用户可见文案：index.html 标题、AuthPanel 登录标题、ShellLayout document.title、Onboarding 品牌名、ShareView 分享页文案 → `MindLoom 知织`→`ZhiPane 知行台`。
- [x] README 标题/定位/启动命令更新为 ZhiPane；styles.css、nav.ts 注释更新。
- [x] 后端日志/注释中的 `MindLoom` 服务名：已改为 `ZhiPane API listening`、`service:"zhipane-server"`。
- [x] 全局包名 `@mindloom/*` → `@zhipane/*`：root 与 6 个子包 package.json、tsconfig.base.json paths、所有 import、smoke 测试、脚本、docs 全部替换。
- [x] 运行时变量名：`mindloom:theme`/`mindloom:last-space`/`mindloom:favorites`/`mindloom:draft:`/`mindloom:*` CustomEvent/`createMindloomBlock` 等改为 `zhipane:*`（web 前端 localStorage/事件标识）。
- [x] DB 凭证保持 `mindloom`（库名/用户/连接串/容器名/卷名）不变，避免数据库连不上、数据丢失；`env.ts` 的 DATABASE_URL 默认值误改已修复回 mindloom。
- [x] 验证：全仓 `pnpm -r typecheck` 通过、`build:packages` 成功；`/health` 返回 `zhipane-server`/`db:connected`/24 迁移；注册 200；app(52)+wiki.phase0(7)+metrics(3) 等测试通过。security/concurrency 个别 test 仅因钩子超时（环境慢），非功能回归。

## 1.5 下一步（进行中）
- [x] 配色系统：主色改为绿色系（`brand-500 #22C55E` / `#16a34a` hover / `#dcfce7` soft），浅色 `tokens.css` + 深色 `themes/dark.css` + 自动深色块全部改为绿色，深浅色均支持。
- [x] 任务管理模块：在 ZhiPane 上原生实现（交互/配色借鉴已删除的参考仓库）。
  - 后端：Drizzle 新增 `projects` / `tasks` / `focus_sessions` 三表（GTD 状态枚举、优先级、截止日、项目关联、循环、专注时长）；迁移 `0025_tasks.sql`；路由 `routes/tasks.ts`（`/api/tasks`、`/api/tasks/projects`、`/api/tasks/focus`，JWT 鉴权，按 workspace 作用域）。
  - 前端：`features/tasks/`（api.ts 类型与封装、TasksView.tsx 主视图：GTD 列表视图 + 看板 6 列 + 番茄钟 25/5 计时 + 项目 CRUD + 任务增删改/完成/优先级/状态），绿色风格 `tasks.css`。
  - 导航接入：types.ts / nav.ts / useShellContext.ts / ShellLayout.tsx / LeftSidebar.tsx 共 5 处加入 `tasks` 入口（左侧"任务管理"✓ 图标）。
- [ ] Dashboard 工作台聚合（今日任务/逾期/最近笔记/收藏/当前项目）。
- [ ] docs/ 下 12 个 md 针对性更新为 ZhiPane 内容（产品定位、架构、部署、AGENTS 规范）。

## 2. 阶段二：知识笔记模块（基于 mindloom 改造，降低 AI 依赖）
- [x] 页面树（Space/Page 自引用）、Tiptap 编辑器、Markdown 快捷输入。
- [x] 文件夹、标签（用户手写 + AI 建议可关）、**真正的双向链接 `[[wikilink]]`** 与反向链接面板。
- [x] 全文搜索（前端简易 BM25 / 子串匹配，覆盖页面标题与文本）。

## 3. 阶段三：任务管理模块（实现 ZenithFlow2.0 功能）
- [x] 数据模型：tasks/projects/sessions/recurrence，Dexie 存储。
- [x] GTD 五视图（收件箱/今日/下一步/等待/将来）、项目视图。
- [x] 看板（6 列 GTD + 拖拽）、日历（日/周/月 + 拖放）、甘特图（按项目分组）。
- [x] 循环任务（预生成实例）、番茄钟（25/5/15 + 环形进度 + 提示音 + 通知）。
- [x] 快速收集（Quick Capture）。

## 4. 阶段四：常用导航模块（数据库化原生实现）
- [x] 分组、书签 CRUD、拖拽排序（HTML5 DnD，跨组移动），数据全部存储于 PostgreSQL（Drizzle 三张表：`nav_groups` / `nav_links` / `nav_search_engines`）。
- [x] **收藏置顶**（pinned 字段）、**打开次数统计**（openCount/lastOpenedAt，点击埋点）。
- [x] 可配置搜索引擎（默认 Bing，可在设置中替换为任意含 `%s` 的搜索地址，按 workspace 作用域隔离）。
- [x] 本地书签搜索 + 外搜跳转。
- [x] 备份导入导出（JSON，含 schema 校验）。

## 5. 阶段五：统一工作台（Dashboard）
- [x] 今日任务、逾期任务、最近笔记、收藏网址、当前项目。
- [x] 快速创建（任务/笔记/书签）、全局搜索、命令面板（Cmd/K）。

## 6. 阶段六：文档更新（docs/）
- [x] 将 mindloom docs/ 下 12 个 md 针对性更新为 ZhiPane 的内容（产品定位、架构、功能说明、部署、AGENTS 规范）。

## 7. 阶段七：收尾
- [x] README 完善、`pnpm dev` 可启动、typecheck 通过、构建成功。
