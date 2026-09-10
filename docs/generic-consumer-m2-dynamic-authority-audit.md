# Generic Consumer Readiness v1 — M2 Dynamic Context / Authority / Cost Audit

Status: **M2 acceptance design — no Runtime behavior change**  
Date: **2026-09-07**  
Owning issue: **#165 — Generic Consumer Readiness v1**  
Depends on: M0 matrices, M0-B performance gate, M1 static projection audit, #155 record reference-label semantics

## 1. Purpose

M2 defines the dynamic correctness boundary before #165 permits M3 implementation.

M0/M1 established that static Model semantics can be progressively projected without rewriting Generic Runtime. M2 now fixes the requirements for mutable context and authority:

- G5 — batch Reference Resolution / Hydration for relation IDs a caller already holds;
- G8 — state-transition and concurrent revocation conformance across mutable authority sources;
- dynamic cache/freshness rules for compact inventory, relation lookup and reference projection;
- request/I/O bounds inherited from M0-B;
- one additional current-main semantic drift found during M2: Service Principal disablement is not currently rechecked for already-issued OAuth service JWTs even though Stable documentation describes Service Principal state as current/revocable.

M2 is still audit/acceptance work. It does not introduce a new endpoint or modify authentication/Runtime behavior.

## 2. Stable authority invariant and linearization boundary

LifeSpace's Stable authority commitment is current-state revocation for mutable authority sources that are defined as current-state inputs.

The precise v1 linearization rule is:

> After an authority mutation/revocation transaction commits, an authoritative authorization check that begins afterward must observe the new committed state and must not authorize from a stale positive projection.

v1 does **not** promise:

- cancellation of a request whose authoritative authorization decision completed before the revoke commit;
- distributed transaction rollback across an already-started external side effect;
- revocation by invalidating every cached UX projection before it can be displayed;
- global push invalidation of all clients.

This distinction is required for deterministic concurrent tests.

Conceptually:

```text
request A: authority check -------- execution
                         |
                         | revoke commit
                         v
request B:                       authority check -> must see revoked state
```

Request A may complete if its authoritative check linearized before the revoke commit. Request B must fail if its check occurs after the commit.

## 3. Projection is not authority

All dynamic consumer-facing projections are point-in-time facts.

This includes:

- compact current capability inventory;
- current Space/model visibility;
- current effective access level shown to a client;
- current Action visibility;
- Relation Target Lookup results;
- Reference Resolution labels;
- cached UI selector options.

A consumer may cache these for UX and routing. It may not present them back as proof of permission.

Normal execution remains authoritative:

```text
credential/authentication validity
∩ current Application × Model Access
∩ current Membership/Data Grant
∩ current Delegation when delegated Agent
∩ active published Model
∩ Model access declaration
∩ current Policy/Capability/record state
```

A write/query/action must therefore continue to execute correctly even when the caller skips Discovery entirely or holds a stale positive Discovery result.

## 4. Relation Target Lookup and Reference Resolution are different contracts

### 4.1 Relation Target Lookup

Question:

> Which current targets may I select for this relation field?

Properties:

- source relation field is known;
- current authority and source Model read Policy apply;
- search + cursor pagination are appropriate;
- result is a selector hint, not mutation authority;
- mutation rechecks current relation/Policy/authority.

Current Person lookup already satisfies this bounded shape.

### 4.2 Reference Resolution / Hydration

Question:

> I already hold these relation IDs. What minimal current display references may I resolve for them?

Properties:

- caller does not need the full candidate universe;
- many held IDs must be resolved in one bounded operation rather than one HTTP/D1 request per ID;
- result must minimize information and hide target existence distinctions the caller is not independently authorized to know;
- resolution is presentation/context data, never permission to mutate the target or source record.

Adapters must not emulate Reference Resolution by calling Relation Target Lookup repeatedly and searching pages for each held ID.

## 5. G5 — Batch Reference Resolution acceptance contract

### 5.1 Input context

Resolution must be anchored to enough LifeSpace-owned relation semantics to avoid guessing target type or label rules.

For a relation value originating from an ordinary model field, the request semantics must identify at least:

- source Space;
- source model identity/key;
- source relation field;
- bounded list of caller-held target IDs.

The source field determines relation kind/cardinality and, for record relations, target model. A caller must not supply an arbitrary target model to reinterpret a source relation field.

Exact method/path/body names remain Candidate representation until implementation review.

### 5.2 Batch bound

The operation must have an explicit finite maximum number of IDs per request.

Acceptance requires:

- maximum is documented and mechanically enforced;
- implementation stays inside D1 binding/request budgets, using bounded chunking/batching if necessary;
- D1/HTTP work does not scale as one network round trip per ID;
- duplicate IDs have deterministic behavior;
- malformed request structure fails before target-by-target lookup.

M2 does not invent an arbitrary permanent numeric limit. The implementation PR must choose a concrete bound from D1/request evidence; it should not exceed the current general relation/query bounded-consumer expectations without separate evidence.

### 5.3 Per-item result semantics

For every syntactically valid caller-supplied ID, the batch result should provide one deterministic item with only one of two visibility states:

```text
resolved
  -> id + minimal canonical label/reference projection

unavailable
  -> caller-supplied id + opaque unavailable status
```

`unavailable` intentionally does **not** distinguish:

- target does not exist;
- target was deleted;
- target exists but caller cannot see it;
- target exists in another Space;
- target fails current target Policy;
- target is otherwise not currently resolvable.

The caller already supplied the opaque ID, so echoing that ID does not reveal a new identifier. The status must not reveal hidden existence/lifecycle information.

Richer states such as `deleted`, `forbidden` or `hidden` are outside v1 unless a future contract proves the caller is independently authorized to know that distinction.

### 5.4 Whole-request denial vs per-item opacity

These cases are different:

- malformed source model/field/request -> normal 4xx validation/not-found contract as appropriate;
- caller lacks authority to use the source model/relation projection at all -> whole request fails closed;
- caller is authorized to request the relation projection, but an individual supplied target cannot be resolved -> that item is `unavailable` without a reason.

This prevents a batch resolver from becoming an existence oracle.

### 5.5 Person references

Person relations already have a canonical minimal label: Space Person `displayName`.

A batch resolver may therefore support `person` / `person_list` using the same source-field-aware authority semantics as current Relation Target Lookup.

It must not expose Membership rows, linked global User identity, roles, emails or other Person metadata merely to resolve a display reference.

### 5.6 Ordinary record references

`record` / `record_list` resolution depends on canonical ordinary-record reference-label semantics.

#155 remains the owner of that semantic. M2 does not define a second label convention.

Until #155 is implemented, a generic resolver may:

- support Person relation fields; and
- explicitly report field-level unsupported capability for ordinary record relations.

It must not infer labels from `title`, `name`, `summary` or other model-specific conventions.

Once #155 exists, record resolution must additionally enforce the target model/current read visibility required by that canonical reference projection.

### 5.7 Mutation independence

Successful resolution does not authorize assignment.

A later create/update/action must re-evaluate normal current authority, Policy and relation integrity. The resolved label itself is never an authorization token or durable foreign-key proof.

## 6. Dynamic authority transition matrix

The M2 conformance harness must use controlled state transitions rather than only static positive/negative fixtures.

Each family should prove:

```text
State A
  projection says usable
  execution succeeds

commit authority/state mutation

State B
  fresh projection removes/reduces capability as applicable
  authoritative execution started after commit fails or reflects new state
  stale cached State-A projection cannot restore authority
```

### 6.1 Membership

Representative transitions:

- active membership -> leave/remove;
- role downgrade, e.g. editor -> viewer;
- Space close as a stronger active-Space boundary.

Evidence must cover both Discovery/inventory effect and ordinary Runtime execution after commit.

### 6.2 Data Grant

Representative transitions:

- active model/Space grant -> revoke;
- write -> read downgrade;
- active -> expired where deterministic clock control is available;
- whole-Space + model grant precedence where one remains after the other is revoked.

Fresh projection and execution must agree on the new effective maximum.

### 6.3 Application × Model Access

Representative transitions:

- write -> read ceiling reduction;
- catalog entry removal;
- application ceiling remains an intersection, never overridden by Membership/Grant.

A valid credential and Data Grant must not preserve model write access after the application ceiling is reduced.

### 6.4 Agent Delegation

Representative transitions:

- active Delegation -> revoke;
- write -> read replacement/reduction where supported by lifecycle;
- expiry;
- Delegation removal for one Space/model while other authority remains.

A delegated-Agent JWT may remain cryptographically valid, but Core's current Delegation check must deny a request whose authoritative check starts after revocation commit.

### 6.5 Model publication / retirement

Representative transitions:

- active model identity A -> newly published active identity B;
- active model -> retired.

Fresh inventory/detail identity must advance/remove accordingly. An old exact `mct_*` remains immutable evidence but must not make a superseded/retired historical Runtime version executable.

### 6.6 Relation target state

Representative transitions for current Person support:

- visible Person -> deleted/removed;
- display label A -> label B.

