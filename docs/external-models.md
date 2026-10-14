# Space-local External Models / 空间外部模型

Status: implementation contract for Federated Truth / External Data; not production availability evidence until the exact candidate passes production rollout.

External Model is a **Query** relationship to provider-authoritative Shared World/Knowledge. Core owns Semantics, Authority and Context Projection; the provider owns record payload/schema. Core never mirrors external business records.

## Business definition and Space binding / 业务定义与空间绑定

External models first publish a provider-neutral business definition through the existing Model Registry / Console Model publishing flow. The closed definition declares `origin: external`, stable business `key`, display/description, access ceiling and outgoing Semantic Relations, with `fields: {}`. It does not prescribe provider fields, generate a native table or inherit Native Actions/Capabilities/versioning.

A Space then configures:

```text
Provider
  → Connection
  → Provider Resource / Data Source
  → published External Model Definition binding
```

The **same Space API is the canonical product setup contract for Console and downstream applications** such as ALOHA/HomeMew. Console is only one client; it is not a hidden provisioning authority.

A binding stores the latest compatible Provider snapshot and associates it with the stable business definition. One active binding per `(spaceId, definitionKey)` is allowed; one provider resource still belongs to exactly one source Space. The public model address and Authority key are the stable business key; `ext_*` remains the binding identity. Legacy untyped registrations keep explicit `ext_*` CRUD addressing.

Provider schema discovery is automatic and latest-only. Immutable Registry/mct pins business semantics only; Provider fields stay dynamic and are read from Space Discovery. Unsupported Provider fields are absent rather than represented as provider-specific pseudo-types.

`Space Model Catalog = global active Native Models + active External registrations for this Space`. Native publication cannot use `ext_`. Provider/resource identity is unique across connections and Spaces, including disabled registrations. Disabling a binding removes runtime availability without deleting provider data or old Grants.

## Product Connection configuration / 产品连接配置

Normative product contract: `apps/core/external-connection.openapi.yaml`.

A direct User with `spaces:manage` plus current Space `manage` authority can:

- discover supported Providers;
- create/list/update Space Connections;
- rotate a managed credential or reduce/restore its read/write ceiling;
- discover Provider resources visible through one managed Connection;
- bind a published External Model Definition to a selected resource.

The public create/update API **never accepts a server-side `credentialRef`**. It accepts the Provider credential as transient authenticated request input. Core generates an opaque `cnx_*` reference, immediately forwards the credential through the fixed private Adapter Service Binding and persists only Space Connection metadata plus the opaque reference. Provider plaintext is never returned and never stored in Core D1, Model Registry, audit payloads or Console/application state.

The public Connection ID is `exc_*`. The persisted table is still `external_sources` for compatibility; `sourceId` remains an accepted legacy alias in External Model 0.2 while new product callers use `connectionId`.

`credentialMode=managed` means product-configured and supports resource discovery/credential update. `credentialMode=bootstrap` means deployment-managed compatibility. Bootstrap connections may be inspected/disabled but their credential cannot be changed and their resource catalog is not exposed through the product API.

Connection creation grants **no** Application × Model Access, Membership, Data Grant, Delegation or record permission. Runtime uses the same current Application × Model Access, Membership/Data Grant, scope and Delegation functions as Native.

## Credential ownership / 凭据归属

Dynamic Provider credentials are owned by the private Provider Adapter. The Notion Adapter maps each generated `cnx_*` to one SQLite-backed Cloudflare Durable Object. That object stores the token and connection read/write ceiling and performs Provider execution for that connection; the credential therefore does not need to be returned to the outer Adapter Worker after setup.

The Durable Object is a credential/runtime isolation mechanism, **not** a second authorization system. LifeSpace Space/Grant/Application/Delegation authority remains exclusively in Core. Different connections use different Durable Objects; one connection naturally shares pacing/circuit state without serializing unrelated connections.

Deployment-managed `NOTION_CONNECTIONS` remains supported only for bootstrap/staging/ops use. `POST /api/v1/model-admin/external-sources` remains service-only `models:manage` for binding such a preconfigured opaque reference to a Space. An ordinary Space manager cannot submit or guess these server-side references.

Core and Adapter authenticate over one fixed Service Binding with an independent >=32-character shared Secret. The Adapter has no public workers.dev/preview/custom-domain endpoint. Staging and production use separate Workers, Durable Object namespaces, secrets and Connection state.

## Adapter contracts / 适配器契约

Runtime execution contract: `apps/core/external-adapter.contract.json`, version `1`, on private `/internal/v1/external-models`.

