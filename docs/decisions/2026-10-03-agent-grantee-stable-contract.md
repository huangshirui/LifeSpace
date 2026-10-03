# Add Agent as a Stable Data Grant grantee

Status: **Accepted**

Date: 2026-10-03

## Context

Authority v3 makes Entity Role Capability explicit and allows an Agent to act as a Principal when it owns Authority. The existing Data Grant model is the platform Authority source for non-membership Principals. Therefore an Agent Principal needs `granteeType=agent`; introducing a parallel Agent-only grant store or endpoint would duplicate Authority semantics and violate the single generic Authority model.

The Core Kernel Data Grant representation is Stable/Public and currently documents `granteeType` as the closed enum `user | space | service | device`. Adding `agent` is wire-compatible for tolerant string consumers but is a formal Stable response-enum widening: generated clients or exhaustive switch statements may reject an unknown value. The Stable compatibility gate correctly blocks this change until an explicit migration decision exists.

Repository and downstream checks performed for this change found no active exhaustive dependency on the four-value enum:

- LifeSpace Console represents inspected `granteeType` as `string` and renders the value generically;
- LifeSpace Core tests and infrastructure automation create concrete `service` grants rather than exhaustively branching over all grantee types;
- HomeMew contains no `granteeType` / `GranteeType` dependency;
- `lifespace-n8n-nodes` contains no `granteeType` / `GranteeType` dependency.

No existing stored grant changes meaning. Existing values remain valid and byte-for-byte unchanged.

## Decision

Core Kernel 0.41.0 adds `agent` to the Stable/Public `GranteeType` representation and Core schema 48 permits `data_grants.grantee_type='agent'`.

This is an explicit Stable Public representation migration. The `core-data-grants` group remains Stable; it is not downgraded to avoid compatibility review. After this decision, implementation/tests and downstream evidence are present, the accepted Stable schema baseline is regenerated deliberately for Kernel 0.41.0.

The Platform Admin Space Inspector representation is updated at the same time so operational tooling can observe Agent grants without a second vocabulary.

## Compatibility

Existing requests and responses for `user`, `space`, `service` and `device` are unchanged.

Consumers that modeled `granteeType` as an exhaustive four-value enum must add `agent` (or treat future Entity types as forward-compatible strings) before consuming Kernel 0.41.0 responses. No current first-party downstream code requires such a migration.

There is no data backfill. Agent Authority is created only when a new Agent Data Grant is explicitly issued; creating or registering an Agent identity never grants Space/model Authority implicitly.

## Data migration

Migration 0048 rebuilds `data_grants` without the historical closed-list table CHECK. Existing rows are copied unchanged. This is structural vocabulary widening, not business-data conversion.

The runtime remains stricter than storage: Core's code-owned Entity Role Capability decides whether an Entity type may be a Principal/Actor/Delegation participant, and grant creation validates currently supported grantee types. Removing the database enum avoids future table rebuilds solely to extend the verified Entity vocabulary.

## Rollback

Before any Agent grant is created, application rollback to Kernel 0.40.0 can be performed with the usual compatible schema/runtime procedure.

After Agent grants exist, rolling runtime code back to a version that cannot interpret `granteeType=agent` is not supported without first revoking/removing those Agent grants or restoring a compatible runtime. Production rollout must therefore treat Kernel 0.41.0 / schema 48 as the capability boundary for Agent-owned Authority.