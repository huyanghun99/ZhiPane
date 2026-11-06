# MCP 工具参数速查

端点：`POST <base>/mcp`，JSON-RPC 2.0。先 `initialize`，再 `tools/list`，最后 `tools/call`：
```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"kb_list_spaces","arguments":{"workspaceId":"<uuid>"}}}
```

所有写工具支持可选 `idempotencyKey`（字符串，重试时复用）。所有 id 均为 UUID。

## 知识库 · 读（`kb:read`）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `kb_list_workspaces` | 无 | `{workspaces:[{id,name,role}]}` |
| `kb_list_spaces` | `workspaceId` | `{spaces:[{id,name,kind,status}]}`，不含已归档 |
| `kb_get_tree` | `spaceId` | `{tree:[...]}`，笔记目录树 |
| `kb_get_page` | `pageId` | `{page:{...,contentVersion,contentJson}}` |
| `kb_search_pages` | `q`, 可选 `workspaceId`, `limit` | `{pages:[{id,title,spaceId,...}]}` |

## 知识库 · 写（`kb:write`）

| 工具 | 必填 | 可选 | 说明 |
| --- | --- | --- | --- |
| `kb_create_page` | `spaceId`, `title` | `contentJson`, `parentPageId` | 新建笔记 |
| `kb_update_page` | `pageId`, `contentVersion` | `title`, `contentJson` | 乐观锁；冲突时重新 `kb_get_page` |
| `kb_delete_page` | `pageId` | — | 软删 |
| `kb_archive_page` / `kb_unarchive_page` | `pageId` | — | 归档后从目录树隐藏 |
| `kb_move_page` | `pageId` | `parentPageId`(可 null), `spaceId`, `position` | 跨空间需两端都有编辑权限 |
| `kb_create_space` | `workspaceId`, `name` | — | 自动把调用者设为管理员 |
| `kb_rename_space` / `kb_archive_space` | `spaceId` | `name` | — |

## 任务 · 读（`tasks:read`）

| 工具 | 参数 | 说明 |
| --- | --- | --- |
| `tasks_list` | `workspaceId?`, `status?`, `projectId?`, `from?`, `to?`, `limit?` | 状态：`inbox/today/next/waiting/someday/done/scheduled` |
| `tasks_get` | `id` | 单任务全字段 |
| `tasks_list_projects` | `workspaceId?` | 项目列表 |
| `tasks_calendar` | `from`, `to`, `workspaceId?` | 按时间窗口返回日程字段 |

## 任务 · 写（`tasks:write`）

| 工具 | 必填 | 可选 |
| --- | --- | --- |
| `tasks_create` | `title` | `workspaceId`, `status`, `projectId`, `startDate`, `endDate`, `dueDate`, `notes` |
| `tasks_update` | `id` | `title`, `status`, `progress` |
| `tasks_move` | `id` | `status`, `projectId`, `startDate`, `endDate`, `position` |
| `tasks_delete` / `tasks_complete` | `id` | — |

时间均为 ISO 8601 字符串。`projectId` 必须属于当前知识库，否则服务端返回错误。

## 日历（`calendar:read`）

`calendar_get_feed_url` → `{caldavUrl, icsUrl, hint}`。

## 错误语义

| 错误文本 | 处理 |
| --- | --- |
| `Version conflict` | 重新 `kb_get_page` 取新 `contentVersion` 再更新 |
| `Token lacks scope xxx` | 让用户在全局设置补权限 |
| `Token is not allowed to access this workspace` | Token 绑定了别的知识库，换 Token |
| `Forbidden` | 当前用户对该对象无权限 |
| `projectId does not belong to this workspace` | 先 `tasks_list_projects` 取合法 id |
