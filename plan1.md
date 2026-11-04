# ZhiPane UED 修复计划（交给执行 AI 的任务书）

> 背景：对 `apps/web` 完成了一轮 UED/交互/审美审查。用户核心痛点：
>
> 1. 页面布局和菜单导航设计怪异、不优雅
> 2. 知识库面包屑导航没有起到作用、不优雅
>
> 本文档是唯一的执行依据。按 P0 → P1 → P2 顺序执行，每个任务包含
> 【问题 / 根因 / 涉及文件 / 修改指引 / 验收标准】。

## 全局约束（每个任务都必须遵守）

- 仅修改 `apps/web`（本轮不做后端/数据库改动）。

- 所有颜色、间距、字号、圆角必须使用 `src/styles/tokens.css` 中的 CSS 变量，禁止硬编码色值（`rgba(34,197,94,…)` 这类必须替换为 `color-mix(in srgb, var(--primary) …%)` 或语义 token）。

- 遵守 `docs/AGENTS.md` 的 UX 规则：不使用原生 `confirm()`/`alert()`（现有 `features/nav/NavView.tsx` 中有违规的 `confirm()`，顺手替换为 Toast + 二次确认弹窗）。

- 不引入新依赖；图标继续用 lucide-react。

- 每完成一个 P 级任务，运行 `pnpm --filter web build` 确认无 TS/构建错误。

***

## P0-1 修复路由解析缺失（面包屑失效 + 归档中心空白的根因）

**问题**

- 访问 `/settings` 时面包屑显示"首页"（在设置页却告诉你身处首页）。

- 访问 `/archive` 时页面整个空白：三个数据查询的 `enabled` 全为 false。

**根因**

- `src/features/shell/useShellContext.ts` 中 `parsePath` 与 `activeRouteFromPath` 均未处理 `archive`、`settings` 两个 route（`MainRoute` 联合类型里已有 `'archive'`，见 `src/types.ts`）。

**涉及文件**

- `src/features/shell/useShellContext.ts`

- `src/features/shell/TopBar.tsx`（`ROUTE_LABEL` 常量）

**修改指引**

1. `parsePath`：为 `/archive`、`/settings` 增加分支，返回合理的上下文（workspace 用现有回退逻辑，space 可为 null 但 route 必须正确）。其他模块（tasks/nav）的解析方式作为参照。
2. `activeRouteFromPath`：增加 `archive`、`settings` 两个分支。
3. `TopBar.tsx` 的 `ROUTE_LABEL`：补 `{ archive: '归档中心', settings: '设置' }`。
4. 检查 `/settings` 与 `/archive` 页面组件接到的 props 是否因此恢复（`ArchiveCenter` 依赖 `space`/`workspace`，修复后查询应正常发出）。

**验收标准**

- `/archive` 页面三个 tab 均能加载数据（无数据时显示空态文案，而非整页空白）。

- `/settings` 面包屑显示「设置」而非「首页」。

***

## P0-2 面包屑瘦身与层级重设计

**问题**

- 面包屑一行塞了四种角色：工作区切换器（与侧栏顶部重复）、空间下拉、页面链、设置入口。

- 空间下拉里的「知识库设置 / 空间设置」两个菜单项都跳同一个 `/settings`——假入口。

- 13px 字号下每级都加粗（`crumb-link` 600、`crumb-current` 也加粗），分不清"我在哪"。

**涉及文件**

- `src/features/shell/TopBar.tsx`

- `src/styles/layout.css`（`.crumbs` / `.crumb-link` / `.crumb-current` / `.crumb-sep` 段，约 352–364 行附近）

**修改指引**

1. **删除面包屑中的工作区切换器**（侧栏顶部已有）。
2. **删除空间下拉里的「知识库设置 / 空间设置」菜单项**；设置统一入口 = 右上角头像菜单 + 侧栏底部齿轮。
3. 面包屑只保留路径：`空间名 / 父页面 / … / 当前页`。层级样式规则：

   | 元素                 | 字号                | 字重  | 颜色                  |
   | ------------------ | ----------------- | --- | ------------------- |
   | 中间各级（crumb-link）   | `--text-sm`(13px) | 400 | `--muted`           |
   | 当前页（crumb-current） | 14px              | 600 | `--text`            |
   | 分隔符（crumb-sep）     | 12px              | —   | `--muted` + 60% 透明度 |

   hover 时中间级变为 `--text-2` 即可，不要变绿。
4. **截断策略**：路径超过 3 级时中间折叠为 `…`，点击展开下拉（`.crumb-pop` 下拉样式已存在于 layout.css，接上 `buildCrumbChain` 的中间层即可）。
5. `/`、`/settings`、`/archive`、tasks、nav 等非页面路由只显示单级标签（用 P0-1 补的 `ROUTE_LABEL`），不渲染空链。

**验收标准**

- 打开一个 4 层深度的页面，面包屑为 `空间 / … / 父页 / 当前页`，`…` 可点击展开。

- 视觉上能一眼分辨当前页（最粗最深）与上级（灰、细）。

***

## P1-1 双顶栏合并为单一顶栏（56px）

**问题**

- 现状两条栏堆叠 108px：48px `TopAppSwitcher` + 60px `TopBar`。

