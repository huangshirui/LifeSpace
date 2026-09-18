# LifeSpace Model Definition Specification v1

Status: **Normative human-readable specification**  
Definition version: **1**  
Scope: ordinary metadata-driven business models in LifeSpace Core

## 1. Purpose and authority

This document is the human-readable specification for LifeSpace **模型定义（Model Definition）v1** and its embedded **策略（Policy）**、**记录动作 / 转换（Record Action / Transition）** and **能力（Capability）** declarations.

The purpose of the DSL is to let LifeSpace describe ordinary Shared Reality semantics without adding one handwritten router/service/table implementation per domain model.

The intended chain is:

```text
Model Definition
  -> validation
  -> Model Registry publication
  -> Runtime Model Descriptor
  -> Generic Runtime / Policy / Workflow / Capability engines
  -> generated OpenAPI + JSON Schema Model Contract Revision
```

Normative ownership is split deliberately:

- this document defines the human-readable DSL semantics;
- `apps/core/src/model-definition.ts`, `time-range-definition.ts`, `policy-definition.ts`, `workflow-definition.ts` and `capability-definition.ts` are the machine validators and must remain aligned with this specification;
- runtime implementation and automated tests verify executable behavior;
- a published Model Registry version plus its immutable `mct_*` Model Contract Revision is the exact contract evidence for a deployed model version.

If this specification, validator, runtime, tests or generated Model Contract disagree, treat that as **contract drift to fix**, not as permission to silently choose whichever interpretation is convenient.

Notion documentation may explain this specification, but it is not an independently editable second source of protocol truth.

## 2. Mental model

A Model Definition answers six different questions:

```text
Model
├── Fields       — what typed data does this thing contain?
├── Query        — how may clients find it?
├── Access       — what model-level operation classes exist?
├── Policy       — who may perform an otherwise-authorized operation?
├── Actions      — what model-specific semantic changes can be invoked?
└── Capabilities — which reusable cross-model semantic packages does it conform to?
```

Do not collapse these concepts:

- **字段（Field）** describes state. Time values are fields too: `instant`, `date`, `range<instant>`, `range<date>` and `temporal_range` are first-class logical field types.
- **CRUD** is the generic transport for ordinary state access/change.
- **记录动作 / 转换（Record Action / Transition）** is a named, single-record semantic command specific to a model, such as `Task.complete`.
- **变更权限（Mutation Authority）** declares which mutation surface owns a field change: ordinary CRUD, or trusted model semantics such as an Action/Capability.
- **策略（Policy）** is a deny-capable authorization refinement.
- **守卫（Guard）** decides whether an Action is valid in the current business state.
- **分支（Branch）** chooses the effect of an Action from current record state.
- **能力（Capability）** is a reusable cross-model semantic contract + runtime package, such as Calendar or Temporal.

A Capability may contribute Actions, queries, validation, computed output or auxiliary storage, but a Capability is not merely a collection of Actions.

## 3. Top-level Model Definition

The v1 top-level shape is:

```ts
{
  definitionVersion: 1,
  key: string,
  description?: string,
  display: {
    singular: string,
    plural: string
  },
  fields: Record<string, FieldDefinition>,
  referenceLabel?: { field: string } | { template: string },
  defaults?: Record<string, DefaultValue>,
  query?: {
    searchable?: string[],
    filterable?: string[],
    sortable?: string[]
  },
  access: ("read" | "write" | "manage")[],
  lifecycle?: {
    optimisticConcurrency?: true,
    softDelete?: true
  },
  capabilities?: CapabilityDefinitions,
  policies?: ModelPolicies,
  actions?: WorkflowActions
}
```

Unknown top-level properties are rejected.

### 3.1 `definitionVersion`

Must be exactly `1`.

The definition version versions the DSL language itself. It is different from the published model version in the Model Registry.

### 3.2 `key`

Stable logical identity of the model.

Current syntax:

```text
^[a-z][a-z0-9_]{1,62}$
```

Examples:

```text
task
day_record
football_match
```

The key is not a UI label and should not change merely for presentation reasons.

### 3.3 `description`

Optional semantic description, maximum 500 characters after trimming.

The description should explain **what the model means and when to use it**, not only restate its display name. It is useful to humans, generated clients and AI interpretation/discovery.

### 3.4 `display`

Human-facing singular and plural labels. Both are required and limited to 1–80 characters after trimming.

They do not define model identity; `key` does.

## 4. Field Definition

A model must declare at least one field and may declare at most 100 fields.

Field keys use:

```text
^[a-z][A-Za-z0-9]{0,62}$
```

Examples:

```text
name
dueDate
ownerPersonId
completedAt
```

The following common envelope fields are reserved and are owned by the Generic Runtime:

```text
id
spaceId
modelKey
modelVersion
version
createdAt
updatedAt
deletedAt
createdBy
updatedBy
```

### 4.1 Field types

v1 supports:

| Type | Meaning |
|---|---|
| `string` | trimmed short/general string |
| `text` | text whose whitespace is preserved |
| `integer` | finite integer |
| `number` | finite number |
| `boolean` | boolean |
| `date` | calendar date, `YYYY-MM-DD` |
| `instant` | absolute RFC 3339 instant with `Z` or numeric offset; runtime normalizes it to one absolute Instant representation |
| `range<date>` | one first-class half-open `Range<Date>` value: `{ start, endExclusive }` |
| `range<instant>` | one first-class half-open `Range<Instant>` value: `{ start, endExclusive }` |
| `temporal_range` | controlled half-open `Range<Date> | Range<Instant>` value with canonical `kind: "date" | "instant"` tagging |
| `timezone` | valid IANA timezone |
| `enum` | one declared string value |
| `person` | one active Space Person in the same Space |
| `person_list` | unique list of active Space People in the same Space |
| `record` | one active record of the declared target model in the same Space |
| `record_list` | unique list of active records of the declared target model in the same Space |

