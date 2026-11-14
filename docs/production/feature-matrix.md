# LifeSpace Production Feature Matrix

> 快速检索当前 production 能力。状态只能由成功的 production deployment 推进为 ✅。

## Status legend

- ✅ Production
- 🚧 In development / not yet production
- 🧭 Planned
- 🗑️ Retired / removed from current production capability
- ❓ Needs verification / historical baseline lacks exact release evidence

## Platform

| Domain | Feature | Status | Notes |
|---|---|---:|---|
| Identity | Global LifeSpace user identity | ✅ | 跨应用 LifeSpace 用户身份 |
| Identity | Cloudflare Access principal mapping | ✅ | Identity 负责 verified `(iss, sub) -> usr_*` |
| Identity | Trusted application backend exchange (`lsa_*`) | ✅ | 应用后端身份上下文 |
| Identity | Agent identity / principal | ✅ | `agt_*` 是正式 Identity-capable Entity |
| Identity | Agent API Credential (`lsp_agt_*`) | ✅ | revocable；绑定 Application + Agent；credential possession 不授予业务 Authority |
| Service Auth | Opaque Service API Token (`lsp_svc_*`) | ✅ | canonical scoped / revocable service credential；legacy `lsp_pat_*` 仅兼容 |
| Service Auth | OAuth `client_credentials` | ✅ | 面向第三方/策略控制服务 |
| OAuth | Authorization code / PKCE, refresh / revoke, Resource-bound execution | ✅ | Identity 0.19.0 已部署；本轮真实 Production 授权及撤权待复测 |
| OAuth | Console-managed CIMD / DCR admission | ✅ | 当前 Identity 准入策略、网络和 limiter 约束；部署不等于所有客户端均允许 |
| MCP | Current Server configuration / enabled state | ✅ | Core schema 78，配置不产生底层 Authority |
| MCP | Core generic Operation Projection / private protocol Adapter | ✅ | Core 533321d + private Adapter cc15736；真实 Production E2E 待验收 |
| MCP | Real Production OAuth/Delegation E2E on latest release | ❓ | 独立验收，不能用 Staging 或部署成功替代 |
| Space | Space membership | ✅ | 普通业务授权基础 |
| Space | Data Grant | ✅ | 显式、可撤销的数据授权 |
| Person | First-class Person Directory CRUD/list/search | ✅ | Kernel `per_*`，不是普通 metadata model |
| Person | Alternate names / aliases | ✅ | primary + alternate names 参与检索 |
| Person | 独立只读/读写 Person Directory Data Grant（Service / Agent） | ✅ | Kernel `0.54.0`，Candidate `/person-directory/grants`；需要 Scope + Grant， 不开放 User/Membership、整个 Space 或普通模型 |
| Authorization | Application × Model Access | ✅ | 与 credential scope / Space authority 共同生效 |
| Authorization | Core-side effective authorization | ✅ | UI/BFF 不是安全边界 |
| Authorization | Principal / Actor attribution | ✅ | Change 记录执行主体与代表关系 |
| Authorization | Generalized entity capability | ✅ | `canBePrincipal` / delegation eligibility 由平台能力控制 |
| Authorization | Authorization Request -> Confirm -> Delegation | ✅ | 用户确认后才产生代表 Authority；exact-candidate Golden Flow 已验证 |
| Discovery | Configuration-time Model Semantic Discovery | ✅ | `/api/v1/me/_discovery/models` 与 `/{modelKey}`；静态模型语义与具体 Space Membership / Data Grant / Delegation 分离，不授予 Space 数据 Authority |
| Delegation | Root / Child Delegation | ✅ | 独立 immutable single-scope `dlg_*` |
| Delegation | Delegation chain / bounded re-delegation | ✅ | Child 必须收窄 parent Authority |
| Delegation | Single-use ancestor consumption | ✅ | mutation commit 时原子消费 Authority chain |
| Delegation | Account-approved once / time-limited / until revoked | ✅ | 用户确认时选择时效，当前 Scope、Resource、Space、Actor 与操作约束不变；External 单次写入限制保留 |
| Delegation | Atomic multi-Delegation issuance (`1..20`) | ✅ | `/delegations/batch`；全部成功或零落地 |
| Models | Metadata-driven Model Definition / Registry | ✅ | 普通模型由元数据驱动 |
| Models | Immutable Model Contract revision | ✅ | `mct_*` revision |
| Models | New baseline ordinary models (Anniversary / Activity / Goal / Person Profile / Habit) | ✅ | Current Model Contract has 19 published ordinary models (10 baseline + 2 football + 7 health) |
| Models | Goal lifecycle | ✅ | `active / paused / achieved / abandoned`; guarded Actions |
| Models | Habit ownership and Check-in | ✅ | immutable single `subjectPersonId`, owner-controlled Check-in and lifecycle |
| Models | Record icon metadata + image File link preservation | ✅ | schema 76 preserves image attachment on ordinary PATCH; safe legacy link recovery (D1/R2 verified) |
| Models | Semantic relations | ✅ | model-declared outgoing relation support; authority checked by Core |
| Runtime | Generic CRUD | ✅ | ordinary models |
| Runtime | Optimistic concurrency / version checks | ✅ | 更新/删除并发正确性 |
| Runtime | Canonical Query | ✅ | 统一 Query Contract |
| Runtime | Cross-Space `/api/v1/me/...` aggregation | ✅ | Core capability |
| Runtime | Relation Target Lookup / Reference Resolution | ✅ | Person / ordinary record reference projection; schema 75 canonical reference labels on Task/Wish/DayRecord/Event |
| Runtime | Model Capability / Action mechanism | ✅ | 具体模型 Action 以 active contract 为准 |
| Runtime | Atomic Batch create/update/delete | ✅ | `/models/batch`，bounded `1..20`，同 Space 可跨 Model，全部成功或回滚 |
| Runtime | Batch update/delete server-resolved version | ✅ | 可省略 version，仍保持 optimistic concurrency |
| Runtime | Non-atomic Bulk mixed create/update/delete | ✅ | `/models/bulk`；bounded；per-item 独立结果；允许部分成功 |
| Runtime | Native File upload / attach / download | ✅ | 已部署 #453 临时对象 GET 校验与发布后异步清理；正式 PUT/HEAD/原子发布不变；60/60 合成 Staging 基准，不是生产 UI 耗时 |
| Runtime | Batch Execute Action | 🚧 | 尚未作为 production contract 提供 |
| Change | Explicit ChangeSet (`cgs_*`) | ✅ | Atomic Batch 的 Governed Change 原子边界 |
| Change | Bulk correlation (`blk_*`) | ✅ | Non-atomic Bulk 关联；不制造 atomicity |
| Eventing | Domain Event | ✅ | durable mutation 事件 |
| Eventing | Outbox / Queue delivery | ✅ | 集成事件投递基础 |
| Eventing | Subscription / Webhook | ✅ | Integration/Eventing contract |
| Eventing | HMAC webhook signing | ✅ | webhook authenticity |
| Eventing | `change_set.committed` aggregation | ✅ | 同一显式 atomic ChangeSet 按 endpoint 聚合投递 |
| Eventing | Current-authority revocation boundary | ✅ | disabled subscriber / revoked authority fail closed |
| Change / Audit | Operation Attribution | ✅ | Application / Principal / Actor / Delegation / ChangeSet/Bulk correlation / occurredAt |
| Legacy | Creation Draft API/runtime/current storage | 🗑️ | 当前 API/contract/runtime 已移除，schema 53 删除 runtime table；历史 migrations 保留 |
| Provenance | Generic Resource Provenance envelope | 🧭 | 当前 concept-only；无 production 平台能力 |
| Console | Platform Console | ✅ | 独立 Production #43533673820，533321d；可搜索 Grant 对象与独立编辑流程；真实浏览器操作待独立验收 |
| Account | Account Center / approval UI | ✅ | 独立 Production #43534485019，533321d；部分完整自助管理及审计后续补齐 |
| Performance | OAuth execution context / live authorization optimization | ✅ | Identity 0.19.0、Adapter cc15736；保留独立 Core 实时授权；不宣称生产耗时提升 |
| Control Plane | Identity Platform Admin API | ✅ | Identity `0.17.0` 普通 API 不再声明 Bootstrap 管理契约；必要 Seed/Break-glass 路由仍由独立 companion 管理 |
| Control Plane | Bootstrap-free routine platform production release | ✅ | 默认保留 Identity Bootstrap Secret；Model Admin 通过预配置 `models:manage` Service Token 验证，不以 Bootstrap 日常创建身份 |
| Control Plane | Core Platform Admin API | ✅ | 与普通 Kernel API 分离 |
| Control Plane | Model Control Plane API | ✅ | Registry / Model Contract governance |
| External Provider | Notion private Adapter routing / encrypted dynamic Connection Vault | ✅ | #42 部署级私有路由及 Secret/DO 验证；真实生产 Notion 数据不执行破坏性 smoke |
| Federated Truth | Complete Own / Mirror / Reference / Query framework | 🧭 | North Star / 后续专项；不能将已部署 Notion Query Adapter 误写为完整四模式框架 |