- 两层各有一个 `left: 50%; transform: translateX(-50%)` 的绝对居中元素（模块胶囊、480px 搜索框），窗口 <1280px 时互相压盖——"怪异"的直接来源。

**涉及文件**

- `src/features/shell/TopAppSwitcher.tsx`、`src/features/shell/TopBar.tsx`

- `src/styles/layout.css`（`.top-appswitcher`、`.topbar`、`.appswitcher-modules`、`.palette-trigger`、`.topbar-actions`）

**修改指引**
目标结构（一条 56px 栏，纯 flex 三段式，**禁用绝对定位居中**）：

```
[☰ 侧栏开关] [面包屑 flex:1 min-width:0 可收缩] [搜索触发器 320px] [模块图标×3] [主题/设置/头像]
```

1. 将 `TopAppSwitcher` 与 `TopBar` 合并为一个 `TopBar` 组件（或让 ShellLayout 只渲染一层容器）。
2. 模块切换「知识库 | 任务 | 导航」三个文字胶囊 → **三个图标按钮**（BookOpen / CheckSquare / Compass）+ tooltip，放在右侧用户区左边。它是低频操作，不占视觉中心。
3. 搜索框 `max-width: 480px` 绝对居中 → 右侧固定 320px 的触发按钮，文案「搜索  ⌘K」，点击打开现有 CommandPalette（`src/components/CommandPalette.tsx`）。
4. 面包屑区 `flex: 1; min-width: 0;`，内部 overflow 处理沿用现有 media query 的横向滚动/省略。
5. 删除 layout.css 中 `.appswitcher-modules` 的绝对定位段与多余的 48px 栏高。
6. 顺手把 CommandPalette 的命令补全：目前仅 5 条，增加「打开任务」「打开导航」「归档中心」「设置」。

**验收标准**

- 顶栏总高度 = 56px（DevTools 量测）。

- 窗口宽 1024px 时无元素互相压盖；面包屑过长时收缩为省略号而非溢出。

- ⌘K 与点击搜索框均能打开命令面板。

***

## P1-2 深色主题去"泛绿"（border-strong / 滚动条）

**问题**

- `src/styles/themes/dark.css` 中 `--border-strong: #22c55e`（纯品牌绿）。该 token 被全局滚动条（`base.css` 的 `::-webkit-scrollbar-thumb` 与 `scrollbar-color`）、输入框边框、焦点框、下拉边框复用 → 深色下整个应用滚动条是绿的、输入框泛绿光。

**涉及文件**

- `src/styles/themes/dark.css`（`:root[data-theme="dark"]` 块 + `prefers-color-scheme` 媒体查询内的重复定义，**两处都要改**）

**修改指引**

- 深色主题：`--border-strong: #334155`（slate-700）。

- 深色滚动条：`::-webkit-scrollbar-thumb` 的 background 改用 `--surface-3`（#334155），hover 用 `--muted`。`base.css` 中的全局滚动条也建议改用 `--surface-3` 而非 `--border-strong`（浅色下同样偏灰更优雅）。

- 绿色只保留给 `--primary` 系：按钮、链接、active/选中态。

**验收标准**

- 深色模式下滚动条为灰色，输入框 focus 无绿色光晕，仅主按钮/选中项为绿色。

***

## P1-3 知识库侧栏分组 + 归档中心移底部

**问题**

- `KnowledgeSidebar.tsx` 的 NAV 数组 6 个一级项平铺：首页、智能整理、搜索、知识问答、关系图、归档中心。「搜索」与顶栏搜索/⌘K 重复；「归档中心」是低频管理功能却与首页平级。

- `layout.css` 中 `.sb-nav-group` 分组样式**已定义但未被使用**。

**涉及文件**

- `src/features/shell/KnowledgeSidebar.tsx`（NAV 数组与渲染段）

- `src/styles/layout.css`（启用 `.sb-nav-group`）

**修改指引**

1. NAV 数组重构为三段：

   - 顶部：`首页`

   - 中组（工具）：`智能整理`(badge)、`知识问答`、`关系图`

   - 底部固定区（管理）：`归档中心`、`设置`（齿轮）
2. **删除侧栏中的「搜索」项**（顶栏搜索框 + ⌘K 已覆盖）。
3. 用 `.sb-nav-group` 给中组加分组容器与间距；底部固定区用 `margin-top: auto` 贴底（侧栏为 flex column 时）。

**验收标准**

- 侧栏视觉三段清晰；无重复的搜索入口；归档中心在侧栏底部。

***

## P2-1 统一三模块的页面骨架（ModuleLayout）

**问题**

- 三个模块三种壳：kb 有 280px 全局侧栏；tasks 的 TasksSidebar 藏在视图内部；nav 的 NavSidebar 是 `return null` 空壳。切模块时页面骨架跳动。

**涉及文件**

- `src/features/shell/ShellLayout.tsx`

- `src/features/tasks/TasksView.tsx`、`src/features/tasks/components/TasksSidebar.tsx`

- `src/features/nav/NavView.tsx`（NavSidebar 空壳）

- `src/styles/layout.css`（`.shell-body`）

**修改指引**

