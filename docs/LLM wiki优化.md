# ZhiPane 智能整理优化指导

## 一、当前核心问题

当前 LLM Wiki 已经有候选生成、Topic 聚类、结构化综合和质量检测，但实际执行链路仍不统一，导致结果不稳定。

### 1. 自动整理与手动采纳走了不同流程

* 自动整理会调用 LLM 综合和质量检查。
* 用户手动采纳候选时，仍可能直接截取原文生成 Definition、Overview 和 Key Points。
* 批量采纳与单个采纳的副作用也不完全一致。

这会导致标题看起来正确，但采纳后正文重复、残缺或混入无关内容。

### 2. Page Map、Facet、Claim 没有成为 Topic 的真正上游

目前 Page Knowledge Map 与 Topic 候选生成基本是两套并行流程：

* Page Map 从章节生成 Facet 和简单 Claim。
* Topic 候选仍直接读取原文前部分内容重新生成。

因此 Page Map 没有真正参与 Topic 路由、聚类和综合。

### 3. 文档结构在预处理阶段丢失

当前主要把编辑器内容转为纯文本，再按固定字符长度切 Chunk，容易造成：

* 从半句话开始；
* 标题、列表、引用层级丢失；
* HTML 图片属性进入正文；
* 相邻主题混入同一个 Chunk；
* Topic 只能获得局部证据。

### 4. 候选生成仍然过早

系统在还没有完成全文理解、Claim 提取和已有 Topic 检索之前，就要求模型直接生成全局 Topic。

这会把文章内部章节误认为长期 Topic，导致知识库越来越碎。

### 5. 已有 Topic 匹配和持续更新不足

新知识进入时，系统仍容易创建新 Topic，而不是：

* 补充已有 Topic；
* 增强已有 Claim；
* 添加案例；
* 标记冲突；
* 生成增量 Diff。

---

## 二、优化目标

将智能整理统一为以下主流程：

```text
结构化文档
→ 文档清洗与语义分段
→ Page Map
→ Facet
→ Atomic Claim
→ 检索已有 Topic
→ 路由决策
→ 证据选择
→ 增量综合
→ 质量检查与自动修复
→ 自动发布或异常队列
```

Chunk 只用于引用定位、Embedding 和证据回溯，不直接作为最终 Wiki 内容。

---

## 三、优先改造事项

### P0-1：统一所有采纳入口

自动整理、单个采纳、批量采纳必须调用同一个领域服务：

```text
提取 Claims
→ 检索已有 Topic
→ 决定更新、新建、案例或 Reference
→ 选择证据
→ LLM 综合
→ 质量检查
→ 自动修复
→ 保存版本
```

删除手动采纳中的原文拼接式正式综合。

LLM 失败时只能保存证据并标记失败，不能用 Chunk 填充 Definition、Overview 和 Key Points。

### P0-2：保留编辑器结构

将 ProseMirror 内容转换为结构化 `DocumentBlock[]`，至少保留：

* 标题及层级；
* 段落；
* 列表层级；
* 引用；
* 表格；
* 图片说明；
* 原文位置；
* 稳定 Block ID。

切分必须优先按照章节和完整段落进行，禁止从句子中间截断。

### P0-3：让 Page Map 成为唯一上游

Topic 候选不再直接读取原文或 `text.slice(...)`。

流程应改为：

```text
Page Map
→ Facets
→ Claims
→ Topic Routing
```

Facet 是文章内部结构，不能默认升级为全局 Topic。

### P0-4：从“一候选一个 Chunk”改为 Claim-Evidence 模型

每个 Claim 可以绑定多个 Evidence Block。

每个 Topic 应由多个 Claim 组成，每个 Claim 都有自己的引用，不能只选择一个最佳 Chunk 生成整篇 Topic。

### P0-5：自动质量门禁

正式 Topic 必须通过以下检查：

* Definition、Overview、Key Points 不得高度重复；
* 不得出现 HTML 残片；
* 不得从残句开始；
* 不得长段复制原文；
* 每条 Key Point 必须有有效引用；
* 引用必须真正支持对应结论；
* Topic 中不得混入明显无关主题；
* 用户锁定字段不得被覆盖。

检查失败后最多自动修复两轮，仍失败才进入异常队列。

---

## 四、Topic 路由规则

新 Claim 进入知识库时，只允许以下动作：

```text
update_existing      更新已有 Topic
create_emerging      创建新兴 Topic
keep_as_facet        仅保留为页面 Facet
attach_as_example    作为案例加入已有 Topic
keep_as_reference    保存为参考资料
ignore_duplicate     忽略重复内容
request_review       冲突或边界不明确
```

默认优先更新已有 Topic，而不是创建近义 Topic。

只有边界清晰、具有长期复用价值且无法归入已有 Topic 的内容，才允许创建新 Topic。

---

## 五、提示词优化原则

不要使用一个 Prompt 同时完成全文理解、Topic 生成、聚类和综合。

拆分为独立 Prompt：

```text
page-map
claim-extraction
claim-relation
topic-routing
topic-synthesis
quality-review
topic-repair
```

每个 Prompt 必须：

* 使用明确 JSON Schema；
* 记录 Prompt 版本和模型参数；
* 禁止补充来源不存在的内容；
* 输出 Claim ID、Evidence ID 和变更类型；
* 支持稳定回归测试。

---

## 六、验收标准

至少2篇长文作为固定回归用例。

验收要求：

* 全文章节覆盖率不低于 95%；
* 不出现 HTML 残片和残句；
* Definition、Overview、Key Points 职责明确；
* “敏捷与 CMMI”不得混入团队实践作为核心定义；
* 第二篇相似文章导入后，应优先更新已有 Topic，而不是新建近义 Topic；
* 自动整理、单个采纳和批量采纳结果必须一致；
* 相同文章重复导入不得产生重复 Topic、Claim 或引用；
* 正常情况下需要人工处理的内容应控制在 5%～10% 以内。

## 七、实施顺序

1. 统一自动整理、单个采纳和批量采纳。
2. 删除正式 Topic 的原文拼接 fallback。
3. 重构结构化文档预处理和语义分段。
4. 接通 Page Map → Facet → Claim → Topic。
5. 建立已有 Topic 检索和路由服务。
6. 实现 Claim-Evidence 增量综合。
7. 增加自动质量检查和修复。
8. 建立端到端回归评测。

不要继续只调整当前候选生成 Prompt 或相似度阈值。当前首要任务是统一知识中间表示和执行链路，否则优化后的 Prompt 仍可能被旧采纳路径绕过。
