# LifeSpace Console — Production Rollout

Status: **production active; permanent deployment path is manual-only**

## Production evidence

The first isolated LifeSpace Console production rollout completed successfully on 2026-08-26.

```text
Source SHA:       977e44568f7637f237d763f86be116f4cb460bd5
Actions run:      32946437701
Worker:           lifespace-console
Worker version:   1af8266b-4c98-4c73-942d-6219432fa025
Hostname:         https://lifespace.aisr.online
```

The rollout verified `lifespace.aisr.online` as reachable with HTTP `302`, which is the expected unauthenticated Cloudflare Access redirect.

Authoritative platform dependencies were verified, not redeployed:

```text
Identity: schema 7 / contract 0.5.0
Core:     schema 28 / Kernel 0.15.0
```

The successful rollout did **not** run Core/Identity migrations, did **not** deploy Core/Identity, did **not** mutate ordinary Space/business records, and did **not** perform HomeMew production migration/cutover.

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

The production bootstrap secret is provisioning/break-glass authority only. It is available to the controlled GitHub Actions `production` environment during reconciliation, but it is never installed in the Console Worker and never enters browser code.

## Permanent deployment workflow

Canonical workflow:

```text
.github/workflows/lifespace-console-production-deploy.yml
```

Production deployment is **manual-only** through `workflow_dispatch` and requires the typed confirmation:

```text
DEPLOY_LIFESPACE_CONSOLE_PRODUCTION
```

The temporary first-release push trigger used on 2026-08-26 has been removed from the permanent workflow. Repository guard `apps/console/scripts/check-production-deploy-isolation.mjs` rejects any future push, pull-request, scheduled or `workflow_call` trigger for this production workflow.

Every rollout publishes the commit status context:

```text
lifespace-console-production/deploy
```

## Fail-closed production preflight

Before Console authority is changed or the Worker is deployed, the workflow requires:

1. the committed repository and Console checks to pass;
2. production Identity and Core to match repository-expected schema/contract versions;
3. exact production service URLs `https://auth.aisr.online` and `https://core.aisr.online`;
4. a verified Cloudflare Access application protecting `lifespace.aisr.online` with a resolvable audience;
5. an active LifeSpace platform administrator that is explicit, already assigned, or uniquely resolvable from Identity's existing verified Access-principal mapping;
6. the production Console LifeSpace Application to retain the approved classification and control-plane scope ceiling.

If any condition is ambiguous or incompatible, deployment stops. The Console workflow never repairs that condition by silently invoking a full platform production deploy.

## Cloudflare Access boundary

Cloudflare Access is an external perimeter adapter, not LifeSpace Identity authority.

`infra/scripts/prepare-production-console-access.mjs` is idempotent. It verifies the existing production Access application. During the first rollout only, when no production application existed, it was allowed to clone the already-proven staging Access authentication policy into a **separate** production self-hosted application.

Accepted policy shape is intentionally narrow:

- decision must be `allow`;
- policy must include an explicit individual email rule at the Cloudflare perimeter;
- `everyone`, `any_valid_service_token`, `service_token`, `bypass` and other broadening paths are rejected;
- production hostname is fixed to `lifespace.aisr.online`;
- production owns a separate Access application and audience.

The perimeter email rule controls Cloudflare admission only. It is **not** LifeSpace user-identity or platform-admin authority.

## Platform-administrator authority

Identity owns explicit `platform_administrators` assignments. A Cloudflare Access session by itself is not platform-admin authority.

`infra/scripts/resolve-production-console-admin.mjs` resolves authority in this order:

```text
explicit LIFESPACE_PRODUCTION_PLATFORM_ADMIN_USER_ID
-> otherwise exactly one existing active platform administrator
-> otherwise exactly one active usr_* already referenced by an active,
   Identity-verified access_principals row
-> otherwise fail closed
```

For first-rollout recovery, the resolver obtains the **real** production Identity D1 UUID by exact Cloudflare database name `lifespace-identity`, then performs only the bounded read-only Access-principal→user query. It never trusts the placeholder D1 ID committed in Wrangler configuration.

The resolver does not select or merge users by email, display name, Access subject, Space membership or application-owned external identity. The successful production rollout reported:

```text
source: unique-verified-access-principal
assignmentCreated: true
databaseResolvedByName: true
emailUsedAsAuthority: false
accessSubjectUsedAsAuthority: false
candidateCount: 1
```

The explicit assignment itself is created through Identity's canonical bootstrap API. Normal Console runtime never reads D1 directly and never holds bootstrap authority.

## Console authority reconciliation

Production Console Application:

```text
app_lifespace_console
```

Application scope ceiling:

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

Dedicated Core executor scope ceiling:

```text
applications:manage
models:manage
spaces:inspect
audit:read
```

Reconciliation order:

```text
verify Cloudflare Access
-> resolve explicit platform administrator
-> create/rotate Console lsa_* and lsp_pat_* executors
-> verify the Core executor
-> build and deploy lifespace-console
-> verify production hostname behind Access
-> revoke superseded executor credentials
-> delete ephemeral local secrets file
```

Credential plaintext is masked and exists only in the Actions process environment and an ephemeral `0600` secrets file. Plaintext is not committed, logged or written into audit/summary output.

The first successful rollout created the initial executor set, so there were no superseded production credentials to revoke. The finalizer nevertheless completed successfully and the ephemeral secrets file was removed.

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
- point production Console bindings at staging services;
- use automatic push/PR/schedule/workflow-call production triggers.

`apps/console/scripts/check-production-deploy-isolation.mjs` enforces the repository-visible portion of these invariants as part of normal Console `check`.

## First-rollout lessons

The first production rollout intentionally failed closed several times before the successful deployment. These failures are retained as engineering evidence rather than hidden:

1. release-intent shell logic used a fragile heredoc/command-substitution form; it was replaced with a simpler validated path;
2. no production Cloudflare Access application existed, so the bounded Access bootstrap was added;
3. no explicit production platform administrator existed, so the unique verified Access-principal resolver was added instead of matching by email;
4. one Core performance-budget test exceeded its 5-second CI timeout once and passed on an unchanged rerun, demonstrating runner variability rather than a production defect;
5. the first admin resolver tried to use the intentional placeholder production D1 UUID from Wrangler; it was changed to resolve the real D1 by exact Cloudflare database name.

The resulting production preflight now checks these first-release assumptions before Worker deployment and remains fail-closed.

## Post-release verification boundary

The production workflow proves non-destructive release readiness and reachability. It deliberately does not repeat the disposable mutation lifecycle against production.

A+B+C mutation behavior was already transaction-proven and authenticated-browser-verified in staging before production promotion. Production verification therefore focuses on Access protection, authority reconciliation, executor authentication, Worker/domain deployment and secret cleanup without manufacturing disposable production business state.
