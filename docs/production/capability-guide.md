# LifeSpace Production Capability Guide

> 目的：帮助人快速理解 **当前 production 真实具备的能力**。
>
> 本文不是 North Star、目标架构或开发进度说明。只有通过 production deployment 成功发布并验证的能力才可标记为 Production。

## Production baseline

- Release date: **2026-10-22**
- Deployed release SHA: `4e2eb18aa35738aae9f908e86ee55063a58c4466`
- Production workflow: **Deploy LifeSpace platform production #42** (`39752702491`) ✅
- Production Core: `https://core.aisr.online` — Kernel `0.53.0`, schema `72`
- Production Identity: `https://auth.aisr.online` — contract `0.12.0`, schema `11`
- Active Model Contract: `mct_ee9aa79db15247e204572f14703ffb8e5bdab90854133224f13f02df8518f172`
- Active ordinary models (10): Task v9, Wish v9, Day Record v6, Event v6, Person Group v1, Anniversary v1, Activity v1, Goal v2, Person Profile v1, Habit v2
- Release confidence: **exact release-bound production evidence**

> 本页与成功的 production workflow 精确绑定。main、PR 或 staging 中的能力不能自动视为 Production。

## 1. LifeSpace 是什么

LifeSpace 是 Shared Reality 与 Governed Change 的平台基座。它负责统一 Identity、Space 与数据授权、Person Directory、通用模型运行时、Authority / Delegation、Change、契约、事件集成以及平台级部署配置；ALOHA、HomeMew、n8n 等是其消费者或适配层，而不是平台边界本身。

理解 production 时建议按下面顺序：

1. 先看本页了解“线上能做什么”；
2. 再看 [`feature-matrix.md`](./feature-matrix.md) 快速检索单项能力；
3. 需要设计原因时再进入 `north-star.md`、`architecture.md`、`permissions.md`、`agent-ready.md`、`person-directory.md` 等规范文档；
4. 需要接口细节时查看对应 OpenAPI / Model Contract。

## 2. 当前核心能力

### 2.1 Identity / 身份与 Credential

Production 已形成独立 Identity 服务，并与 Core 分离部署。当前支持 LifeSpace 全局用户身份、应用后端身份交换、Service / machine credential、Agent identity / Agent credential，以及 Cloudflare Access 场景的平台 Web 身份映射。

关键理解：

- LifeSpace User 是跨应用的全局身份，不是某个应用自己的账号。
- 外部应用身份（例如微信 `openid`）由应用/BFF 映射，不直接成为 LifeSpace 身份。
- `lsa_*` 用于可信 Application backend 与 Identity。
- `lsp_svc_*` 是 canonical Service API Token；legacy `lsp_pat_*` 只保留运行时/迁移兼容，不再是消费者应采用的 canonical 前缀。
- `lsp_agt_*` 是 revocable Agent API Credential，绑定 Application + Agent；持有 credential 本身不会获得 Space / Model / User Authority。
- Agent 是正式 Identity-capable Entity，可作为 Principal / Actor 参与 Authority 与 Change attribution，但实际能力仍受当前 Authority、Application exposure 与 Delegation 约束。

### 2.2 Space / Grant / Authorization / Delegation

Space 是普通业务数据的所有权与默认授权边界。Production 已支持：

- Space Membership；
- Data Grant；
- Application × Model Access；
- credential scope 与模型 capability / policy 共同参与 effective authorization；
- Core 作为最终授权判断边界，而不是依赖 UI/BFF 隐藏按钮；
- Principal 与 Actor 分离的执行上下文与 Change attribution；
- Entity capability 驱动的 Principal / Delegation eligibility；
- Root / Child Delegation、bounded re-delegation、single-use ancestor consumption；
- `POST /api/v1/spaces/{spaceId}/delegations/batch` 原子签发 `1..20` 个独立 single-scope Delegation。

Authorization Request 是标准授权协议入口：Agent/Application 可提出待确认的授权请求，用户确认后产生明确 Delegation；拒绝、取消或未确认的 request 不产生业务 Authority。Production promotion 的 exact-candidate Golden Flow 已真实验证 `Agent Credential -> Authorization Request -> Confirm -> Delegation -> governed mutation`。

跨 Space 的共享不会改变原始记录所有权，也不应生成第二份权威副本。

### 2.3 Person Directory / 人物目录

Space Person (`per_*`) 是 Kernel 的 first-class Person Directory 能力，不是普通 metadata model，也不是 Authority-bearing identity。

Production 当前支持：

- Person create / read / update / delete；
- bounded list / search；
- primary display name；
- alternate names / aliases，并参与人物检索；
- Relation Target Lookup / Reference Resolution 使用同一 Space Person 语义；
- Person 作为模型 Policy / relation 的业务上下文，但 Membership / Grant / Delegation Authority 仍以 User / Principal 等身份体系为准。

### 2.4 Generic Model Runtime / 通用模型运行时

普通业务模型采用 metadata-driven Runtime，而不是每个模型手写一套路由、service 和表。Production 已具备：