Canonical Model Definition syntax uses **`instant`**, not `datetime`. The string `datetime` is retained only as a **legacy published spelling** so immutable Registry rows and their historical schema hashes remain readable. A new model or newly introduced field must use `instant`; a later version may preserve an already-published `datetime` field unchanged, or explicitly migrate that field to `instant` under normal compatibility/versioning rules. Validators/loaders therefore understand the legacy spelling, but publication policy does not treat it as a second canonical DSL type.

The controlled TemporalRange canonical value uses the tagged variant `kind: "instant"`; `datetime` is never a TemporalRange tag.

First-class Range fields are one logical value. `range<date>` and `range<instant>` use exactly:

```json
{ "start": "...", "endExclusive": "..." }
```

The field type already fixes Date versus Instant, so a fixed Range value does not repeat a `kind`. Bounds are always half-open `[start,endExclusive)`. `temporal_range` remains the controlled tagged union for a field that deliberately permits both Date and Instant variants.

The physical mapping is deterministic and internal: one fixed Range field expands to start/end columns; one `temporal_range` field expands to discriminator/start/end columns. REST/Resource values remain the logical values above. Scalar fields retain one-field/one-column mapping and relation fields retain relation-table storage.

A `temporal_range` field may be published for generic CRUD and declared `query.filterable` and/or `query.sortable`. Create/update validation accepts the canonical tagged value, storage dehydrates it into the internal physical columns, and get/list/query resource projection hydrates it back into the same logical value. Generated Model Contracts and Creation Draft schemas expose only that canonical logical shape. Filter execution uses typed range operators and the internal discriminator/bounds index. Sort execution requires `context.viewingTimezone`, projects Date variants to absolute boundaries, keeps Instant variants absolute, and compares `projectedStart`, then `projectedEnd`, then record ID. Physical columns never become public fields. Search remains unavailable because no text projection is defined.

Conformance-ID: MDV1-FIELD-TYPES-01

### 4.1.1 Physical mapping boundary

Physical mapping is not Model Definition syntax and is never exposed to model authors or callers. Current deterministic compiler behavior is:

| Logical field | Physical storage |
|---|---|
| scalar field `field` | existing `field` column |
| relation field `field` | existing relation-table rows |
| `range<date>` / `range<instant>` field | internal `__r_<field>_start`, `__r_<field>_end` columns |
| `temporal_range` field | internal `__tr_<field>_kind`, `__tr_<field>_start`, `__tr_<field>_end` columns |

Range columns enforce all-null/all-present integrity and `start < end`; TemporalRange columns additionally enforce the canonical `date | instant` discriminator. These names and checks are Storage implementation details, not REST or Resource fields. Generic create/update dehydrates the logical value into these columns; get/list and Generic/Canonical Query result projection hydrate them back into one canonical `temporal_range` value. A partial or invalid stored tuple fails closed instead of leaking physical state.

Compatible physical migration may add an optional fixed Range as two nullable columns or an optional `temporal_range` as three nullable columns. Adding a required field still requires an explicit backfill/migration plan. Existing scalar schema and index output remains byte-for-byte stable.

### 4.2 Field properties

```ts
{
  type: FieldType,
  title?: string,
  description?: string,
  required?: boolean,
  nullable?: boolean,
  immutable?: boolean,
  readOnly?: boolean,
  minLength?: number,
  maxLength?: number,
  minimum?: number,
  maximum?: number,
  values?: string[],
  targetModel?: string
}
```

Rules:

- field `title` is optional, human-facing, trimmed, and limited to 1–80 characters; it is readable semantic metadata, not stable field identity;
- field `description` is optional and limited to 300 characters;
- `required: true` and `nullable: true` cannot be combined in v1;
- `minLength` / `maxLength` apply only to `string` / `text`;
- `minimum` / `maximum` apply only to `integer` / `number`;
- `values` is required for `enum`, must be unique and may contain at most 50 entries;
- `targetModel` is required only for `record` / `record_list`; it remains structural relation semantics and is not encoded into `title`. Generated contracts may project relation target/cardinality metadata separately so human-readable naming and machine relation semantics remain orthogonal;
- `range<date>`, `range<instant>` and `temporal_range` accept none of `minLength`, `maxLength`, `minimum`, `maximum`, `values` or `targetModel`.

Conformance-ID: MDV1-FIELD-REQUIRED-NULLABLE-01
Conformance-ID: MDV1-FIELD-CONSTRAINTS-01
Conformance-ID: MDV1-RELATION-STRUCTURE-01

### 4.2.1 `referenceLabel`

`referenceLabel` defines the model-owned minimal human-readable label used when an ordinary record is referenced by another model. It is semantic Reference Projection for generic clients, not record identity, UI layout, search ranking or mutation authority.

V1 supports exactly one of:

```ts
referenceLabel: { field: "name" }

referenceLabel: { template: "{code} · {name}" }
```

Rules:

- the object must contain exactly one of `field` or `template`;
- referenced fields must exist and must be scalar `string`, `text`, `integer`, `number`, `boolean`, `date`, `instant`, `timezone` or `enum` fields; an already-published legacy `datetime` field remains readable as the same Instant semantic; range/relation fields are not valid label inputs;
- a template is trimmed, contains 1–200 characters, uses only simple `{field}` placeholders and contains at most eight placeholders; at least one placeholder is required;
- rendered output is trimmed and limited to 200 characters; boolean values render as `true` / `false`;
- when `referenceLabel` is omitted, or when every referenced value is null/blank so the projected label is empty, the stable record ID is the canonical fallback;
- Relation Target Lookup search/pagination and Batch Reference Resolution must use the same canonical label projection;
- changing, adding or removing `referenceLabel` on an already-published model is a breaking semantic compatibility change because generic consumers may observe different labels/search ordering;
- adapters must not override this semantic by guessing conventional fields such as `name`, `title` or `summary`.

