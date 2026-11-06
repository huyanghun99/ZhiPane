# CalDAV 日程

ZhiPane 把任务的时间安排以 **CalDAV（RFC 4791）** 暴露，支持 iOS 日历、macOS 日历、Thunderbird/Lightning、以及支持 CalDAV 的 Outlook 插件双向读写。

## 连接信息

在「全局设置 → Agent Token」创建带 `calendar:read` / `calendar:write` 的 Token。

- **账户 URL**：`<base>/caldav/`（发现入口），或直接用日历集合 `<base>/caldav/calendars/<workspaceId>/`
- **用户名**：任意（如邮箱）
- **密码**：Agent Token（Basic 认证）；也可用 `Authorization: Bearer <token>`
- 云端部署务必使用 HTTPS；Token 可随时撤销

`calendar_get_feed_url` MCP 工具会返回拼好的地址。只读订阅可用 `<base>/caldav/calendars/<workspaceId>/feed.ics`（单向、客户端按缓存刷新）。

## 字段映射

| 任务字段 | iCalendar |
| --- | --- |
| `id` | `UID: <id>@zhipane` |
| `startDate` / `endDate`（缺 `startDate` 用 `dueDate`） | `DTSTART` / `DTEND` |
| `estimatedDuration`（分钟） | 无 `endDate` 时用于推算 `DTEND` |
| `isAllDay` | `DTSTART;VALUE=DATE` / `DTEND;VALUE=DATE` |
| `title` / `notes` / `tags` | `SUMMARY` / `DESCRIPTION` / `CATEGORIES` |
| `status=done` / `completedAt` | `STATUS:COMPLETED` / `COMPLETED` |
| `recurrenceUnit` / `Interval` / `EndDate` | `RRULE:FREQ=...;INTERVAL=...;UNTIL=...` |
| `updatedAt` | `DTSTAMP` / ETag |

所有时间以 UTC（`Z`）输出；数据库不存时区列，客户端按本地时区显示。

## 支持的方法

| 方法 | 作用 |
| --- | --- |
| `OPTIONS` | 返回 `DAV: 1, 2, 3, calendar-access` |
| `PROPFIND /caldav/` | principal 与 calendar-home-set 发现 |
| `PROPFIND /caldav/calendars/` | 列出知识库对应的日历集合 |
| `PROPFIND /caldav/calendars/<ws>/` | 集合属性（displayname、ctag、支持 VEVENT） |
| `REPORT ... calendar-query` | 按 `time-range` 返回事件（含 ETag 与 calendar-data） |
| `GET .../feed.ics` | 聚合 `.ics` |
| `GET / PUT / DELETE .../<uid>.ics` | 单事件读 / 新建或更新 / 删除 |

`PUT` 时服务端解析 VEVENT 并创建/更新任务；客户端自带的 UID 会记录在 `calendar_sync_map` 里，后续同步保持一致。

## 限制

- 只提供 VEVENT（任务日程），不提供 VTODO。
- 重复规则支持 DAILY / WEEKLY / MONTHLY / YEARLY + INTERVAL + UNTIL。
- 没有服务端推送（无 WebDAV sync-collection 增量报告），客户端按自己的刷新间隔轮询。
