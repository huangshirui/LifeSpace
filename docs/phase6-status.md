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
- HomeMew production application registration required for later Phase 7 cutover

## Status

**In progress.** Phase 6 started on 2026-08-14.

Repository implementation is now prepared on PR #25. Production provisioning/deployment evidence has not yet been accepted, so Phase 6 is not complete.

### Implemented production foundation

- explicit production resource manifest at `infra/production/resources.json`;
- idempotent create-if-missing provisioning in `infra/scripts/provision-production.mjs`;
- exact production D1 resolution into the ephemeral CI checkout only;
- conservative production Custom Domain preflight/attachment that refuses to move an existing hostname owned by another Worker;
- production contract/schema expectations derived from current package versions and numbered migrations;
- guarded manual `Deploy production` workflow using the GitHub `production` Environment;
- repository `pnpm check` now validates production infrastructure scripts and frozen production resource/profile invariants before merge;
- one-time first-bring-up ordering of Identity -> Core so the initial Core Service Binding has an existing Identity target;
- long-lived post-Phase-6 deployment ordering of Core -> Identity to preserve verifier/runtime compatibility;
- production runtime secret initialization that creates signing/shared material only when the complete sets are absent, preserves existing complete sets, and refuses partial automatic repair/rotation;
- production HTTP, Cloudflare resource/isolation, D1/Registry/Model Contract and business-empty verification scripts;
- disposable production Model Admin probe that verifies `lsp_pat_*` -> Core introspection and initializes/verifies the pinned active Model Contract, then removes probe authority;
- frozen HomeMew production application ID `homemew-miniprogram` aligned with Core Application × Model Access;
- HomeMew production registration/JWT probe that leaves the application registered but leaves **zero active HomeMew application credentials** after Phase 6.

### Accepted HomeMew production registration behavior

`infra/homemew-integration-profile.json` now freezes:

```text
productionId: homemew-miniprogram
```

Phase 6 registers this application with the accepted HomeMew scope/TTL/trusted-backend policy, verifies the Identity -> JWT -> Core path using disposable authority, and revokes the temporary credential.

The final HomeMew production `lsa_*` credential is deliberately **not** retained or exported during Phase 6. Phase 7 creates a fresh credential and stores it in the HomeMew production secret store as part of the controlled cutover.

## Remaining work

1. Let PR #25 repository CI validate the production implementation and fix any failures.
2. Merge the validated Phase 6 implementation to `main`; GitHub requires a `workflow_dispatch` workflow to exist on the default branch before it can be manually dispatched.
3. Configure/confirm the GitHub `production` Environment inputs required by `infra/production/README.md`, especially the production-only bootstrap secret.
4. From `main`, run `Deploy production` with `phase6_bringup=true`, `provision=true`, `confirmation=DEPLOY_PRODUCTION`.
5. Confirm production D1/R2/Queue/Workers/domains and runtime secrets are created/isolated as expected.
6. Confirm HTTP schema/contracts, JWT signing, opaque service authentication, Registry/Model Contract and HomeMew application registration all pass.
7. Confirm the final Phase 6 database gate reports business state empty and no residual probe authority/active HomeMew credential.
8. Record the GitHub Actions run ID/SHA and resulting evidence here, then mark Phase 6 complete.

## Safety invariants

- No HomeMew production D1 reads/writes are part of Phase 6.
- No HomeMew traffic routing changes are part of Phase 6.
- No staging resource may be rebound or reused by production.
- Provisioning is create-if-missing and does not delete/rename resources.
- Production credentials/secrets never enter repository files or workflow artifacts.
- Production signing/shared secret sets are never automatically rotated merely because a deployment runs.
- Phase 6 verification authority must be disposable and cleaned before the empty-state gate passes.
- The HomeMew production application has no active cutover credential at Phase 6 exit.
- Phase 7 remains the only phase allowed to perform the controlled one-shot HomeMew production migration/cutover.

## Exit gate

Phase 6 is complete when the empty production platform is independently deployed and verified at the accepted contracts, with production Identity/Core D1, R2, Queue, signing/authentication, Model Registry/Contract and HomeMew production application registration ready for Phase 7, while HomeMew production data and traffic remain untouched and no final HomeMew production credential has yet been issued.
