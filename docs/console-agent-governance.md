# LifeSpace Console Agent Identity Governance

## Purpose

LifeSpace Console is the operator surface for stable Agent identity (`agt_*`) configuration. Identity remains the source of truth; Console is a policy/UI shell over the canonical Identity control plane.

The first consumer is ALOHA M3, but this boundary is platform-wide and applies equally to HomeMew and future Agent applications.

## Contract split

Agent identity governance is part of the independent Identity Platform Admin companion contract:

```text
Identity Application Contract:    0.6.0
Identity Platform Admin Contract: 0.2.0
Core Platform Admin Contract:     0.2.0
```

The ordinary Identity Application Contract is unchanged. Business applications do not repin merely because Console gains a new operator capability.

## Authority model

Console must never borrow the target Application's `lsa_*` credential.

A privileged Agent governance request uses the existing dual-authority control-plane model:

```text
verified human platform administrator
  -> purpose=platform_admin_actor proof (<= 5 minutes)

LifeSpace Console server
  -> Console-owned lsa_* executor with applications:manage

human actor proof + Console executor
  -> Identity Platform Admin Agent operation
```

Actor `azp` and Console executor Application must match. Identity rechecks the current platform-administrator assignment and executor capability on every request.

## Supported lifecycle

For a target Application, Console may:

- list stable Agent identities bound to that Application;
- create a new `agt_*` and active Application binding;
- rename the Agent identity;
- globally disable or reactivate the Agent identity.

Creation is allowed only for an active trusted-backend Application.

Agent `status` is global identity state. It is not a per-Application toggle. Disabling an Agent therefore affects every Application binding for the same `agt_*`. Console must display this impact explicitly and require confirmation before changing global status.

Application-binding lifecycle remains independent. A revoked binding is historical evidence and is not silently reactivated by the global-status editor.

## Identity is not authority

Creating an Agent identity does **not** grant execution/data authority.

No Agent-governance operation may implicitly create or expand:

- User -> Agent Delegation;
- Space Membership;
- Data Grant;
- Application scope ceiling;
- Application × Model Access;
- Model policy/capability authority.

These are independent current-state authorization inputs and remain owned by their canonical services.

## No Agent execution-token minting in Console

Console Agent configuration deliberately does not expose Agent execution-token issuance.

Agent execution tokens are short-lived runtime artifacts for an already-authorized delegated execution path. They are not platform-configuration credentials and must not be minted from an operator settings screen merely because the operator can manage the stable `agt_*` identity.

## Browser / BFF boundary

The browser receives only sanitized Agent metadata. It never receives:

- Console `lsa_*` executor plaintext;
- platform-admin actor proof;
- target Application credentials;
- Agent execution tokens;
- credential hashes or Authorization headers.

Console mutations are same-origin, JSON-only, purpose-specific requests with explicit intent headers and target confirmations. Global Agent status changes require an additional explicit global-impact confirmation.

## Audit

Identity platform-admin audit distinguishes:

- the human platform-administrator actor;
- the Console executor Application;
- operation (`agent.create` / `agent.update`);
- target Agent;
- bounded non-secret summary metadata;
- request ID and timestamp.

Agent creation audit records that no authority or Delegation was created as a side effect.

## ALOHA M3

ALOHA M3 can use this UI to establish the stable `ALOHA Assistant` Agent identity after its LifeSpace Application, Cloudflare Access Audience and Application Credential are configured. The Agent identity may then be referenced by ALOHA's trusted runtime envelope; actual LifeSpace business authority remains subject to the normal Delegation/Grant/model intersections.
