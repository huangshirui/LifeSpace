# Phase 5 Migration Tooling Agent Instructions

This directory contains operational one-shot HomeMew -> LifeSpace migration planning, import and verification tooling.

## Rules

- Source HomeMew data is read-only. Never write to the source database or snapshot.
- Identical source data + migration namespace + accepted target contract tuple must produce identical mappings and report checksums.
- Fail closed on unknown source schema, unresolved references, duplicate source identifiers, target contract mismatch, semantic mismatch, or missing required objects.
- Never copy or emit source credential plaintext/hashes, signing keys, provider secrets, Cloudflare secrets, or WeChat `openid` mappings.
- Transform durable data directly into the final metadata-driven/typed-storage target; never recreate retired Phase-2 business tables or intermediate JSON persistence.
- Planning and mutation are separate operations. A plan must be inspectable before target mutation.
- Tests and fixtures must be synthetic; never commit production snapshots or user data.
- Production execution is out of scope until Phase 7 and requires explicit approval plus environment guards.
