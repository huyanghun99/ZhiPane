# ZhiPane 分阶段整改任务

## 第一阶段：引入 URL 路由。

请执行 Phase 1：引入 URL 路由。

目标：让应用从"状态驱动"变成"URL 驱动"，支持浏览器前进/后退、刷新保持、deep link。

任务：
1. 安装 react-router-dom（或 @tanstack/react-router）
2. 定义路由表：
   / → 重定向到最后访问的 Space 或 Home
   /w/:workspaceId/s/:spaceId → Space 视图（页面树 + 编辑器）
   /p/:pageId → 直接打开页面（自动解析所属 space）
   /wiki/:spaceId → LLM Wiki 视图
   /ask/:spaceId → RAG 问答
   /search → 搜索（query param: q, spaceId）
   /share/:token → 公开分享（已有，保留）
   /settings → 设置
3. 修改 App.tsx：
   - 删除 route state 和 selectedPageId state
   - 改用 useParams / useSearchParams
   - LeftSidebar 的导航改为 <Link> 或 navigate()
   - PageTree 点击改为 navigate(`/p/${pageId}`)
4. 修改 PageEditor：
   - 从 URL 获取 pageId
   - 加载页面数据
   - 保存时不改变 URL
5. 面包屑组件：
   - 显示 Workspace > Space > Page 层级
   - 每级可点击
6. 浏览器标题随页面变化：document.title = `${pageTitle} - ZhiPane`

验收标准：
- 刷新页面不丢失当前视图
- 浏览器前进/后退正常工作
- 可以复制 URL 给他人（登录后可访问）
- RAG citation 点击可跳转到 /p/:pageId

限制：
- 不修改后端 API
- 不修改编辑器功能
- 不新增业务功能

## 第二阶段：建立设计 系统并重构样式

请执行 Phase 2：建立设计 token 系统并重构样式。

目标：让 ZhiPane 有统一的视觉语言，支持暗色模式，有"产品感"。

任务：
1. 创建 styles/tokens.css：
   - 颜色：--bg, --surface, --surface-2, --text, --text-2, --muted, --primary, --primary-soft, --border, --danger, --success
   - 间距：--space-1 到 --space-8（4px 递增）
   - 字号：--text-xs(11px), --text-sm(13px), --text-base(15px), --text-lg(17px), --text-xl(21px), --text-2xl(26px)
   - 圆角：--radius-sm(6px), --radius-md(10px), --radius-lg(14px)
   - 阴影：--shadow-sm, --shadow-md, --shadow-pop
   - 动画：--ease-out: cubic-bezier(0.16, 1, 0.3, 1); --duration-fast: 120ms; --duration-normal: 200ms
   - 字体：--font-sans, --font-mono
2. 创建 styles/themes/dark.css（覆盖颜色 token）
3. 拆分 styles.css 为：
   - styles/base.css（reset, typography, scrollbar）
   - styles/layout.css（app-shell, sidebar, main, right-panel）
   - styles/editor.css（ProseMirror 相关）
   - styles/components.css（button, input, modal, toast, empty-state）
4. 全局过渡：
   - 所有 hover 状态加 transition: background var(--duration-fast)
   - 面板展开/收起加 width + opacity 过渡
   - 菜单弹出加 scale + opacity 动画
   - 页面切换加 fadeIn 动画
5. 页面树打磨：
   - hover 背景色
   - 当前页面左侧 3px 蓝色指示条
   - 展开/折叠箭头旋转动画
   - 缩进层级线
6. 编辑器打磨：
   - 块 hover 时左侧显示淡色 ⋮⋮
   - 选中块有 primary-soft 背景
   - 标题输入时有轻微的字重变化动画
   - placeholder 颜色更淡

验收标准：
- 暗色模式可切换（跟随系统或手动）
- 所有交互有过渡动画，不再"跳变"
- 视觉一致性明显提升
- 页面树有 hover/active 反馈

限制：
- 不修改功能逻辑
- 不修改后端
- 不引入 UI 组件库（保持自定义 CSS，但用 token 系统化）

## 第三阶段：编辑器体验从"能用"升级到"好用"

请执行 Phase 3：编辑器体验从"能用"升级到"好用"。

目标：让编辑器接近 Notion/语雀的写作体验。

任务：
1. 保存状态指示器：
   - 在编辑器顶部右侧显示：✓ 已保存 / ● 保存中... / ⚠ 未保存 / ⚡ 版本冲突
   - 自动保存 debounce 2 秒
   - 保存失败时 toast 提示
   - 版本冲突时显示"有人修改了此页面"弹窗，提供：覆盖 / 查看最新版 / 另存副本
2. 修复编辑器内容同步：
   - 不用 JSON.stringify 全量比较
   - 用 selfUpdateRef 区分本地编辑和外部更新
   - 外部更新时保持光标位置（如果可能）
3. Slash 菜单优化：
   - 输入 "/" 后菜单跟随光标位置
   - 支持键盘上下选择 + Enter 确认
   - 支持模糊搜索过滤（输入 "/ta" 过滤出 table）
   - 分组：基础 / 媒体 / 高级 / AI
   - 每项有图标 + 名称 + 简短描述
4. BubbleMenu 优化：
   - 选中文字后 200ms 延迟出现（避免闪烁）
   - 位置在选区上方居中
   - 包含：加粗 / 斜体 / 删除线 / 代码 / 链接 / 高亮色 / AI 操作
   - AI 操作：润色 / 翻译 / 总结 / 解释
5. 页面标题：
   - 标题是编辑器的一部分（第一个 H1 块），不是独立 input
   - 或者：标题 input 在编辑器上方，Enter 后 focus 到正文
   - 标题支持 emoji 前缀（如 📝 会议记录）
