# Phase 6 — LifeSpace Production Platform Bring-up

Updated: 2026-08-14

## Goal

Bring up an empty, isolated LifeSpace production platform before any HomeMew production migration or traffic cutover.

Phase 6 must not migrate HomeMew durable production data and must not route HomeMew production traffic to LifeSpace.

## Target production resources

- Identity Worker: `lifespace-identity` -> `auth.aisr.online`
- Core Worker: `lifespace-core` -> `core.aisr.online`
- Identity D1: `lifespace-identity`
- Core D1: `lifespace-core`
- R2: `lifespace-assets`
- Queue: `lifespace-creation-drafts`
- production-only runtime/signing/shared secrets
- production application/service registrations required for later Phase 7 cutover

## Status

**In progress.** Phase 6 started on 2026-08-14.

Completed in the initial slice:

- added an explicit production resource manifest under `infra/production/resources.json`;
- added idempotent, create-if-missing production provisioning logic in `infra/scripts/provision-production.mjs`;
- bound `auth.aisr.online` and `core.aisr.online` as production Worker Custom Domains in Wrangler configuration;
- kept all production names separate from staging names.

## Remaining work

1. Add production D1 ID resolution that only resolves exact production database names into the ephemeral deployment checkout.
2. Add conservative production custom-domain verification/attachment; fail if a hostname belongs to another Worker.
3. Add production version/schema expectations and empty-platform verification.
4. Add a manually triggered GitHub Actions production environment workflow with production-only credentials/secrets.
5. Provision D1/R2/Queue resources.
6. Apply Core migrations and deploy Core first.
7. Apply Identity migrations and deploy Identity after the compatible Core verifier is live.
8. Generate/activate production signing and Core/Identity shared authentication secrets using production-only lifecycle procedures.
9. Verify `core.aisr.online` and `auth.aisr.online` health/status/schema/contracts.
10. Verify Registry/Model Contract, D1/R2/Queue bindings and representative empty-platform operations.
11. Register only the production applications/services required for later cutover; do not import HomeMew user/business data.
12. Record evidence and mark Phase 6 complete only after the production verification gate passes.

## Safety invariants

- No HomeMew production D1 reads/writes are part of Phase 6.
- No HomeMew traffic routing changes are part of Phase 6.
- No staging resource may be rebound or reused by production.
- Provisioning is create-if-missing and does not delete/rename resources.
- Production credentials/secrets never enter repository files.
- Phase 7 remains the only phase allowed to perform the controlled one-shot HomeMew production migration/cutover.

## Exit gate

Phase 6 is complete when the empty production platform is independently deployed and verified at the accepted contracts, with production Identity/Core D1, R2, Queue, signing/authentication, Model Registry/Contract and required application/service registrations ready for Phase 7, while HomeMew production data and traffic remain untouched.
