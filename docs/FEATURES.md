# UI 体验改进特性说明

> 日期：2026-07-23
> 状态：已实现，typecheck + build + 255 tests 全绿

## 改进清单

### F1: 块节点无标题直接展示内容
**文件**: `editor/BlockFrame.tsx`, `styles/editor.css`

- 流程图、公式、白板等高级块不再默认显示标题栏
- 内容直接展示，hover 时右上角显示类型标签
- 选中后才显示操作栏（编辑、删除等）

### F2: 暗色模式 header 修复
**文件**: `styles/layout.css`

- topbar 背景从硬编码 `rgba(255,255,255,.85)` 改为 `color-mix(in srgb, var(--surface) 88%, transparent)`
- 暗色模式下自动跟随主题色

### F3: 编辑区背景改白色
**文件**: `styles/layout.css`

- center 列（编辑区）背景改为 `var(--surface)`（白色）
- sidebar（左侧菜单）和 right-panel（右侧功能区）背景改为 `var(--bg)`（浅灰色）

### F4: 编辑器顶部工具栏
**文件**: `editor/EditorToolbar.tsx`（新建）, `editor/RichEditor.tsx`

- 粘性工具栏，包含：撤销/重做、标题级别、加粗/斜体/下划线/删除线/代码、文字颜色（8 色）、高亮（5 色）、列表/有序列表/任务列表、引用/代码块/分割线/链接、插入图片/表格

### F5: 图片选中后调整尺寸和对齐
**文件**: `editor/ImageView.tsx`（新建）, `editor/RichEditor.tsx`

- 自定义 Image NodeView，选中后显示右下角拖拽手柄
- 顶部对齐工具栏：左对齐/居中/右对齐/删除
- width 和 align 作为节点属性持久化保存

### F6: 页面图标自定义选择
**文件**: `db/migrations/0019_pages_icon.sql`, `packages/db/src/schema.ts`, `packages/shared/src/schemas.ts`, `apps/server/src/services/page.service.ts`, `apps/web/src/features/notes/PageEditor.tsx`, `apps/web/src/features/notes/PageTree.tsx`

- pages 表新增 `icon` 列
- 编辑器标题左侧添加 emoji 选择按钮（44 个预设图标）
- 页面树节点显示自定义图标
- API 支持 create/update 时携带 icon

### F7: 标题颜色修复
**文件**: `styles/layout.css`

- `.title-input` 显式设置 `color: var(--text)`，修复输入文字灰色问题

### F8: 右侧功能区优化
**文件**: `features/shell/RightPanel.tsx`, `styles/layout.css`

- 默认展示「大纲」标签页（原来是「摘要」）
- 标签按钮隐藏文字，仅显示图标

### F9: 面包屑下拉切换
**文件**: `features/shell/TopBar.tsx`

- 知识库（workspace）名称支持点击下拉切换
- 空间（space）名称支持点击下拉切换
- 下拉菜单底部有「知识库设置」/「空间设置」入口

### F10: 搜索/问答页面宽度稳定
**文件**: `styles/layout.css`

- `.single-pane` 增加 `width: 100%` 和 `min-height: 100%`
- 内容空时和有结果时宽度一致

### F11: 创建子页面
**文件**: `components/PageActionMenu.tsx`, `features/shell/LeftSidebar.tsx`

- 右键菜单顶部新增「创建子页面」选项
- 直接在当前页面下创建子页面，无需先创建再拖动

### F12: 悬浮 AI 助手
**文件**: `features/shell/AiAssistant.tsx`（新建）, `App.tsx`

- 右下角悬浮球（可拖拽调整位置）
- 点击展开右侧抽屉式对话窗口
- 支持三种检索范围：本页/本空间/全部
- 流式回答 + 引用来源标注

### F13: 打印/PDF 排除版本状态
**文件**: `styles/layout.css`

- `@media print` 中隐藏 `.page-editor-head`（版本号·状态信息）和 `.fav-toggle`（收藏按钮）

### F14: 智能整理 topic 去重修复
**文件**: `apps/server/src/services/wiki.service.ts`

- **根因**: merged group 只用第一个成员的 normalized title 检查 existing topic，遗漏了同组其他 title 匹配已存在 topic 的情况
- **修复**: 遍历 group 中所有候选的 normalized title，逐一检查 `existingByNorm`，只要任一匹配到已存在的 topic 就复用而非新建

## 验证状态

| 检查项 | 状态 |
|--------|------|
| TypeScript (server) | ✅ 通过 |
| TypeScript (web) | ✅ 通过 |
| Build | ✅ 通过 |
| Tests | ✅ 255/255 通过 |
| DB Migration 0019 | ✅ 已应用 |
