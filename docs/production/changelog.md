# LifeSpace Production Changelog

本文件只记录**已经成功发布到 production** 的变化。开发中、staging、PR 或 main 上的变化不得提前写成 production changelog。

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