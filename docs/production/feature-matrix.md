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
| Identity | Agent principal / authentication | ✅ | `agt_*` 是正式 Identity-capable Entity |
| Service Auth | Opaque Service API Token (`lsp_pat_*`) | ✅ | scoped / revocable service credential |
| Service Auth | OAuth `client_credentials` | ✅ | 面向第三方/策略控制服务 |
| Space | Space membership | ✅ | 普通业务授权基础 |
| Space | Data Grant | ✅ | 显式、可撤销的数据授权 |
| Authorization | Application × Model Access | ✅ | 与 credential scope / Space authority 共同生效 |
| Authorization | Core-side effective authorization | ✅ | UI/BFF 不是安全边界 |
| Authorization | Principal / Actor attribution | ✅ | Change 记录执行主体与代表关系 |
| Authorization | Generalized entity capability (`canBePrincipal`, delegation capability) | ✅ | production #30 / SHA `0b28eeb…` 已发布 |
| Delegation | Root / Child Delegation | ✅ | 独立 immutable single-scope `dlg_*` |
| Delegation | Delegation chain / bounded re-delegation | ✅ | Child 必须收窄 parent Authority |
| Delegation | Single-use ancestor consumption | ✅ | mutation commit 时原子消费 Authority chain |
| Delegation | Atomic multi-Delegation issuance (`1..20`) | ✅ | `/delegations/batch`；全部成功或零落地 |
| Models | Metadata-driven Model Definition / Registry | ✅ | 普通模型由元数据驱动 |
| Models | Immutable Model Contract revision | ✅ | `mct_*` revision |
| Runtime | Generic CRUD | ✅ | ordinary models |
| Runtime | Optimistic concurrency / version checks | ✅ | 更新/删除并发正确性 |
| Runtime | Canonical Query | ✅ | 统一 Query Contract |
| Runtime | Cross-Space `/api/v1/me/...` aggregation | ✅ | Core capability |
| Runtime | Model Capability / Action mechanism | ✅ | 具体模型 Action 以 active contract 为准 |
| Runtime | Atomic Batch create/update/delete | ✅ | `/models/batch`，bounded `1..20`，同 Space 可跨 Model |
| Runtime | Batch update/delete server-resolved version | ✅ | 可省略 version，仍在同一 atomic ChangeSet 内提交 |
| Runtime | Batch Execute Action | 🚧 | 尚未作为 production contract 提供 |
| Change | Explicit ChangeSet (`cgs_*`) | ✅ | First-class Batch 的 Governed Change 原子边界 |
| Eventing | Domain Event | ✅ | durable mutation 事件 |
| Eventing | Outbox / Queue delivery | ✅ | 集成事件投递基础 |
| Eventing | Subscription / Webhook | ✅ | Integration/Eventing contract |
| Eventing | HMAC webhook signing | ✅ | webhook authenticity |
| Eventing | `change_set.committed` aggregation | ✅ | 同一显式 ChangeSet 按 endpoint 聚合投递 |
| Eventing | Current-authority revocation boundary | ✅ | disabled subscriber / revoked authority fail closed |
| Change / Audit | Operation Attribution | ✅ | Application / Principal / Actor / Delegation / ChangeSet / occurredAt |
| Provenance | Generic Resource Provenance envelope | 🧭 | 当前 concept-only；无 production 平台能力，未来按真实可验证场景重设计 |
| Console | Platform Console | ✅ | 平台自身 Experience / control plane |
| Control Plane | Identity Platform Admin API | ✅ | 与普通 Identity API 分离 |
| Control Plane | Core Platform Admin API | ✅ | 与普通 Kernel API 分离 |
| Control Plane | Model Control Plane API | ✅ | Registry / Model Contract governance |
| Federated Truth | Own / Mirror / Reference / Query framework | 🧭 | North Star / 后续专项，不作为当前 production 能力 |

## Current ordinary models

本 release 的 production active Model Contract 已验证 4 个普通模型：

| Model | Version | Status | Typical use |
|---|---:|---:|---|
| Event | 6 | ✅ | 日程 / 时间事件 |
| Task | 8 | ✅ | 待办 / 任务 |
| Day Record | 5 | ✅ | 日子记录 |
| Wish | 9 | ✅ | 愿望 / 愿望池 |

Active Model Contract: `mct_90595ab8f69914ddf156ae699361204db0fba5fb95fcc93bed06881ef44efcab`

> 新模型只有在对应 release 的 production active Model Contract 中激活并通过 production verification 后才可加入 ✅ 列表。

## Release binding

- Release date: **2026-10-05**
- Exact production SHA: `0b28eeb202f0a5535a4b802f6d474f7289b2e382`
- Production workflow: **#30** / run `37248751610` — ✅ success
- Core: Kernel `0.43.0` / schema `48`
- Identity: contract `0.8.0` / schema `8`

这是 Production Documentation 机制建立后的首个 exact-SHA production baseline。后续 Feature Matrix 状态必须由新的成功 production workflow 明确推进，不以 main / staging 状态代替 production 事实。