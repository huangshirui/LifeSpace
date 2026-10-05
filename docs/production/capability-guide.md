# LifeSpace Production Capability Guide

> 目的：帮助人快速理解 **当前 production 真实具备的能力**。
>
> 本文不是 North Star、目标架构或开发进度说明。只有通过 production deployment 成功发布并验证的能力才可标记为 Production。

## Production baseline

- Release date: **2026-10-05**
- Release SHA: `0b28eeb202f0a5535a4b802f6d474f7289b2e382`
- Production workflow: **Deploy LifeSpace platform production #30** (`37248751610`) ✅
- Production Core: `https://core.aisr.online` — Kernel `0.43.0`, schema `48`
- Production Identity: `https://auth.aisr.online` — contract `0.8.0`, schema `8`
- Active Model Contract: `mct_90595ab8f69914ddf156ae699361204db0fba5fb95fcc93bed06881ef44efcab`
- Active ordinary models: Task v8, Wish v9, Day Record v5, Event v6
- Release confidence: **exact release-bound production evidence**

> 这是 Production Documentation 机制建立后的第一份与成功 production workflow 精确绑定的能力快照。后续 production 发布必须继续更新本页、Feature Matrix 与 Changelog。

## 1. LifeSpace 是什么

LifeSpace 是 Shared Reality 与 Governed Change 的平台基座。它负责统一身份、Space 与数据授权、通用模型运行时、Authority / Delegation、Change、契约、事件集成以及平台级部署配置；ALOHA、HomeMew、n8n 等是其消费者或适配层，而不是平台边界本身。

理解 production 时建议按下面顺序：

1. 先看本页了解“线上能做什么”；
2. 再看 [`feature-matrix.md`](./feature-matrix.md) 快速检索单项能力；
3. 需要设计原因时再进入 `north-star.md`、`architecture.md`、`permissions.md`、`agent-ready.md` 等规范文档；
4. 需要接口细节时查看对应 OpenAPI / Model Contract。

## 2. 当前核心能力

### 2.1 Identity / 身份

Production 已形成独立 Identity 服务，并与 Core 分离部署。现有体系支持 LifeSpace 全局用户身份、应用后端身份交换、Service / machine credential、Agent principal，以及 Cloudflare Access 场景下的平台 Web 身份映射。

关键理解：

- LifeSpace User 是跨应用的全局身份，而不是某个应用自己的账号。
- 外部应用身份（例如 WeChat `openid`）由应用/BFF 负责映射，不直接成为 LifeSpace 身份。
- `lsa_*` 用于可信应用后端与 Identity；`lsp_pat_*` / service JWT 用于 Service 主体访问 Core。
- Agent 是正式 Identity-capable Entity，可作为 Principal / Actor 参与 Authority 与 Change attribution，但其实际能力仍受当前 Authority 与 Application exposure 约束。

### 2.2 Space / Grant / 授权

Space 是普通业务数据的所有权与默认授权边界。Production 已支持：

- Space 成员关系；
- Data Grant；
- Application × Model Access；
- credential scope 与模型能力共同参与 effective authorization；
- Core 作为最终授权判断边界，而不是依赖 UI/BFF 隐藏按钮；
- Principal 与 Actor 分离的执行上下文与 Change attribution；
- Entity capability 驱动的 Principal / Delegation eligibility，而不是只靠固定身份类型硬编码。

跨 Space 的共享不会改变原始记录所有权，也不应生成第二份权威副本。

### 2.3 Generic Model Runtime / 通用模型运行时

LifeSpace 的普通业务模型已经走 metadata-driven 路线，而不是每个模型手写一套路由、service 和表。

Production 已具备的主要运行时能力包括：

- Model Definition / Registry；
- immutable Model Contract revision；
- Generic CRUD；
- Canonical Query；
- optimistic concurrency / version 约束；
- 模型级 Capability / Action 机制；
- ordinary model typed persistence 与 runtime descriptor；
- Application × Model Access 与模型策略共同参与运行时授权。

当前 release 的 active Model Contract 激活 4 个普通模型：Task v8、Wish v9、Day Record v5、Event v6。

### 2.4 Query / 时间语义

Production 的查询能力不是简单的“按表查记录”，而是由统一 Query Contract 与模型语义驱动。当前体系包括：

- Canonical Query；
- Space 内查询；
- `/api/v1/me/...` 类跨 Space aggregate 能力；
- Temporal / date 相关查询能力由模型定义和对应 Capability 决定。

### 2.5 Write / Batch / Change

普通模型支持 create / update / delete 等写操作，并执行授权、模型约束、版本并发控制及 Domain Event 生成。

Production 已验证 First-class Runtime Batch：

- `POST /api/v1/spaces/{spaceId}/models/batch`；
- bounded `1..20`，同一 Space 内可跨普通 Model；
- 支持 atomic `create / update / delete`；
- 一个显式 `cgs_*` ChangeSet 作为原子边界，整批全成功或整批回滚；
- update / delete 可由服务端解析当前 version，同时仍保持同一 atomic ChangeSet；
- Authority 校验走 set-wise 路径，不使用逐 item HTTP/D1 waterfall；
- 每条 mutation 保留独立 Change / Domain Event evidence；同一显式 ChangeSet 可聚合为 `change_set.committed` Webhook delivery。