## Current ordinary models

当前 production active Model Contract 已验证 **19 个**普通模型：

| Model | Version | Status | Typical use |
|---|---:|---:|---|
| Event | 8 | ✅ | 日程 / Location / canonical summary reference label |
| Task | 10 | ✅ | 待办 / canonical name reference label |
| Day Record | 7 | ✅ | 日子记录 / canonical name reference label |
| Wish | 10 | ✅ | 愿望 / canonical title reference label |
| Person Group | 2 | ✅ | 人物分组 / 球队也可作为消费者领域使用场景 |
| Anniversary | 2 | ✅ | 独立纪念日模型；日程样式归消费者负责 |
| Activity | 2 | ✅ | 活动容器，可承载语义关联 |
| Goal | 3 | ✅ | 明确目标状态与 Action 生命周期 |
| Person Profile | 2 | ✅ | 人物档案 |
| Habit | 3 | ✅ | 归属人、打卡及 Action 生命周期 |
| Football Match | 1 | ✅ | `football_match`，比赛领域模型；具体 UI 独立发布 |
| Football Performance | 1 | ✅ | `football_performance`，比赛表现领域模型；统计与 UI 由消费者实现 |
| Health Assessment | 1 | ✅ | `health_assessment` |
| Health Concern | 1 | ✅ | `health_concern` |
| Health Document | 1 | ✅ | `health_document` |
| Health Event | 1 | ✅ | `health_event` |
| Health Metric | 1 | ✅ | `health_metric` |
| Health Observation | 1 | ✅ | `health_observation` |
| Health Regimen | 1 | ✅ | `health_regimen` |