Conformance-ID: MDV1-REFERENCE-LABEL-01

Relation metadata defines **what may be referenced structurally**, not a static list of current target instances. Generated JSON Schema therefore projects stable relation target/cardinality through `x-lifespace-relation` and must not encode mutable Space-specific targets as `enum`. Runtime Discovery / Relation Target Lookup may resolve current targets under current authorization for clients such as n8n, Agents/MCP and generated UI. A lookup result is a capability/reference projection only: it does not bypass create/update Policy or mutation-time relation validation. `person` / `person_list` use the canonical Space Person `displayName`. `record` / `record_list` use the target Model's canonical `referenceLabel` semantics defined below, with stable record ID fallback. Record lookup/resolution additionally requires current read authority to the target Model; adapters must never infer labels from conventional field names such as `name`, `title` or `summary`.

### 4.3 `readOnly`, Mutation Authority, and `immutable`

These flags answer different questions.

**`readOnly: true`** means ordinary clients cannot supply the field during create/update. Trusted platform behavior such as Action or Capability execution may still write it. In Model Definition v1 this is also the declarative mechanism for **变更权限（Mutation Authority）** when a field's valid changes are owned by semantic platform behavior rather than generic CRUD.

Examples:

```ts
status: {
  type: "enum",
  required: true,
  readOnly: true,
  values: ["pending", "completed", "cancelled"]
}
completedAt: { type: "instant", nullable: true, readOnly: true }
```

This means a normal `POST`/`PATCH` cannot choose Task lifecycle state or completion bookkeeping, while `Task.complete`, `Task.cancel` and `Task.reopen` can change those fields through the trusted Action path.

Normative Mutation Authority rules in v1:

- if direct client mutation of a field would bypass an Action/Capability guard, policy, companion-field update, or declared semantic invariant, that field must be `readOnly: true`;
- a server `default` may initialize a `readOnly` field when the client omits it; `readOnly` prevents client assignment, not server initialization;
- `readOnly` does not make a field hidden or unqueryable: it may still appear in resource output, filters, sorts and Runtime Discovery;
- generated create/update schemas omit `readOnly` fields, generated resource schemas mark them `readOnly`, and Runtime Discovery exposes the field declaration;
- Actions/Capabilities may write a `readOnly` field because they are trusted model semantics and still pass the normal model validation/persistence boundary;
- do **not** mark a field `readOnly` merely because an Action also happens to assign it. Ordinary CRUD and Actions may legitimately coexist for a field when no invariant requires exclusive semantic ownership;
- therefore Mutation Authority is explicit, not inferred from field names such as `status` and not hard-coded for Task/Wish in Runtime.

Conformance-ID: MDV1-FIELD-READONLY-01

**`immutable: true`** means the value cannot be changed after creation. Workflow Action assignments to immutable fields are rejected at definition validation time.

Example:

```ts
ownerPersonId: { type: "person", required: true, immutable: true }
```

Conformance-ID: MDV1-FIELD-IMMUTABLE-01

### 4.4 Legacy compatibility: `timeRanges`

`timeRanges` is **not the canonical way to declare an ordinary Range value**. It is a retained structural projection for already-published definitions that historically represented an interval with two separately meaningful scalar fields.

New range-valued state must be modeled as one `range<date>` or `range<instant>` field. Model authors must not split one logical Range into start/end fields merely to satisfy storage.

Registry/runtime compatibility remains deliberately one-way:

- historical definitions containing `timeRanges` remain readable;
- a later version may preserve an existing `timeRanges.<key>` declaration byte-for-byte while other model semantics evolve;
- a later version may remove a legacy declaration as part of an explicit migration to first-class Range state;
- publication must reject a newly introduced or changed `timeRanges` declaration;
- legacy bound fields may be `date` or Instant-semantic scalar fields; historical `datetime` remains accepted only as the legacy spelling of Instant;
- existing non-half-open bounds are interpreted only as historical structural semantics. They do not redefine canonical `Range<T>`, whose bounds are always `[start,endExclusive)`;
- Calendar-owned split-field projections remain compatibility behavior until their separately tracked migration completes; they do not make `timeRanges` canonical.

This compatibility surface must not be used to design new models.

Conformance-ID: MDV1-TIME-RANGES-LEGACY-01

## 5. Defaults

`defaults` supplies server defaults for declared fields.

Example:

```ts
defaults: {
  status: "pending"
}
```

A default must satisfy the field type and constraints.

Important v1 rules:

- `null` is allowed only for nullable fields;
- `range<date>`, `range<instant>` and `temporal_range` cannot have defaults, including `null`;
- scalar relation fields `person` and `record` cannot have non-null defaults;
- `person_list` / `record_list` may only use an empty list `[]` as a default;
- enum defaults must be one of the declared values;
- numeric/string defaults must satisfy their declared ranges/lengths.

Conformance-ID: MDV1-DEFAULTS-01

## 6. Query Definition

A model may expose three field lists:

```ts
query: {
  searchable?: [...],
  filterable?: [...],
  sortable?: [...]
}
```

Every listed field must exist in `fields`. A `range<date>` or `range<instant>` field may appear in `filterable`, exposing `overlaps`, `contains`, `before`, `after` and, when nullable, `isNull` / `isNotNull`. Fixed Range fields are not searchable. **No canonical ordinary-Range sort ordering has been approved**, so they must not appear in `sortable`.

