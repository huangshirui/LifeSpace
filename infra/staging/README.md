# LifeSpace staging provisioning

## Verified status

Phase 1 staging deployment and the Identity -> token -> Core -> Space smoke test passed on 2026-08-10. Later platform slices continue to use the same isolated staging foundation.

`aisr.online` Bot Fight Mode was disabled because the generic Bot Fight Mode issues browser challenges to legitimate API/CI machine traffic and cannot be selectively skipped by hostname on the current plan. Keep API protection at the application/WAF/rate-limit layers; if a future bot product supports selective hostname bypass, re-evaluate this zone-level setting.

## Purpose

Maintain isolated Cloudflare staging resources for LifeSpace. Production resources must never be reused.

Long-lived staging operations are deliberately split:

- **Provision staging resources**: low-frequency create-if-missing reconciliation of declared D1/R2/Queue resources.
- **Deploy staging**: migrations, Core/Identity deployment and full authenticated acceptance against already-declared infrastructure.

Routine deployment does not provision shared infrastructure.

## Resources

- Identity D1: `lifespace-identity-staging`
- Core D1: `lifespace-core-staging`
- R2: `lifespace-staging-assets`
- Event delivery Queue: `lifespace-staging-event-deliveries`
- Event delivery DLQ: `lifespace-staging-event-deliveries-dlq`
- Identity Worker custom domain: `auth-staging.aisr.online`
- Core Worker custom domain: `core-staging.aisr.online`

The desired shared resource names live in `resources.json`. The Cloudflare account is supplied by GitHub Actions through `CLOUDFLARE_ACCOUNT_ID`; account-specific IDs are not part of the resource manifest. Eventing smoke receivers are ephemeral verification resources and are therefore not shared manifest resources.

## GitHub configuration

Repository/`staging` Environment Actions must provide:

- Secret: `CLOUDFLARE_API_TOKEN`
- Variable or secret: `CLOUDFLARE_ACCOUNT_ID`
- Staging Environment secret: `LIFESPACE_STAGING_BOOTSTRAP_SECRET` (at least 32 characters) for deployment/runtime verification.

The Cloudflare API token must have the account permissions required to manage Workers, Worker Custom Domains, D1, R2 and Queues used by staging. The staging Eventing verifier creates and removes one ephemeral Worker plus an ephemeral staging-only Custom Domain; it does not require a permanent receiver or third-party Webhook collector.

`LIFESPACE_STAGING_BOOTSTRAP_SECRET` is the persistent platform-administration credential used by deployment CI to register trusted staging applications through Identity. It must not be committed to the repository. The deploy workflow synchronizes it into the Identity Worker as `BOOTSTRAP_SECRET`.

The resource-provisioning workflow deliberately does not need that bootstrap secret because it only reconciles Cloudflare infrastructure declared in the manifest.

## Provision staging resources

The historical Phase 1 one-time provisioning workflow was removed after initial establishment. The long-term need to add/reconstruct declared resources is now represented by the separate **Provision staging resources** workflow rather than by a checkbox inside deployment.

Input:

```text
confirmation: PROVISION_STAGING
```

It calls `infra/scripts/provision-staging.mjs`, which:

1. lists each required staging resource;
2. creates it only when the exact resource name is missing;
3. never deletes, renames, replaces or reuses a production resource;
4. reports the resolved resource identifiers.

It does not run database migrations or deploy Workers. Provisioning and deployment share the same staging concurrency lock, so infrastructure reconciliation cannot overlap a staging deployment.

Use it only when `infra/staging/resources.json` adds a resource or when an explicitly reviewed recovery needs to reconstruct a missing declared resource.

## D1 IDs

The checked-in Wrangler files intentionally keep non-production placeholder UUIDs for resources that do not exist in a fresh checkout.

Before migration/deployment, `infra/scripts/resolve-staging-d1.mjs` looks up the real staging D1 UUIDs by exact database name and replaces the placeholder values only in the ephemeral CI checkout. No human needs to copy D1 UUIDs into GitHub, and CI does not commit account-specific UUID changes back to `main`.

## Runtime secrets

The staging deploy initializes and validates runtime secrets automatically.

- `BOOTSTRAP_SECRET` is synchronized with `wrangler secret bulk` for Identity.
- The smoke test validates the active Identity/Core RS256 signing relationship. If the signing key pair is missing or inconsistent, staging generates a new RSA key pair and activates `TOKEN_PRIVATE_KEY` on Identity and `IDENTITY_PUBLIC_KEY` on Core. If the active pair works, it is preserved.
- Service authentication also uses a staging-only random `CORE_IDENTITY_SHARED_SECRET`, synchronized to both Core and Identity for internal opaque-token introspection. It is never exposed to service clients and is not committed.
- The Eventing smoke receiver gets only the current subscription's one-time signing secret as an ephemeral Worker `secret_text` binding in the same upload that creates the receiver Worker.
- Secret values are never printed or stored in repository files.

## Custom domains

The Wrangler staging configs declare the long-lived Identity/Core Worker Custom Domains. After deploying those Workers, `infra/scripts/ensure-staging-domains.mjs` verifies the account-level Custom Domain state through the Cloudflare Workers Domains API and attaches a missing domain explicitly.

The script is conservative: if a target hostname is already attached to a different Worker, deployment fails instead of silently moving that hostname. It never creates a manual A/CNAME record; Cloudflare Custom Domains create the DNS record and certificate on behalf of the Worker.

The Eventing staging verifier independently creates a run-scoped hostname such as `eventing-smoke-staging-<run>.aisr.online`, attaches it to the temporary receiver Worker, waits until it is reachable, and removes the Custom Domain before deleting the Worker. The hostname is never a stable application endpoint.

