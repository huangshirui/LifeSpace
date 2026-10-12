# Space-local External Models / 空间外部模型

Status: implementation contract for #340; not a production capability.

External Model is a **Query** relationship to provider-authoritative Shared World/Knowledge. Core owns Semantics, Authority and Context Projection (A1/A3/A5); the provider owns record payload/schema. Core never mirrors external business records.

## Identity and lifecycle / 身份与生命周期

`Space Model Catalog = global active Native Models + active External registrations for this Space`. External keys reserve `ext_<32 hex>`; Native publication cannot use `ext_`. Identity is unrelated to display name. Provider/resource identity is unique across **all** connections and Spaces, including disabled registrations. Re-registration in the same Space restores a disabled identity, never moves it to another Space. Active duplicate registration is a conflict. Disable removes runtime availability without deleting provider data or old Grants. Sources are configured under a managing Space; they are execution connections, not ACLs.

Native resolver retains its isolate descriptor path with zero additional D1/HTTP tax. External resolution checks current registration/connection status and reads the latest compatible snapshot. Native immutable Registry/mct lifecycle applies only to Native models. External detail binds `(spaceId,modelKey,schemaHash)` and has no Native model version.

## Credentials / 凭据

Provider tokens live only in a provider Adapter Worker Secret. D1 stores a bounded opaque credential reference. Rotation replaces the Secret at the same reference; revocation disables the connection in Core and removes/disables the Secret. Core connects to one fixed Service Binding, authenticated with an independent >=32 character shared Secret. There is no caller-controlled URL, token forwarding from ordinary callers or public unauthenticated adapter endpoint. Deployment must keep workers_dev/preview URLs disabled and bind matching isolated environments.

Source provisioning is service-only `models:manage` at `/api/v1/model-admin/external-sources`, binding a connection to a Space. A credential reference is not Authority: ordinary Space managers cannot create Sources from guessed server Secret references. Model registration/refresh/disable and Source status/list are Space-management (`spaces:manage`, direct User and current Space manage). Connection creation grants no application/model/data authority. Runtime uses the **same** current Application × Model Access, Membership/Data Grant, scope and Delegation functions as Native.

## Adapter contract / 适配器契约

Canonical internal contract: `apps/core/external-adapter.contract.json`, version `1`. A POST to the fixed `/internal/v1/external-models` accepts providerKey, credentialRef, operation, resourceId and the latest compatible snapshot. It returns normalized data or a bounded generic error code. Provider messages/bodies/headers never enter client errors or audit.

Snapshot contains only supported fields: stable canonical key, source field identity, canonical type, title, nullable/readable/writable/filter operators/sortable and optional enum values. Private bounded `adapterState` holds codecs for **supported** fields only; it is never exposed by Discovery. Unsupported fields do not appear anywhere in the LifeSpace model. Stable source property identity survives rename; types are automatically replaced, without request/data coercion. A schema hash identifies current semantics, not a revision history.

Read/query/write use the same `/models/{modelKey}/records` paths. Response is an external envelope (`id,spaceId,modelKey,origin,schemaHash,data fields,provider timestamps`); it omits fabricated version/createdBy/updatedBy. Query pushes a declared typed subset to the provider and rejects unsupported operators/values. No unbounded scans. Opaque authenticated cursor binds Space/model/schema/query/provider continuation. Pagination is live, not a snapshot; provider sorting/null placement/tie behavior is explicitly provider-defined rather than Native-guaranteed.

## Capability and change boundary / 能力与变更边界

get/query/create/update/delete and bounded per-item bulk may be supported. `atomicBatch`, `transaction`, `versionedWrite`, `actions`, Native Eventing and Native record history are false. Caller-supplied version is rejected. Unified `/models/batch` accepts External CRUD with explicit `atomicConsistency=false` and optional request-wide `delegationId`; atomic/default requests reject before any write. `/models/bulk` remains compatible. Mixed Native/external CRUD requests retain per-item semantics with no distributed transaction; relation actions and cross-provider clientRef dependencies remain unavailable and must be separate requests until their contract is implemented.

External operation audit is `pending -> succeeded | failed | unknown`. It captures verified Application/Principal/Actor/Delegation chain, operation, identity, timestamp and status; no record payload, secret or historical schema. Write audit is persisted **before** provider execution. Crash/network ambiguity remains pending/unknown; it is never reported as a guaranteed failure and never retried blindly. This is operation attribution, not Native Change/outbox or Information Provenance. Single-use delegated writes are rejected because provider success and D1 consumption cannot be atomically guaranteed. Single-use reads use the existing conditional consumption before returning data.

## Freshness and failures / 新鲜度与失败

Registration discovers once; manual refresh and a bounded scheduled reconciliation update only the latest snapshot. Source provisioning requires deployment-supplied `EXTERNAL_SCHEMA_REFRESH_SECONDS` (60–86400); no speculative default SLO is presented as measured. Reconciliation selects at most 20 executable due registrations through the partial next_refresh_at/model_key index, with 2 concurrent refreshes. Disabling a Source parks its queue entries; reactivation schedules enabled registrations immediately. Source and Space liveness filter before LIMIT. External reconciliation, Recurrence rolling and existing outbox dispatch run with independent failure isolation; all failures remain observable. No ordinary operation fetches schema first. An explicitly unexecuted schema-mismatch response permits one refresh and one retry; uncertain writes never retry. Metadata status uses current-state checks. Provider access removal and connection revoke fail closed.

## Relations / 关系

#339 is not merged into the baseline. `relationTargetResolution=false` until #337 wiring is verified. Grouped external-record resolution is a bounded Core hook; it does not authorize callers by itself. A future integration must first authorize model/record endpoints and use that hook, return opaque unavailable for missing/hidden endpoints, reconcile orphan edges and preserve Native-Native atomic cleanup. External delete plus D1 edges cannot be atomic. This dependency is tracked in #340/#337; clients cannot currently create external relation endpoints.

## Verification and rollout / 验证与发布

Synthetic contract/integration tests and structural call-count tests are reproducible. Provider wall latency/freshness SLO, real credential permissions and staging acceptance require an isolated deployed Adapter binding and synthetic Notion data source. Local timings are not provider p50/p95. No production docs may mark this available before successful production deployment.
