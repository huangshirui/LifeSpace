# Agent-ready Authority and Change

Status: **Complete** on `feature/agent-delegation-foundation` after automated and staging acceptance.

## Purpose

LifeSpace supports independent Agent products such as HomeMew Agent and ALOHA Assistant without coupling them to each other or creating an AI-specific data world.

The stable platform rule is:

```text
Agent intent/action
  -> signed Execution Context
  -> current Effective Authority
  -> normal Model/Capability validation
  -> commit the same Shared Reality
  -> durable Change attribution
```

## Non-negotiable decisions

1. **Agent is an identifiable entity, not a User alias.** An Agent has an `agt_*` identity and is bound to the registered application(s) allowed to operate it.
2. **Agent has no inherited user authority.** A user-directed Agent operation requires an explicit, current, bounded Delegation.
3. **Principal and Actor are distinct roles.** For delegated user action, the User is the Principal whose authority is exercised and the Agent is the Actor executing the operation.
4. **Application context is explicit.** A Delegation is valid only in the same registered application context used by the signed Agent execution credential.
5. **Delegation only narrows.** It is intersected with the user's current credential scope, Application × Model Access, Space membership/Data Grant authority and Model/Capability policy. It never expands any of them.
6. **Revocation is current-state.** Core re-checks Delegation on each model access; a still-unexpired Agent JWT cannot preserve revoked authority.
7. **No Agent-only business data path.** Agent-created Event/Task/etc. uses the same Generic Runtime, Model Definition, validation, policy, optimistic concurrency and storage as Web/Mini Program operations.
8. **Every committed mutation leaves Change evidence.** The evidence separates Principal, Actor, application and Delegation while retaining existing `createdBy` / `updatedBy` compatibility.
9. **Unsigned actor hints are never authority.** Request headers/body fields such as `agentId` cannot impersonate an Agent or user. Agent execution context comes from an Identity-signed short-lived credential.
10. **Simple Change stays simple.** Ordinary CRUD and semantic Actions remain `Action/CRUD -> Authority -> Validation -> Commit`. Proposal/Approval/Compensation are future controls for higher-risk operations, not mandatory ceremony for every edit.

## Execution contexts

### Direct user

```text
Principal   = usr_*
Actor       = same usr_*
Application = app context from signed credential
Delegation  = none
```

### Trusted service / n8n

```text
Principal   = svc_*
Actor       = same service
Application = service's registered app context
Delegation  = none
```

Service authority remains its own explicit scope/Application × Model Access/Data Grant authority. It does not masquerade as user delegation.

### HomeMew member -> HomeMew Agent

```text
Principal   = household member usr_*
Actor       = HomeMew agt_*
Application = HomeMew application
Delegation  = member -> Agent, bounded to family Space/model access
```

### User -> ALOHA Assistant -> HomeMew family Space

```text
Principal   = user usr_*
Actor       = ALOHA agt_*
Application = ALOHA application
Delegation  = user -> ALOHA Agent, bounded to the family Space/model access
```

ALOHA calls the same LifeSpace Event/Task capability directly after authorization. It does not call HomeMew Agent.

## Agent execution credential

A trusted application backend registers its Agent with Identity and obtains a short-lived Core-only Agent execution JWT after it already knows the LifeSpace user identity.

The signed claims preserve:

```text
sub            = User Principal
azp            = Application Context
principal_type = user
actor_type     = agent
actor_id       = agt_*
purpose        = delegated_agent
scope          = stable credential scopes
```

The token authenticates the execution context. It does **not** contain durable Space/model authority. Core resolves that from current state.

Agent execution tokens are Core-only and cannot be reused as user Identity API credentials.

## Delegation

MVP Delegation is intentionally bounded to:

```text
User Principal
+ Agent
+ Application
+ Space
+ model -> maximum read/write/manage access
+ optional expiry
+ revocation state
```