Connection-management contract: `apps/core/external-connection-adapter.contract.json`, version `1`, on private `/internal/v1/external-connections`. Operations are `describe`, `create`, `update`, `delete`, `listResources`. Credential plaintext may appear only in create/update input and must never be echoed or logged. Provider-specific resource discovery is normalized to `{id,type,displayName}` plus opaque pagination cursor.

Snapshot contains only supported fields: stable canonical key, source field identity, canonical type, title, nullable/readable/writable/filter operators/sortable and optional enum values. Private bounded `adapterState` holds codecs for supported fields only; it is never exposed by Discovery. Stable source property identity survives rename. A schema hash identifies current semantics, not a revision history.

Read/query/write use the same `/models/{modelKey}/records` paths. Response is an External envelope without fabricated Native version/createdBy/updatedBy. Query pushes a declared typed subset to the provider and rejects unsupported operators/values. No unbounded scans. Cursor binds Space/model/schema/query/provider continuation. Provider sorting/null placement/tie behavior remains provider-defined.

## Capability and change boundary / 能力与变更边界

get/query/create/update/delete and bounded per-item bulk may be supported. `atomicBatch`, `transaction`, `versionedWrite`, `actions`, Native Eventing and Native record history are false. Caller-supplied version is rejected. Unified `/models/batch` accepts External CRUD only with `atomicConsistency=false`; atomic/default requests reject before Provider I/O.

External operation audit is `pending -> succeeded | failed | unknown`. It records verified Application/Principal/Actor/Delegation chain, operation, identity, timestamp and status; it does not store record payload, credential or historical schema. Write audit is persisted before Provider execution. Crash/network ambiguity is never reported as guaranteed failure and is never retried blindly. Single-use delegated writes remain rejected because Provider success and D1 consumption cannot be atomically guaranteed.

## Freshness and failures / 新鲜度与失败

Registration discovers once; manual refresh and bounded scheduled reconciliation update only the latest snapshot. `EXTERNAL_SCHEMA_REFRESH_SECONDS` is deployment configuration, not a measured freshness SLO. Reconciliation selects bounded indexed work and keeps disabled Connections/bindings out of executable queues. No ordinary operation fetches schema first. An explicitly unexecuted schema mismatch may refresh and retry once; uncertain writes never retry.

Provider access removal, Connection disable/revoke and missing business definition fail closed. Provider errors are normalized; raw Provider bodies/messages/headers do not enter client errors or audit.

## Relations / 关系

Published active External business bindings participate in the same Semantic Relation API using business model keys. Source write and target read are checked before Provider resolution. Native-Native commit/cleanup remains atomic; External endpoints reject atomic batch before Provider I/O and never invent Native versions. Provider record writes and D1 edges do not roll back together.

Confirmed through-LifeSpace Provider deletion invalidates observed identity and cleans local edges afterward. Provider-direct absence remains opaque because missing and denied cannot reliably prove deletion. Periodic observation is bounded and stores only availability/observation metadata, never Provider payload or saved User/Delegation tokens.

## Console and application UX / Console 与应用入口

Normal UX belongs to the application managing the Space. Console exposes the same flow as a reference/governance client:

1. select Provider;
2. enter credential and create a named Connection;
3. select a Provider resource discovered through that Connection;
4. select an already published External Model Definition;
5. bind with read/write ceiling.

The browser sends credential only to its own bounded same-origin BFF/application backend. The backend obtains a LifeSpace User token with `spaces:manage` and calls the public Core API. Console does not use its platform Core executor or hidden membership for this flow. Downstream apps should use the same Core contract rather than duplicating credential storage or calling the Provider directly.

External Model Definition publication remains platform Model Registry governance and can stay in Console/Model Admin. Ordinary application settings bind already-published definitions to that Space.

## Verification and rollout / 验证与发布

Synthetic unit/integration tests prove contract boundaries. Real Provider acceptance requires an isolated Adapter deployment and synthetic Notion resources. Deployment remains code-owned by canonical manual platform workflows: deploy the immutable Adapter revision in `infra/external-provider.json` before Core, synchronize the independent shared Secret, run migrations, verify private bindings/DO packaging, then run real staging acceptance.

Staging browser acceptance must exercise the **product flow** above: create a managed Connection, discover the second synthetic Data Source, bind it and verify descriptor-driven fields/read/write behavior. It must not rely on staging-only direct D1 provisioning as proof of product completeness.

No production document may mark this capability available until the exact candidate passes staging, APAC gates where applicable, production deployment and post-deploy verification.
