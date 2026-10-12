# LifeSpace Model Platform Architecture

Updated: 2026-09-23

## Native and External / 原生与外部模型

The DSL/publication/typed-storage/default version guarantees in this document describe **Native** models. The composite resolver is `(spaceId,modelKey) -> Native published descriptor | active local External registration`. Native resolution keeps its existing hot path; reserved `ext_*` addresses use current registration/connection state and latest compatible provider snapshot. External registration is not Native draft/publish/supersede, does not generate mct revisions, and does not inherit Policy/Workflow/Temporal/Calendar or transaction/concurrency guarantees. `docs/external-models.md` owns that boundary.

## 中文摘要

LifeSpace 的普通业务模型采用 metadata-driven runtime。新增一个普通业务模型，不应要求修改 Core 的运行时代码；只有当平台增加新的 Kernel 能力或可复用 Capability 时，才需要新增平台代码。

本文件是当前规范，不记录历史 Phase、迁移顺序或具体消费应用的切换状态。

## 1. Core decision

The governing invariant is:

> Adding an ordinary LifeSpace business model must not require modifying Core runtime source code.

LifeSpace separates explicit Kernel concepts from metadata-driven ordinary models.

Kernel concepts remain explicit code because they define platform authority, identity, governance, security or lifecycle boundaries. Ordinary business records are defined by validated metadata and executed by the Generic Runtime.

## 2. Architecture

```text
LifeSpace
├── Kernel
│   ├── Identity / Application / Principal
│   ├── Space / Membership / Space Person
│   ├── Data Grant / authorization
│   ├── Agent / Delegation / current-state authority
│   ├── audit / tracing / governed change
│   └── environment and deployment security
│
├── Model Platform
│   ├── Model Definition DSL
│   ├── Model Registry
│   ├── publish / supersede / retire lifecycle
│   ├── compiled Runtime Model Descriptors
│   ├── Physical Schema Compiler
│   ├── Generic Resource Runtime
│   ├── relation/reference projection
│   ├── generic CRUD / query / pagination
│   └── contract generation
│
├── Generic Engines
│   ├── Policy
│   ├── Workflow / Actions
│   ├── server defaults
│   └── governed mutation attribution
│
├── Capabilities
│   ├── Calendar
│   ├── Temporal
│   ├── Asset
│   ├── AI Interpretation
│   └── Async Job
│
└── Published Model Definitions
    ├── event
    ├── task
    ├── day_record
    ├── wish
    └── future ordinary models
```

## 3. Kernel boundary

The following are Kernel/platform concepts and are not ordinary user-defined models:

- Identity, users and Application registrations;
- credentials and Service Principals;
- Space, Membership and Space Person;
- Data Grants;
- Agent identity and Delegation;
- Model Registry administration;
- platform audit, signing and security state;
- environment/deployment configuration.

A downstream application may use these concepts, but it must not cause LifeSpace to introduce application-specific Kernel branches.

## 4. Model Definition DSL

Model definitions are executable configuration, not arbitrary code.

Definitions may express:

- stable `modelKey`;
- display metadata;
- version;
- fields and constraints;
- query/search/sort declarations;
- relation/reference semantics;
- read/write/manage access declarations;
- lifecycle options such as optimistic concurrency and soft delete;
- safe policies and Actions;
- reusable Capability bindings.

The DSL must not permit arbitrary JavaScript, SQL, Worker code, shell commands or unrestricted expressions.

AI tooling may propose definitions, but publication always runs through the same validators, compatibility checks and schema planner as any other model change.

## 5. Model lifecycle

```text
draft
  -> validate
  -> compatibility + physical schema plan
  -> publish
  -> active
  -> superseded / retired
```

Published definitions are immutable. A change creates a new version.

Publication rejects invalid model keys, field collisions, unsafe policy/workflow expressions, incompatible relations, unsupported Capability combinations and unsafe physical changes.

Publication records actor, timestamp, schema hash and compatibility classification.

Ordinary model publication must not require a repository commit or Worker deployment.

## 6. Runtime addressing

The stable ordinary Runtime identity is `modelKey`.

Canonical paths are:

```text
GET    /api/v1/spaces/{spaceId}/models/{modelKey}/records
POST   /api/v1/spaces/{spaceId}/models/{modelKey}/records
GET    /api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}
PATCH  /api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}
DELETE /api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}
POST   /api/v1/spaces/{spaceId}/models/{modelKey}/records/{recordId}/actions/{actionKey}
```

Native Runtime resolves `modelKey` to a published compiled descriptor; External resolution also binds the source `spaceId`. It must not dispatch ordinary models to generated per-model routers/services.

## 7. Physical storage

Logical metadata authority and physical persistence are separate concerns.

Current ordinary-record persistence is:

```text
resource_records
  common record identity
  space ownership
  model key/version
  optimistic version
  audit attribution
  timestamps / soft delete

mdl_<model_key>
  one row per ordinary record
  typed scalar business columns
  duplicated space_id for query locality

resource_relations
  Person and ordinary-record relation values
  ordered relation-list entries

Capability projections
  Calendar / Temporal / future capability-specific persistence
```

Rules:

- the published Model Definition is the logical source of truth;
- `resource_records` is the common envelope/catalog, not a universal JSON business-data store;
- scalar model fields use deterministic typed storage;
- relation fields remain in shared relation storage unless a Capability explicitly owns another projection;
- table/column/index names and DDL are generated deterministically from validated definitions;
- destructive physical changes require an explicit safe migration plan.

## 8. Authorization

Effective authority is an intersection:

```text
verified credential scope
∩ Application × Model Access
∩ current Space membership / Data Grant
∩ published model capability and policy
∩ current Delegation when Actor is an Agent
```

Stable metadata may be isolate-cached. Mutable authority must be evaluated from current state so revocation takes effect without waiting for a long-lived authorization cache.

Model administration is platform administration, not an ordinary Space write.

## 9. Policy and Actions

Policy and Action evaluation use a closed deterministic expression language.

Supported context may include:

- `$actor`;
- `$space`;
- `$record`;
- `$input`;
- `$now`.

The evaluator must not use `eval`, arbitrary JavaScript or raw SQL supplied by model definitions.

Actions may perform validated field assignments and state transitions while preserving optimistic concurrency, model policy and governed Change attribution.

## 10. Capabilities

Capabilities exist when a semantic is reusable across models and deserves platform-owned validation/projection/query behavior.

Examples:

- Calendar: timed/all-day semantics, timezone handling and interval queries;
- Temporal: date/instant range semantics and occurrence projection;
- Asset: safe object ownership and replacement;
- AI Interpretation: structured model-aware interpretation/proposal flow;
- Async Job: bounded asynchronous execution infrastructure.

A Capability must not become a disguised application-specific feature.

## 11. Contract ownership

Canonical inputs are:

1. explicit Kernel API definitions;
2. published Model Registry definitions;
3. registered Capability contract contributions.

The Kernel contract remains explicit. Ordinary Model Contracts are generated deterministically from published model semantics.

Applications pin explicit compatible LifeSpace contract identities in their own repositories. LifeSpace does not maintain consumer-specific dependency pins or acceptance profiles.

## 12. Change rules

When changing the model platform:

- preserve the Kernel/ordinary-model boundary;
- do not add handwritten CRUD for an ordinary model;
- do not make physical schema the semantic source of truth;
- do not introduce universal JSON storage as a shortcut for undeclared fields;
- do not cache mutable authority as stable metadata;
- do not add consumer-specific runtime branches;
- do not expose raw platform storage details as public model contracts;
- preserve Generic Runtime validation, optimistic concurrency and governed Change evidence.

## 13. Acceptance invariants

A healthy Model Platform satisfies all of the following:

- a new ordinary model can be published without Core source changes;
- its typed persistence is created from validated metadata;
- Runtime validation and query behavior derive from the published descriptor;
- Application × Model Access and Space authority remain explicit;
- no hot request requires reparsing model definitions from D1;
- list/query hydration remains bounded and non-N+1;
- ordinary mutations preserve Principal / Actor / Application / Delegation attribution where applicable;
- consumer applications remain downstream dependencies only.