1. 定义统一骨架：`56px 顶栏 + [240px 模块侧栏 | 内容区]`。每个模块**必须**提供侧栏。
2. `TasksSidebar` 从 `TasksView` 内部上提到 `ShellLayout` 的 tasks 分支，与 KnowledgeSidebar 平级渲染（过滤状态通过 props/context 传递，注意 `TasksView.tsx` 中 view 状态目前不随 sidebar filter 过滤的问题可一并理顺）。
3. 删除 `NavSidebar` 空壳，为导航模块实现真实侧栏：分组列表 + 「新增网址/新增分组/编辑模式」快捷操作（内容取自 NavView 现有数据）。
4. 侧栏宽度统一 240px；折叠态维持现有逻辑但建议折叠宽度 48–56px（现 72px 过宽）。
5. nav 模块内容区从全宽改为与 kb 相同的居中限宽（max-width 1200px 已有，保留）。

**验收标准**

- 三个模块切换时，侧栏位置/宽度、顶栏高度完全一致，无骨架跳动。

***

## P2-2 模块切换位置记忆

**问题**

- `switchModule('kb')` 固定 `onNavigateHome()`：从任务切回知识库永远回首页，像"重启"而非"切换"。

**涉及文件**

- `src/features/shell/ShellLayout.tsx`

**修改指引**

1. 用内存 Map（或 `sessionStorage`）按模块记忆最后路由：离开模块时写入当前 `routeToUrl(activeRoute)`，切入时若有记录则导航到记录值，无记录走现有默认。
2. tasks 模块额外记住 sidebar filter；kb 记住最后打开的 page。

**验收标准**

- 知识库打开页面 A → 切任务 → 切回，仍在页面 A；刷新后行为合理（sessionStorage 方案时刷新保留，内存方案时可回默认，二选一即可）。

***

## P2-3 导航模块去"霓虹孤岛"化

**问题**

- `features/nav/components.css` 是全应用唯一的霓虹玻璃拟态：4rem 发光时钟、绿色渐变页面背景、backdrop-filter 卡片、图标发光阴影、`position: fixed` 悬浮胶囊控制条。与知识库/任务的朴素工具风格断裂。

**涉及文件**

- `src/features/nav/components.css`（全文可精简约 40%）

- `src/features/nav/NavView.tsx`（结构调整处）

**修改指引**

1. **时钟**：4rem → `--text-2xl`(26px)、颜色 `--text`、删除 `text-shadow`；或直接移除时钟（顶栏已有意义的场景下时间价值低）。
2. **页面背景**：删除 `linear-gradient`，用 `var(--bg)`。
3. **卡片**：删除 `backdrop-filter`、发光 `box-shadow`；hover 改为背景 `--surface-2` + `translateY(-2px)`，边框不变色。
4. **`.nav-text-icon`**：删除 `text-shadow`。
5. **悬浮胶囊控制条**：从 `position: fixed; bottom: 30px` 改为内容区顶部右侧的普通按钮组（与其他模块操作区位置一致），删除 z-index:100 与 50px 圆角胶囊样式。
6. `.nav-group-title` 的绿色药丸底改为普通小节标题（13px、600、`--muted`），与知识库侧栏分组风格一致。

**验收标准**

- 导航页与知识库页并排截图，除内容外看不出是两套设计系统。

***

## 顺手修（与上述任务同行，不单列优先级）

- `NavView.tsx` 的原生 `confirm()` → 应用内二次确认（违反 AGENTS.md）。

- `src/nav.ts` 中 `routeToUrl('page', …)` 把 spaceId 当 pageId 用的 bug（会生成错误 URL，修 P2-2 时会踩到）。

- `base.css` 全局 hover transition 白名单（约 40 个类名枚举）：合并顶栏/重构侧栏后清理已删除类名，避免继续膨胀。

## 执行顺序与提交建议

```
P0-1 → P0-2        （面包屑"能用"）
P1-1 → P1-2 → P1-3 （布局"好看"）
P2-1 → P2-2 → P2-3 （骨架"一致"）
```

- 每个任务一个独立 commit，message 格式：`fix(ued): P0-1 补齐 archive/settings 路由解析`。

- P1-1（合并顶栏）与 P0-2（面包屑）都动 TopBar.tsx，务必按顺序执行，避免冲突。



# ZhiPane UED 修复计划（交给执行 AI 的任务书）

> 背景：对 `apps/web` 完成了一轮 UED/交互/审美审查。用户核心痛点：
>
> 1. 页面布局和菜单导航设计怪异、不优雅
> 2. 知识库面包屑导航没有起到作用、不优雅
>
> 本文档是唯一的执行依据。每个任务包含【问题 / 根因 / 涉及文件 / 修改指引 / 验收标准】。
>
> **执行状态**：第一轮（P0-1 \~ P2-3）已于 commit `87575b0..9b95aa4` 完成，
> 但二轮评审发现若干回归与偏离，见下方「第二轮任务（R2）」——**当前只需执行 R2**。
> R2 按 R2-1 → R2-6 顺序执行。

***

# 第二轮任务（R2）——基于 commit 9b95aa4 的二轮评审

> 二轮评审结论：R1 大部分任务完成质量可接受，但出现 1 个功能回归、
> 1 个擅自改品牌色的偏离、1 个虚报完成的任务。R2 逐项修复。
> **纪律要求：只做任务书里写明的事。禁止顺手改变任务范围之外的设计决策
> （如品牌色、信息架构）。每项完成后对照验收标准自检。**
> 文末 R1 的「全局约束」章节对 R2 同样生效（token 化、AGENTS.md、构建验证）。

