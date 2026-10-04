# Authority Role Capability, Agent Principal and Bounded Re-delegation

Status: **Implemented architecture (#302 / PR #304); atomic multi-issuance completed by #298**

Date: 2026-10-02

This document records the accepted target architecture that extends Authority v2 without creating an Agent-specific authorization subsystem.

The existing North Star remains authoritative:

- Entity identity and operation roles are orthogonal.
- Authority is explicit, bounded, current-state, revocable and auditable.
- Principal identifies whose Authority is exercised.
- Actor identifies who actually executes at the LifeSpace trust boundary.
- Application Context remains independently attributable.
- Delegation never creates Authority; it can only allow an Actor to exercise a bounded subset of a Principal's current Authority.

## 1. Entity Role Capability

User, Service, Device and Agent are Entity Types. Whether an Entity Type may occupy an operation role must not be scattered as hard-coded type unions and database enum lists.

LifeSpace owns one code-level Entity Role Capability definition with at least:

```text
canBePrincipal
canBeActor
canDelegateOwnAuthority
canReceiveDelegation
authoritySources
```

These values express **role eligibility only**. They never grant business Authority.

Example target capability:

```text
Agent
  canBePrincipal             = true
  canBeActor                 = true
  canDelegateOwnAuthority    = true
  canReceiveDelegation       = true
  authoritySources           = [dataGrant]
```

A role-capable Agent with no current Data Grant or other supported Authority source remains unable to act on the corresponding business data.

Entity Role Capability is code-owned/static configuration for the initial implementation. It is not a per-request database lookup.

## 2. Direct Agent Authority

An Agent may act using explicitly granted independent Authority:

```text
Principal = Agent A
Actor     = Agent A
```

Effective Authority remains the ordinary current-state intersection:

```text
verified Execution Context
∩ credential scope
∩ Application × Model Access
∩ Principal current Authority (for Agent: Data Grant in the initial model)
∩ published Model capability
∩ Policy / Capability restrictions
```

Agent identity does not imply User Authority, Space membership or Space Person identity.

Unless a future explicit business-identity model says otherwise:

```text
principal.personId = null
actor.personId     = null
```

for direct Agent execution.

## 3. Unified Agent Execution Credential

Identity should converge on one short-lived **Agent Execution Token** instead of permanently separating "Agent own authority" and "delegated user authority" credential families.

Accepted target signed context:

```text
sub            = agt_* of the actual Agent Actor that owns/uses the token
principal_type = user | service | device | agent
principal_id   = Root Principal
actor_type     = agent
actor_id       = sub
azp            = registered Application
purpose        = agent_execution
scope          = stable credential scopes
```

The important rule is:

> `sub` identifies the authenticated Agent Actor; Principal is an independent signed operation-role claim.

Identity verifies:

- Application credential / context;
- active Agent identity and its Application binding;
- Principal identity existence/status where applicable;
- requested credential scopes against the Application ceiling.

Identity does **not** decide whether the Actor is currently authorized to represent a different Principal.

Core remains authoritative for:

- Principal current Authority;
- Delegation / Delegation chain;
- Application × Model Access;
- Model capability;
- Policy / Capability restrictions.

A Delegation ID remains an opaque request selector and is not embedded as bearer Authority in the token.

## 4. Execution Profiles

The unified model supports all of the following without special business authorization paths.

### 4.1 Entity uses its own Authority

```text
Principal = A
Actor     = A
Delegation = none
```

Example: Agent A directly uses its own Agent Data Grant.

### 4.2 Entity delegates its own Authority

```text
Principal = Agent A
Actor     = Agent B
Delegation = D1 (A -> B)
```

This is ordinary Delegation, not re-delegation.

### 4.3 Re-delegation of inherited Authority

```text
User U
  -> D1 -> Agent A
  -> D2 -> Agent B
```

The final operation remains:

```text
Principal = User U
Actor     = Agent B
leaf Delegation = D2
```

The Root Principal never changes merely because Authority passes through an allowed delegation chain.

## 5. Delegation Storage and Chain Shape

Authority v2 generic Delegation persistence remains the correct foundation:

```text
principal_type
principal_id
actor_type
actor_id
application_id
source_space_id
...
```

Do not create a second Agent-specific delegation model.

Extend the durable row with bounded chain metadata, conceptually:

```text
parent_delegation_id nullable
remaining_redelegation_depth integer
```

Naming can be finalized during implementation, but the semantics are fixed.

Root Delegation:

```text
D1
principal = Root Principal U
actor     = Agent A
parent    = null
remainingDepth = 1
```

Child Delegation:

```text
D2
principal = same Root Principal U
actor     = Agent B
parent    = D1
remainingDepth = 0
createdBy = Agent A
```

The child Principal is **not** rewritten to the immediate delegating Actor.

## 6. Re-delegation Rules

Re-delegation is supported, but never implicit.

Default:

```text
remainingRedelegationDepth = 0
```

so an ordinary Delegation cannot be propagated.

A parent that explicitly permits propagation may set a positive remaining depth, bounded by a small platform hard limit. Initial implementation should use a hard maximum no larger than 3 unless performance evidence justifies another bound.

Every Child Delegation must be a strict non-expanding derivative of its parent:

```text
child.scope                  ⊆ parent.scope
child.maxAccess              <= parent.maxAccess
child.expiresAt              <= parent.expiresAt
child.remainingDepth         < parent.remainingDepth
child.applicationId          = parent.applicationId
child.rootPrincipal          = parent.rootPrincipal
```

Target narrowing rules are deterministic:

```text
Space
  -> same Space
  -> Model in that Space
  -> Record in that Space

Model M
  -> same Model M
  -> Record belonging to M

Record R
  -> same Record R
```

No widening is allowed:

- record -> model;
- model -> space;
- model A -> model B;
- later expiry;
- higher access ceiling;
- increased propagation depth.

Initial re-delegation is same-Application only. Cross-Application propagation is a separate future architecture decision.

## 7. Chain Selection and Resolution

Clients submit only the leaf selector:

```http
X-LifeSpace-Delegation-Id: dlg_leaf
```

Clients do not submit `[D1,D2,...]` and do not participate in chain interpretation.

Core resolves:

```text
leaf -> parent -> ... -> root
```

and validates every current-state ancestor.

Core still does not search for or silently choose a "best matching" Delegation.

## 8. Parent Invalidation

Do not cascade-update descendants when a parent is revoked, expires or is consumed.

A parent lifecycle mutation remains O(1).

Every represented operation resolves the current ancestor chain. If any required ancestor is:

- revoked;
- expired;
- consumed when single-use;
- otherwise invalid;

the entire represented Authority is invalid immediately.

This preserves current-state authorization without maintaining descendant status copies.

## 9. Delegation Issuance

### 9.1 Root issuance

A Root Delegation requires verifiable confirmation by the Root Principal and a current check that the Principal actually owns the Authority being delegated.

### 9.2 Child issuance

A current Actor may issue a Child Delegation only when:

- it is the Actor authorized by the parent;
- the parent explicitly permits re-delegation;
- the requested Child is a valid subset of the parent;
- the complete parent chain remains currently valid;
- the Child stays inside the same Application Context for the initial implementation.

This is not a third party creating new Authority. It is propagation of the same Root Principal's explicitly propagatable Authority under stricter constraints.

`created_by_type/id` or equivalent immutable issuance evidence should identify the immediate issuer.

## 10. Single-use Semantics Across a Chain

The accepted rule is:

> A successful business exercise consumes every single-use Delegation that the operation actually depends on across the complete chain.

Example:

```text
D1 U -> A        maxUses=1
D2 U -> B        unlimited, parent=D1
```

A successful business operation by B consumes D1.

If both D1 and D2 are single-use, the successful operation consumes both.

### 10.1 Child creation does not consume parent single-use

Creating D2 from D1 is issuance/narrowing, not final business exercise.

Therefore creating a Child must not consume a single-use parent. Otherwise the newly issued Child would become unusable immediately because its required ancestor was already consumed.

### 10.2 Multiple children of one single-use parent are allowed

Example:

```text
             -> D2 -> Agent B
D1(single)
             -> D3 -> Agent C
```

Both Children may exist.

The first successful business execution that depends on D1 consumes D1. Every other descendant then becomes invalid through normal ancestor resolution.

The whole subtree therefore permits at most one successful exercise of D1 without requiring special "only one child" issuance state.

## 11. Mutation Atomicity

For a mutation, all of the following must commit or roll back together:

```text
business mutation
+ resource Change
+ durable Delegation-chain evidence
+ consumption of every required single-use ancestor
+ ChangeSet finalization when applicable
```

No single-use ancestor consumption may occur in a separate pre-commit network round trip.

Concurrent attempts must allow at most one successful exercise of a single-use Delegation.

## 12. Batch Semantics

Batch must preserve the same chain rules.

If two Batch operations depend on the same single-use ancestor, the Batch cannot successfully exercise that single-use Authority twice.

Example:

```text
op1 -> D2 -> D1(single)
op2 -> D3 -> D1(single)
```

The atomic ChangeSet must fail as a whole. Any provisional first consumption must roll back with the ChangeSet.

Batch Authority preparation must deduplicate shared:

- base Principal Authority keys;
- leaf Delegations;
- ancestor Delegations.

It must not resolve the same shared ancestor separately for every operation.

## 13. Read Semantics

Normal reads remain current-state authorized and must not gain an additional network round trip merely because chain support exists.

A single-use read is the bounded slow path because no business Change row exists.

For a successful single-use read:

1. prepare the authorized response;
2. atomically consume every required single-use Delegation in the chain;
3. return the response only after consumption succeeds.

The consumption step must handle ancestor contention and fail closed.

## 14. Governed Change Evidence

`resource_changes.delegation_id` may remain the leaf selector used for the request.

However, historical audit must not rely on reconstructing an old chain from mutable current Delegation state.

Add durable Change-to-chain evidence, conceptually:

```text
resource_change_delegations
  change_id
  delegation_id
  chain_position
```

Example:

```text
chg_123
  0 -> D1
  1 -> D2
  2 -> D3
```

The exact physical shape may be refined during implementation, but the invariant is fixed:

> Governed Change must preserve the actual Delegation chain relied on when the operation committed.

This also provides the natural atomic hook for mutation-time single-use ancestor consumption.

## 15. Migration Boundary

Do not manufacture business migration cost for unused execution profiles.

Existing direct User / Service execution remains unchanged.

Existing single-hop Delegation remains valid as:

```text
parent = null
re-delegation disabled
```

At the time of this decision, production Core is still schema 46 and production contains:

- 0 `agent_delegations`;
- 0 `resource_changes` with a Delegation;
- Data Grants only for Service principals in the inspected production data.

Therefore there is no production Agent delegation business-state conversion to perform before the generalized model.

Schema changes required to remove current Entity-type hard-coding are **structural migrations**, not business semantic migrations.

Known current constraints include:

- `data_grants.grantee_type`;
- `resource_records.created_by_type / updated_by_type`;
- `temporal_occurrences.recorded_by_type`;
- `resource_changes.principal_type`;
- `resource_change_sets.principal_type`.

Existing User / Service values are copied 1:1.

Prefer central verified role eligibility over repeatedly expanding closed database enums such as:

```text
CHECK(type IN ('user','service','device','agent',...))
```

for runtime attribution fields, so adding a future Entity Type does not require rebuilding multiple business tables merely to permit a new role-capable identity.

## 16. Rollout Sequencing

Because production has not yet adopted schema 47, avoid an unnecessary production sequence of:

```text
46
-> 47 (single-hop User->Agent only)
-> immediate later generalized chain schema
```

Prefer converging the generalized Authority schema and staging evidence first, then perform one production migration from the current production baseline to the accepted final schema if release timing permits.

This does not mean rewriting Authority v2. The generic Delegation structure, set-wise Authority resolution, Change/ChangeSet evidence and atomic mutation foundations from #295 remain the base.

## 17. Performance Invariants

### 17.1 Direct Agent

Agent-as-Principal must not add a Core Authority D1 round trip compared with direct User / Service execution.

Agent Data Grant lookup should reuse the existing set-wise Data Grant Authority shape.

Entity Role Capability must not require per-request D1 I/O.

### 17.2 Delegation chain

Never implement chain validation as:

```text
fetch leaf
await
fetch parent
await
fetch grandparent
...
```

Use bounded recursive or set-wise current-state resolution so the complete chain is read and validated within one bounded Authority I/O phase.

Target invariant:

```text
ordinary delegated Authority resolution <= 1 Core D1 RTT
```

Chain depth increases SQL/row work, not Worker<->D1 network round trips.

### 17.3 Batch

Batch remains O(1) in Worker<->D1 Authority round trips with respect to item count within the supported bound.

Shared ancestors are deduplicated before or inside the set-wise query.

### 17.4 Single-use

Mutation-time single-use ancestor consumption remains inside the existing atomic mutation batch and adds no standalone Worker<->D1 RTT.

Do not introduce a long-lived positive Authority cache.

## 18. Required Performance / Correctness Gates

Add structural/integration coverage for at least:

- direct Agent Principal read/write;
- Agent Data Grant grant/revoke effects;
- Agent A delegating its own Authority to Agent B;
- User -> Agent A -> Agent B re-delegation;
- scope/access/expiry/depth narrowing rejection;
- parent revoke/expire invalidating descendants;
- single-use ancestor consumed by descendant execution;
- multiple Children sharing one single-use parent;
- concurrent single-use descendant execution;
- Batch with shared ancestors;
- Batch conflict through one shared single-use ancestor;
- full Change chain evidence;
- bounded D1 RTT / statement shape at maximum supported depth;
- no N-times duplicate ancestor resolution in a 20-operation Batch.

## 19. Relationship to #298

#298 closes the remaining issuance consistency gap for one confirmed business intent that materializes as multiple independent Delegations.

Core exposes bounded atomic multi-issuance over the generalized Delegation primitive:

- request size is `1..20`;
- every item remains an independent immutable one-scope `dlg_*` object;
- a direct Principal may atomically issue multiple Root Delegations;
- a represented Actor may atomically issue multiple Child Delegations from explicit already-existing propagatable parents;
- all Root Principal Authority and parent-chain/narrowing checks complete before the write boundary;
- the D1 commit is all-or-none;
- Child issuance never consumes a single-use parent;
- v1 deliberately does not allow one item to reference a parent created by another item in the same request.

The multi-issue operation is an issuance atomicity primitive only. It does not create a Session Delegation, Approval Grant or multi-scope Delegation.

## 20. Implementation State

The repository implementation now includes:

- code-owned Entity Role Capability;
- Agent-as-Principal backed by explicit Data Grant Authority;
- bounded same-Application re-delegation with Root Principal preservation;
- set-wise chain resolution and chain-aware governed Change evidence;
- atomic single-use ancestor consumption on successful business exercise;
- bounded atomic multi-Delegation issuance for one confirmed business intent.

Production support remains a deployment fact and must be read from `docs/production/*`; repository/main/staging implementation alone must not be described as Production.
