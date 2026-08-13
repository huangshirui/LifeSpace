# Phase 5 One-shot Migration Agent Instructions

This directory contains only the purpose-built HomeMew -> LifeSpace one-shot migration script and concise execution notes.

## Rules

- Keep the implementation specific to the frozen HomeMew source schema and accepted LifeSpace target. Do not generalize it into a migration framework without a separately approved need.
- Source HomeMew data is read-only. Never write to the source database or snapshot.
- Reject incompatible source schema, unresolved durable references, unexpected target contract state, or missing required objects.
- Sensitive authentication material is re-provisioned separately and is not part of the migration payload.
- Transform durable data directly into the final metadata-driven/typed-storage target; never recreate retired Phase-2 business tables or intermediate JSON persistence.
- Emit one consolidated `migration-report.json` with enough source-to-target mapping, counts, omissions and verification information to diagnose a run.
- Never commit production snapshots or user data.
- Phase-5 rehearsal must reject production targets. Production execution belongs to Phase 7 and requires explicit approval and environment guards.
