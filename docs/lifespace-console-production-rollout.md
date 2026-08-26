# LifeSpace Console — Production Rollout

Status: **production rollout path implemented; first release pending**

## Purpose

This document defines the production deployment boundary for the LifeSpace platform Console at `https://lifespace.aisr.online`.

The Console is an Experience/Authority control-plane client over LifeSpace Identity/Core. Deploying the Console must not be treated as permission to migrate or redeploy the authoritative platform services or to mutate ordinary Space/business data.

## Production topology

```text
https://lifespace.aisr.online
  -> Cloudflare Access
  -> lifespace-console Worker + React/Vite assets
       -> Identity Service Binding: lifespace-identity
       -> Core Service Binding:     lifespace-core
```

Runtime secrets remain server-only:

```text
IDENTITY_APPLICATION_CREDENTIAL  # Console app lsa_*
CORE_EXECUTOR_BEARER             # dedicated Console lsp_pat_*
```

The production bootstrap secret is provisioning/break-glass authority only. It is available to the controlled GitHub Actions production environment during reconciliation but is never installed in the Console Worker and never enters browser code.

## Canonical deployment workflow

```text
.github/workflows/lifespace-console-production-deploy.yml
```

Permanent use is explicit manual `workflow_dispatch` with the typed confirmation:

```text
DEPLOY_LIFESPACE_CONSOLE_PRODUCTION
```

For the first rollout only, the workflow temporarily also accepts the exact branch:

```text
release/lifespace-console-production-20260826
```

That bootstrap trigger is additionally required to point at exactly the current `main` SHA. It exists only because the current GitHub connector cannot dispatch a workflow directly. It must be removed immediately after the first successful production rollout so the permanent path is manual-only.

## Fail-closed production preflight

Before mutating LifeSpace Console authority or deploying the Worker, the workflow requires:

1. committed repository and Console checks to pass;
2. production Identity and Core to already match the repository's expected schema/contract versions;
3. exactly the production service URLs `https://auth.aisr.online` and `https://core.aisr.online`;
4. a verified Cloudflare Access application protecting `lifespace.aisr.online` and a resolvable Access `aud`;
5. an active LifeSpace platform administrator, either explicitly configured, already assigned, or uniquely resolvable from Identity's existing verified Access-principal mapping during first-rollout break-glass provisioning;
6. the production Console LifeSpace Application to have the approved immutable classification and exact control-plane scope ceiling.

If production Core/Identity are behind, the Console workflow stops. It does **not** silently invoke the full platform production deployment.

If the platform administrator cannot be resolved without ambiguity, the workflow stops. Production first-use Access registration remains disabled.

## First production Access bootstrap

Cloudflare Access is an external security/perimeter adapter, not LifeSpace Identity state. The production Console must never be deployed publicly first and protected later.

The first rollout therefore runs:

```text
infra/scripts/prepare-production-console-access.mjs
```

before any LifeSpace Console Application/executor reconciliation.

Behavior is intentionally narrow and idempotent:

```text
if exactly one production Access app already protects lifespace.aisr.online
  -> verify it is self_hosted
  -> verify its policies remain owner-only
  -> resolve aud
else if no production Access app exists
  -> read exactly one accepted staging Console Access app
  -> clone only its bounded authentication configuration
  -> create a separate production self_hosted Access app atomically with policy
  -> verify created production policy
  -> resolve aud
else
  -> fail closed
```

The staging Access application is used only as a **one-time configuration template**. Production receives a separate Access application, separate audience and independent runtime state. No staging LifeSpace Identity/Core endpoint, credential or data is shared with production.

The bootstrap accepts only the already-proven owner-only policy shape:

- decision must be `allow`;
- every cloned policy must include an explicit individual email rule;
- `everyone`, `any_valid_service_token`, `service_token`, `bypass` and other non-owner broadening paths are rejected;
- application type must be `self_hosted`;
- production hostname is fixed to `lifespace.aisr.online`;
- policy IDs/account IDs are not reused; production policies are newly created from sanitized rule content.

If the Cloudflare API token lacks the Access application/policy write capability, creation fails before LifeSpace authority or Worker deployment. The deployment does not weaken the policy to work around missing Cloudflare permission.

After the first successful production rollout, the production Access application is verified/reused directly; normal Console runtime does not depend on the staging Access application.

## First production platform-administrator bootstrap