## R2-1【P0·功能回归】恢复主题切换与用户菜单

**问题**

- 旧 `TopAppSwitcher`（含主题切换、用户名、退出登录）被删除后无人接管。

- `TopBar.tsx` 已接收 `me / theme / onToggleTheme / onLogout` 四个 props，
  已声明 `userOpen / userRef` 状态，已导入 `Sun / Moon / Monitor / LogOut` 图标，
  **但 JSX 中全部未使用**——纯遗忘，不是设计决策。

- `layout.css` 中 `.avatar-trigger` 样式已写好但没有任何元素使用它。

- 现状：用户在 UI 中**无法切换主题**（`cycleTheme` 成为死代码）；
  退出登录只剩设置页一个入口。

**涉及文件**

- `src/features/shell/TopBar.tsx`

- `src/styles/layout.css`（`.avatar-trigger` 已存在，无需新增）

**修改指引**
在 `.topbar-actions` 末尾（更多菜单之后）添加头像 + 下拉菜单：

```tsx
<div className="more-menu" ref={userRef}>
  <button className="avatar-trigger" onClick={() => setUserOpen((v) => !v)}>
    {(me?.name ?? 'U').slice(0, 1).toUpperCase()}
  </button>
  {userOpen && (
    <div className="more-pop">
      <div className="more-item" style={{ cursor: 'default', color: 'var(--muted)' }}>
        {me?.name}
      </div>
      <div className="more-sep" />
      <button className="more-item" onClick={onToggleTheme}>
        {theme === 'dark' ? <Sun size={14} /> : theme === 'light' ? <Moon size={14} /> : <Monitor size={14} />}
        {' '}切换主题（当前：{theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'}）
      </button>
      <button className="more-item" onClick={() => navigate(urls.settings())}><Settings size={14} /> 设置</button>
      <div className="more-sep" />
      <button className="more-item danger" onClick={onLogout}><LogOut size={14} /> 退出登录</button>
    </div>
  )}
</div>
```

- `userOpen` 的外点关闭逻辑已写在现有 useEffect 里（第 76–86 行），无需新增。

- `theme` prop 当前只可能是 `getTheme()` 的返回值；`ThemeMode` 若为
  `'light' | 'dark' | 'system'`，图标按上面三分支处理。

**验收标准**

- 顶栏右侧出现圆形头像按钮，点击展开菜单；菜单内可切换主题且立即生效；

- 「退出登录」可登出；外点任意处菜单关闭。

- TopBar 中不再存在未使用的 props / 状态 / 图标导入（见 R2-6 一并清理）。

## R2-2【P0·审美回归】深色主题品牌色回退为绿色

**问题**

- R1 任务书只要求「`--border-strong` 去绿」，执行端却把深色 `--primary`
  改成了靛蓝 `#6366f1`，而 `--brand-500/400/300` 仍是绿色。结果深色模式下
  两种强调色同屏：

  - `.sb-brand-mark { background: var(--primary) }` → 靛蓝 logo 块

  - `.sb-ws-trigger { box-shadow: inset 3px 0 0 var(--brand-500) }` → 绿色竖条

  - `.mod-tab.active` → 靛蓝；`--success/--ok` → 绿色

- 且浅色主题 `--primary` 仍是绿色 → **品牌色随主题翻转**，从未被要求。

**涉及文件**

- `src/styles/themes/dark.css`（`:root[data-theme="dark"]` 块与
  `prefers-color-scheme` 媒体查询块，**两处都要改**）

**修改指引**

- 深色主题恢复：`--primary: #22c55e; --primary-hover: #4ade80; --primary-soft: #064E3B; --primary-strong: #86efac;`

- `--border-strong: #334155` 与滚动条改 `--surface-3` 的修改**保留**（这部分是对的）。

**验收标准**

- 深色模式下全应用只有一种品牌强调色（绿色）；logo、模块 tab、
  侧栏工作区竖条颜色一致；滚动条仍为灰色。

## R2-3【P1】补完 P2-1：任务模块接入统一骨架

**问题**

- R1 的 "P2-1 统一模块骨架" commit 实际只处理了 nav 模块
  （且处理方式是 `NavSidebar` 直接渲染 `<KnowledgeSidebar {...props}/>`）。

- tasks 模块仍由 `ShellLayout` 加 `no-sidebar` 类（ShellLayout.tsx:367），
  `TasksSidebar` 仍渲染在 `TasksView` 内部（TasksView\.tsx:302）——
  三个模块两种壳的问题未解决。

**涉及文件**

- `src/features/shell/ShellLayout.tsx`

- `src/features/tasks/TasksView.tsx`、`src/features/tasks/components/TasksSidebar.tsx`

**修改指引**

1. 在 `ShellLayout` 中为 tasks 分支渲染一个真正的任务侧栏容器：

   - 新建 `TaskSidebar`（或复用并改造 `TasksSidebar`），挂到 `.shell-body`
     的侧栏列，与 `KnowledgeSidebar` 平级；

   - 从 `TasksView` 中移除内部 `<TasksSidebar>` 渲染；

   - 移除 `moduleKey === 'tasks' ? ' no-sidebar' : ''`。