A `temporal_range` field may appear in `filterable`, exposing `overlaps`, `contains`, `before`, `after`, `kindIs` and nullable predicates. It may also appear in `sortable`; each Canonical Query that actually sorts it must provide `context.viewingTimezone`. It cannot appear in `searchable`.

The purpose is not to describe SQL. It declares the model's supported logical query surface, from which Runtime/query planning and generated contracts are derived.

Conceptually:

```text
searchable -> free-text query participation
filterable -> exact / supported range filtering
sortable   -> explicit field sort options
```

Canonical Query sorting is an ordered tuple. Structured callers provide ordered `{ field, direction }` criteria; retained GET shorthand may repeat `sort=field:direction` up to eight times. Envelope fields `createdAt` and `updatedAt` are always sortable; model fields must be declared in `query.sortable`. Omitted sort defaults deterministically to `createdAt:desc`. Cursor pagination binds the complete Effective Sort and uses stable record identity as the final tie-breaker. Nullable sortable fields use null-last semantics for both ascending and descending directions. A TemporalRange sort expands to `projectedStart`, `projectedEnd`, and record ID under the explicit `context.viewingTimezone`; that context is part of cursor identity. TemporalRange sort is structured-Query-only and is not projected into legacy GET shorthand. Capability semantics may contribute typed targets or internal planning, but do not create a second caller-visible Query mode. Existing Calendar/Temporal computed GET sorts remain compatibility transport until their explicit migrations are complete.

For filterable `date`, `instant`, `integer` and `number` fields, Generic Query owns an explicit comparison-operator semantic set. Historical `datetime` fields retain the same Instant comparison behavior as a compatibility spelling:

```text
eq | lt | lte | gt | gte
```

The semantic operator is independent from a REST parameter name. Existing v1 REST compatibility is frozen as:

```text
field=x       -> eq x
fieldFrom=x   -> gte x
fieldTo=x     -> lte x
```

In particular `fieldTo` remains inclusive. New explicit comparison transport uses collision-free `field.operator` parameter names such as `dueDate.gte` and `dueDate.lt`; Model field keys cannot contain `.`, so adapters never need to infer an operator from a field-name suffix. Supplying two transport aliases for the same field/operator in one request is invalid rather than silently choosing precedence.

The platform-owned envelope `createdAt` and `updatedAt` fields are semantically Instant comparison fields even though they are not repeated in Model `query.filterable`. Existing legacy query/discovery metadata may retain the historical `datetime` wire token until its own versioned compatibility migration; that token is not Model Definition canonical syntax. Their comparison transport is explicit only. Generated Model Contract metadata and Progressive Runtime Semantic Detail enumerate the actual operator/parameter mapping; adapters must consume that published mapping rather than reconstructing names.

For any comparison-queryable `instant` field (and an already-published legacy `datetime` field), Generic Query additionally exposes one concrete local-calendar window transport:

```text
<field>.dateStart=YYYY-MM-DD
<field>.dateEndExclusive=YYYY-MM-DD
<field>.timezone=<IANA timezone>
```

All three parameters are required together. Core resolves the two local date boundaries with the shared DST-safe Time Semantics primitive and applies the canonical half-open instant predicate `value >= startInclusive AND value < endExclusive`. Adapters must not calculate UTC boundaries themselves. `date` fields remain calendar-date values and use ordinary explicit comparisons without timezone conversion.

A direct filterable `range<date>`, `range<instant>`, or `temporal_range` field uses Canonical Query range operands. A retained legacy `timeRanges` projection may use the same operands for compatibility, but it is not a second Model Definition Range syntax. A `local_date_window` compares Date variants directly and projects its boundaries to Instants for Instant variants. Direct `date` and `instant` operands match only the same stored variant; `kindIs` filters the controlled discriminator without exposing physical columns.

Conformance-ID: MDV1-QUERY-COMPARISON-01
Conformance-ID: MDV1-QUERY-LOCAL-DATE-WINDOW-01

Capabilities may contribute reusable field semantics and internal planner behavior to the same Canonical Query. They do not create a separate Capability Query contract. Existing Calendar time-window and Temporal attention/effective-date GET parameters are deprecated compatibility transport while direct TemporalRange/Event migration and concrete Temporal reassessment remain incomplete.

Only `searchable`, `filterable` and `sortable` are defined query properties in v1. Other query metadata must not be relied on as protocol semantics.

Conformance-ID: MDV1-QUERY-GENERIC-01

## 7. Model Access

`access` declares which generic operation levels the model exposes:

```text
read < write < manage
```

Rules:

- at least one access level is required;
- `write` requires `read`;
- `manage` requires `write`.

Conformance-ID: MDV1-ACCESS-HIERARCHY-01

This declaration is only one part of authorization. Effective permission is the intersection of:

```text
verified authenticated principal context
∩ credential scope
∩ Application × Model Access
∩ Space membership / Data Grant
∩ model access declaration
∩ model Policy / Capability restrictions
```

Therefore declaring `write` does not grant anyone write authority by itself.

## 8. Lifecycle Metadata

Optimistic concurrency（乐观并发） and soft deletion（软删除） are **Generic Runtime invariants（通用运行时不变量）** for every ordinary Model Definition v1. They are not per-model lifecycle strategies.

For historical/explicit representation, v1 may contain the optional assertion object:

```ts
lifecycle?: {
  optimisticConcurrency?: true,
  softDelete?: true
}
```

Rules:

- omission never disables either invariant;
- an explicitly present value may only be `true`;
- `false` is invalid and publication must reject it;
- ordinary update/delete/action mutations continue to use the record `version` concurrency boundary;
- ordinary deletion remains logical deletion through `deleted_at`, never a per-model hard-delete switch;
- adding or removing these redundant `true` assertions is a representation change, not a domain-semantic breaking change.

