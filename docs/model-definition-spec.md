# LifeSpace Model Definition Specification v1

Status: **Normative human-readable specification**  
Definition version: **1**  
Scope: ordinary metadata-driven business models in LifeSpace Core

## 1. Purpose and authority

This document is the human-readable specification for LifeSpace **模型定义（Model Definition）v1** and its embedded **策略（Policy）**、**动作 / 工作流（Action / Workflow）** and **能力（Capability）** declarations.

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
- `apps/core/src/model-definition.ts`, `policy-definition.ts`, `workflow-definition.ts` and `capability-definition.ts` are the machine validators and must remain aligned with this specification;
- runtime implementation and automated tests verify executable behavior;
- a published Model Registry version plus its immutable `mct_*` Model Contract Revision is the exact contract evidence for a deployed model version.

If this specification, validator, runtime, tests or generated Model Contract disagree, treat that as **contract drift to fix**, not as permission to silently choose whichever interpretation is convenient.

Notion documentation may explain this specification, but it is not an independently editable second source of protocol truth.

## 2. Mental model

A Model Definition answers six different questions:

```text
Model
├── Fields       — what data does this thing contain?
├── Query        — how may clients find it?
├── Access       — what model-level operation classes exist?
├── Policy       — who may perform an otherwise-authorized operation?
├── Actions      — what model-specific semantic changes can be invoked?
└── Capabilities — which reusable cross-model semantic packages does it conform to?
```

Do not collapse these concepts:

- **字段（Field）** describes state.
- **CRUD** is the generic transport for ordinary state access/change.
- **动作（Action）** is a named semantic command specific to a model, such as `Task.complete`.
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
  route: string,
  description?: string,
  display: {
    singular: string,
    plural: string
  },
  fields: Record<string, FieldDefinition>,
  defaults?: Record<string, DefaultValue>,
  query?: {
    searchable?: string[],
    filterable?: string[],
    sortable?: string[]
  },
  access: ("read" | "write" | "manage")[],
  lifecycle?: {
    optimisticConcurrency?: boolean,
    softDelete?: boolean
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

### 3.3 `route`

One lowercase URL segment used by the Generic Runtime.

Current syntax:

```text
^[a-z][a-z0-9-]{1,62}$
```

Examples:

```text
tasks
day-records
football-matches
```

Kernel-reserved routes such as `health`, `status`, `me`, `spaces`, `space-invites`, `grants`, `creation-drafts`, `models` and `model-admin` cannot be used.

A published route may be owned by only one model key.

### 3.4 `description`

Optional semantic description, maximum 500 characters after trimming.

The description should explain **what the model means and when to use it**, not only restate its display name. It is useful to humans, generated clients and AI interpretation/discovery.

### 3.5 `display`

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
| `datetime` | RFC 3339-compatible date-time; runtime normalizes it to ISO instant form |
| `timezone` | valid IANA timezone |
| `enum` | one declared string value |
| `person` | one active Space Person in the same Space |
| `person_list` | unique list of active Space People in the same Space |
| `record` | one active record of the declared target model in the same Space |
| `record_list` | unique list of active records of the declared target model in the same Space |

### 4.2 Field properties

```ts
{
  type: FieldType,
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

- field `description` is optional and limited to 300 characters;
- `required: true` and `nullable: true` cannot be combined in v1;
- `minLength` / `maxLength` apply only to `string` / `text`;
- `minimum` / `maximum` apply only to `integer` / `number`;
- `values` is required for `enum`, must be unique and may contain at most 50 entries;
- `targetModel` is required only for `record` / `record_list`.

### 4.3 `readOnly` vs `immutable`

These two flags mean different things.

**`readOnly: true`** means ordinary clients cannot supply the field during create/update. Trusted platform behavior such as Action or Capability execution may still write it.

Example:

```ts
completedAt: { type: "datetime", nullable: true, readOnly: true }
```

This is why `Task.complete` can set `completedAt` while a normal `PATCH` cannot.

**`immutable: true`** means the value cannot be changed after creation. Workflow Action assignments to immutable fields are rejected at definition validation time.

Example:

```ts
ownerPersonId: { type: "person", required: true, immutable: true }
```

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
- scalar relation fields `person` and `record` cannot have non-null defaults;
- `person_list` / `record_list` may only use an empty list `[]` as a default;
- enum defaults must be one of the declared values;
- numeric/string defaults must satisfy their declared ranges/lengths.

## 6. Query Definition

A model may expose three field lists:

```ts
query: {
  searchable?: [...],
  filterable?: [...],
  sortable?: [...]
}
```

Every listed field must exist in `fields`.

The purpose is not to describe SQL. It declares the model's supported logical query surface, from which Runtime/query planning and generated contracts are derived.

Conceptually:

```text
searchable -> free-text query participation
filterable -> exact / supported range filtering
sortable   -> explicit field sort options
```

For filterable `date`, `datetime`, `integer` and `number` fields, the generated query surface also supports `FieldFrom` / `FieldTo` style range parameters.

Capabilities may add their own semantic query parameters. For example, Calendar contributes time-window queries and Temporal contributes attention/effective-date semantics.

Only `searchable`, `filterable` and `sortable` are defined query properties in v1. Other query metadata must not be relied on as protocol semantics.

## 7. Model Access

`access` declares which generic operation levels the model exposes:

```text
read < write < manage
```

Rules:

- at least one access level is required;
- `write` requires `read`;
- `manage` requires `write`.

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

v1 declares:

```ts
lifecycle: {
  optimisticConcurrency?: boolean,
  softDelete?: boolean
}
```

These fields describe ordinary resource lifecycle intent.

### Current v1 runtime note

The current Generic Runtime always uses record `version` for mutations and performs deletion through `deleted_at` soft deletion for ordinary resources. Therefore callers must not treat `false` as a supported switch that disables concurrency checking or turns deletion into hard delete.

Current built-in models explicitly declare both as `true`.

If lifecycle flags later become genuine behavior switches, that change requires coordinated specification, validator, runtime and contract changes.

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

## 10. Action / Workflow DSL

An Action is a model-specific semantic command.

Examples:

```text
Task.complete
Task.reopen
Wish.claim
Wish.fulfill
DayRecord.archive
```

An Action is declared in the model; it does not require a model-specific handler when its behavior fits Workflow v1.

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

### 10.2 Execution order

Conceptually, a normal Workflow Action executes as:

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

### 10.3 Action input in v1

The public Action request body currently accepts only:

```json
{
  "version": 3
}
```

Custom Action input parameters are not part of Model Definition v1.

If an Action needs arbitrary caller input beyond the optimistic version, Workflow v1 is insufficient and the DSL/runtime contract must be extended deliberately rather than hiding ad-hoc request fields in one model.

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

Current references:

| Reference | Meaning | Compatible target |
|---|---|---|
| `now` | Action execution timestamp | `datetime` |
| `actor.id` | current operation Actor ID | `string` / `text` |
| `actor.type` | current operation Actor type | enum containing `user`, `service`, `device`, `agent` |
| `actor.personId` | current actor's active Space Person, if one exists | `person`, `string`, `text` |
| `record.<field>` | current record field value | same field type; `string` / `text` are mutually compatible |

`actor.*` describes the **Actor（执行者）** of the current operation. For direct execution the Actor is the Principal（主体）; for delegated Agent execution the Principal remains the authority-bearing user while `actor.type=agent` and `actor.id` identifies the delegated Agent. Model fields assigned from `actor.type` must therefore represent the full current Actor vocabulary, not only Principal types.

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

### 14.2 Calendar Capability

Configuration:

```ts
capabilities: {
  calendar: {
    allDayField: string,
    timedStartField: string,
    timedEndField: string,
    startTimezoneField: string,
    endTimezoneField: string,
    allDayStartField: string,
    allDayEndExclusiveField: string,
    attendeePersonField?: string
  }
}
```

Field contracts:

- all-day marker: `boolean`;
- timed start/end: `datetime`;
- start/end timezone: `timezone`;
- all-day start/exclusive end: `date`;
- optional attendees: `person_list`;
- Calendar core fields must map to distinct model fields.

Calendar contributes timed/all-day shape validation and semantic time-window query behavior. It does not currently contribute a model-specific Workflow Action.

## 15. Generated Runtime API

Ordinary models do not receive handwritten route implementations.

For a published model with route `tasks`, the Generic Runtime exposes the model through the common route pattern:

```text
GET    /api/v1/spaces/{spaceId}/tasks
POST   /api/v1/spaces/{spaceId}/tasks
GET    /api/v1/spaces/{spaceId}/tasks/{recordId}
PATCH  /api/v1/spaces/{spaceId}/tasks/{recordId}
DELETE /api/v1/spaces/{spaceId}/tasks/{recordId}
```

A declared Action such as `complete` becomes:

```text
POST /api/v1/spaces/{spaceId}/tasks/{recordId}/actions/complete
```

This is **runtime projection**, not per-model API code generation. One Generic Runtime route resolves `modelRoute` and `actionKey` against the published Registry.

## 16. Generated Model Contract

Every successful Registry publication/retirement produces or activates an immutable Model Contract Revision containing concrete generated OpenAPI and JSON Schema.

Model-derived contract content includes:

- concrete collection/item paths;
- create/update/resource schemas;
- query parameters;
- Action paths;
- Capability contract contributions;
- model version/schema-hash evidence.

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

Rules already enforced by the Registry include:

- first publication must use `initial`;
- later publications cannot use `initial`;
- an unchanged schema hash is rejected;
- route conflicts are rejected;
- model versions advance monotonically per model key.

A model-only publication is designed not to require a Worker deployment when no Kernel/Capability/runtime implementation changes.

## 18. Complete Task example

The current Task model demonstrates the core v1 pattern:

```ts
{
  definitionVersion: 1,
  key: "task",
  route: "tasks",
  display: { singular: "Task", plural: "Tasks" },
  fields: {
    name: { type: "string", required: true, minLength: 1, maxLength: 100 },
    status: {
      type: "enum",
      required: true,
      values: ["pending", "completed", "cancelled"]
    },
    completedAt: { type: "datetime", nullable: true, readOnly: true },
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
    reopen: {
      access: "write",
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
Task is a model with generic CRUD/query behavior.
Task additionally exposes a semantic `complete` command.
`complete` is allowed only when the Task is not already completed.
The command, not the client, owns completed timestamp/actor bookkeeping.
The same generic Workflow engine executes it for every model.
The Action route and OpenAPI operation are derived automatically.
```

## 19. Why Action, Policy and Capability are separate

A useful decision rule is:

| Need | Use |
|---|---|
| store a model-specific value | Field |
| expose generic create/read/update/delete | Generic Runtime |
| restrict who may perform an operation | Policy |
| reject a semantic command in an invalid current state | Guard |
| choose different effects from current state | Branch |
| expose a model-specific semantic command | Action |
| reuse a stable semantic/runtime package across unrelated models | Capability |
| coordinate multiple records/services/long-running work | external Orchestration / future governed Change mechanism, not Workflow v1 |

In particular, do not promote every repeated-looking Action into a Capability. Reuse alone is insufficient; a Capability needs stable semantic identity plus meaningful reusable platform behavior.

## 20. Explicit v1 limits

Model Definition v1 is intentionally **not** a general-purpose programming language.

Not supported by current Workflow/Policy v1:

- arbitrary JavaScript, SQL, shell or user-supplied executable code;
- external HTTP/service calls inside Policy or Workflow;
- arbitrary Action input beyond `version`;
- cross-resource Action mutations;
- long-running orchestration;
- loops;
- user-defined functions;
- arbitrary expression evaluation;
- record-aware `read` Policy filtering;
- `now` / `space.*` in Policy expressions;
- arbitrary unregistered Capability names.

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