- Model Definition / Registry；
- immutable Model Contract revision；
- Generic CRUD；
- Canonical Query；
- optimistic concurrency / version 约束；
- 模型级 Capability / Action；
- typed persistence 与 runtime descriptor；
- Application × Model Access 与模型 Policy；
- Relation Target Lookup / Reference Resolution；
- configuration-time Model Semantic Discovery：`GET /api/v1/me/_discovery/models` 与 `GET /api/v1/me/_discovery/models/{modelKey}`，用于消费者在配置阶段获取当前 Application 可配置的静态模型语义；该能力与具体 Space 的 Membership / Data Grant / Delegation 分离，不授予任何 Space 数据 Authority。

当前 active Model Contract 激活 **10 个**普通模型：Task v9、Wish v9、Day Record v6、Event v6、Person Group v1、Anniversary v1、Activity v1、Goal v2、Person Profile v1、Habit v2。`person_group` 仍与 Kernel Person Directory 严格分离。模型发布是 LifeSpace 平台事实，不自动授予 HomeMew 等 Application 的 Model Access，也不代表消费者 UI 已上线。

### 2.5 Query / 时间语义

Production 查询能力由统一 Query Contract 与模型语义驱动，包括：

- Canonical Query；
- Space 内查询；
- `/api/v1/me/...` 跨 Space aggregate；
- typed comparison / sorting；
- Calendar / TemporalRange / date / instant 语义由模型定义及 Capability 决定。

### 2.6 Write / Atomic Batch / Non-atomic Bulk / Change

普通模型 create / update / delete 均执行当前授权、模型约束、乐观并发与 Governed Change。

**Atomic Batch**：

- `POST /api/v1/spaces/{spaceId}/models/batch`；
- bounded `1..20`，同一 Space 内可跨普通 Model；
- 支持 atomic `create / update / delete`；
- 一个显式 `cgs_*` ChangeSet 作为原子边界，整批全成功或整批回滚；
- update / delete 可省略 caller-known version，由 Core 从当前 snapshot 解析，同时仍进行并发保护；
- Authority / target preparation 走 set-wise bounded I/O，不实现为逐 item HTTP waterfall。

**Non-atomic Bulk**：

- `POST /api/v1/spaces/{spaceId}/models/bulk`；
- bounded mixed `create / update / delete`；
- 每个 item 独立 success / failure，可部分成功；
- common path 使用 set-wise authority / target / relation preparation，而不是把 Bulk 简化成客户端 N 次单条调用；
- 成功 item 产生各自 Governed Change，失败 item 不产生 Change；同一请求保留 `blk_*` correlation。

**当前限制**：通用 Execute Action Batch 尚未作为 production contract 提供；客户端可循环调用 Action 不等于平台提供了 Action Batch。

### 2.7 Eventing / Integration

Core 提供独立 Integration / Eventing contract。Production 包括：

- Domain Event；
- Outbox / Queue；
- Subscription / Webhook delivery；
- HMAC signing；
- atomic ChangeSet 的 `change_set.committed` 聚合投递；
- Service / Principal current-authority revocation boundary。

独立 Non-atomic Bulk 的成功 mutation 保留逐 Change / Event evidence；它不被伪装成一个 atomic ChangeSet。

### 2.8 Agent-ready execution

当前生产 Agent 路径已经形成完整闭环：

```text
lsp_agt_* Agent API Credential
  -> verified Application + Agent identity
  -> configuration-time model semantics（不等于 Space Authority）
  -> Authorization Request（需要用户代表权限时）
  -> Confirm / Delegation
  -> current Effective Authority
  -> Generic Runtime / Person / Bulk 等平台能力
  -> Governed Change attribution
```

Credential 负责认证“谁在调用”，configuration-time discovery 负责说明“可配置哪些模型及其静态语义”，Delegation 负责表达“该 Actor 可以代表谁做什么”；三者不能互相替代。配置某个 Space / Model 目标本身不会产生对应数据 Authority，运行时仍必须通过 Direct Authority 或有效 Delegation。

### 2.9 Operation Attribution 与 Provenance 边界

Production 保留 Change / Operation Attribution 作为平台可验证证据：Application、Principal、Actor、Delegation、ChangeSet/Bulk correlation、operation/version/changed fields/occurredAt 用于回答“谁在什么 Authority 下做了什么变更”。

Information Provenance 当前仍是 **concept only**：Production 不提供通用 Resource Provenance envelope、独立 Provenance storage、External Reference 或 lineage graph。业务模型确有“来源报告 / 上游记录”等领域事实时，应使用普通字段 / Relation 表达。

### 2.10 Platform Console / Control Plane

LifeSpace Console 是平台自身的管理界面，不是普通消费者应用。平台控制面与普通业务权限分离，Production contract 体系包括：

- Identity Platform Admin；
- Core Platform Admin；
- Model Control Plane；
- 普通 Kernel / Integration API。

交互式平台管理使用 human actor proof + server-side executor credential，而不是把平台管理员伪装成所有 Space 的成员。本次 **Core/Identity Platform Production release 不等价于 Console application rollout**；Console 有独立 production deployment workflow。