6. 快捷键：
   - Cmd/Ctrl+S → 手动保存
   - Cmd/Ctrl+K → 插入链接 / 打开 Command Palette
   - Cmd/Ctrl+Shift+K → 代码块
   - Tab / Shift+Tab → 列表缩进
   - Cmd/Ctrl+/ → 切换 Slash 菜单

验收标准：
- 写作时不需要鼠标就能完成基本操作
- 保存状态始终可见且可信
- Slash 菜单响应快、过滤准
- 选中文字后 BubbleMenu 自然出现

限制：
- 不新增编辑器节点类型
- 不修改 Draw.io / Excalidraw 实现
- 不修改后端

## 第四阶段：让 AI 功能从"有"变成"可信且不打扰"

请执行 Phase 4：让 AI 功能从"有"变成"可信且不打扰"。

目标：用户信任 AI 输出，感到 AI 是辅助而非干扰。

任务：
1. RAG 问答 UI 优化：
   - 提问后立即显示 "正在检索..." skeleton
   - sources 以卡片列表先出现（标题 + 相关度 + 来源 Space）
   - 答案逐字流式显示，有打字机光标
   - citation [1] [2] 是可点击的 chip，点击跳转到源页面
   - 无答案时显示友好插图 + "知识库中未找到相关信息"
   - 扩展思考模式有明确开关和视觉区分
2. 右侧 AI Panel 优化：
   - Tab: AI 摘要 | 标签 | 相关页面 | 大纲
   - 摘要：显示 AI 生成的 2-3 句话摘要，有"重新生成"按钮
   - 标签：AI 标签 + 用户标签，可删除/新增
   - 相关页面：最多 5 个，显示标题 + 相关度条
   - 大纲：从 H1/H2/H3 自动生成，点击滚动到对应位置
3. LLM Inbox 优化：
   - 显示待处理数量 badge
   - 每项显示：页面标题 + 修改时间 + 状态
   - 批量操作：全部标记已处理 / 全部忽略
   - 处理完成后有 ✓ 动画反馈
4. Suggestion 交互：
   - 低风险（标签）：自动应用，显示 "已自动添加标签: xxx" toast
   - 中风险（Topic）：卡片形式，[接受] [忽略] [稍后]
   - 高风险（合并/删除）：Modal 确认，显示影响范围
   - 接受后有 ✓ 反馈动画
5. Topic stale 提示：
   - 来源页面更新后，Topic 显示 "来源已更新" 黄色 badge
   - 点击可查看 diff 或重新生成

验收标准：
- RAG 回答有逐字流式效果
- citation 可点击跳转
- AI 建议有明确的风险等级视觉区分
- 用户不会感到 AI 在"偷偷改东西"

限制：
- 不修改 RAG 后端逻辑（已经是真流式）
- 不新增 AI 功能
- 测试使用 Mock Provider

## 第五阶段：规模下体验流畅

请执行 Phase 5：确保 1000+ 页面规模下体验流畅。

任务：
1. 页面树虚拟化：
   - 使用 @tanstack/react-virtual 或 react-arborist
   - 只渲染可见区域的节点
   - 支持懒加载子节点（hasChildren 时点击展开才请求）
2. 搜索优化：
   - 输入 300ms debounce
   - AbortController 取消上一次请求
   - 搜索结果高亮匹配文字
   - 显示搜索耗时
3. Job 去重：
   - 数据库加唯一索引：同一实体同一类型只保留一个 pending job
   - 连续编辑不创建重复 job
4. rate_limit_events 清理：
   - 增加定时清理 job：删除 7 天前的记录
   - 或改为 rolling counter
5. 编辑器性能：
   - 大文档（10000+ 字）不卡顿
   - 图片懒加载
   - Mermaid/Excalidraw 不在视口内时不渲染
6. 全局错误边界：
   - React ErrorBoundary 包裹主要区域
   - API 失败有 retry 按钮
   - 网络断开有 banner 提示

验收标准：
- 1000 页面时页面树渲染 < 100ms
- 搜索响应 < 500ms（不含 AI）
- 连续快速编辑不产生重复 job
- 组件 crash 不白屏

限制：
- 不修改 API 契约
- 不新增功能


## 第五阶段：补齐"产品感"
请执行 Phase 6：补齐"产品感"的最后 20%。

任务：
1. Home Dashboard 优化：
   - 最近编辑（5 篇，带时间）
   - 快速新建（空白页 / 模板选择）
   - LLM Inbox 待处理数量
   - 最近 AI 问答记录
   - 收藏页面（可选）
2. 模板系统（简单版）：
   - 新建页面时可选择：空白 / 会议记录 / 读书笔记 / 技术方案
   - 模板只是预填 contentJson
3. 页面操作菜单：
   - 右键或 ⋯ 按钮
   - 重命名 / 移动到 / 复制 / 删除 / 分享 / 导出 Markdown
4. 拖拽排序：
   - 页面树支持拖拽调整顺序
   - 编辑器内块支持拖拽排序（如果 Tiptap 支持）
5. 通知/反馈系统：
   - Toast 组件完善（success / error / info / warning）
   - AI 处理完成通知
   - 保存冲突通知
6. 键盘导航：
   - Cmd/Ctrl+K 打开 Command Palette
   - Cmd/Ctrl+N 新建页面
   - Cmd/Ctrl+P 快速跳转页面
   - Escape 关闭弹窗/菜单

验收标准：
- 新用户 30 秒内能开始写第一篇笔记
- 常用操作都有快捷键
- 反馈及时、明确、不打扰
- 整体感觉像"产品"而非"demo"

限制：
- 不新增后端 API（除非模板需要）
- 不修改核心数据模型