Conformance-ID: MDV1-LIFECYCLE-INVARIANTS-01

The validator preserves whether the optional assertion metadata was present so existing canonical Model Definition hashes are not rewritten merely to restate a Runtime invariant.

If a future use case genuinely requires another concurrency or deletion strategy, it must be introduced deliberately as new Model Definition semantics with coordinated specification, validator, Runtime, contract and compatibility design. Model Definition v1 must not encode that future possibility as a fake boolean switch.

## 9. Policy DSL

Policy is an authorization refinement. It may **deny** an operation that passed the outer authentication/application/Space/model checks; it may not expand authority beyond them.

Policy failure returns authorization denial (`POLICY_DENIED`, HTTP 403).

### 9.1 Where policies appear

Model-level policies:

```ts
policies: {
  create?: PolicyExpression,
  read?: PolicyExpression,
  update?: PolicyExpression,
  delete?: PolicyExpression
}
```

An Action may also declare its own `policy`.

### 9.2 Expression forms

Comparison:

```ts
{
  op: "eq" | "neq",
  left: Operand,
  right: Operand
}
```

Boolean composition:

```ts
{ all: [PolicyExpression, ...] }
{ any: [PolicyExpression, ...] }
{ not: PolicyExpression }
```

Operands are explicit objects:

```ts
{ $ref: "actor.personId" }
{ $ref: "record.ownerPersonId" }
{ $ref: "input.ownerPersonId" }
{ value: "open" }
{ value: null }
```

There are no bare implicit field names.

### 9.3 Current references

Always-supported actor references:

```text
actor.type
actor.id
actor.personId
```

Field references:

```text
record.<field>
input.<field>
```

Availability depends on operation:

| Operation | `record.*` | `input.*` |
|---|---:|---:|
| create | no | yes |
| read | no | no |
| update | yes | yes |
| delete | yes | no |
| action | yes | no |

The current v1 read policy is deliberately not record-aware because list queries evaluate the read policy before pagination; record-aware query policies require a future policy-aware query compiler.

Likewise, current Policy v1 does **not** expose `now` or `space.*` references even if older planning documents discussed them.

### 9.4 Complexity limits

- comparison operators: only `eq`, `neq`;
- `all` / `any`: 1–20 children;
- maximum nesting depth: 8;
- maximum total expression nodes: 64;
- literals: finite number, string, boolean or null;
- list-valued relation fields are not directly comparable as typed scalar operands in v1.

Policy is a closed deterministic DSL: no JavaScript, SQL, shell, network call or arbitrary function execution.

Conformance-ID: MDV1-POLICY-BOUNDARY-01

## 10. Record Action / Transition DSL

A **记录动作 / 转换（Record Action / Transition）** is a model-specific semantic command over one record. The implementation modules retain the historical `workflow-*` naming, but **Workflow v1 is not a general workflow/orchestration system**.

Examples:

```text
Task.complete
Task.cancel
Task.reopen
Wish.fulfill
DayRecord.archive
```

An Action is declared in the model; it does not require a model-specific handler when its behavior fits the bounded Workflow v1 engine.

### 10.1 Action shape

```ts
actions: {
  "action-key": {
    access: "write" | "manage",
    policy?: PolicyExpression,
    guards?: Guard[],
    branches?: Branch[],
    set: AssignmentMap
  }
}
```

Current limits:

- at most 32 Actions per model;
- Action keys match `^[a-z][a-z0-9-]{1,62}$`;
- Action access must be `write` or `manage`;
- the model itself must expose that access level.

Conformance-ID: MDV1-ACTION-ACCESS-01

### 10.2 Execution order

Conceptually, a normal Record Action executes as:

```text
resolve model + action
-> authenticate / require model access
-> load record
-> verify optimistic version
-> evaluate Action Policy
-> evaluate all Guards
-> choose first matching Branch, if any
-> otherwise use Action.set
-> resolve assignment literals / references
-> validate resulting model fields/relations
-> persist through Generic Runtime
-> return updated resource
```

Authorization checks outside the Action DSL still run normally.

### 10.3 Action semantic input and concurrency metadata in v1

Workflow v1 currently defines **no custom caller-owned semantic Action parameters**. A Workflow Action such as `Task.complete` therefore has an empty semantic input set.

Optimistic-concurrency evidence is a separate Generic Runtime mutation concern. The current HTTP wire representation still carries the record version in the Action request body for compatibility:

```json
{
  "version": 3
}
```

That `version` property is **并发元数据（concurrency metadata）**, not Action semantic input. Runtime Discovery exposes it separately from `action.input.fields`, and generated Model Contract operations mark the same distinction. Generic clients must not render it as a model/domain Action field or infer semantics from the literal key `version`.

If a future Workflow Action needs caller-owned domain parameters, Workflow v1 must be extended deliberately with a bounded semantic-input contract. Such an extension is independent from where optimistic-concurrency evidence is transported. Likewise, a future transport change such as moving concurrency evidence to an HTTP header must not redefine the Action's semantic input.

Conformance-ID: MDV1-ACTION-CONCURRENCY-01

### 10.4 CRUD vs Record Action/Transition vs external orchestration

The three mutation surfaces have different responsibilities:

```text
CRUD
  ordinary client-controlled field editing
  -> PATCH writable model fields

Record Action / Transition
  one-record atomic semantic change
  -> named Action + Policy + Guard/Branch + deterministic assignments
  -> optimistic-concurrency evidence is enforced separately by Generic Runtime
  -> may own readOnly fields when direct CRUD would bypass semantics

External orchestration / governed Change
  multi-record, multi-service, long-running, asynchronous or externally coordinated work
  -> outside Workflow v1
```