### 2.11 本次 Production 新增／升级能力（2026-10-22）

以下为 Release #42 已验证的 **Core/Identity 平台能力**，下游应用仍需单独授权、适配与发布：

- **Goal v2**：明确 `active / paused / achieved / abandoned` 生命周期，通过模型 Action 转换；不是仅在 UI 中修改一个显示状态。
- **Habit v2**：使用不可变的 `subjectPersonId` 表达单一归属人；有权限的家庭成员可以帮他人创建 Habit，但后续变更、状态转换与 Check-in 由对应归属人经 Core 当前 Authority 校验执行。状态 `active / paused / ended`，只有 active 可打卡。
- **Activity v1 / Anniversary v1 / Person Profile v1**：通过标准普通模型 Registry/Runtime 发布；`Activity` 适用于跨 Event / Task 等记录的业务容器；Anniversary 是独立普通模型，是否合并展示在日历由消费者负责。
- **Task v9 / Day Record v6**：当前 active Model Contract 已升级；与 Event v6、Wish v9、Person Group v1 一并在生产合同中验证。
- **External Provider（Notion）**：生产独立的私有 Adapter Worker、Service Binding、shared-secret、Core cursor secret 与加密 Connection Vault 部署与路由验证通过。真实生产 Connection 配置、数据授权和业务场景需单独验收；不能从基础设施成功推断所有 Provider 业务读写已实测。
- **Record 图标／语义关联／周期及计划机制**：这些能力的可用边界以当前 Kernel/OpenAPI、已发布模型 Definition 及对应权限为准；不将 HomeMew 的日历、足球统计或图标选择器 UI 作为本次平台发布的组成部分。
- **APAC release gate**：仍维持原有 P50/P90 限制；对生产候选使用每场景 45 次计时采样以降低小样本百分位不稳定性，且不隐去慢请求。它是发布测量改进，不代表实际请求延迟被代码优化。

## 3. API / Contract surfaces

当前 Production 契约分为：

- Identity application/user/service/agent API；
- Identity Platform Admin API；
- Core Kernel API；
- Core Integration / Eventing API；
- Core Model Control Plane API；
- Core Platform Admin API；
- ordinary models 的 immutable Model Contract revision。

消费者应依赖明确兼容版本，而不是默认追踪“最新”。

## 4. Production deployment guarantees

`Deploy LifeSpace platform production` 对 exact candidate SHA 执行：

1. main / release intent 校验；
2. exact candidate 的 staging identity / schema / Model Contract 对齐；
3. APAC performance gate，并重新执行 staging Platform Golden Flow；
4. production Core migration + deploy；
5. production Identity migration + deploy；
6. production HTTP convergence；
7. Cloudflare isolation / bindings verification；
8. canonical `lsp_svc_*` service authentication + active Model Contract verification。

2026-10-22 release #42 在同一 exact candidate SHA 的 staging #147 和 production 上通过上述 gate。Production 当前为 Core Kernel `0.53.0` / schema `72`，Identity contract `0.12.0` / schema `11`。Core 已执行 schema 54–72 的增量迁移并验证 10 个普通模型的 active Model Contract；production Notion External Provider 私有 Adapter/路由/Connection Vault 和签名凭据已通过部署校验。这里不宣称已经对真实生产 Notion 数据执行 CRUD 回归。

Production runtime signing material 与 Core↔Identity shared authentication secret 由本次 workflow 完成 presence/consistency 和真实 `lsp_svc_* -> Core -> Identity introspection` 验证；`repair_core_identity_shared_secret=false`，不执行主动 repair。生产 R2 S3 签名凭据与 Notion Adapter 的独立生产 Secret 由该 workflow 同步和验证。

### Creation Draft retirement

Creation Draft 已从当前 Production 能力中完全退出：当前 API / contract / runtime / tests 不再提供 Creation Draft，migration `0053_remove_creation_draft_jobs.sql` 已删除其运行时表。历史 migration 文件继续保留，因为已执行 migration history 必须不可变；这不代表 Creation Draft 仍是当前平台能力。

## 5. 不应从本文推断的内容

以下内容不能因为出现在设计文档、Issue、PR、main 或 staging 就视为 Production：

- 通用 Execute Action Batch；
- planned Federated Truth；
- 通用 Information Provenance / lineage 平台能力；
- downstream n8n / HomeMew / ALOHA 的适配或发布状态；
- Console application 的某个新版本已经 rollout（其 production workflow 独立）；
- 尚未进入成功 production workflow 的模型或 Capability（例如尚未手工发布的 Football Match / Football Goal）。

## 6. 发布后的维护要求

每次 production 成功后，本页至少更新：

- `Deployed release SHA` 与发布日期；
- 新增/删除/改变的 production 能力；
- active model / contract 有实质变化时的说明；
- 已知限制；
- 对应 [`feature-matrix.md`](./feature-matrix.md)；
- 对应 [`changelog.md`](./changelog.md)。

Production 发布完成但本目录未同步，视为发布流程尚未完整收尾。
