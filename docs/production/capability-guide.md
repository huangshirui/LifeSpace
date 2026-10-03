# LifeSpace Production Capability Guide

> 目的：帮助人快速理解 **当前 production 真实具备的能力**。
>
> 本文不是 North Star、目标架构或开发进度说明。只有通过 production deployment 成功发布并验证的能力才可标记为 Production。

## Production baseline

- Baseline established: **2026-10-03**
- Production Core: `https://core.aisr.online`
- Production Identity: `https://auth.aisr.online`
- Release SHA: **Needs backfill from the latest successful production workflow**
- Baseline confidence: **historical production capability inventory; exact release-SHA binding will start with the next successful production deployment**

> 说明：本目录是在已有 production 之后首次建立。由于仓库文档此前没有保存“最后一次成功 production workflow 的 SHA → 人类可读能力快照”映射，本次不伪造 release SHA。自下一次 production 发布成功起，此字段必须与 workflow candidate SHA 精确绑定。

## 1. LifeSpace 是什么

LifeSpace 是 Shared Reality 与 governed action 的平台基座。它负责统一身份、Space 与数据授权、通用模型运行时、契约、事件集成以及平台级部署配置；ALOHA、HomeMew、n8n 等是其消费者或适配层，而不是平台边界本身。

理解 production 时建议按下面顺序：

1. 先看本页了解“线上能做什么”；
2. 再看 [`feature-matrix.md`](./feature-matrix.md) 快速检索单项能力；
3. 需要设计原因时再进入 `north-star.md`、`architecture.md`、`permissions.md`、`agent-ready.md` 等规范文档；
4. 需要接口细节时查看对应 OpenAPI / Model Contract。

## 2. 当前核心能力

### 2.1 Identity / 身份

Production 已形成独立 Identity 服务，并与 Core 分离部署。现有体系支持 LifeSpace 全局用户身份、应用后端身份交换、Service / machine credential，以及 Cloudflare Access 场景下的平台 Web 身份映射。

关键理解：

- LifeSpace user 是跨应用的全局身份，而不是某个应用自己的账号。
- 外部应用身份（例如 WeChat `openid`）由应用/BFF 负责映射，不直接成为 LifeSpace 身份。
- `lsa_*` 用于可信应用后端与 Identity；`lsp_pat_*` / service JWT 用于服务主体访问 Core。

### 2.2 Space / Grant / 授权

Space 是普通业务数据的所有权与默认授权边界。Production 已支持：

- Space 成员关系；
- Data Grant；
- Application × Model Access；
- credential scope 与模型能力共同参与 effective authorization；
- Core 作为最终授权判断边界，而不是依赖 UI/BFF 隐藏按钮。

跨 Space 的共享不会改变原始记录所有权，也不应生成第二份权威副本。

### 2.3 Generic Model Runtime / 通用模型运行时

LifeSpace 的普通业务模型已经走 metadata-driven 路线，而不是每个模型手写一套路由、service 和表。

Production 已具备的主要运行时能力包括：

- Model Definition / Registry；
- immutable Model Contract revision；
- Generic CRUD；
- canonical query；
- optimistic concurrency / version 约束；
-模型级 Capability / Action 机制；
- ordinary model typed persistence 与 runtime descriptor；
- Application × Model Access 与模型策略共同参与运行时授权。

当前常用业务模型包括 Event、Task、Day Record、Wish 等；具体 production 激活模型应以该 release 的 active Model Contract 为准。

### 2.4 Query / 时间语义

Production 的查询能力不是简单的“按表查记录”，而是由统一 Query Contract 与模型语义驱动。当前体系包括：

- canonical query；
- Space 内查询；
- `/api/v1/me/...` 类跨 Space aggregate 能力；
- temporal/date 相关查询能力由模型定义和对应 Capability 决定。

### 2.5 Write / Batch / Change

普通模型支持 create / update / delete 等写操作，并执行授权、模型约束、版本并发控制及 domain event 生成。

批量能力的 production 状态必须以 Feature Matrix 和当前 OpenAPI 为准；不因 main/staging 中已有实现就自动视为 production。

### 2.6 Eventing / Integration

Core 提供独立的 Integration / Eventing contract。Production 架构包括：

- domain event；
- outbox / Queue；
- subscription / webhook delivery；
- HMAC signing；
- service / principal revocation 与集成鉴权边界。

事件契约与 Kernel contract 分开维护，以避免集成生命周期与核心业务 API 强绑定。

### 2.7 Agent-ready Authority

LifeSpace 已经把 Principal / Actor / Delegation / governed Change 作为长期 Authority 模型的一部分进行建设。

但这一部分变化较快，因此必须特别区分：

- 已存在的 service authentication、actor attribution、现有 delegation 能力；
- 正在开发的通用 entity capability、delegation chain / re-delegation、single-use ancestor consumption 等新能力。

后者在未成功发布 production 前一律标记为 🚧，即使 main/staging 已经实现。

### 2.8 Platform Console / Control Plane

LifeSpace Console 是平台自身的管理界面，不是普通消费者应用。平台控制面与普通业务权限分离，Production 体系区分：

- Identity Platform Admin；
- Core Platform Admin；
- Model Control Plane；
- 普通 Kernel / Integration API。

交互式平台管理需要 human actor proof 与 server-side executor credential 的组合，而不是把平台管理员伪装成所有 Space 的成员。

## 3. API / Contract surfaces

当前代码与部署体系将契约分为：

- Identity application/user/service API；
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

因此，本手册只有在上述 workflow 成功后才能将新能力升级为 ✅ Production。

## 5. 不应从本文推断的内容

以下内容不能因为出现在设计文档、Issue、PR、main 或 staging 就视为 production：

- 尚未完成 production workflow 的新 Authority / Delegation 设计；
- 仅在开发分支或 staging 上存在的 API；
- planned Federated Truth；
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