Active Model Contract: `mct_3bb7219eafc9834084e7643251ed8f6103f26196f579b6807246fed4b4b6b2f4`

> Space Person Directory 是 Kernel first-class resource，因此不会作为 ordinary model 出现在本表。

## Release binding

- Release date: **2026-11-14 (UTC+8)**
- Exact production SHA: `533321d0884675ada6aba8558a850d686e700608`
- Production workflow: **[#43530179347](https://github.com/huangshirui/LifeSpace/actions/runs/43530179347)** — ✅ success
- Security maintenance: #567/#575/#576 deployed; Owner-confirmed zero open Dependabot / CodeQL alerts; no platform capability or feature-status changes.
- Core: Kernel `0.54.0` / schema `78`
- Identity: contract `0.19.0` / schema `18`
- APAC exact-candidate performance + Platform Golden Flow prerequisite: ✅ success
- Production HTTP convergence + Cloudflare isolation/bindings: ✅ success
- Production `lsp_svc_* -> Core -> Identity introspection` + active Model Contract verification: ✅ success
- External Provider: **enabled**, Notion Adapter private routing and vault/secret verification ✅；R2 signing credentials ✅
- Core↔Identity shared-secret repair requested: **false**；Bootstrap re-synchronization requested: **false**；既有 Secrets 未重写，Service Token 真实认证成功
- Production Model Admin 使用已配置的专用 `models:manage` `lsp_svc_*`，不再每次通过 Bootstrap 临时创建 Application/User/Principal/Token 或直接删除生产 Identity D1
- 正式 APAC User JWT + Service Token 性能门禁：✅；临时 Probe/Smoke Authority Cleanup：✅

- 独立 Console [#43533673820](https://github.com/huangshirui/LifeSpace/actions/runs/43533673820)、Account [#43534485019](https://github.com/huangshirui/LifeSpace/actions/runs/43534485019)、private MCP Adapter [#43362441505](https://github.com/huangshirui/lifespace-adapters/actions/runs/43362441505) 部署通过；真实 Production OAuth/MCP/Delegation 待验收。

Feature Matrix 状态必须由成功的 production workflow 明确推进，不以 main / staging / downstream consumer 状态代替 production 事实。

## Development-only addition / 尚未部署

Recurrence Plan-to-Task (#338): production 行为必须依当前 Kernel 契约及已发布模型 Capability 独立验证；本次不依据历史 development-only 说明推断所有计划生成模式都完成真实生产业务验收。

Football Match / Football Performance：✅ 已在当前生产 Model Contract（v1）；HomeMew UI、足球图表和消费者端到端发布不属于本次平台生产工作流的验收范围。