Fresh target lookup/reference resolution must reflect current state. A stale label may remain in a client cache for presentation, but mutation still resolves/validates current relation state independently.

## 7. Credential/principal freshness is credential-mode specific

M2 must not use the phrase “current principal state” as if all credential types have the same revocation behavior.

### 7.1 Opaque `lsp_pat_*` Service API Token

Current behavior:

```text
Core receives opaque token
-> Identity introspection on each inbound request
-> current token + Service Principal + application status/scopes
```

Immediate token revocation/scope reduction/principal disablement is therefore a current-state decision on subsequent requests.

This behavior is aligned with the documented recommendation for owner-controlled n8n/scripts/MCP/backend automation.

### 7.2 Delegated-Agent JWT

The JWT is locally verified, but delegated authority is not carried solely by the token.

Core rechecks current User -> Agent Delegation and current Space/model authority. Therefore revoking the Delegation blocks subsequent delegated Runtime requests even while the JWT remains cryptographically valid.

### 7.3 Ordinary user JWT

Core locally verifies the short-lived Identity-signed JWT and rechecks Core-owned mutable Space/model authority on execution.

M2 does **not** create a new promise that disabling a global User in Identity is synchronously introspected by Core on every ordinary JWT request. That would be a new authentication contract outside the proven #165 requirement and must not be inferred from Data Grant/Membership revocation semantics.

### 7.4 OAuth `client_credentials` Service JWT — proven current drift

Current service authentication documentation states that Service Principal/current credential status belongs to Identity and the Stable Contract Baseline lists Service Principal under Current-State Revocation. The same documentation also records that service JWTs use local RS256 verification in Core.

Current Core `verifyAccessToken()` validates signature/issuer/audience/expiry/principal claims but does not introspect current Service Principal/application state for an already-issued JWT.

Therefore:

> An OAuth service JWT issued while the Service Principal is active can remain acceptable to Core until JWT expiry even if that Service Principal is disabled afterward, subject to Core-owned authority checks.

This differs from opaque `lsp_pat_*` and from the current Stable wording that stale credentials do not preserve disabled Service Principal authority.

Classification: **G10 — current Stable semantic drift, not merely missing conformance coverage.**

## 8. G10 acceptance direction — align service JWT with the Stable revocation promise

M2 adopts the existing Stable Current-State Revocation commitment rather than silently weakening it for OAuth service JWTs.

Required externally observable rule:

> If a Service Principal or its owning application is disabled and that mutation commits, a subsequent Core request authenticated by an already-issued service JWT must not be authorized solely because the JWT is still cryptographically valid.

Implementation strategy is intentionally not fixed by M2, but it must satisfy:

- Identity remains the source of Service Principal/application active state;
- Core does not copy Identity's principal-status table into Core D1 as a second authority source;
- failure to establish required current status fails closed;
- no positive cache may extend authority past the promised revocation boundary;
- added cross-service I/O must be measured explicitly because M0-B/Phase-3 performance discipline still applies;
- opaque token and service JWT modes must normalize to equivalent effective authority, even if authentication mechanics differ.

Likely implementation options may include authenticated Identity Service Binding eligibility/introspection reuse, but M2 does not pre-authorize a cache/DO/KV architecture.

This gap should receive a focused implementation issue/PR after M2 is merged.

## 9. Concurrent-boundary harness design

Static “before revoke succeeds / after revoke fails” tests are necessary but insufficient for the stated linearization rule.

The dynamic harness must support a controlled authorization barrier around at least representative mutable sources.

Conceptual fixture:

```text
request R1 starts
  -> pause immediately before authoritative current-state read
commit revoke
  -> release R1 authorization read
  -> R1 must observe revoked state

request R2 starts
  -> complete authoritative read while authority is active
pause before mutation persistence
commit revoke
  -> release R2
  -> v1 does not require cancellation solely because revoke committed later
```

The test mechanism may use injected repositories/hooks/test-only barriers. Production semantics must not depend on test hooks.

Minimum representative concurrent boundaries:

- Data Grant revoke;
- Agent Delegation revoke;
- Application × Model Access reduction or removal.

Membership removal/Space close and Service Principal disablement should receive equivalent coverage when their implementation boundary can be controlled deterministically.

## 10. Failure and opacity rules

Dynamic projection APIs must fail closed without unnecessarily revealing protected state.

Rules:

