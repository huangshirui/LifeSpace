# ALOHA Health · 普通模型注册候选包

> **状态：Agent 语义优化候选；待 CI / Console Validate / Publish；未注册、未部署、不是 Baseline。**
>
> 本目录是 ALOHA Health 第一批七个 LifeSpace 普通模型的**一次性注册候选快照**。正式权威以目标环境发布成功的 Model Registry 定义与不可变 `mct_*` 合约为准。本目录不自动部署，也不引入模型专用路由、数据库表或平台迁移。

## 本次范围

- `health_metric` — 可复用的健康指标定义与可选默认参考范围
- `health_concern` — 持续关注的健康问题
- `health_event` — 发生过的健康事件
- `health_document` — 原始报告/资料的 LifeSpace File 锚点
- `health_observation` — 原子测量事实
- `health_regimen` — 持续干预方案与现有 Recurrence 能力
- `health_assessment` — 与原始事实分离的健康判断

不包含饮食 `nutrition_intake` 和运动 `exercise_session`；不增加通用 Health Kernel/Baseline/Provenance 字段。


## Agent 语义 / Language / Token 原则（2026-10-29）

- **模型 `description`**：用中文业务语言回答“是什么、何时使用、与相邻模型的区别”；不将内部 Registry、CRUD、迁移和技术版本词当作业务语义。
- **字段 `description`**：仅给可能误选、误填或导致不实事实的字段增加简短指引。普通 `type`、`required`、`targetModel`、`enum` 等机器约束不复制写进正文。对象引用和时间/文件的通用 Tool 语法由 Agent Adapter 提供。
- **语言**：稳定 `key`、Field Key、Enum Value 保持英文；`display`、`title`、`description` 用中文。中文名没有单复数变化，`singular` 与 `plural` 相同是刻意的，不修改机器 Model Key。
- **Token**：压缩目标是实际给 Agent 暴露的工具描述，而非 Git 中 JSON 文件体积。模型发现按需加载，工具只暴露执行任务需要的操作、Space 和字段；不要一次挂载全部模型的全量 CRUD。若无目标 Agent tokenizer/实际 Tool Schema 样本，不能把字符数当成准确 Token。
- **去冗余**：`lifecycle.optimisticConcurrency=true` 和 `softDelete=true` 在 DSL v1 由 Core 强制成立，候选省略这两个重复断言，不意味着关闭并发或软删除。Semantic Relations、Recurrence、Query、Reference Label 等保持原样。

### 静态体积对比（不是 Token 计数）

| 口径 | 旧候选 | Agent 语义版 | 差值 |
| --- | ---: | ---: | ---: |
| 七份原始 JSON 字符数（含格式化） | 12,503 | 14,187 | +1,684 |
| `model.description + 60 field.description/默认 title(type)` 字符数 | 1,112 | 1,846 | +734 |
| 有业务字段描述数 | 0/60 | 44/60 | +44 |

**解释**：补足业务语义后字符数必然增加，不能误称“Token 已下降”。已优先消除 DSL 默认声明，避免往字段描述中重复附带 Tool Factory 生成的语法说明。Agent 生产 Token 成本必须在具体模型、Tokenizer 和真实 Tool 定义下复测；后续需要进一步降低成本时，优先限制工具数量和逐层语义发现。Agent 语义丰富度与 Token 预算须同时记录。

**行为不变性**：仅改模型和字段描述、`display` 中文标签，以及删除 DSL 已固定为 true 的重复 `lifecycle` 表达；字段名称/类型/必填性/不可变性、默认值、引用、Query、Relation、Recurrence 及 Access 都没有改动。此优化不会自动实现跨字段约束，更不会给 Agent 新增 Authority。

## 注册顺序与门禁

1. 在 **Staging Console** 对单个 JSON 依次 Validate：`health_metric` → `health_concern` → `health_event` → `health_document` → `health_observation` → `health_regimen` → `health_assessment`；校验通过后 Publish。模型间引用必须指向已发布的目标模型。若目标环境已发布同 key，先比较不可变旧契约及兼容计划，不要盲目重发。
2. 在 LifeSpace Console 给同一个 **ALOHA Application** 配置七个模型的 `read/write` Application × Model Access；用户/服务还要有匹配的 `resources:read/resources:write` Scope 和 Space Membership / Data Grant，不能把模型发布等同于开放权限。
3. 用合成数据在 Staging 验收查询、新增、版本冲突、更正、软删除、引用关系、File 上传及 Recurrence，并核对“跨字段业务约束由可信应用端强制，不被 DSL 描述自动保证”。
4. 只有前述通过并确认生产迁移影响后才在 Production Console 重新 Validate / Publish；`main` 中存在 JSON 不代表 Production 已有模型。

## 2026-10-28 观测模型收敛

遵循已确认的最新 Health UX：从 **`health_observation`** 移除 `status`、`interpretation`、`sourceNote`；不再写 `final` 默认值。手工记录即为正式事实；编辑/软删除及 LifeSpace Change Attribution 管理更正和撤销。报告原始解释由关联的 `sourceDocumentId` 回溯原始 HealthDocument，不复制枚举。保留 `referenceLow/referenceHigh/referenceSource`，这些是本次报告的参考范围，不是通用来源说明。

HealthObservation 的三个值字段 `valueNumber/valueText/valueBoolean` **必须且只能使用一个**、且与引用 HealthMetric 的 `valueType` 一致；开始/结束日期、参考上下限顺序等跨字段约束也需可信 BFF/适配层校验。Model Definition 的字段类型本身不能声明上述跨记录不变量。

## 权责边界

- Health 日常数据归用户授权的 Space；不能由 Space 名字推断 Personal Space，前端不注入私有 `usr_*` 当作身份依据。
- 任意真实数据都只在 LifeSpace 环境中保存，仓库和 CI 只用虚构测试数据，不提交私人健康资料/真实 ID/密钥。
- ALOHA Health PWA 的 BFF 必须服务器端持有 `lsa_*`，通过 Cloudflare Access 原始 Assertion 到 Identity 换取限定 Scope 的用户 token，再转发到 Core；Core 是最终授权边界。
- 参考曲线（儿童身高/BMI）属于后续版本；静态参考范围不能代替按年龄、标准与人群计算的动态曲线。

参照：[LifeSpace Model Definition](../../../../docs/model-definition-spec.md) · [LifeSpace Permission](../../../../docs/permissions.md) · [ALOHA Health 模型产品笔记](https://app.notion.com/p/3f5873b4a6a2801a86bac5867ba6f7f3)。