2. filter 状态上提：`ShellLayout` 持有 `taskFilter` state（或用
   sessionStorage key `zp.taskFilter` 持久化），通过 props 分别传给侧栏与
   `TasksView`。
3. 任务侧栏宽度与其他模块一致（`.shell-body` 的 280px 列）；
   侧栏内已有的 GTD 六项 + 项目列表结构不变，只需补齐外壳样式
   （背景、右边框与 `.sidebar` 一致）。

**验收标准**

- tasks 模块出现与 kb 相同位置/宽度的左侧栏；主内容区不再自带侧栏；

- 切换 kb ↔ tasks 时侧栏不消失不跳动；侧栏选中的 filter 能驱动
  `TasksView` 主区过滤（含此前已知的 view 状态不随 filter 过滤问题，
  顺带修：calendar/gantt/kanban 视图也应响应 filter）。

## R2-4【P1】顶栏排布修正 + 模块 tab 激活态

**问题**

1. 当前顺序 `[模块图标][搜索框 440px][面包屑 flex:1]`：搜索框挤在第二位，
   1280px 宽度下面包屑被压扁；任务书原意是搜索靠右、面包屑居中偏左。
2. `.mod-tab.active { box-shadow: inset 3px 0 0 var(--primary) }` ——
   3px 左竖条出现在 36px 圆角图标按钮内部，视觉上像渲染毛刺。
3. kb 模块顶栏从侧栏右侧 (x=280) 开始，tasks/nav 从 x=0 开始，
   切换模块时顶栏左边缘横跳。

**涉及文件**

- `src/features/shell/TopBar.tsx`（仅 JSX 顺序）

- `src/styles/layout.css`（`.topbar-mods` / `.mod-tab` / `.topbar`）

**修改指引**

1. 调整 TopBar 内 JSX 顺序为：`[.crumbs(flex:1)] [.palette-trigger] [.topbar-mods] [.topbar-actions]`，
   即面包屑在最左（flex:1 吸收剩余空间），搜索框固定 320px
   （`flex: 0 0 320px`），模块图标在搜索框右侧、操作区左侧。
2. `.mod-tab.active` 去掉 `inset box-shadow`，改为：
   `background: var(--surface-3); color: var(--primary);`
   （实底灰背景 + 品牌色图标，激活态清晰且无毛刺）。
3. 顶栏横跳问题：将 TopBar 从 `main-col` 内部提升到 `app-shell-3` 层级，
   使顶栏横跨全宽（`.shell-body` 只含侧栏+内容，顶栏在其上方，
   `flex column` 布局：`topbar(56px) + shell-body(flex:1)`）。
   注意 sticky 定位随之删除或保留均可（顶栏已在最外层）。

**验收标准**

- 1280px 宽：面包屑完整可读、搜索框 320px、无横向溢出；

- 三个模块切换时顶栏左边缘位置不变（全宽顶栏）；

- 模块 tab 激活态为实底灰 + 品牌色图标，无内部竖条。

## R2-5【P1】面包屑两处残余

**问题**

1. 空间首页（`/w/:wid/s/:sid`，route='home'）面包屑只显示「首页」——
   恰恰是最需要方位感的页面却看不到空间名。space 下拉被锁在
   `route === 'page'` 分支里。
2. 路径折叠只保留 `…` + 最后两级，**第一级（根页面）被丢掉**，
   任务书要求保留第一级 + 最后两级。

**涉及文件**

- `src/features/shell/TopBar.tsx`（crumbs 渲染段、`renderChain`）

**修改指引**

1. space 下拉的渲染条件从 `route === 'page' && crumbChain.length > 0`
   放宽为 `module === 'kb' && space`（所有 kb 路由都显示空间上下文；
   空间名作为第一段，后接页面链或单级标签）。
2. `renderChain` 折叠规则改为保留首级：

```ts
const visible: Array<Part | '…'> = showAll
  ? parts
  : [parts[0], '…', parts[parts.length - 1]];
// '…' 下拉内容 = parts.slice(1, parts.length - 1)
```

**验收标准**

- 空间首页面包屑：`空间名 ▾`（可点切换空间）；

- 4 层深页面：`空间名 ▾ / 根页面 / … / 当前页`，
  `…` 展开列出中间层级，根页面可点击。

## R2-6【P2】导航模块侧栏差异化 + 死代码清理

**问题**

1. `NavSidebar` 现在就是 `<KnowledgeSidebar {...props}/>`：导航模块里
   显示知识库的页面树/最近/收藏，点任何页面都会跳回 kb 模块——
   语义混乱。
2. `TopBar.tsx` 存在死代码：未使用的导入（LogOut/Monitor/Moon/Sun/Settings
   在 R2-1 后会被使用，其余见下）、`onSwitchWorkspace` prop 从未被
   ShellLayout 传入、`workspace/workspaces` props 已无用途。
3. `ArchiveCenter.tsx` 通篇内联样式（padding 24 / maxWidth 960 / TabButton
   自定义），与设计系统脱节。

**涉及文件**

- `src/features/shell/NavSidebar.tsx`、`src/styles/layout.css`

- `src/features/shell/TopBar.tsx`