**当前限制**：通用 Execute Action Batch 尚未作为 production contract 提供；不能因为客户端可循环调用 Action 就把它视为平台 Batch 能力。

### 2.6 Eventing / Integration

Core 提供独立的 Integration / Eventing contract。Production 架构包括：

- Domain Event；
- Outbox / Queue；
- Subscription / Webhook delivery；
- HMAC signing；
- `change_set.committed` 的显式 ChangeSet 聚合投递；
- Service / Principal current-authority revocation 边界。

事件契约与 Kernel contract 分开维护，以避免集成生命周期与核心业务 API 强绑定。

### 2.7 Agent-ready Authority / Delegation

本 release 已将 Authority v3 相关能力正式发布到 production：

- User / Agent / Service 等实体是否可作为 Principal、是否可接收 Delegation，由平台 entity capability 约束；
- Principal 与 Actor 分离，Agent 可直接以自身 Principal 执行，也可在有效 Delegation 下代表 Root Principal 执行；
- Root / Child Delegation 与 bounded re-delegation chain；
- Child 必须收窄 parent scope / access / expiry / remaining re-delegation depth；
- single-use Delegation 的 ancestor consumption 在真实 mutation commit 时原子执行，避免同一 single-use Authority 被重复消费；
- 一个业务确认需要多个独立 scope 时，可使用 `POST /api/v1/spaces/{spaceId}/delegations/batch` 原子签发 `1..20` 个独立单-scope `dlg_*`；任一项失败则零落地；
- Child issuance 本身不消费 single-use parent，Authority 只在受治理业务变更提交时消费。

Delegation 不是业务数据字段；它属于执行 Authority evidence，并与 Change attribution 保持分离。

### 2.8 Operation Attribution 与 Provenance 边界

Production 保留 Change / Operation Attribution 作为平台可验证证据：Application、Principal、Actor、Delegation、ChangeSet、operation/version/changed fields/occurredAt 用于回答“谁在什么 Authority 下做了什么变更”。

Information Provenance 当前仍是 **concept only**：Production 不提供通用 Resource Provenance envelope、独立 Provenance 存储、`semanticRole: provenance_source`、External Reference 或 lineage graph。业务模型若确有“来源报告 / 上游记录”等领域事实，应使用普通字段 / Relation 表达。

### 2.9 Platform Console / Control Plane

LifeSpace Console 是平台自身的管理界面，不是普通消费者应用。平台控制面与普通业务权限分离，Production 体系区分：

- Identity Platform Admin；
- Core Platform Admin；
- Model Control Plane；
- 普通 Kernel / Integration API。

交互式平台管理需要 human actor proof 与 server-side executor credential 的组合，而不是把平台管理员伪装成所有 Space 的成员。

## 3. API / Contract surfaces

当前代码与部署体系将契约分为：

- Identity application/user/service/agent API；
- Identity Platform Admin API；
- Core Kernel API；
- Core Integration / Eventing API；
- Core Model Control Plane API；
- Core Platform Admin API；
- ordinary models 的 immutable Model Contract revision。

消费者应依赖明确的兼容版本，而不是默认追踪“最新”。

## 4. Production deployment guarantees

`Deploy LifeSpace platform production` 当前会对精确 candidate SHA 执行：

1. main / release intent 校验；
2. staging candidate identity / schema / Model Contract 对齐；
3. APAC performance gate；
4. production Core migration + deploy；
5. production Identity migration + deploy；
6. production HTTP convergence verification；
7. Cloudflare isolation / bindings verification；
8. active Model Contract verification。

2026-10-05 release 已完整通过以上 gate。Production Core 本次应用 migrations `0047_authority_v2_batch_changeset.sql` 与 `0048_authority_role_capability_redelegation.sql`；Identity schema 保持 v8。HTTP convergence 曾在第一次探测看到旧 Identity contract `0.6.0`，下一次探测即收敛到 `0.8.0`，workflow 按设计等待成功后才继续验收。

## 5. 不应从本文推断的内容

以下内容不能因为出现在设计文档、Issue、PR、main 或 staging 就视为 production：

- 通用 Execute Action Batch；
- planned Federated Truth；
- 通用 Information Provenance / lineage 平台能力；
- 尚未发布的模型、Capability、Console 页面；
- consumer application 自己实现、但并非 LifeSpace 平台保证的行为。

## 6. 发布后的维护要求

每次 production 成功后，本页至少更新：

- `Release SHA` 与发布日期；
- 新增/删除/改变的 production 能力；
- active model / contract 有实质变化时的说明；
- 已知限制；
- 对应 [`feature-matrix.md`](./feature-matrix.md)；
- 对应 [`changelog.md`](./changelog.md)。

Production 发布完成但本目录未同步，视为发布流程尚未完整收尾。