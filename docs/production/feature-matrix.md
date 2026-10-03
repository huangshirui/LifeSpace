# LifeSpace Production Feature Matrix

> 快速检索当前 production 能力。状态只能由成功的 production deployment 推进为 ✅。

## Status legend

- ✅ Production
- 🚧 In development / not yet production
- 🧭 Planned
- ❓ Needs verification / historical baseline lacks exact release evidence

## Platform

| Domain | Feature | Status | Notes |
|---|---|---:|---|
| Identity | Global LifeSpace user identity | ✅ | 跨应用 LifeSpace 用户身份 |
| Identity | Cloudflare Access principal mapping | ✅ | Identity 负责 verified `(iss, sub) -> usr_*` |
| Identity | Trusted application backend exchange (`lsa_*`) | ✅ | 应用后端身份上下文 |
| Service Auth | Opaque Service API Token (`lsp_pat_*`) | ✅ | scoped / revocable service credential |
| Service Auth | OAuth `client_credentials` | ✅ | 面向第三方/策略控制服务 |
| Space | Space membership | ✅ | 普通业务授权基础 |
| Space | Data Grant | ✅ | 显式、可撤销的数据授权 |
| Authorization | Application × Model Access | ✅ | 与 credential scope / Space authority 共同生效 |
| Authorization | Core-side effective authorization | ✅ | UI/BFF 不是安全边界 |
| Authorization | Principal / Actor attribution | ✅ | 当前已存在基础执行上下文 |
| Authorization | Generalized entity capability (`canBePrincipal`, delegation capability) | 🚧 | 正在开发，未完成 production 发布前不可写为 ✅ |
| Delegation | Delegation chain / re-delegation | 🚧 | 正在开发 |
| Delegation | Single-use ancestor consumption | 🚧 | 正在开发 |
| Models | Metadata-driven Model Definition / Registry | ✅ | 普通模型由元数据驱动 |
| Models | Immutable Model Contract revision | ✅ | `mct_*` revision |
| Runtime | Generic CRUD | ✅ | ordinary models |
| Runtime | Optimistic concurrency / version checks | ✅ | 更新/删除并发正确性 |
| Runtime | Canonical Query | ✅ | 统一 Query Contract |
| Runtime | Cross-Space `/api/v1/me/...` aggregation | ✅ | Core capability |
| Runtime | Model Capability / Action mechanism | ✅ | 具体模型 Action 以 active contract 为准 |
| Runtime | Batch create/update/delete | ❓ | 已有实现演进历史；首个精确 production baseline 后固定状态 |
| Runtime | Batch Execute Action | 🚧 | 不因设计/main/staging 存在而视为 production |
| Eventing | Domain Event | ✅ | durable mutation 事件 |
| Eventing | Outbox / Queue delivery | ✅ | 集成事件投递基础 |
| Eventing | Subscription / Webhook | ✅ | Integration/Eventing contract |
| Eventing | HMAC webhook signing | ✅ | webhook authenticity |
| Console | Platform Console | ✅ | 平台自身 Experience / control plane |
| Control Plane | Identity Platform Admin API | ✅ | 与普通 Identity API 分离 |
| Control Plane | Core Platform Admin API | ✅ | 与普通 Kernel API 分离 |
| Control Plane | Model Control Plane API | ✅ | Registry / Model Contract governance |
| Federated Truth | Own / Mirror / Reference / Query framework | 🧭 | North Star / 后续专项，不作为当前 production 能力 |

## Current ordinary models

以下是当前已知、被现有消费者使用的普通模型。每次 production 发布后应与 active Model Contract 对账：

| Model | Status | Typical use |
|---|---:|---|
| Event | ✅ | 日程 / 时间事件 |
| Task | ✅ | 待办 / 任务 |
| Day Record | ✅ | 日子记录 |
| Wish | ✅ | 愿望 / 愿望池 |

> 新模型只有在该 release 的 production active Model Contract 中激活后才可加入 ✅ 列表。

## Release binding

- Baseline date: **2026-10-03**
- Exact production SHA: **pending first post-policy production release**

本表首次建立时没有历史的“production successful SHA → feature snapshot”文档映射，因此对无法由现有 production evidence 精确反推的项目使用 ❓，不猜测。下一次 production 成功后必须消除相关可验证的不确定项，并绑定精确 SHA。
