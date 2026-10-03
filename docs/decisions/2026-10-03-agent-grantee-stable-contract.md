# Add Agent to Stable Principal and Data Grant representations

Status: **Accepted**

Date: 2026-10-03

## Context

Authority v3 makes Entity Role Capability explicit and allows an Agent to act as a Principal when it owns Authority. Two existing Stable/Public Kernel representations therefore need to expose the same Entity vocabulary:

- `PrincipalType` must include `agent`, because direct Agent execution can legitimately appear from `/api/v1/me` and in governed Change principal attribution;
- `GranteeType` must include `agent`, because Data Grant is the existing platform Authority source for non-membership Principals and an Agent Principal must be able to own explicit Space/model Authority.

Introducing a parallel Agent-only principal/grant representation would duplicate Authority semantics and violate the single generic Principal/Actor/Authority model.

Both existing schemas are closed enums. Adding `agent` is wire-compatible for tolerant string consumers but is a formal Stable response-enum widening: generated clients or exhaustive switch statements may reject an unknown value. The Stable compatibility gate correctly blocks these changes until an explicit migration decision exists.

Repository and downstream checks performed for this change found no active first-party exhaustive dependency that would require a business migration:

- LifeSpace Console represents inspected `granteeType` as `string` and renders the value generically;
- LifeSpace Core callers/tests use concrete known principal/grantee types rather than relying on a four-value runtime branch for application behavior;
- HomeMew contains no `granteeType` / `GranteeType` dependency and does not own the Kernel Principal vocabulary;
- `lifespace-n8n-nodes` contains no `granteeType` / `GranteeType` dependency; its Agent execution profile will be adapted after the Kernel contract is proven.

No existing stored Principal, Grant, Change or Delegation changes meaning. Existing values remain valid and byte-for-byte unchanged.

## Decision

Core Kernel 0.41.0 adds `agent` to both Stable/Public vocabularies:

- `PrincipalType = user | service | device | agent`;
- `GranteeType = user | space | service | device | agent`.

Core schema 48 permits Agent values in runtime attribution and Data Grants without keeping the Entity vocabulary as closed table CHECK constraints. Runtime acceptance is still governed by code-owned Entity Role Capability and verified Execution Context; storage widening does not grant capability by itself.

This is an explicit Stable Public representation migration. The affected Stable groups remain Stable; they are not downgraded to avoid compatibility review. After this decision, implementation/tests and downstream evidence are present, the accepted Stable schema baseline is regenerated deliberately for Kernel 0.41.0.

The Platform Admin Space Inspector representation is updated at the same time so operational tooling can observe Agent grants without a second vocabulary.

## Compatibility

Existing request/response values for `user`, `space`, `service` and `device` retain their existing meanings.

Consumers that modeled `PrincipalType` or `GranteeType` as exhaustive closed enums must add `agent` (or treat future verified Entity types as forward-compatible values) before consuming Kernel 0.41.0 responses. No current first-party downstream code identified by this change requires a data or product migration.

There is no automatic Authority upgrade. Creating/registering an Agent identity gives it no Space/model Authority. A direct Agent Principal becomes authorized only through an explicit current Authority source such as an Agent Data Grant. Represented Agent execution additionally requires a current Delegation/Delegation-chain.

## Data migration

Migration 0048 performs structural vocabulary widening:

- rebuild `data_grants` without the historical closed grantee-type CHECK;
- rebuild runtime attribution/audit tables without the historical closed Principal/Actor type CHECKs;
- copy every existing row unchanged;
- add bounded Delegation-chain structure/evidence independently of the Entity vocabulary widening.

The runtime remains stricter than storage: Core's Entity Role Capability determines whether an Entity type may be a Principal, Actor or Delegation participant, and API creation/authentication paths validate currently supported verified types. Removing database enums avoids future table rebuilds solely to extend that verified Entity vocabulary.

## Rollback

Before any Agent Grant, Agent Principal Change evidence or Agent-owned Delegation exists, application rollback to Kernel 0.40.0 can be performed with the usual compatible schema/runtime procedure.

After those new 0.41.0 values exist, rolling runtime code back to a version that cannot interpret `agent` as a Principal/grantee is not supported without first removing/revoking the new Agent-owned Authority and restoring a compatible runtime. Production rollout must therefore treat Kernel 0.41.0 / schema 48 as the capability boundary for Agent-owned Authority.