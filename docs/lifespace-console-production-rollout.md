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

Before mutating Console authority or deploying the Worker, the workflow requires:

1. committed repository and Console checks to pass;
2. production Identity and Core to already match the repository's expected schema/contract versions;
3. exactly the production service URLs `https://auth.aisr.online` and `https://core.aisr.online`;
4. a Cloudflare Access application protecting `lifespace.aisr.online` and a resolvable Access `aud`;
5. an existing active LifeSpace platform administrator, either explicitly configured or uniquely resolvable from production Identity;
6. the production Console LifeSpace Application to have the approved immutable classification and exact control-plane scope ceiling.

If production Core/Identity are behind, the Console workflow stops. It does **not** silently invoke the full platform production deployment.

If the Access application is absent/ambiguous, the workflow stops before exposing the Console.

If an existing production platform administrator cannot be resolved, the workflow stops. Production first-use Access registration remains disabled.

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
create new lsa_* + lsp_pat_*
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
- Access application presence and audience registration;
- Console executor authentication;
- production Worker/domain deployment;
- old executor revocation after successful cutover.

It deliberately does not repeat the staging disposable write acceptance against production. The A+B+C mutation lifecycle was already transaction-proven and browser-verified in staging. A production operator browser smoke may verify login/read/control visibility without manufacturing disposable platform/business state.

## First-release cleanup

After the first production rollout succeeds:

1. remove the temporary `push` trigger and release-branch-specific logic;
2. keep `workflow_dispatch` + typed production confirmation as the permanent release path;
3. update the production-isolation guard to enforce manual-only production deployment;
4. record the deployed main SHA, rollout status evidence and production boundary in the engineering log.
