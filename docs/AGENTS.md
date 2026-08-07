# ZhiPane AI Agent Engineering Rules

你正在维护 ZhiPane / 知行台项目（基于 ZhiPane 知织改造而来）。开始任何任务前，先阅读 README、docs、数据库 schema、现有测试和本文件。

## 核心原则

ZhiPane 是个人一体化工作台（知识笔记 + 任务管理 + 常用导航），其核心是知识创作与整理，不是功能演示集合。

用户的核心流程是：

1. 快速记录
2. 安全编辑
3. 稳定保存
4. 快速查找
5. 由 AI 辅助整理
6. 回到原始资料验证

任何新功能都不得破坏上述主流程。

## 固定技术约束

继续使用：

* TypeScript
* React + Vite
* Hono
* Drizzle
* PostgreSQL
* pgvector
* Tiptap
* Zod
* Vitest / Playwright

禁止引入：

* NestJS
* Next.js
* Prisma
* SQLite 作为默认数据库
* Redis
* BullMQ
* CASL

Embedding dimension 是实例级唯一配置，不允许 Workspace 使用不同维度。

AI Key 只允许使用 `ai_configs.encrypted_api_key` 加密存储，不得明文保存。

中文全文检索采用应用层分词和 PostgreSQL simple tsvector，不将 zhparser 作为 Windows MVP 依赖。

## 架构规则

后端必须遵循：

route → service → repository

Route 只负责：

* 身份认证
* 请求校验
* 调用 Service
* 序列化响应

Route 不得直接承载复杂事务、跨表业务和大段 SQL。

前端必须按 feature 拆分。不得继续把 Auth、Workspace、Page、Editor、Search、RAG、LLM Wiki 和 Graph 逻辑堆入 App.tsx。

页面列表和页面树不得返回完整 contentJson 或 textContent。完整正文只能通过 Page Detail API 获取。

## 数据正确性规则

Page 创建时，workspaceId 必须由后端根据 spaceId 查询，不能信任客户端。

Page 更新必须使用事务和 CAS：

WHERE id = pageId AND content_version = clientVersion

Revision、Page Update 和 Job Enqueue 必须在同一事务中完成。

所有异步任务必须携带 sourceVersion。任务执行前发现页面版本已更新时，应跳过旧任务。

附件归属必须通过 pageId 反查 Space 和 Workspace，不信任客户端提交的 workspaceId 和 spaceId。

## AI 与隐私规则

所有 LLM、Embedding、RAG 和 LLM Wiki 操作必须通过统一的 `resolveWorkspaceRuntimeConfig()` 获取有效配置。

配置优先级：

User override > Space override > Workspace default > Instance default

Space 为 local_only 时，LLM 和 Embedding 都不得访问公网 Provider。

Space 为 disabled 时，不得执行 AI Job、Embedding、RAG 或自动整理。

自动化测试不得真实调用外部模型，必须使用 Mock Provider。

## 用户体验规则

默认编辑界面应保持安静。

* Slash Menu 是主要块插入入口
* Bubble Menu 只在选择文字时出现
* Block Handle 只在 Hover 时出现
* 不使用浏览器原生 alert 或 confirm
* 所有异步操作提供 Loading、Success、Error 和 Undo 反馈
* 页面持续显示保存状态
* 保存失败时保留本地草稿
* 版本冲突必须提供恢复界面

AI 应优先出现在当前页面的右侧上下文面板，不应迫使用户频繁切换到独立管理页面。

## 性能规则

* 页面树必须使用轻量 DTO
* 长页面树必须支持虚拟化或懒加载
* 搜索请求必须可取消
* 向量查询不得在每次按键后立即执行
* Embedding 应批量调用和批量写入
* Job 必须去重
* 定时轮询必须在页面不可见时暂停
* Graph 默认显示局部关系，不直接加载全量边

## 开发纪律

每次任务：

1. 只完成指定 Sprint。
2. 开始前列出修改文件。
3. 新功能必须添加测试。
4. 修改后运行 lint、typecheck、test 和 build。
5. 不得提交 dist、node_modules、.env、上传文件或数据库文件。
6. 不得为了快速通过测试删除安全检查。
7. 不得擅自修改数据库核心模型。
8. 发现规格冲突时先报告，不自行猜测。

完成后输出：

* 修改摘要
* 涉及文件
* 数据库迁移
* 测试命令与结果
* 性能影响
* 安全影响
* 尚未解决的问题
