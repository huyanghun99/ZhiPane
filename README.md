# ZhiPane 知行台

ZhiPane·知行台是一个连接**任务、知识笔记与常用资源**的个人一体化工作台。

- **知识笔记**：双向链接、反向链接、AI 整理（LLM Wiki）、知识图谱关系
- **任务管理**：GTD 列表 / 看板 / 番茄钟 / 项目 / 循环任务
- **常用导航**：分组与书签管理、HTML5 拖拽排序、可配置搜索引擎、打开统计、JSON 备份导入导出
- **AI 能力**：PostgreSQL + pgvector 向量化与严格引用的 RAG 问答

数据存储统一于 PostgreSQL（Drizzle ORM），按 workspace 作用域隔离；前端为 React + Vite，后端为 Hono，整体为 pnpm monorepo（位于 `ZhiPane/`）。

## 快速开始

```bash
cd ZhiPane
cp .env.example .env        # 数据库默认 zhipane:zhipane@127.0.0.1:5432/zhipane
docker compose up -d db     # 启动 Postgres + pgvector
pnpm install
pnpm --filter @zhipane/server db:migrate
bash start-dev.sh           # 或分别 pnpm start（后端 39280）与 pnpm --filter @zhipane/web dev（前端 5173）
```

打开：

- Web: http://127.0.0.1:5173
- API: http://127.0.0.1:39280

`ALLOW_SIGNUP=true` 时，首位注册用户成为实例 Owner。

## 项目结构

```text
ZhiPane/
  apps/web        React/Vite 客户端（features/tasks、features/nav、features/notes…）
  apps/server     Hono API 服务器（routes/tasks.ts、routes/nav.ts、routes/wiki…）
  packages/db     Drizzle schema 与迁移
  packages/shared 共享 Zod schema 与类型
  docs/           设计、计划与特性说明（12 个 md）
```

## 常用导航模块要点

- 后端三张表：`nav_groups` / `nav_links` / `nav_search_engines`（迁移 `0027_nav.sql`），路由挂载于 `/api/nav`。
- 前端 `features/nav/`：`NavView.tsx` 主视图、`api.ts` 封装、霓虹绿玻璃拟态 `components.css`。
- 左侧栏可折叠（状态持久化于 `localStorage`）。

## 文档

更详细的设计、实施计划与特性说明见 `ZhiPane/docs/`（`AGENTS.md`、`FEATURES.md`、`plan02~04.md`、`DESIGN-v1.3.md` 等）。
