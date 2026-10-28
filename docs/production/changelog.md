# LifeSpace Production Changelog

本文件只记录**已经成功发布到 production** 的变化。开发中、staging、PR 或 main 上的变化不得提前写成 production changelog。

## 2026-10-28 — Identity Bootstrap 日常发布依赖收敛（Production #40628917903）

- **Verified release:** SHA `c5c1efa631cba7cee191a14a8bfab78dff033887`；[Staging #40626481504](https://github.com/huangshirui/LifeSpace/actions/runs/40626481504) 和 [Production #40628917903](https://github.com/huangshirui/LifeSpace/actions/runs/40628917903) 成功。Production 三个 Job 全部通过：人工发布来源确认、严格 APAC 性能验收、真实 Production Core/Identity 部署与验证。
- **当前已发布版本：** Core Kernel `0.53.0` / schema `76`（保持不变）；Identity Application contract `0.17.0` / schema `14`（此前生产为 `0.15.0`）。Identity 普通 Application OpenAPI 已将 Bootstrap 管理操作归入单独的 Platform Admin companion contract（源文件版本 `0.6.0`，仍保持 Bootstrap-only 安全约束），**没有删除服务端首次 Seed/Break-glass 路由**。
- **生产日常发布不再调用 Bootstrap 做管理：** 默认只检查 Identity Worker 现有 `BOOTSTRAP_SECRET` 的存在性并保留值，不再每次重新写入；本次执行时明确输出 `bootstrapSecret: preserved`。本次未勾选 `sync_production_bootstrap_secret` 或 `repair_core_identity_shared_secret`；既有 RS256 signing 和 Core↔Identity shared authentication secret 均保留。
- **Model Admin 真实验证：** 由现有 GitHub production Environment 的独立 `LIFESPACE_PRODUCTION_MODEL_ADMIN_BEARER`（canonical `lsp_svc_*`，`models:manage`）完成真实 Core↔Identity service introspection、必要的兼容模型语义发布和 Active Model Contract 精确校验；日志报告 `serviceAuthentication: lsp_svc_to_core_introspection_passed`、`identityMutationsByVerifier: false`、`publishedSemanticModels: []`。正常发布不再通过 Bootstrap 新建生产临时 Application/User/Service Principal，也不再执行 Identity D1 删除测试身份。
- **模型契约保持：** Active `mct_21ac4fd66f72ea4dfe259974970a0eb55c1e02a4424003404897862d2e8629d3`，仍为 **12** 个普通模型（Task v10、Wish v10、Day Record v7、Event v8、Person Group v2、Anniversary v2、Activity v2、Goal v3、Person Profile v2、Habit v3、Football Match v1、Football Performance v1），本次没有重复发布模型。
- **验收与边界：** 正式 APAC 门禁（User JWT + Service API Token，场景级 P50/P90）通过，临时 Probe 和测试凭证已清理；Production HTTP/schema/contract、Cloudflare 资源隔离、External Provider 私有路由/Secret/Vault 绑定均通过。此发布**没有重新部署 Console、HomeMew、n8n 或 ALOHA**，也没有验证真实生产 Notion 业务 CRUD。首次初始化和显式失联恢复仍保留独立 Bootstrap 流程，不能将本次常规发布成功解释为已实测 break-glass 流程。

---

## 2026-10-27 — Reference labels, Record Icon file link repair and current Model Contract (Production #50)

- **Verified release:** SHA `0ab94ccf4aeeaa6e9309b6a344d7280051691a21`; [Staging](https://github.com/huangshirui/LifeSpace/actions/runs/40436370316) and [Production #50](https://github.com/huangshirui/LifeSpace/actions/runs/40438311024) completed/success. All three production jobs passed, including exact-candidate provenance and APAC performance gate.
- **Core:** Kernel `0.53.0` / schema `76`. **Identity:** contract `0.15.0` / schema `14`. These are verified production database/service versions, not implied by main branch alone.
- **Active Model Contract:** `mct_21ac4fd66f72ea4dfe259974970a0eb55c1e02a4424003404897862d2e8629d3`, verified against Production D1 with **12** ordinary models: Task v10, Wish v10, Day Record v7, Event v8, Person Group v2, Anniversary v2, Activity v2, Goal v3, Person Profile v2, Habit v3, Football Match v1 and Football Performance v1. The two football models are verified as published, but this workflow does not deploy or validate HomeMew's football UI/stats.
- **Schema 75 reference labels:** Task `name`, Wish `title`, Day Record `name`, Event `summary` now supply their declared canonical Reference Resolution display labels; labels for other models remain model-defined (or use contract-supported fallback).
- **Schema 76 Record Icon repair:** a normal business-field update no longer detaches an unchanged `presentation.icon` image File; the migration restores only unambiguous legacy missing `__record_icon` links. Post-release production inspection found **two** active image Icons and **zero** missing links, including the previously affected HomeMew 「明强」 team; both corresponding R2 objects exist and file sizes match. Actual HomeMew browser download/rendering still requires consumer-side acceptance.
- **Changed release verifiers:** schema 75 published model hashes are now correctly pinned by Staging/Production proving checks, without bypassing strict equality or release version floors ([PR #421](https://github.com/huangshirui/LifeSpace/pull/421)); Staging D1 convergence, authenticated R2 upload/download, Model Contract, Golden Flow, Eventing and performance checks all passed.
- **Boundaries/limits:** No new Space/Grant authority or bypass, no automatic downstream deployment; Notion production business CRUD was not proven by this deployment. Generic Batch Execute Action, full Federated Truth and generic Provenance remain outside verified production claims. Console rollout is separately governed.

---

## 2026-10-22 — Core/Identity and baseline models production release #42

- **Verified release:** SHA `4e2eb18aa35738aae9f908e86ee55063a58c4466`; [Staging #147](https://github.com/huangshirui/LifeSpace/actions/runs/39750058970) and [Production #42](https://github.com/huangshirui/LifeSpace/actions/runs/39752702491) successful.
- **Core:** Kernel 0.53.0 / schema 72 (was 0.49.0 / 53). **Identity:** contract 0.12.0 / schema 11 (was 0.11.0 / 11).
- **Active Model Contract:** `mct_ee9aa79db15247e204572f14703ffb8e5bdab90854133224f13f02df8518f172`; ten published models: Task v9, Wish v9, Day Record v6, Event v6, Person Group v1, Anniversary v1, Activity v1, Goal v2, Person Profile v1, Habit v2.
- **New capabilities:** Goal lifecycle via Actions; Habit one-person ownership and authorized Check-in; five new baseline models; independently routed production Notion External Provider deployment verified. R2 integration prerequisites passed.
- **Production verification:** database migrations, Core/Identity deployment, APAC performance and Golden Flow, environment isolation, live Service authentication and active Model Contract all passed.
- **Operational change:** APAC promotion uses 45 timed samples per scenario with unchanged P50/P90 targets. This improves the percentile estimate, not measured runtime speed.
- **Limits:** Production provider business CRUD is not claimed from deployment checks alone; model availability does not automatically configure consumer application access or ship HomeMew UI. Football Match/Goal are excluded from baseline pending manual publication. Generic batch Action, complete Federated Truth modes and generic provenance are not claimed here.
- **Consumer impact:** HomeMew / ALOHA / n8n can adopt the published models after explicit Application × Model Access and consumer deployment. No HomeMew deployment is performed by this platform release.

---

## 2026-10-09 — Configuration-time Model Semantic Discovery 与当前 0.49/0.11 Production 基线

### Release metadata

- SHA: `6659ad86c5ea8a893f22f28a42f89f2e0371523c`
- Production workflow: **Deploy LifeSpace platform production #37** / run `37936055161` — ✅ success
- Core: Kernel `0.49.0` / schema `53`
- Identity: contract `0.11.0` / schema `11`
- Active Model Contract: `mct_bc784389d406c580cbaf1a9cafaa48a155732771e1b24f058fcb884bffcb2345`
- Active models: Task v8 / Wish v9 / Day Record v5 / Event v6 / Person Group v1
- Exact-candidate APAC performance gate + Platform Golden Flow: ✅ passed before production mutation
- Production HTTP convergence, Cloudflare isolation/bindings, canonical `lsp_svc_*` service authentication and active Model Contract verification: ✅ passed
- Core↔Identity shared-secret repair requested: `false`

### Added / production-confirmed

- Configuration-time Model Semantic Discovery：新增 `GET /api/v1/me/_discovery/models` 与 `GET /api/v1/me/_discovery/models/{modelKey}`，让消费者在配置阶段获取当前 Application 可配置的静态模型语义，而不要求调用方已经拥有某个具体 Space 的 Membership、Data Grant 或 Delegation。
- 配置期可见性与运行时数据 Authority 正式分离：选择/填写某个 Space 或 Record Type 不等于获得对应数据权限；真正执行仍由 Direct Authority 或有效 Delegation 决定。
- Exact-candidate production gate 再次验证现有 Agent Credential / Authorization Request / Delegation / Runtime / Model Contract 闭环，并确认新增配置期 discovery 不改变运行时授权边界。

### Changed

- Core Kernel 从 `0.48.0` 升至 `0.49.0`；schema 保持 `53`，本次 release 无新的 Core D1 migration。
- 当前 Production Identity 基线为 contract `0.11.0` / schema `11`；本次 #37 exact candidate 无新的 Identity D1 migration，production verifier 对该状态重新确认。
- Active Model Contract 与普通模型集合保持不变，仍为 5 个模型：Task v8 / Wish v9 / Day Record v5 / Event v6 / Person Group v1。
- Production runtime signing material 与 Core↔Identity shared authentication secret 均保留既有值；真实 `lsp_svc_* -> Core -> Identity introspection` gate 通过，因此本次未触发 shared-secret repair。

### Known limitations

- 通用 Execute Action Batch 尚未作为 production contract 提供。
- Federated Truth / Own-Mirror-Reference-Query 仍是后续专项，不属于当前 production capability。
- 通用 Information Provenance / External Reference / transformation lineage 尚未提供平台级 contract。
- n8n / HomeMew / ALOHA 的适配与发布是 downstream lifecycle，不由本次平台 Production workflow 自动完成。
- Console application 有独立 Production rollout；本 release 的 Core/Identity 成功不等价于新 Console application version 已 rollout。

### Human-readable impact

- Consumer 可以先配置“目标 Space + Record Type”，即使 Agent 当前还没有这个 Space 的 Direct Data Grant；配置动作本身不会越权。
- Agent 运行时有 Direct Grant 就直接执行；需要代表 User 时仍通过 Authorization Request / Confirm / `dlg_*` 获取受限 Authority；没有任何有效 Authority 时继续 fail closed。
- n8n 等 adapter 可以把 Space 选择器作为便利功能、允许直接填写 `spc_*`，同时通过新的静态 Model Semantic Discovery 获取 Record Type schema，而不再把编辑器配置能力错误地绑定到当前 Space 数据权限。

> 注：`docs/production` 在 #37 成功后补齐到当前 exact-candidate 基线。Identity `0.11.0` / schema `11` 是 #37 production verifier 已确认的当前状态；本条不反向推断此前未记录 release 的首次上线时点。

---

## 2026-10-08 — Agent Credential / Authorization Request、Person Directory、Non-atomic Bulk 与 Creation Draft retirement

### Release metadata

- SHA: `cc60fa13071b72b2f4d75db43999be38648cacd6`
- Production workflow: **Deploy LifeSpace platform production #34** / run `37651204090` — ✅ success
- Core: Kernel `0.48.0` / schema `53`
- Identity: contract `0.10.0` / schema `9`
- Active Model Contract: `mct_bc784389d406c580cbaf1a9cafaa48a155732771e1b24f058fcb884bffcb2345`
- Active models: Task v8 / Wish v9 / Day Record v5 / Event v6 / Person Group v1
- Exact-candidate APAC performance gate + Platform Golden Flow: ✅ passed before production mutation
- Production HTTP convergence, Cloudflare isolation/bindings, canonical `lsp_svc_*` service authentication and active Model Contract verification: ✅ passed

### Added / production-confirmed

- First-class Agent API Credential：canonical `lsp_agt_*`，绑定 Application + Agent，可撤销；持有 credential 本身不授予 Space / Model / User Authority。
- Authorization Request protocol：Agent/Application 可提交待确认授权请求；用户 Confirm 后产生 Delegation，deny/cancel/pending 均不产生代表 Authority。
- Exact-candidate Platform Golden Flow 已验证 `Agent Credential -> Authorization Request -> Confirm -> Delegation -> governed mutation`。
- First-class Person Directory CRUD/list/search：Space Person (`per_*`) 继续是 Kernel business-policy context，而不是 Authority-bearing identity。
- Person alternate names / aliases：primary display name 与 alternate names 可用于人物检索。
- Person Group v1：作为普通 metadata-driven model 进入 active Model Contract，用于人物分组/圈子等领域关系，不把 Person Group 硬编码进 Kernel。
- Non-atomic Runtime Bulk：`POST /api/v1/spaces/{spaceId}/models/bulk`，bounded mixed create/update/delete；每项独立 success/failure，允许部分成功，同时保持 set-wise preparation 与 `blk_*` correlation。

### Changed

- Canonical Service API Token 前缀统一为 `lsp_svc_*`；legacy `lsp_pat_*` 只保留运行时/迁移兼容。Consumer-facing OpenAPI/contract metadata 已由 CI guard 防止回退。
- Core 从 Kernel `0.43.0` / schema `48` 升至 `0.48.0` / schema `53`，Production 应用 migrations `0049_authorization_requests.sql`、`0050_non_atomic_bulk.sql`、`0051_space_person_names.sql`、`0052_person_group_model.sql`、`0053_remove_creation_draft_jobs.sql`。
- Identity 从 contract `0.8.0` / schema `8` 升至 `0.10.0` / schema `9`，Production 应用 `0009_agent_api_credentials.sql`。
- Production promotion 的 APAC prerequisite 不再只做版本/性能检查：同一 exact candidate 会重新执行 Platform Golden Flow，避免 alternate staging path 绕过 Agent Credential / Authorization Request / Person / Bulk 治理闭环。
- Active Model Contract 从 4 个普通模型扩展为 5 个，新增 Person Group v1。

### Removed / retired

- Creation Draft 已退出当前 Production：当前 API / contracts / runtime / tests 不再提供该能力，schema 53 删除 `creation_draft_jobs` runtime table。
- 历史 `0009_creation_draft_jobs.sql`、`0015_registry_creation_drafts.sql` 等 migration 文件继续保留，原因是已执行 migration history 必须不可变；它们不是当前能力声明。

### Production incident / operational hardening

本 release 第一次 Production 尝试在最终 Model Admin service-auth gate 暴露了历史 Core↔Identity `CORE_IDENTITY_SHARED_SECRET` 值漂移：Cloudflare secret API 只能证明两端**存在同名 secret**，不能证明 write-only secret 的值相同。

PR #329 因此增加显式、default-off 的 recovery control：只有 operator 明确请求时才重新生成并同步两端 runtime shared secret；普通 release 不自动轮换，bootstrap secret 也不复用为 runtime authentication secret。成功 run #34 执行一次 repair 后，真实 `lsp_svc_* -> Core -> Identity introspection` 与 Model Contract gate 通过。

### Known limitations

- 通用 Execute Action Batch 尚未作为 production contract 提供。
- Federated Truth / Own-Mirror-Reference-Query 仍是后续专项，不属于当前 production capability。
- 通用 Information Provenance / External Reference / transformation lineage 尚未提供平台级 contract。
- n8n / HomeMew / ALOHA 的适配与发布是 downstream lifecycle，不由本次平台 Production workflow 自动完成。
- Console application 有独立 Production rollout；本 release 的 Core/Identity 成功不等价于新 Console application version 已 rollout。

### Human-readable impact

- Agent 现在可以只持有一个正式 `lsp_agt_*` credential，并通过标准 Authorization Request / Delegation 流程获得用户明确确认后的代表权限。
- “人物”成为可检索、支持多个称呼的 first-class Space Directory；人物分组则保持普通模型，可独立演进。
- Consumer 可以按业务需求选择 Atomic Batch（全部成功或回滚）或 Non-atomic Bulk（逐项独立结果、允许部分成功），不再把“性能批量”和“原子一致性”混为一件事。
- Creation Draft 不再是平台当前概念，减少了一套不再需要的 API/runtime/storage 基础设施。

---

## 2026-10-05 — Authority v3、First-class Batch 与首个 exact-SHA production baseline

这是 Production Documentation 机制建立后的第一条与成功 production workflow 精确绑定的 release 记录。

### Release metadata

- SHA: `0b28eeb202f0a5535a4b802f6d474f7289b2e382`
- Production workflow: **Deploy LifeSpace platform production #30** / run `37248751610` — ✅ success
- Core: Kernel `0.43.0` / schema `48`
- Identity: contract `0.8.0` / schema `8`
- Active Model Contract: `mct_90595ab8f69914ddf156ae699361204db0fba5fb95fcc93bed06881ef44efcab`
- Active models: Task v8 / Wish v9 / Day Record v5 / Event v6
- APAC performance gate: ✅ passed for the same exact candidate SHA before production mutation
- Production HTTP convergence, Cloudflare isolation/bindings and active Model Contract verification: ✅ passed

### Added / production-confirmed

- Authority v3 generalized entity capability：Identity-capable Entity 是否可作为 Principal / 接收 Delegation 由平台 capability 控制。
- Agent Principal / Actor 正式进入 production Authority 与 Change attribution 路径。
- Root / Child Delegation 与 bounded re-delegation chain。
- Single-use Delegation ancestor consumption：在真实 mutation commit 时原子消费 Authority chain。
- Atomic multi-Delegation issuance：`POST /api/v1/spaces/{spaceId}/delegations/batch`，bounded `1..20`，每项仍为独立 immutable single-scope `dlg_*`，整批全成功或零落地。
- First-class Runtime Batch：`POST /api/v1/spaces/{spaceId}/models/batch`，同一 Space 内跨普通 Model 的 atomic `create / update / delete`。
- Explicit `cgs_*` ChangeSet 作为 Runtime Batch 的 Governed Change 原子边界。
- Batch update/delete 支持服务端解析当前 version，同时保持同一 atomic ChangeSet。
- Integration/Eventing `change_set.committed` 聚合投递；每条 mutation 仍保留独立 Change / Domain Event evidence。
- Eventing current-authority revocation boundary：subscriber / Service 当前 Authority 失效后 fail closed。

### Changed

- Production Core 应用了 `0047_authority_v2_batch_changeset.sql` 与 `0048_authority_role_capability_redelegation.sql`。
- Kernel contract 升至 `0.43.0`；runtime `/api/v1/status`、OpenAPI `info.version` 与 `StatusResponse.contractVersion` 现在由 repository gate 强制一致。
- Identity contract 升至 `0.8.0`；本次无新的 Identity schema migration，schema 保持 `8`。
- Information Provenance 平台边界收敛为 **concept only**：不提供通用 Resource Provenance envelope / 独立存储 / lineage graph；可验证的 Change / Operation Attribution 继续作为当前平台 durable evidence。

### Known limitations

- 通用 Execute Action Batch 尚未作为 production contract 提供。
- Federated Truth / Own-Mirror-Reference-Query 仍是后续专项，不属于当前 production capability。
- 通用 Information Provenance / External Reference / transformation lineage 尚未提供平台级 contract。

### Human-readable impact

- Agent 可以在更清晰的 Principal / Actor / Delegation Authority 模型下执行，且 re-delegation 与 single-use Authority 有平台级约束，而不是由 Adapter 自行约定。
- 一个用户确认需要多个 scope 时，应用可以一次原子签发多条独立 Delegation，不会出现只成功一部分的 Authority 状态。
- ALOHA / HomeMew / n8n 等消费者可以使用同一 First-class Runtime Batch 一次性提交多个 create/update/delete，并获得平台级 atomicity、ChangeSet 与聚合 Eventing。
- Production 状态从本 release 开始有 exact SHA、contract/schema、active Model Contract 的可追溯基线。

---

## 2026-10-03 — Production documentation baseline established

这是 Production Documentation 机制的建立时间，不代表一次新的 production deployment。

- 新增 Production Capability Guide；
- 新增 Feature Matrix；
- 建立 release metadata / exact SHA 绑定规则；
- 建立“production workflow 成功后必须同步文档，才算发布完整收尾”的规则；
- 对无法从历史文档精确绑定到 production release SHA 的能力使用 `❓ Needs verification`，不进行猜测。

### Release metadata

- Production deployment SHA: **not backfilled**
- Reason: 在本机制建立前，仓库没有保存“最后一次成功 production deployment SHA → 人类可读 feature snapshot”的映射。
- Resolution: 首个 exact-SHA baseline 已由 **2026-10-05 release** 建立；本历史条目不反向猜测此前 production SHA。

---

## Entry template for future production releases

```md
## YYYY-MM-DD — <short release title>

### Release metadata
- SHA: `<exact production workflow candidate SHA>`
- Core contract/schema: ...
- Identity contract/schema: ...
- Active Model Contract: ...

### Added
- ...

### Changed
- ...

### Removed / deprecated
- ...

### Known limitations
- ...

### Human-readable impact
- 对普通用户 / consumer app / Agent / operator 有什么变化。
```