The Custom Domain is intentional rather than cosmetic. Cloudflare Worker-to-Worker `fetch()` has routing restrictions when another Worker is reached through workers.dev or a Route in the same zone. A Custom Domain is callable from another Worker and also represents the public HTTPS Webhook topology that Eventing is meant to support. Therefore canonical Eventing acceptance must not use a temporary workers.dev hostname as its asynchronous Webhook target.

## Deploy staging

Run **Deploy LifeSpace platform staging** manually from `main` for the exact candidate to be verified.

The workflow has read-only repository permissions and never commits generated changes back to the branch. Source generation/bindings must already be reproducible and committed before deployment.

Current flow:

1. Report the selected ref/SHA and install dependencies.
2. Run full repository validation (`pnpm check`).
3. Resolve real staging D1 IDs in the CI checkout.
4. Apply Core migrations and deploy Core first.
5. Wait until `core-staging.aisr.online` serves the expected schema/contract version.
6. Apply Identity migrations and deploy Identity after the compatible Core verifier/runtime is live.
7. Explicitly verify/attach both long-lived staging Worker Custom Domains.
8. Wait until `auth-staging.aisr.online` serves the expected Identity schema/contract version.
9. Synchronize/validate staging runtime secrets and prepare bounded ephemeral smoke authority.
10. Run the native staging end-to-end smoke suite, including a real Eventing mutation/outbox/Queue/HMAC-signed Webhook delivery through an ephemeral staging Custom Domain.
11. Clean up all ephemeral smoke authority/receiver resources.

The Core-first ordering is intentional for changes where Identity may begin issuing credentials/tokens that require a newer Core verifier. A future change may alter deployment ordering only when its compatibility reasoning is explicit.

The staging workflow proves LifeSpace's own deployed contract/schema/model/runtime behavior. Consumer applications perform their own compatibility acceptance against the published LifeSpace contracts and do not gate LifeSpace staging or production.

Eventing verification goes beyond the direct subscription test endpoint. `infra/scripts/verify-staging-eventing.mjs` creates an ephemeral staging-only Worker and Custom Domain, verifies the HMAC signature and exact reference-only payload shape, creates a real `event` record, waits for the scheduled outbox dispatcher and Cloudflare Queue consumer to produce a successful Webhook delivery, then proves subscriber Grant revocation is enforced. The subscription, test record, temporary authorization, subscriber state, Custom Domain and receiver Worker are cleaned up after the check. No workers.dev target and no webhook.site/httpbin-style third-party collector is part of canonical staging acceptance.

Smoke data is staging-only and is identified by the GitHub Actions run ID/attempt. Production resources and external application traffic/data are not modified by the staging workflow.

Recurrence enrollment/completion now has automatic live acceptance after both services converge. External Provider deployment is an explicit environment opt-in: its pinned private Worker, matching secrets, Core Binding and real synthetic Notion/relations/batch/Scheduled-refresh acceptance run in the same workflow. Complete [External Provider rollout](../external-provider-rollout.md) prerequisites before enabling it. A green Native-only release does not claim External acceptance. Console has a separate staging release and browser gate.


## File upload signing and staging acceptance

The Core `ASSETS` Worker R2 binding verifies/copies/deletes objects. Browser/n8n direct upload uses S3 presigned URLs; the public client never receives a long-lived API credential.

**Before starting the owner's manual staging deployment**, configure these secrets in the LifeSpace repository's **staging GitHub Environment**:

- `R2_S3_ACCESS_KEY_ID`: R2 token Access Key ID, scoped to the **staging assets bucket** `lifespace-staging-assets` with object read/write permission.
- `R2_S3_SECRET_ACCESS_KEY`: its matching R2 Secret Access Key; not a Cloudflare account API token.
- `CLOUDFLARE_ACCOUNT_ID`: existing staging account variable/secret; the release sends this value to the Core Worker as `R2_S3_ACCOUNT_ID`.

The manual `staging-deploy.yml` validates these inputs **before migration or Worker mutation**, and then synchronizes all three values as Core Worker runtime Secrets after deployment. They are never written into source, logs or the public API. Production must use an independent production-scoped token and its separately approved manual deployment; do not reuse staging R2 credentials.

**R2 bucket CORS is a shared resource policy**. Before browser acceptance, inspect its existing rules; **append a narrow `PUT` + `Content-Type` rule for each intended staging Web/PWA origin**, retaining unrelated pre-existing rules. Optionally allow `GET` when clients fetch a presigned download URL directly. Do not blindly overwrite the entire bucket CORS document, add `*` origin, or treat CORS as API authorization. n8n/Node signed R2 upload doesn't require browser CORS.

The canonical staging workflow automatically exercises **a real synthetic Native File**:
create an ephemeral published File-capable model; obtain `upl_*` + presigned PUT; upload bytes into `uploads/native/`; complete to a new permanent `fil_*`; attach/download through the Record with the current Authority; reject deletion while referenced; soft-delete the Record and delete the detached File. It retires the synthetic model and removes temporary model access. An R2 smoke failure fails the workflow.

When `LIFESPACE_EXTERNAL_PROVIDER_ACTIVE=1`, the existing real Notion self-service smoke additionally uploads a synthetic file through `file_ref_list.upload` using the same session transport, then proves the original Notion External file reference survives and the new Provider-owned URL is returned. If External Provider is disabled, **Notion upload is not accepted**, even when the Native smoke is green. Production remains manual and is not inferred from staging success.