A Record Action becomes **authoritative** for a protected state transition only when the fields that would otherwise bypass its semantics are removed from the ordinary CRUD write surface, normally with `readOnly: true`.

Do not solve semantic authority with model-specific Runtime conditionals such as “Task.status is special”. The authority must be visible in the Model Definition and therefore flow into Runtime validation, generated contract and Discovery.

Likewise, do not expand Workflow v1 into a process engine merely because a use case needs several steps or external calls. Such work belongs to an orchestration/Change layer that can coordinate LifeSpace mutations through stable contracts.

## 11. Guards

A Guard answers:

> Is this Action currently valid for this record state?

Shape:

```ts
{
  field: "status",
  op: "eq" | "neq",
  value: scalar | null,
  errorCode?: "UPPER_CASE_API_CODE",
  message?: "Human-readable message"
}
```

Rules:

- at most 20 Guards per Action;
- referenced field must exist;
- literal must be type-compatible with the field;
- optional error code uses `^[A-Z][A-Z0-9_]{1,63}$`;
- optional message is 1–200 characters;
- all Guards must pass;
- the first failed Guard stops execution;
- default failure is `ACTION_NOT_AVAILABLE`, HTTP 409, unless a custom error code/message is declared.

Policy and Guard are intentionally different:

```text
Policy false -> you are not authorized to do this         -> 403
Guard false  -> this action is invalid in current state   -> 409
```

## 12. Branches

A Branch answers:

> If the Action is valid, does the effect depend on current record conditions?

Shape:

```ts
{
  when: WorkflowCondition,
  set: AssignmentMap
}
```

An Action may define at most 8 branches.

Branches are evaluated in declaration order. The **first matching branch wins**. If no branch matches, the Action's top-level `set` is used.

### 12.1 Branch conditions

Field comparison:

```ts
{ field: "status", op: "eq", value: "claimed" }
```

Active Space Person relation test:

```ts
{ personRelation: "claimantPersonId", active: false }
```

Boolean composition:

```ts
{ all: [...] }
{ any: [...] }
{ not: ... }
```

Limits:

- `all` / `any`: 1–8 child conditions;
- condition nesting depth: at most 4;
- condition node budget: at most 20.

`personRelation` must name a declared `person` field. It tests whether the referenced Space Person currently exists as an active Person relation in the same Space.

## 13. Assignments and Workflow references

Every Action and every Branch must assign at least one field; each assignment map may contain at most 20 fields.

Assignments may use scalar literals / null:

```ts
set: {
  status: "completed",
  completedAt: null
}
```

or supported references:

```ts
set: {
  completedAt: { $ref: "now" },
  completedByType: { $ref: "actor.type" },
  completedById: { $ref: "actor.id" }
}
```

Conformance-ID: MDV1-ACTION-TRANSITION-01

Current references:

| Reference | Meaning | Compatible target |
|---|---|---|
| `now` | Action execution timestamp | `datetime` |
| `actor.id` | current operation Actor ID | `string` / `text` |
| `actor.type` | current operation Actor type | enum containing `user`, `service`, `device`, `agent` |
| `actor.personId` | current actor's active Space Person, if one exists | `person`, `string`, `text` |
| `record.<field>` | current record field value | same field type; `string` / `text` are mutually compatible |

`actor.*` describes the **Actor（执行者）** of the current operation. For direct execution the Actor is the Principal（主体）; for delegated Agent execution the Principal remains the authority-bearing user while `actor.type=agent` and `actor.id` identifies the delegated Agent. Model fields assigned from `actor.type` must therefore represent the full current Actor vocabulary, not only Principal types.

Conformance-ID: MDV1-ACTOR-REFERENCES-01

If `actor.personId` is required by an assignment but no active Space Person can be resolved, the Action fails with `POLICY_CONTEXT_MISSING` (403).

Actions may assign `readOnly` fields because Actions are trusted model semantics. Actions may not assign immutable fields.

## 14. Capability Definition

A Capability is a reusable cross-model semantic package that is registered in Core.

A model **maps its own fields into the Capability contract** instead of implementing the behavior itself.

Conceptually:

```text
Model fields
   + Capability field mapping
   -> reusable validation
   -> reusable runtime behavior
   -> reusable query/computed semantics
   -> optional Capability Actions/storage
   -> generated contract contribution
```

Capability names are closed in v1. An arbitrary model cannot invent a new capability name. Adding a new reusable Capability requires platform code covering validation, runtime semantics and deterministic contract generation.

Current registered Capabilities are `temporal` and `calendar`.

### 14.1 Temporal Capability

Configuration:

```ts
capabilities: {
  temporal: {
    kindField: string,
    anchorDateField: string,
    cycleDaysField: string,
    attentionBeforeDaysField: string,
    attentionAfterDaysField: string,
    statusField: string,
    subjectPersonField?: string,
    occurrences?: boolean
  }
}
```

Required field contracts include:

- kind field: `enum` containing `elapsed`, `countdown`, `cycle`;
- anchor date: `date`;
- cycle/attention values: `integer`;
- status: `enum` containing `active`, `archived`;
- optional subject: `person`.

Temporal contributes reusable date/cycle validation, derived `computed.temporal` output, special query semantics and, when `occurrences: true`, occurrence history plus Capability-owned `record-occurrence` Action.

A model may not also declare a Workflow Action named `record-occurrence` when Temporal owns that Action.

Conformance-ID: MDV1-CAPABILITY-TEMPORAL-01

### 14.2 Calendar Capability

Current/canonical configuration:

