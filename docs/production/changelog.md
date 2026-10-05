# LifeSpace Production Changelog

本文件只记录**已经成功发布到 production** 的变化。开发中、staging、PR 或 main 上的变化不得提前写成 production changelog。

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