# 外部 AI 作业（LLM Wiki 整理）

仅当「全局设置 → AI 整理执行方式」= `WorkBuddy / 桌面智能体` 时，服务端才会把 LLM Wiki 推理排成外部作业。

## 分工（重要）

| 环节 | 谁做 |
| --- | --- |
| 笔记切块 + embedding 向量化 | **服务端**，使用全局设置里配置的 embedding 接口 |
| 结构化 Wiki 提取（摘要 / 主题 / 论断 / 标签） | **你（桌面智能体）** |
| 结果校验、幂等、落库 | **服务端**（Zod 严格校验） |

**绝对不要生成 embedding 数组**。聊天模型输出的浮点数不具备语义检索能力，会让知识库检索失效。

## 完整流程

所有请求都带 `Authorization: Bearer <Agent Token>`，Token 需要 `ai:claim` 与 `ai:submit` 权限。

1. `GET /api/agent/jobs` — 查看 `external.*` 的 pending/running 作业。
2. `POST /api/agent/jobs/claim` — 领取一个作业（服务端用 `FOR UPDATE SKIP LOCKED` 保证唯一，租约 10 分钟）。返回 `null` 表示暂无作业。
3. `GET /api/agent/jobs/{jobId}/payload` — 返回：
   - `promptVersion`：必须原样回传语义
   - `prompt.system` / `prompt.user`：笔记原文与指令
   - `outputSchema`：结果必须匹配的 JSON Schema
   - `sourceVersion`：页面版本；若页面已改动，返回 409，放弃该作业
4. 用你自己的模型按 `prompt` 生成结构化结果。
5. `POST /api/agent/jobs/{jobId}/result` — body 直接是结果 JSON：

```json
{
  "summary": "不超过 400 字的摘要",
  "topics": [{"title": "主题名", "summary": "简述", "confidence": 0.8}],
  "claims": ["关键论断 1", "关键论断 2"],
  "tags": ["标签1", "标签2"]
}
```

限制：`topics` ≤ 50、`claims` ≤ 100、`tags` ≤ 30；`topics` 必填，每项 `title` 必填。

6. 失败时 `POST /api/agent/jobs/{jobId}/fail`，body `{"reason":"..."}`，作业会回到 pending 供重试。

## 约束

- 结果校验失败服务端返回 400，作业状态不变，可修正后重新提交。
- 每个 `(jobId, sourceVersion)` 只保留最后一次结果，重复提交是幂等的。
- 服务端会把 `tags` 合并进该笔记的 AI 档案；主题/论断的完整落库随后续版本开放。
- 切回「系统接口」模式后不再产生外部作业，已领取的作业仍可提交。
- 可以用 `POST /api/agent/reindex`（body 可选 `workspaceId`、`limit`）为尚未处理的笔记补排队。