```ts
capabilities: {
  calendar: {
    rangeField: string,
    attendeePersonField?: string
  }
}
```

Field contracts:

- `rangeField` must name one declared `temporal_range` field;
- optional attendees must name a `person_list` field;
- the bound TemporalRange is the single Calendar time truth. Date and Instant variants are represented by the canonical tagged value and are validated/persisted by Generic Runtime;
- Calendar adds semantic role/context around that field but does not create a second time representation.

Current Model Definitions must use this canonical binding. The validator/runtime also retain the prior split-field binding:

```ts
{
  allDayField,
  timedStartField,
  timedEndField,
  startTimezoneField,
  endTimezoneField,
  allDayStartField,
  allDayEndExclusiveField,
  attendeePersonField?
}
```

That shape exists only so already-published historical Model Definitions remain interpretable during migration. Historical timed fields may use the legacy `datetime` spelling or canonical `instant`; both mean Instant. A Calendar definition must use either `rangeField` or the complete legacy split binding, never both. New baseline models and AI-generated proposals must not introduce the legacy shape.

Runtime Discovery and progressive static semantic detail project the same canonical/legacy union. Generic consumers inspect the returned binding instead of guessing Event field names. For current models, `rangeField` points directly at the authoritative `temporal_range` field. The projection contains no UI layout semantics and never replaces execution-time validation.

Conformance-ID: MDV1-CAPABILITY-CALENDAR-01

Canonical Calendar query behavior is the normal Canonical Query behavior of the bound TemporalRange field. Overlap/filter/sort predicates therefore target `rangeField`; TemporalRange sort requires explicit `context.viewingTimezone`. Relative-language inputs such as `today` or `tomorrow` remain caller/Agent concerns and are resolved to concrete Canonical Query values before execution.

The historical split-field Calendar engine retains its previous grouped `calendar.window`, `rangeStart/rangeEnd`, `dateStart/dateEndExclusive` and `calendarStart` semantics only for historical published definitions. Canonical Calendar models do not expose or execute that legacy query transport.

Conformance-ID: MDV1-CAPABILITY-CALENDAR-WINDOW-01

## 15. Generated Runtime API

Ordinary models do not receive handwritten route implementations.

For a published model with key `task`, the Generic Runtime exposes the model through the common modelKey-addressed route pattern:

```text
GET    /api/v1/spaces/{spaceId}/models/task/records
POST   /api/v1/spaces/{spaceId}/models/task/records
GET    /api/v1/spaces/{spaceId}/models/task/records/{recordId}
PATCH  /api/v1/spaces/{spaceId}/models/task/records/{recordId}
DELETE /api/v1/spaces/{spaceId}/models/task/records/{recordId}
```

A declared Action such as `complete` becomes:

```text
POST /api/v1/spaces/{spaceId}/models/task/records/{recordId}/actions/complete
```

This is **runtime projection**, not per-model API code generation. One Generic Runtime resolves `modelKey` directly from its isolate-memory Registry descriptor and resolves `actionKey` within that model. Callers that already know `spaceId + modelKey` perform CRUD and Actions with zero Discovery and no Registry D1 query on the hot path.

## 16. Generated Model Contract

Every successful Registry publication/retirement produces or activates an immutable Model Contract Revision containing concrete generated OpenAPI and JSON Schema.

Model-derived contract content includes:

- concrete collection/item paths;
- create/update/resource schemas;
- query parameters;
- Action paths and semantic-input/concurrency metadata;
- Capability contract contributions;
- model version/schema-hash evidence.

For Mutation Authority specifically, a `readOnly` field is present in resource schemas with `readOnly: true` but absent from ordinary create/update request schemas. Runtime Discovery carries the same field metadata plus the authorized Action set, allowing consumers and Agents to discover the valid semantic mutation surface instead of guessing from field names.

For Action concurrency specifically, generated request schemas may retain the current wire-level record-version property, but it is explicitly identified as technical concurrency metadata rather than semantic Action input. The generated Action operation and Runtime Discovery must expose the same concurrency strategy/transport semantics, while execution remains authoritative for stale-write rejection.

The contract identity is content-addressed as `mct_<sha256(...)>`.

The Kernel OpenAPI deliberately does not duplicate ordinary model paths.

## 17. Publication and versioning

Published Model Definitions are immutable.

Publication flow conceptually is:

```text
definition
-> DSL validation
-> canonicalization + schema hash
-> compatibility / physical schema checks
-> typed physical schema plan
-> publish next model version
-> supersede previous version
-> generate/activate immutable Model Contract Revision
-> invalidate runtime model snapshot
```

Compatibility values are:

```text
initial
compatible
breaking
```

The Registry derives an **automatic minimum compatibility classification** from the currently published Model Definition and the validated candidate. Caller-supplied compatibility is an explicit publication decision, but it may only be equally or more conservative than that minimum; it is never trusted to weaken the classifier.

Normative rules:

- first publication must use `initial`;
- later publications cannot use `initial`;
- if the automatic minimum is `breaking`, publication with caller-supplied `compatible` must be rejected before Registry/physical-contract mutation;
- if the automatic minimum is `compatible`, caller-supplied `breaking` is allowed as conservative over-classification;
- conservative over-classification does not bypass physical schema/migration safety, dependency review or any other publication gate;
- an unchanged schema hash is rejected;
- model versions advance monotonically per model key.

The minimum-classification rule belongs to the authoritative Registry publication boundary. AI proposal/Console clients may preflight the same result for clearer UX, but a caller-specific precheck must never be the only enforcement path.

Conformance-ID: MDV1-PUBLICATION-COMPATIBILITY-01