Record-level/action-level delegation is not required for the first Agent-ready milestone. Add it only when a concrete product case requires narrower authority.

A Delegation can be created/revoked only by a direct user operation in the same application context. An Agent operation cannot grant itself additional authority.

## Effective Authority

For delegated Agent model access, Core requires all of the following:

```text
verified signed execution credential
∩ credential scope
∩ Application × Model Access
∩ User's current Space membership / Data Grant authority
∩ current Agent Delegation
∩ Model access capability
∩ Model/Capability policy
```

Failure of any term denies the operation.

## Governed Change

`resource_changes` is lightweight append-only evidence for committed Generic Runtime mutations. It is not a workflow engine and does not replace the domain record.

Each Change records at least:

```text
record / Space / model
operation
version before / after
changed fields
Principal
Actor
Application
Delegation reference when applicable
timestamp
```

The existing domain record continues to use the same Model Contract regardless of whether it was created by UI, service automation or Agent.

Operation Attribution and Information Provenance remain distinct:

- **Operation Attribution**: Principal, Actor, Application, Delegation — who exercised authority and executed the Change.
- **Information Provenance**: source, sourceRef, derivedFrom — where the information itself came from. Information Provenance can be expanded separately where the domain/use case requires it.

## Atomic Batch Create for Agent intent

Kernel 0.38.0 adds a bounded same-Space Batch Create primitive for cases where one user/Agent intent creates several ordinary records, including mixed models such as Event + Task. This is not an Agent-only data path: every item uses the same Model Definition, current Effective Authority, Model Policy, Capability preparation, relation validation, Provenance and governed Change attribution as ordinary single Create.

The batch is all-or-nothing. Current write authority and Agent Delegation are evaluated per distinct selected model, so one unauthorized or invalid item prevents every item from committing. Adapters such as n8n, MCP and ALOHA should use the Kernel batch primitive rather than implement loops with partial-success semantics.

## Event evidence boundary

Domain Event / Webhook delivery remains **reference-only**. Agent readiness does not copy User/Agent identity or full Change attribution into every outbound Webhook.

The durable correlation key is the committed resource version:

```text
Domain Event
  Space + model + record + recordVersion
        ↓
Governed Change
  Space + model + record + versionAfter
```

For Agent-originated mutations, the legacy outbox `actor_type` / `actor_id` continues to reflect the authority-bearing Principal for compatibility, while `resource_changes` is authoritative for the separated User Principal + Agent Actor + Application + Delegation attribution.

An authorized subscriber that needs operation attribution uses the Event's opaque `changeId` and reads exact Change Detail through normal LifeSpace authorization. New Generic Runtime events bind that reference in the same mutation transaction. Legacy pre-linkage Event evidence may have no `changeId` and must fall back to its historical record/version correlation without fabricating exact detail. This keeps Eventing minimal and avoids broadcasting identity metadata or field values to subscribers that only need a change notification.

`changedFields` remains compatibility evidence for fields touched/submitted by the mutation path. Kernel 0.37 adds independent `fieldChanges` exact before/after evidence. A submitted no-op may therefore advance the record version and appear in `changedFields` while `fieldChanges` is empty. Workflow and Capability Actions additionally persist their semantic `actionKey`. Exact Change Detail is immutable for the committed version and remains readable after later updates or soft deletion only while the caller retains current read authority for that Space/model.

## Agent-ready acceptance gate

### HomeMew Agent

A household member can delegate Event/Task authority to HomeMew Agent. The Agent can use the normal Runtime only within that member's effective family-space authority, and the resulting Change identifies both member and Agent.

### ALOHA Assistant

A user can delegate Event/Task authority in the HomeMew family Space to ALOHA. ALOHA uses the same LifeSpace capabilities directly; revoking the Delegation blocks subsequent access immediately.

### Current ALOHA M4 product authority

The 2026-09-01 staging scenario below was a **platform proving scenario**, not a durable ALOHA product entitlement. It intentionally exercised ALOHA with Task write authority to prove Agent mutation attribution and revocation. ALOHA's first real Runtime Tool milestone is narrower.

