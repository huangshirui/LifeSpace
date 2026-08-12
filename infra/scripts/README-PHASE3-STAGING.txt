Phase 3 staging exit entrypoints:
- prepare-phase3-staging-smoke.mjs       (staging-only ephemeral credentials/catalog/Space)
- verify-phase3-staging-db.mjs
- verify-phase3-staging-http.mjs
- verify-phase3-staging-models.mjs
- verify-phase3-staging-creation-draft.mjs
- cleanup-phase3-staging-smoke.mjs       (revokes temporary authority best-effort)

Authoritative closeout sequence: docs/phase3-status.md
Staging-only one-run workflow: .github/workflows/phase3-staging-exit.yml

The workflow masks plaintext smoke credentials, keeps the service PAT lifetime to 15 minutes,
and removes the temporary Application × Model catalog access during cleanup. It never targets
production and does not cut HomeMew traffic/data.

Do not use Phase-2 domain assumptions (Core 0.11.0, schema 9, events:*/tasks:* scopes,
fixed choose-kind or handwritten domain tables) as Phase-3 exit criteria.
