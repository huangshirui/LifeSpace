# Agent-ready Authority and Change

Status: **Active platform authority specification**.

## Purpose

LifeSpace supports independent Agent consumers without coupling the platform to any particular Agent product or creating an AI-specific data world.

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

### Trusted service / automation

```text
Principal   = svc_*
Actor       = same service
Application = service's registered app context
Delegation  = none
```

Service authority remains its own explicit scope/Application × Model Access/Data Grant authority. It does not masquerade as user delegation.

### User -> delegated Agent

```text
Principal   = user usr_*
Actor       = agent agt_*
Application = registered application context
Delegation  = user -> Agent, bounded to Space/model access
```

The Agent calls the same LifeSpace model/capability surfaces used by traditional applications. It never calls another product Agent as an authorization shortcut.

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

Platform acceptance must prove the generic authority model without relying on any named consumer application.

### Required positive paths

- a user can create an explicit bounded Delegation to a registered Agent;
- a short-lived Agent execution credential preserves User Principal + Agent Actor + Application context;
- Generic Runtime uses the same model/Capability validation and storage path as direct-user operations;
- committed mutations preserve User Principal + Agent Actor + Application + Delegation attribution;
- revoking Delegation blocks subsequent requests even when the Agent JWT is still cryptographically valid;
- narrowing Application × Model Access or current Space authority blocks subsequent Agent access immediately.

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

Staging verification uses ephemeral generic Application/Agent/User/Space fixtures and cleans them up after the gate. Consumer-specific authority profiles, milestones and compatibility acceptance belong to the consumer repository.
