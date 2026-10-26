# Identity D1 Migrations

Numbered Identity database migrations will live here once implementation begins.

Identity persistence is separate from Core persistence. Migration history is append-only after deployment; add a new migration rather than rewriting an applied production migration.

0012 adds application-scoped Web mailbox authorization and bounded non-secret operation audit; Identity schema version 12. Deploy before Identity 0.13 consumer rollout.

0013 repairs 0012 forward: pending and verified Access identities share access_principals; independent mailbox grants are removed. User link revisions and operation markers guard both entry points. Schema 13 / Identity 0.14.
