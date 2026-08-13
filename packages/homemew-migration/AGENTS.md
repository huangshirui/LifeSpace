# HomeMew Migration Tooling Agent Instructions

This package contains the version-controlled one-shot HomeMew -> LifeSpace migration planner, importer and verifier used by Phase 5 rehearsal and the later controlled production cutover.

## Rules

- Source HomeMew data is read-only. Never write to a source snapshot/database.
- Planning must be deterministic: identical source data + migration namespace + accepted contract tuple must produce identical IDs, mappings and report checksums.
- Fail closed on unknown source schema, unresolved references, duplicate source identifiers, target contract mismatch, semantic mismatch or missing required objects.
- Never copy or emit source credential plaintext, credential hashes, signing keys, provider secrets, Cloudflare secrets or user-provider identity mappings that belong in the HomeMew application boundary.
- Transform durable business data directly to the final metadata-driven/typed-storage target. Do not recreate retired Phase-2 handwritten business tables or the intermediate JSON physical store.
- Keep planning and mutation separate. A plan must be inspectable and verifiable before any target mutation.
- Test all mapping and transform rules with synthetic fixtures. Never commit production snapshots or user data.
- Machine-readable reports are part of the migration contract; changes to their semantics require tests and documentation updates.
- Production execution is out of scope until Phase 7 and requires separate explicit approval and environment guards.