- invalid authentication -> 401;
- insufficient whole-operation authority -> 403/appropriate existing opaque contract;
- caller-supplied invalid model/field syntax -> deterministic validation error;
- Reference Resolution individual hidden/missing/deleted/forbidden target -> opaque `unavailable`;
- cached positive Discovery/lookup result never changes an execution 403 into success;
- Identity current-status dependency failure for a credential mode that requires current introspection -> fail closed, not stale-positive fallback;
- dynamic projection errors must not be interpreted by Adapter as authority to retry mutation through a broader generic path.

## 11. Dynamic caching rules

### Safe to cache as UX/semantic data

Subject to normal version/identity invalidation:

- static model semantic detail keyed by `(Kernel contractVersion, key, version, schemaHash)` when caches may survive a Kernel deployment;
- immutable `mct_*`;
- previously resolved display labels for non-authoritative presentation, where product UX accepts staleness.

### May be cached only as non-authoritative hints

- compact current inventory;
- current Space/model visibility;
- effective access labels;
- Action visibility;
- target lookup results;
- Reference Resolution results.

### Must not be authorized from a stale positive cache

- Membership;
- Data Grant;
- Application × Model Access;
- Agent Delegation;
- required Service Principal/application active state;
- record Policy/current state;
- current relation integrity.

No TTL value can convert a stale dynamic projection into proof of authority.

## 12. Performance / cost acceptance

M2 inherits M0-B's structural result and adds the following requirements.

### 12.1 Relation Target Lookup

Preserve current evidence:

- explicit finite page bound;
- keyset cursor;
- no D1 round trip per returned target;
- no need to preload all candidates into an LLM/tool context.

### 12.2 Batch Reference Resolution

Implementation evidence must record:

- maximum IDs/request;
- response bytes for representative 1/small/max batches;
- D1 round trips for representative 1/small/max batches;
- proof that network round trips are not one-per-ID;
- opaque partial-result behavior at mixed resolved/unavailable cardinalities.

### 12.3 Current authority

Batch current-state checks where semantics permit, as Runtime Discovery and `requireModelAccess()` already do for Core-owned authority.

Do not cache mutable authority to eliminate a round trip unless a separately reviewed design preserves the Stable revocation boundary.

### 12.4 Service JWT current-state check

If G10 is closed by adding a Core -> Identity current-status call on service JWT requests, the focused implementation must measure its added wall time/request count in a controlled deployed environment before calling the change performance-complete.

The correctness requirement takes priority over pretending a stateless local JWT check currently satisfies immediate Service Principal revocation.

### 12.5 APAC latency

Local Vitest timings remain diagnostic. Absolute deployed claims use the existing controlled APAC probe method.

## 13. M2 implementation decomposition after audit completion

Once M2 is merged, #165 may create focused M3 implementation issues/PRs. Recommended dynamic units:

### D1 — Batch Reference Resolution

Owns G5.

- source-field-aware bounded batch contract;
- Person resolution first using canonical Space Person labels;
- ordinary-record support only after/in coordination with #155;
- opaque per-item `resolved | unavailable`;
- no per-ID network waterfall.

### D2 — Dynamic state-transition / revocation harness

Owns G8.

- reusable transition fixtures;
- controlled commit-point concurrency tests;
- Membership/Data Grant/App×Model/Delegation/model/relation state coverage;
- proves stale projection cannot restore execution authority.

### D3 — Service JWT current-state revocation alignment

Owns G10.

- align already-issued OAuth service JWT behavior with Stable Service Principal/application current-state disablement;
- keep Identity as status source of truth;
- fail closed;
- measure added cross-service cost;
- do not introduce speculative distributed authority cache.

#155 remains a separate semantic prerequisite for ordinary-record reference labels. #130 remains separate from these dynamic authority tasks.

## 14. M2 exit criteria

M2 is complete when:

- Relation Target Lookup and Reference Resolution are explicitly separate contracts;
- batch resolution input context, opaque partial-result semantics and cost bounds are explicit;
- Person resolution can be implemented without exposing Membership/global-user details;
- record resolution remains bound to #155 instead of field-name guessing;
- current-state revocation has an explicit commit-point linearization rule;
- state-transition and concurrent-boundary harness cases are defined for mutable authority sources;
- credential-mode-specific freshness is documented without overclaiming user JWT semantics;
- OAuth service JWT current-state drift is explicitly classified as G10 and has an implementation acceptance direction consistent with the Stable revocation promise;
- dynamic cache rules distinguish UX hints from authority proof;
- M0-B/Phase-3 performance discipline remains mandatory.

After M2 is merged, M0–M2 planning/audit is complete and #165 may proceed to M3 through independent focused issues/PRs. It should **not** create one monolithic Runtime rewrite branch.
