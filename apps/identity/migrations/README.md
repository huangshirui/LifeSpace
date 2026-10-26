# Identity D1 Migrations

Numbered Identity database migrations will live here once implementation begins.

Identity persistence is separate from Core persistence. Migration history is append-only after deployment; add a new migration rather than rewriting an applied production migration.

0012 adds application-scoped Web mailbox authorization and bounded non-secret operation audit; Identity schema version 12. Deploy before Identity 0.13 consumer rollout.

0013 repairs 0012 forward: pending and verified Access identities share access_principals; independent mailbox grants are removed. User link revisions and operation markers guard both entry points. Schema 13 / Identity 0.14.

0014 moves the global user-owned login mailbox out of Access principal metadata. One normalized email maps to at most one LifeSpace user across all Applications, with a database uniqueness constraint. Migration retains established principals, disables only legacy subject-less placeholders, and records conflicting historical snapshots for explicit reconciliation. New email-derived principals are tagged for targeted revocation; code-linked principal mappings survive mailbox replacement. Schema 14 / Identity 0.15.