Cloudflare Access admission is not platform-admin authority. Identity must still own an explicit `platform_administrators` assignment before Console can mint a human actor proof.

The first rollout runs:

```text
infra/scripts/resolve-production-console-admin.mjs
```

before Console application/executor reconciliation.

Resolution is deliberately fail-closed and follows this order:

```text
if LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID is explicitly configured
  -> validate usr_* syntax and use it
else if exactly one active platform_administrators assignment already exists
  -> reuse it
else if no active assignment exists
  -> read production Identity's already-verified access_principals -> users mapping
  -> require exactly one active usr_* candidate
  -> create the explicit platform_administrators assignment through the canonical bootstrap API
else
  -> fail closed and require explicit operator selection
```

The break-glass resolver does **not** select or merge a user by email, display name, Access subject or application-owned external identity. Its only automatic candidate source is Identity's existing verified `access_principals.user_id` relation, and exactly one candidate is required. The production D1 access is read-only; the assignment itself is created through Identity's canonical bootstrap endpoint.

This automatic resolver is first-rollout/recovery infrastructure only. Normal Console runtime never reads Identity D1 directly and never holds bootstrap authority.

## Console authority reconciliation

The production Console Application is:

```text
app_lifespace_console
```

Approved application scopes:

```text
profile:read
platform:admin
applications:manage
services:manage
identities:read
models:manage
spaces:inspect
audit:read
```

The dedicated Core executor is limited to:

```text
applications:manage
models:manage
spaces:inspect
audit:read
```

The workflow reconciles the Console Application, Access audience and platform-administrator assignment, then performs zero-downtime executor rotation:

```text
verify/bootstrap Cloudflare Access first
-> resolve/assign production platform administrator
-> create new lsa_* + lsp_pat_*
-> verify new Core executor
-> build production Vite/Worker config
-> deploy lifespace-console with new secrets
-> verify lifespace.aisr.online is reachable behind Access
-> revoke superseded Console executor credentials
```

Old credentials are not revoked before the new Worker is deployed and the production hostname has passed its reachability gate.

Credential plaintext is masked and held only in the Actions process environment / an ephemeral `0600` secrets file. The file is removed in an `always()` cleanup step. Plaintext is never committed or written to audit/output summaries.

## Isolation invariants

The Console production workflow must never:

- run a Core or Identity D1 migration;
- deploy the Core Worker;
- deploy the Identity Worker;
- invoke the full platform `production-deploy.yml`;
- perform HomeMew migration/cutover work;
- create ordinary Space records or business-model records;
- enable production first-use Access registration;
- install the bootstrap secret in the Console Worker;
- point production Console bindings at staging services.

The first-release Access bootstrap may read the accepted staging **Cloudflare Access configuration** as a template. This is not permission to query staging LifeSpace services or reuse a staging audience/credential; a new production Access application and audience are created.

The first-release administrator resolver may perform a bounded read-only query against **production Identity D1** to identify unique active `access_principals.user_id` authority evidence. It may not inspect Core/business data, application-owned external identities, email/display-name equality or staging Identity.

`apps/console/scripts/check-production-deploy-isolation.mjs` enforces the repository-visible portion of this boundary as part of normal Console `check`.

## Observability

Each production rollout publishes a GitHub commit status context:

```text
lifespace-console-production/deploy
```

The status transitions from `pending` to `success` or `failure` and links to the exact Actions run. This makes rollout state independently observable even when the deployment was initiated through the temporary first-release branch trigger.

## Post-release verification

The workflow itself proves only non-destructive production readiness:

- exact current Identity/Core compatibility;
- Access application protection and audience registration;
- explicit platform-administrator authority;
- Console executor authentication;
- production Worker/domain deployment;
- old executor revocation after successful cutover.

It deliberately does not repeat the staging disposable write acceptance against production. The A+B+C mutation lifecycle was already transaction-proven and browser-verified in staging. A production operator browser smoke may verify login/read/control visibility without manufacturing disposable platform/business state.

## First-release cleanup

After the first production rollout succeeds:

1. remove the temporary `push` trigger and release-branch-specific logic;
2. keep `workflow_dispatch` + typed production confirmation as the permanent release path;
3. update the production-isolation guard to enforce manual-only production deployment;
4. update this document from first-release pending to production-active evidence;
5. record the deployed main SHA, rollout status evidence and production boundary in the engineering log.
