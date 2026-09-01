# Agent-ready Authority and Change

Status: target contract for `feature/agent-delegation-foundation`.

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

## Agent-ready acceptance gate

### HomeMew Agent

A household member can delegate Event/Task authority to HomeMew Agent. The Agent can use the normal Runtime only within that member's effective family-space authority, and the resulting Change identifies both member and Agent.

### ALOHA Assistant

A user can delegate Event/Task authority in the HomeMew family Space to ALOHA. ALOHA uses the same LifeSpace capabilities directly; revoking the Delegation blocks subsequent access immediately.

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

The branch is merge-ready only after these paths pass automated and staging verification while existing direct-user/service/n8n behavior remains regression-safe.
