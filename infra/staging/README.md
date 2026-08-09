# LifeSpace staging provisioning

## Verified status

Phase 1 staging deployment and the Identity -> token -> Core -> Space smoke test passed on 2026-08-10. The staging foundation is accepted as the baseline for Phase 2 migration work.

`aisr.online` Bot Fight Mode was disabled because the generic Bot Fight Mode issues browser challenges to legitimate API/CI machine traffic and cannot be selectively skipped by hostname on the current plan. Keep API protection at the application/WAF/rate-limit layers; if a future bot product supports selective hostname bypass, re-evaluate this zone-level setting.

## Purpose

Create isolated Cloudflare staging resources for LifeSpace. Production resources must never be reused.

## Resources

- Identity D1: `lifespace-identity-staging`
- Core D1: `lifespace-core-staging`
- R2: `lifespace-staging-assets`
- Queue: `lifespace-staging-creation-drafts`
- Identity Worker custom domain: `auth-staging.aisr.online`
- Core Worker custom domain: `core-staging.aisr.online`

The desired resource names live in `resources.json`. The Cloudflare account is supplied by GitHub Actions through `CLOUDFLARE_ACCOUNT_ID`; account-specific IDs are not part of the resource manifest.

## GitHub configuration

Repository/`staging` Environment Actions must provide:

- Secret: `CLOUDFLARE_API_TOKEN`
- Variable or secret: `CLOUDFLARE_ACCOUNT_ID`
- Staging Environment secret: `LIFESPACE_STAGING_BOOTSTRAP_SECRET` (at least 32 characters)

The Cloudflare API token must have the account permissions required to create/manage Workers, D1, R2 and Queues used by staging.

`LIFESPACE_STAGING_BOOTSTRAP_SECRET` is the persistent platform-administration credential used by CI to register trusted staging applications through Identity. It must not be committed to the repository. The deploy workflow synchronizes it into the Identity Worker as `BOOTSTRAP_SECRET`.

## Provisioning flow

Run the **Provision staging infrastructure** workflow manually.

`infra/scripts/provision-staging.mjs` is idempotent:

1. List each required staging resource.
2. Create it only when the exact resource name is missing.
3. Never delete, rename, replace or reuse a production resource.
4. Report the resolved D1 and Queue IDs in the Actions job summary.

## D1 IDs

The checked-in Wrangler files intentionally keep non-production placeholder UUIDs for resources that do not exist in a fresh checkout.

Before migration/deployment, `infra/scripts/resolve-staging-d1.mjs` looks up the real staging D1 UUIDs by exact database name and replaces the placeholder values only in the ephemeral CI checkout. No human needs to copy D1 UUIDs into GitHub, and CI does not commit account-specific UUID changes back to `main`.

## Runtime secrets

The staging deploy initializes and validates the RS256 signing relationship automatically.

- `BOOTSTRAP_SECRET` is synchronized on every deploy with `wrangler secret bulk`, which activates the resulting Worker version immediately.
- The smoke test then asks Identity to issue a token and asks Core to verify it.
- If Identity reports that its signing key is missing, or Core rejects an otherwise valid Identity token because its verification key is missing/mismatched, staging automatically generates a new RSA key pair and activates `TOKEN_PRIVATE_KEY` on Identity and `IDENTITY_PUBLIC_KEY` on Core using Wrangler.
- If the existing active signing pair works, it is preserved and is not rotated.

This intentionally avoids relying on the raw Workers `secrets-bulk` API alone for runtime activation. Secret values are never committed or printed.

## Custom domains

The Wrangler staging configs declare both Worker Custom Domains. After deploying the Workers, `infra/scripts/ensure-staging-domains.mjs` also verifies the account-level Custom Domain state through the Cloudflare Workers Domains API and attaches a missing domain explicitly.

The script is conservative: if a target hostname is already attached to a different Worker, deployment fails instead of silently moving that hostname. It never creates a manual A/CNAME record; Cloudflare Custom Domains create the DNS record and certificate on behalf of the Worker.

Health checks allow extra time for DNS and certificate propagation after a first attachment.

## Deployment flow

Run the **Deploy staging** workflow manually after provisioning succeeds and the staging bootstrap secret is configured.

1. Resolve real staging D1 IDs in the CI checkout.
2. Run contract/tests/typecheck/build.
3. Apply Identity and Core D1 migrations.
4. Deploy Identity and Core Workers with `--env staging`.
5. Explicitly verify/attach both staging Worker Custom Domains.
6. Verify `/health` and `/api/v1/status` on both custom domains.
7. Synchronize and activate the bootstrap secret.
8. Validate the active Identity/Core signing relationship, repairing the staging RSA pair only when required.
9. Run the Phase 1 Identity -> token -> Core -> Space end-to-end smoke test, including an unauthenticated deny check.

The smoke test intentionally creates staging-only application/user/Space records identified by the GitHub Actions run ID and attempt. Credentials and runtime secret values are never printed or committed.