Current ALOHA M4 candidate authority is:

```text
Application scopes     = profile:read + resources:read
Application × Model    = task:read only
User -> Agent Delegation = task:read only
Agent execution scope  = resources:read only
Runtime semantics      = Inventory -> selected Model semantic detail -> Canonical Query / Get
Mutation / Action      = denied; deferred to M5 Confirmation boundary
```

The ALOHA Agent Control backend is the only consumer of the short-lived delegated Agent JWT. n8n receives neither the `lsa_*` application credential nor the delegated Agent JWT. The staging Application identity is milestone-neutral; M4/M5 are authority-profile evolution, not new Application identities.

This M4 LifeSpace-side gate does not claim that the separate real Cloudflare Access M3 production activation is complete. Production M3 activation remains independently gated by its own deployment evidence.

### Required deny paths

- no Delegation -> no inherited user authority;
- wrong Space -> denied;
- wrong application -> denied;
- model/access above Delegation -> denied;
- model/access above user's current authority -> denied;
- model/access above Application × Model Access -> denied;
- unsigned Agent-looking input -> ignored as authority;
- Agent cannot self-create Delegation;
- Agent adapter cannot bypass normal model validation, policy or optimistic concurrency.

## Staging acceptance evidence

The Agent-ready staging gate passed on 2026-09-01:

```text
workflow:   Agent-ready staging gate
run ID:     33507669643
commit:     9591777b176f3084f9586e24d2b3927aa979c50e
Core:       contract 0.17.0 / schema 32
Identity:   contract 0.6.0 / schema 8
```

The M4 verifier proved two independent Agent products over one temporary family Space:

- HomeMew Agent application: `app_homemew_agent_staging`; Delegation `event=write`, `task=read`;
- ALOHA Assistant application: `app_aloha_assistant_staging`; Delegation `event=read`, `task=write`;
- both used the same Generic Runtime and published Event/Task models;
- HomeMew Agent committed a real Event and ALOHA committed a real Task;
- both committed Changes preserved User Principal + Agent Actor + Application + Delegation attribution;
- Domain Event evidence correlated with governed Change by record/version while Webhook actor identity remained reference-only;
- revoking ALOHA Delegation blocked a still-valid Agent token immediately;
- live current-state checks also denied access after temporarily narrowing Application × Model Access and the user's Space membership;
- no-Delegation, wrong-Space, wrong-Application, Delegation ceiling, Agent self-grant and semantic-validation bypass paths were denied;
- temporary records, Spaces, credentials and Delegations were cleaned up; production was untouched.

The full staging gate also passed existing model regression, Registry-driven Creation Draft, signed reference-only Eventing, D1 hot-path checks and the reproducible HomeMew handoff export.

The accepted HomeMew compatibility tuple after this gate is:

```text
Identity Contract:    0.6.0
Core Kernel Contract: 0.17.0
Model Contract:       mct_a4cc6dad278204b08cd706f9abeb68107e229148f1cd9ccde0991382606a92b9
```

The reproducible staging handoff evidence is:

```text
bundle ID:     hmb_717d91aae0fb0c0b5a79f939050dfb8b4ad2af0abca80fd5bc76198aa7b8a770
artifact ID:   9800565590
artifact name: homemew-contract-handoff-9591777b176f3084f9586e24d2b3927aa979c50e
artifact SHA:  bc8b7179f4976f0e9817f0be5528eec85f0c45de1b01e2abd71a0b8af6b30f23
```

The GitHub-hosted HTTP performance sample from this run is diagnostic only because runner geography is uncontrolled; it is not an acceptance gate. Deterministic D1 hot-path/round-trip budgets remain enforced by Core tests.

With automated tests and this staging evidence passing, the Agent-ready architecture gate is complete and the branch is merge-ready subject to normal final CI/review.