- `src/features/shell/ArchiveCenter.tsx`

**修改指引**

1. `NavSidebar` 改为真实的导航模块侧栏：

   - 顶部：模块标题「常用导航」+ 搜索引擎入口；

   - 中部：分组列表（数据来自 `listNav`，点击滚动定位到对应分组，
     或者过滤 NavView 显示该分组）；

   - 底部（`.sb-foot` 样式）：新增分组 / 新增网址 / 编辑模式（整理桌面）
     ——与 NavView 顶部控制条互为冗余的按钮可以从 NavView 移到侧栏，
     NavView 顶部只保留「备份/恢复」。

   - 复用 `.sidebar` / `.sb-nav-group` / `.sb-foot-btn` 既有样式类，
     不新造一套。
2. TopBar 清理：删除 `onSwitchWorkspace`、`workspace`、`workspaces`
   三个 props 及 ShellLayout 对应传参（R2-1 已让 LogOut/Sun/Moon/Monitor/
   Settings 派上用场，不在清理之列）。
3. ArchiveCenter：将内联样式迁移为 `layout.css` 中的 `.archive-page`、
   `.archive-tabs`、`.archive-row` 等类（`.archive-row` 类名已存在于
   JSX 中但从未定义样式），tab 按钮对齐 `.wiki-tab` / `.rp-tab` 的既有
   tab 样式规范。

**验收标准**

- 导航模块侧栏只出现导航相关内容，不出现页面树；

- TopBar 无未使用 props/imports；`grep -n onSwitchWorkspace` 无结果；

- 归档中心无内联样式，tab 视觉与其他模块一致。

***

# 第一轮任务（R1）——已完成，留档备查

## 全局约束（每个任务都必须遵守）

- 仅修改 `apps/web`（本轮不做后端/数据库改动）。

- 所有颜色、间距、字号、圆角必须使用 `src/styles/tokens.css` 中的 CSS 变量，禁止硬编码色值（`rgba(34,197,94,…)` 这类必须替换为 `color-mix(in srgb, var(--primary) …%)` 或语义 token）。

- 遵守 `docs/AGENTS.md` 的 UX 规则：不使用原生 `confirm()`/`alert()`（现有 `features/nav/NavView.tsx` 中有违规的 `confirm()`，顺手替换为 Toast + 二次确认弹窗）。

- 不引入新依赖；图标继续用 lucide-react。

- 每完成一个 P 级任务，运行 `pnpm --filter web build` 确认无 TS/构建错误。

***

## P0-1 修复路由解析缺失（面包屑失效 + 归档中心空白的根因）

**问题**

- 访问 `/settings` 时面包屑显示"首页"（在设置页却告诉你身处首页）。

- 访问 `/archive` 时页面整个空白：三个数据查询的 `enabled` 全为 false。

**根因**

- `src/features/shell/useShellContext.ts` 中 `parsePath` 与 `activeRouteFromPath` 均未处理 `archive`、`settings` 两个 route（`MainRoute` 联合类型里已有 `'archive'`，见 `src/types.ts`）。

**涉及文件**

- `src/features/shell/useShellContext.ts`

- `src/features/shell/TopBar.tsx`（`ROUTE_LABEL` 常量）

**修改指引**

1. `parsePath`：为 `/archive`、`/settings` 增加分支，返回合理的上下文（workspace 用现有回退逻辑，space 可为 null 但 route 必须正确）。其他模块（tasks/nav）的解析方式作为参照。
2. `activeRouteFromPath`：增加 `archive`、`settings` 两个分支。
3. `TopBar.tsx` 的 `ROUTE_LABEL`：补 `{ archive: '归档中心', settings: '设置' }`。
4. 检查 `/settings` 与 `/archive` 页面组件接到的 props 是否因此恢复（`ArchiveCenter` 依赖 `space`/`workspace`，修复后查询应正常发出）。

**验收标准**

- `/archive` 页面三个 tab 均能加载数据（无数据时显示空态文案，而非整页空白）。

- `/settings` 面包屑显示「设置」而非「首页」。

***

## P0-2 面包屑瘦身与层级重设计

**问题**

- 面包屑一行塞了四种角色：工作区切换器（与侧栏顶部重复）、空间下拉、页面链、设置入口。

- 空间下拉里的「知识库设置 / 空间设置」两个菜单项都跳同一个 `/settings`——假入口。

- 13px 字号下每级都加粗（`crumb-link` 600、`crumb-current` 也加粗），分不清"我在哪"。

**涉及文件**

- `src/features/shell/TopBar.tsx`

- `src/styles/layout.css`（`.crumbs` / `.crumb-link` / `.crumb-current` / `.crumb-sep` 段，约 352–364 行附近）

**修改指引**

1. **删除面包屑中的工作区切换器**（侧栏顶部已有）。
2. **删除空间下拉里的「知识库设置 / 空间设置」菜单项**；设置统一入口 = 右上角头像菜单 + 侧栏底部齿轮。
3. 面包屑只保留路径：`空间名 / 父页面 / … / 当前页`。层级样式规则：

   | 元素                 | 字号                | 字重  | 颜色                  |
   | ------------------ | ----------------- | --- | ------------------- |
   | 中间各级（crumb-link）   | `--text-sm`(13px) | 400 | `--muted`           |
   | 当前页（crumb-current） | 14px              | 600 | `--text`            |
   | 分隔符（crumb-sep）     | 12px              | —   | `--muted` + 60% 透明度 |

   hover 时中间级变为 `--text-2` 即可，不要变绿。
