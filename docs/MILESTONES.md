# Implementation Milestones

M0: project skeleton, migrations, auth, health check.
M1: workspace, space, pages, RBAC, autosave, version conflict.
M2A: editor base, ProseMirror JSON, text extraction.
M2B: media and attachment system.
M2C: advanced creation blocks: Draw.io, Excalidraw, Mermaid, KaTeX, iframe embeds.
M3: application-level Chinese tokenization and full-text search. (✅ done: 中文分词 FTS + 权限过滤后端已就绪；前端检索 UI 完善——跨 Space 范围、中文分词高亮、结果归属、实时搜索、⌘/Ctrl+K 唤起)
M4: pgvector, chunks, hybrid search, RRF, strict-citation RAG. (✅ done: pgvector 向量化 + 分块 + 混合检索 + RRF 融合已就绪；strict-citation RAG 问答完成，前端引用可点击跳转原文、答案 [n] 标记渲染为可点击徽标；并修复了 space_id 数组过滤、embedding 请求缺 encoding_format、前端搜索无限重搜循环、Excalidraw CSS 解析等关键 bug)
M5: LLM Inbox, suggestions, Topic Center, batch review. (✅ done: 后端在页面处理后自动生成候选 Topic 与建议——AI 优先、启发式兜底、全程容错不阻断索引；前端 LLM Wiki 视图重写为三标签页：Inbox（待处理页列表/立即处理/自动处理暂停恢复）、建议（类型+风险徽标、单条接受/忽略、多选批量接受审阅）、Topic Center（主题浏览/详情含来源页面/采纳/新建/刷新建议）。新增 `/topics/:id/sources` 接口)
M6: graph edges, evidence card, graph view. (✅ done: 后端在页面处理时同步写入 knowledge_edges——page↔page `related`（按词重叠加权）、topic→page `covers`，AI 生成、部分唯一索引去重；Wiki 建议接受时通过 confirmEdgesForSuggestion 把对应边置为 confirmed，单条/批量均生效。前端新增「图谱」视图：自包含 SVG 力导向图（节点=页面/主题，可拖拽、缩放、平移），点击边弹出证据卡（关系类型/置信度/证据 + 确认/拒绝/编辑，写回 PATCH/accept/reject 接口），点击页面节点跳转原文、主题节点高亮)
M7: import/export/share/print PDF. (✅ done: 后端导入/导出 markdown、分享创建/管理/公开访问已就绪；前端补齐——笔记/空间导出 Markdown 下载、Markdown 导入弹窗、分享链接生成/复制/管理弹窗、公开只读分享页 /share/:token、打印/导出 PDF（window.print + print CSS）)
M8: backup, restore, migration hardening, observability.
M9: Windows one-click bundle.
