# Identity D1 Migrations

Numbered Identity database migrations will live here once implementation begins.

Identity persistence is separate from Core persistence. Migration history is append-only after deployment; add a new migration rather than rewriting an applied production migration.

0012 adds application-scoped Web mailbox authorization and bounded non-secret operation audit; Identity schema version 12. Deploy before Identity 0.13 consumer rollout.

0013 repairs 0012 forward: pending and verified Access identities share access_principals; independent mailbox grants are removed. User link revisions and operation markers guard both entry points. Schema 13 / Identity 0.14.

0014 moves the global user-owned login mailbox out of Access principal metadata. One normalized email maps to at most one LifeSpace user across all Applications, with a database uniqueness constraint. Migration retains established principals, disables only legacy subject-less placeholders, and records conflicting historical snapshots for explicit reconciliation. New email-derived principals are tagged for targeted revocation; code-linked principal mappings survive mailbox replacement. Schema 14 / Identity 0.15.

0015 adds isolated OAuth Client/Authorization/one-time-code/access+refresh credential state for the Identity OAuth Server. This is not a Core Unified Connection registry. Schema 15, not deployed until a confirmed Identity release.
0016 adds the revisioned Identity-owned OAuth Client Admission Policy (Console-managed CIMD exact metadata URLs and DCR exact callback URLs). It starts disabled with empty lists, records administrator attribution and does not create Client credentials, data Grants, or Consent. Identity schema 16; deploy only through the protected platform Staging migration flow first.
0017 adds open/restricted registration modes for CIMD and DCR plus an independent optional platform callback restriction. Existing Identity policy remains restricted until an administrator changes it; OAuth per-client callback validation and user Consent are unchanged.
0018 safely retires per-method CIMD/DCR allowlists from Console. Any enabled legacy strict-registration method is first disabled rather than automatically widened; administrators re-enable it explicitly. Open methods remain enabled. Existing optional global exact callback restrictions are preserved. The visible policy now consists of two feature switches plus a single Allowed callback URLs list; schema 18.