4. **截断策略**：路径超过 3 级时中间折叠为 `…`，点击展开下拉（`.crumb-pop` 下拉样式已存在于 layout.css，接上 `buildCrumbChain` 的中间层即可）。
5. `/`、`/settings`、`/archive`、tasks、nav 等非页面路由只显示单级标签（用 P0-1 补的 `ROUTE_LABEL`），不渲染空链。

**验收标准**

- 打开一个 4 层深度的页面，面包屑为 `空间 / … / 父页 / 当前页`，`…` 可点击展开。

- 视觉上能一眼分辨当前页（最粗最深）与上级（灰、细）。

***

## P1-1 双顶栏合并为单一顶栏（56px）

**问题**

- 现状两条栏堆叠 108px：48px `TopAppSwitcher` + 60px `TopBar`。

- 两层各有一个 `left: 50%; transform: translateX(-50%)` 的绝对居中元素（模块胶囊、480px 搜索框），窗口 <1280px 时互相压盖——"怪异"的直接来源。

**涉及文件**

- `src/features/shell/TopAppSwitcher.tsx`、`src/features/shell/TopBar.tsx`

- `src/styles/layout.css`（`.top-appswitcher`、`.topbar`、`.appswitcher-modules`、`.palette-trigger`、`.topbar-actions`）

**修改指引**
目标结构（一条 56px 栏，纯 flex 三段式，**禁用绝对定位居中**）：

```
[☰ 侧栏开关] [面包屑 flex:1 min-width:0 可收缩] [搜索触发器 320px] [模块图标×3] [主题/设置/头像]
```

1. 将 `TopAppSwitcher` 与 `TopBar` 合并为一个 `TopBar` 组件（或让 ShellLayout 只渲染一层容器）。
2. 模块切换「知识库 | 任务 | 导航」三个文字胶囊 → **三个图标按钮**（BookOpen / CheckSquare / Compass）+ tooltip，放在右侧用户区左边。它是低频操作，不占视觉中心。
3. 搜索框 `max-width: 480px` 绝对居中 → 右侧固定 320px 的触发按钮，文案「搜索  ⌘K」，点击打开现有 CommandPalette（`src/components/CommandPalette.tsx`）。
4. 面包屑区 `flex: 1; min-width: 0;`，内部 overflow 处理沿用现有 media query 的横向滚动/省略。
5. 删除 layout.css 中 `.appswitcher-modules` 的绝对定位段与多余的 48px 栏高。
6. 顺手把 CommandPalette 的命令补全：目前仅 5 条，增加「打开任务」「打开导航」「归档中心」「设置」。

**验收标准**

- 顶栏总高度 = 56px（DevTools 量测）。

- 窗口宽 1024px 时无元素互相压盖；面包屑过长时收缩为省略号而非溢出。

- ⌘K 与点击搜索框均能打开命令面板。

***

## P1-2 深色主题去"泛绿"（border-strong / 滚动条）

**问题**

- `src/styles/themes/dark.css` 中 `--border-strong: #22c55e`（纯品牌绿）。该 token 被全局滚动条（`base.css` 的 `::-webkit-scrollbar-thumb` 与 `scrollbar-color`）、输入框边框、焦点框、下拉边框复用 → 深色下整个应用滚动条是绿的、输入框泛绿光。

**涉及文件**

- `src/styles/themes/dark.css`（`:root[data-theme="dark"]` 块 + `prefers-color-scheme` 媒体查询内的重复定义，**两处都要改**）

**修改指引**

- 深色主题：`--border-strong: #334155`（slate-700）。

- 深色滚动条：`::-webkit-scrollbar-thumb` 的 background 改用 `--surface-3`（#334155），hover 用 `--muted`。`base.css` 中的全局滚动条也建议改用 `--surface-3` 而非 `--border-strong`（浅色下同样偏灰更优雅）。

- 绿色只保留给 `--primary` 系：按钮、链接、active/选中态。

**验收标准**

- 深色模式下滚动条为灰色，输入框 focus 无绿色光晕，仅主按钮/选中项为绿色。

***

## P1-3 知识库侧栏分组 + 归档中心移底部

**问题**

- `KnowledgeSidebar.tsx` 的 NAV 数组 6 个一级项平铺：首页、智能整理、搜索、知识问答、关系图、归档中心。「搜索」与顶栏搜索/⌘K 重复；「归档中心」是低频管理功能却与首页平级。

- `layout.css` 中 `.sb-nav-group` 分组样式**已定义但未被使用**。

**涉及文件**

- `src/features/shell/KnowledgeSidebar.tsx`（NAV 数组与渲染段）

- `src/styles/layout.css`（启用 `.sb-nav-group`）

**修改指引**

1. NAV 数组重构为三段：

   - 顶部：`首页`

   - 中组（工具）：`智能整理`(badge)、`知识问答`、`关系图`

   - 底部固定区（管理）：`归档中心`、`设置`（齿轮）
