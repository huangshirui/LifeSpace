# Information Provenance

Status: **Concept only — no current platform capability**

## 中文摘要

LifeSpace 当前不提供平台级 Information Provenance 能力。Provenance 保留为概念，等待未来出现可验证、稳定且具有平台价值的真实需求后再重新设计。

当前明确边界：

- 不提供通用 Resource Provenance envelope；
- 不提供独立 Provenance 存储；
- 不提供 `semanticRole: provenance_source`；
- 不提供 External Reference / Provenance graph / lineage 平台语义；
- Core 不接受或自动生成通用 `provenance` 字段；
- 业务 Model 如自身存在“来源报告 / 来源记录 / 上游对象”等业务关系，继续使用普通业务字段 / Relation 表达，LifeSpace 不把它解释为平台级 Provenance；
- 调用方声明“来源于 X”本身不等于可验证证据，因此现阶段不为这种声明建设通用平台机制。

## Current durable evidence

当前可靠且已实现的是 **Change / Operation Attribution**。

每个已提交 Change 可记录：

```text
Application
Principal
Actor
Delegation?
ChangeSet?
operation
version before / after
changed fields
occurredAt
```

因此 LifeSpace 可以可靠回答一条 Record：

- 从哪个 Application 进入 / 被修改；
- 当时的 Principal / Actor 是谁；
- 何时创建、何时修改；
- 发生了什么 mutation。

这部分由 LifeSpace 自己验证和提交，不依赖调用方额外声称 Provenance。

## Historical note

早期曾实现过通用 Resource Provenance V0.1，包括 `resource_provenance` 存储以及 `source / sourceRef / derivedFrom` 等平台 metadata。该设计已经退役。

历史 migration 保留为不可变迁移历史；当前 Runtime / Contract / Model Definition 不保留该能力。Schema 47 已删除旧 `resource_provenance` 表。

## Revisit trigger

只有当出现可验证的真实场景时再重新讨论平台级 Provenance，例如：

- LifeSpace 自身执行确定性派生并能证明输入/输出；
- 可信 Connector / Federated Truth 提供稳定且可验证的 source identity；
- 需要平台级、可验证的转换链或 lineage，而不仅是调用方提交一个来源字符串。

重新设计时不得默认继承旧 V0.1 envelope、存储结构或 `semanticRole` 候选方案。
