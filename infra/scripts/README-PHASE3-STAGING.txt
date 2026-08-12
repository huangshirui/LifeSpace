Phase 3 staging exit entrypoints:
- verify-phase3-staging-db.mjs
- verify-phase3-staging-http.mjs
- verify-phase3-staging-models.mjs
- verify-phase3-staging-creation-draft.mjs

Authoritative closeout sequence: docs/phase3-status.md
Staging-only workflow: .github/workflows/phase3-staging-exit.yml

Do not use Phase-2 domain assumptions (Core 0.11.0, schema 9, events:*/tasks:* scopes, fixed choose-kind) as Phase-3 exit criteria.