2. **删除侧栏中的「搜索」项**（顶栏搜索框 + ⌘K 已覆盖）。
3. 用 `.sb-nav-group` 给中组加分组容器与间距；底部固定区用 `margin-top: auto` 贴底（侧栏为 flex column 时）。

**验收标准**

- 侧栏视觉三段清晰；无重复的搜索入口；归档中心在侧栏底部。

***

## P2-1 统一三模块的页面骨架（ModuleLayout）

**问题**

- 三个模块三种壳：kb 有 280px 全局侧栏；tasks 的 TasksSidebar 藏在视图内部；nav 的 NavSidebar 是 `return null` 空壳。切模块时页面骨架跳动。

**涉及文件**

- `src/features/shell/ShellLayout.tsx`

- `src/features/tasks/TasksView.tsx`、`src/features/tasks/components/TasksSidebar.tsx`

- `src/features/nav/NavView.tsx`（NavSidebar 空壳）

- `src/styles/layout.css`（`.shell-body`）

**修改指引**

1. 定义统一骨架：`56px 顶栏 + [240px 模块侧栏 | 内容区]`。每个模块**必须**提供侧栏。
2. `TasksSidebar` 从 `TasksView` 内部上提到 `ShellLayout` 的 tasks 分支，与 KnowledgeSidebar 平级渲染（过滤状态通过 props/context 传递，注意 `TasksView.tsx` 中 view 状态目前不随 sidebar filter 过滤的问题可一并理顺）。
3. 删除 `NavSidebar` 空壳，为导航模块实现真实侧栏：分组列表 + 「新增网址/新增分组/编辑模式」快捷操作（内容取自 NavView 现有数据）。
4. 侧栏宽度统一 240px；折叠态维持现有逻辑但建议折叠宽度 48–56px（现 72px 过宽）。
5. nav 模块内容区从全宽改为与 kb 相同的居中限宽（max-width 1200px 已有，保留）。

**验收标准**

- 三个模块切换时，侧栏位置/宽度、顶栏高度完全一致，无骨架跳动。

***

## P2-2 模块切换位置记忆

**问题**

- `switchModule('kb')` 固定 `onNavigateHome()`：从任务切回知识库永远回首页，像"重启"而非"切换"。

**涉及文件**

- `src/features/shell/ShellLayout.tsx`

**修改指引**

1. 用内存 Map（或 `sessionStorage`）按模块记忆最后路由：离开模块时写入当前 `routeToUrl(activeRoute)`，切入时若有记录则导航到记录值，无记录走现有默认。
2. tasks 模块额外记住 sidebar filter；kb 记住最后打开的 page。

**验收标准**

- 知识库打开页面 A → 切任务 → 切回，仍在页面 A；刷新后行为合理（sessionStorage 方案时刷新保留，内存方案时可回默认，二选一即可）。

***

## P2-3 导航模块去"霓虹孤岛"化

**问题**

- `features/nav/components.css` 是全应用唯一的霓虹玻璃拟态：4rem 发光时钟、绿色渐变页面背景、backdrop-filter 卡片、图标发光阴影、`position: fixed` 悬浮胶囊控制条。与知识库/任务的朴素工具风格断裂。

**涉及文件**

- `src/features/nav/components.css`（全文可精简约 40%）

- `src/features/nav/NavView.tsx`（结构调整处）

**修改指引**

1. **时钟**：4rem → `--text-2xl`(26px)、颜色 `--text`、删除 `text-shadow`；或直接移除时钟（顶栏已有意义的场景下时间价值低）。
2. **页面背景**：删除 `linear-gradient`，用 `var(--bg)`。
3. **卡片**：删除 `backdrop-filter`、发光 `box-shadow`；hover 改为背景 `--surface-2` + `translateY(-2px)`，边框不变色。
4. **`.nav-text-icon`**：删除 `text-shadow`。
5. **悬浮胶囊控制条**：从 `position: fixed; bottom: 30px` 改为内容区顶部右侧的普通按钮组（与其他模块操作区位置一致），删除 z-index:100 与 50px 圆角胶囊样式。
6. `.nav-group-title` 的绿色药丸底改为普通小节标题（13px、600、`--muted`），与知识库侧栏分组风格一致。

**验收标准**

- 导航页与知识库页并排截图，除内容外看不出是两套设计系统。

***

## 顺手修（与上述任务同行，不单列优先级）

- `NavView.tsx` 的原生 `confirm()` → 应用内二次确认（违反 AGENTS.md）。

- `src/nav.ts` 中 `routeToUrl('page', …)` 把 spaceId 当 pageId 用的 bug（会生成错误 URL，修 P2-2 时会踩到）。

- `base.css` 全局 hover transition 白名单（约 40 个类名枚举）：合并顶栏/重构侧栏后清理已删除类名，避免继续膨胀。

## 执行顺序与提交建议

```
P0-1 → P0-2        （面包屑"能用"）
P1-1 → P1-2 → P1-3 （布局"好看"）
P2-1 → P2-2 → P2-3 （骨架"一致"）
```

- 每个任务一个独立 commit，message 格式：`fix(ued): P0-1 补齐 archive/settings 路由解析`。

- P1-1（合并顶栏）与 P0-2（面包屑）都动 TopBar.tsx，务必按顺序执行，避免冲突。