Changing an existing field from CRUD-writable to `readOnly` is a **breaking request-contract change** because generated create/update schemas no longer accept that field, even when stored rows and response shapes remain compatible. Such a change requires a normal compatibility-classified convergence migration and downstream impact review.

A model-only publication is designed not to require a Worker deployment when no Kernel/Capability/runtime implementation changes.

## 18. Complete Task example

The current Task model demonstrates the core v1 Mutation Authority pattern:

```ts
{
  definitionVersion: 1,
  key: "task",
  display: { singular: "Task", plural: "Tasks" },
  fields: {
    name: { type: "string", required: true, minLength: 1, maxLength: 100 },
    status: {
      type: "enum",
      required: true,
      readOnly: true,
      values: ["pending", "completed", "cancelled"]
    },
    completedAt: { type: "instant", nullable: true, readOnly: true },
    completedByType: {
      type: "enum",
      nullable: true,
      readOnly: true,
      values: ["user", "service", "device", "agent"]
    },
    completedById: { type: "string", nullable: true, readOnly: true }
  },
  defaults: { status: "pending" },
  query: {
    searchable: ["name"],
    filterable: ["status"],
    sortable: ["name"]
  },
  access: ["read", "write"],
  lifecycle: {
    optimisticConcurrency: true,
    softDelete: true
  },
  actions: {
    complete: {
      access: "write",
      guards: [
        {
          field: "status",
          op: "neq",
          value: "completed",
          errorCode: "TASK_ALREADY_COMPLETED",
          message: "Task is already completed"
        }
      ],
      set: {
        status: "completed",
        completedAt: { $ref: "now" },
        completedByType: { $ref: "actor.type" },
        completedById: { $ref: "actor.id" }
      }
    },
    cancel: {
      access: "write",
      guards: [
        {
          field: "status",
          op: "neq",
          value: "cancelled",
          errorCode: "TASK_ALREADY_CANCELLED",
          message: "Task is already cancelled"
        }
      ],
      set: {
        status: "cancelled",
        completedAt: null,
        completedByType: null,
        completedById: null
      }
    },
    reopen: {
      access: "write",
      guards: [
        {
          field: "status",
          op: "neq",
          value: "pending",
          errorCode: "TASK_ALREADY_PENDING",
          message: "Task is already pending"
        }
      ],
      set: {
        status: "pending",
        completedAt: null,
        completedByType: null,
        completedById: null
      }
    }
  }
}
```

What this means in plain language:

```text
Task is a model with generic CRUD/query behavior for ordinary editable fields.
Task.status is not part of the client CRUD write surface; the server default initializes it to pending.
Task additionally exposes authoritative semantic complete/cancel/reopen commands.
Those Actions, not PATCH, own lifecycle transitions and completion bookkeeping.
The same generic Workflow engine executes them without Task-specific Runtime code.
The Action routes, readOnly field contract and Discovery metadata are derived automatically.
```

## 19. Why Action, Policy and Capability are separate

A useful decision rule is:

| Need | Use |
|---|---|
| store a model-specific value | Field |
| expose generic create/read/update/delete | Generic Runtime |
| protect a field whose legitimate changes are owned by model semantics | `readOnly` + Action/Capability Mutation Authority |
| restrict who may perform an operation | Policy |
| reject a semantic command in an invalid current state | Guard |
| choose different effects from current state | Branch |
| expose a model-specific semantic command | Record Action / Transition |
| reuse a stable semantic/runtime package across unrelated models | Capability |
| coordinate multiple records/services/long-running work | external Orchestration / future governed Change mechanism, not Workflow v1 |

In particular, do not promote every repeated-looking Action into a Capability. Reuse alone is insufficient; a Capability needs stable semantic identity plus meaningful reusable platform behavior.

## 20. Explicit v1 limits

Model Definition v1 is intentionally **not** a general-purpose programming language.

Not supported by current Workflow/Policy v1:

- arbitrary JavaScript, SQL, shell or user-supplied executable code;
- external HTTP/service calls inside Policy or Workflow;
- custom caller-owned Workflow Action semantic input parameters;
- cross-resource Action mutations;
- long-running orchestration;
- loops;
- user-defined functions;
- arbitrary expression evaluation;
- record-aware `read` Policy filtering;
- `now` / `space.*` in Policy expressions;
- arbitrary unregistered Capability names.

Technical optimistic-concurrency evidence is not a Workflow Action semantic input parameter; it is a Generic Runtime mutation invariant carried by the current transport contract.

When an ordinary model requirement cannot be expressed, first decide whether the missing concept is:

1. a safe generic DSL extension;
2. a reusable Capability / Engine concern;
3. a genuine Kernel concept;
4. an Adapter / Orchestration / Experience concern that does not belong in LifeSpace model semantics.

Do not add one-off domain runtime code merely because the DSL needs extension.

## 21. Related normative sources

- `docs/north-star.md` — durable platform direction and axioms.
- `docs/architecture.md` — current platform boundaries.
- `docs/permissions.md` — authorization model surrounding Model Policy.
- `docs/contracts.md` — contract ownership, publication and Model Contract revisions.
- `docs/phase3-metadata-platform-plan.md` — origin and architectural rationale of the metadata platform.
- `apps/core/src/model-definition.ts` — top-level/field/query/lifecycle validator.
- `apps/core/src/policy-definition.ts` and `policy.ts` — Policy syntax and execution.
- `apps/core/src/workflow-definition.ts` and `workflow.ts` — Action/Workflow syntax and execution.
- `apps/core/src/capability-definition.ts` and Capability runtime modules — Capability syntax/runtime.
- `apps/core/src/model-contract.ts` — deterministic generated OpenAPI/JSON Schema projection.
- `apps/core/src/model-registry.ts` — publication/version/Registry semantics.
