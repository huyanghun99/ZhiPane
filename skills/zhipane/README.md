# ZhiPane Skill 安装

1. 在 ZhiPane「全局设置 → Agent Token」创建 Token，按需勾选 scope，复制保存。
2. 把本目录复制到 `~/.workbuddy/skills/zhipane/`（项目级为 `<project>/.workbuddy/skills/zhipane/`），或把发布包 `zhipane-skill-*.zip` 解压到该目录后重启 WorkBuddy。
3. 把 `config/mcp.workbuddy.json` 的内容合并进 `~/.workbuddy/mcp.json`，替换 `YOUR_ZHIPANE_HOST` 与 `${ZHIPANE_AGENT_TOKEN}`。也可在「连接器 → 自定义连接器 → 配置 MCP」里粘贴。
4. 其他桌面智能体（Claude Desktop / Cursor / Trae 等）使用同一 `mcpServers` 配置；Skill 目录按各自约定放置，例如 `~/.claude/skills/`、`~/.trae-cn/skills/`。

云端部署请使用 HTTPS，Token 只存哈希、可随时撤销。

目录结构：
```
SKILL.md                    技能主文档（YAML frontmatter + 工作流/约束）
references/tools.md         MCP 工具参数速查
references/ai-pipeline.md   外部 AI 作业 claim/get/submit 流程
references/calendar.md      CalDAV 接入与字段映射
config/mcp.workbuddy.json   WorkBuddy MCP 配置模板
```
