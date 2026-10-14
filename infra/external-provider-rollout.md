# External Provider deployment and staging acceptance

This development runbook covers External/Federated Truth, Semantic Relations, Recurrence and the Space-scoped External Connection product flow. Committed deployment support is not production availability evidence. The owner starts **Deploy LifeSpace platform staging** manually from `main`; no additional Adapter workflow needs to be started.

## One-time staging preparation

Keep two dedicated synthetic Notion data sources:

1. **automatic platform smoke source** — reserved for the canonical platform workflow;
2. **browser/app acceptance source** — used to prove the real self-service Connection → Resource Discovery → External Model binding journey.

Both sources must contain synthetic data only and must be accessible to the staging Notion integration. The automatic smoke source must have `Name` as the title property and `Amount` as a number property; acceptance creates, updates and trashes its own pages. Under Notion API `2025-09-03`, use the concrete Data Source identity rather than assuming a multi-source database is itself a data source.

Configure the LifeSpace repository's **staging GitHub Environment** for the automatic platform smoke:

| Kind | Name | Value / purpose |
| --- | --- | --- |
| Variable | `LIFESPACE_EXTERNAL_PROVIDER_ENABLED` | `1`; unset/`0` keeps optional Native-only deployment and does **not** accept External |
| Variable | `LIFESPACE_EXTERNAL_ADAPTER_WORKER` | Dedicated Worker name ending in `-staging`, separate from Core/Identity/Console |
| Secret | `EXTERNAL_ADAPTER_SHARED_SECRET` | Independent random value of 32–512 printable ASCII characters without whitespace; never bootstrap or production secret |
| Secret | `CONNECTION_VAULT_MASTER_KEY` | Independent 32 random bytes encoded as exactly 64 hexadecimal characters; encrypts dynamic `cnx_*` Durable Object credential state with AES-256-GCM. Generate independently (for example `openssl rand -hex 32`); never reuse the Adapter shared secret, bootstrap secret or Provider token |
| Secret | `NOTION_CONNECTIONS` | **Staging smoke only**: JSON map containing the synthetic automatic-smoke connection. Normal product Connections do not use this map |
| Variable | `LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF` | Reference of the active read/write automatic-smoke connection in that map |
| Secret | `LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID` | Concrete automatic-smoke Notion Data Source UUID |
| Variable | `LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED` | `1`, confirming the source is synthetic-only |

`NOTION_CONNECTIONS` is retained for deterministic staging/bootstrap acceptance. It is **not** the normal product configuration mechanism. Normal Console/application users create Space-scoped dynamic Connections through the public External Connection API; the private Adapter maps each Core-generated `cnx_*` reference to one Durable Object. Provider credential plaintext exists only transiently in that Connection DO execution memory. Before DO persistence, the credential projection is encrypted with AES-256-GCM under `CONNECTION_VAULT_MASTER_KEY`; storage contains only a versioned `{version,algorithm,iv,ciphertext}` envelope.

The first encrypted-vault release supports a one-way lazy migration from the previous plaintext DO projection. If a dynamic Connection DO still contains valid legacy `{token,read,write}` state, its first successful read encrypts and replaces that state before execution continues. Missing, malformed or mismatched vault keys fail closed. This migration does not require users to reconnect Notion.

Existing Cloudflare credentials/account and staging bootstrap settings remain required. The deploy token must manage/read Worker settings and secrets and read workers.dev/preview exposure, alongside existing platform permissions. Invalid prerequisites fail before deployment mutation, without printing tokens, vault keys or provider payloads. Core receives the independent Adapter shared secret but never receives the vault master key and never persists provider credential plaintext.

`infra/external-provider.json` pins the reviewed Adapter to a full immutable SHA. Updating it requires a reviewed code change and both environment packaging checks. Live identifiers stay out of the public Adapter repository. The canonical deployment must verify that the Adapter is private, that the `CONNECTIONS` Durable Object binding exists and that `CONNECTION_VAULT_MASTER_KEY` is present as a Worker Secret; otherwise dynamic Connection capability is not accepted.

## Single manual staging release

The workflow validates the repository/configuration, resolves staging D1, deploys the private pinned Adapter and its required bindings/secrets, migrates/deploys Core with `EXTERNAL_ADAPTER`, synchronizes the matching Core shared secret, verifies live private wiring plus the encrypted per-connection vault binding, then migrates/deploys compatible Identity. The existing Core-first → Identity order is preserved. Enabled releases regenerate the Binding and synchronize the required Adapter secrets every time; dashboard-only configuration cannot silently disappear on a later canonical release.

Remote Core profiles explicitly configure schema refresh every 300 seconds. This is a scheduling setting, not a measured freshness/latency SLO. The existing one-minute Scheduled trigger drains bounded indexed work.

After preparing bounded smoke authority, the workflow checks:

- Recurrence semantic discovery, real enrollment/current Identity root checks, first Task, completion successor and pause. Removing the rule precedes Task/Plan cleanup.
- Real bootstrap Notion connection, business-definition publication, Space binding and dynamic schema discovery.
- Provider create/get/query/update/delete with no fabricated Native version. Only bounded read/query convergence may retry.
- Native→External relation creation/hydration, atomic rejection, and a non-atomic batch where an invalid External item fails while an independent Native create and relation succeed.
- Manual refresh and a **real Scheduled refresh**: only this run's binding is made due; its observed timestamp must advance within the smoke window.
- Connection disable/reactivation and confirmed Provider deletion cleaning local edges.
- Run-scoped cleanup: trash confirmed returned page IDs, retire temporary definitions, retain Registry/audit history, and remove only this run's new binding/source/identity metadata.

Unknown Provider writes are never retried. If a create has no confirmed returned ID, inspect the dedicated source for that run's synthetic marker before rerunning; the script cannot safely guess an ID. Cleanup failure fails acceptance too. Already applied additive migrations/deployments are retained; fix the indicated failure and rerun the canonical entry point. Do not remove migrations or bypass a failing gate.

Recorded latency is a staging-runner observation, not APAC p50/p95 acceptance or proof of a real 429. Deterministic Adapter tests cover Retry-After, denial and unknown writes. Do not flood a live integration to force rate limits. Scheduled freshness acceptance is scoped to the dedicated binding, not a universal SLO.

## Console and application self-service acceptance

After platform staging succeeds, run **Deploy LifeSpace Console staging (isolated)** from the exact candidate on `main`; platform deployment does not ship Console assets. The default deploy job remains Console-only: it reads current staging Core/Identity health, deploys only Console, does not migrate/deploy Core or Identity and does not install provider credentials.

The canonical browser acceptance is now the same product journey that ALOHA, HomeMew or another application can implement against `apps/core/external-connection.openapi.yaml`:

1. open a staging Space where the real browser user has current Space `manage` authority;
2. open **External data → 连接**;
3. choose Notion, enter a staging-only Integration Token and choose the Connection access ceiling;
4. submit **验证并添加连接**; Core generates the opaque `cnx_*`, the private Adapter validates the token, the matching Connection DO encrypts it with AES-256-GCM before persistence, and Core stores only secret-free `exs_*` Connection metadata plus the opaque reference;
5. use the Connection resource-discovery UI/API and confirm the second synthetic Notion Data Source appears without manually typing its Data Source ID;
6. choose an already-published External business Model Definition, the Connection and discovered Data Source, then bind it with `read` or `write` no broader than both the Connection ceiling and Model Definition ceiling;
7. verify the discovered descriptor contains only Adapter-supported fields and that read/write behavior matches the selected access;
8. verify disable/reactivate, token rotation and revocation. Rotation writes a new encrypted envelope in the same Connection DO; revocation deletes the dynamic Adapter vault state and disables the Connection's active bindings;
9. verify a non-manager/direct delegated Actor cannot perform Connection configuration and that credential plaintext/`credentialRef` never appears in browser responses, Core D1 business metadata, audit or Console state.

Creating a Connection grants no Membership, Data Grant, Application × Model Access or model binding. Binding an External Model still uses current Space management authority, and Runtime execution still applies the same Application × Model Access, Membership/Data Grant, scope and Delegation intersection as Native.

`external_acceptance_space_id` and `/api/v1/model-admin/external-sources` remain staging/bootstrap compatibility tools for controlled deployment-managed connections. They are not prerequisites for the normal browser/application journey and must not be presented as the product setup flow.

Do **not** use **Converge LifeSpace staging control plane** merely for External browser acceptance. That workflow owns broader Core/Identity/platform-credential convergence and is not the isolated Console acceptance entrypoint; canonical External Provider wiring remains under the platform staging release.

## Production and rollback

Production is an independent opt-in GitHub Environment with its own Worker name, shared secret, **vault master key** and Provider integrations. Never reuse the staging vault master key, staging tokens/test sources/Worker. Production uses the same pinned Adapter packaging and live private/vault-binding/secret verification after the exact-candidate staging/APAC gate; it does not run destructive automatic Provider smoke on real production data.

Normal production product setup uses the same Space-scoped dynamic External Connection API as staging: users with current Space `manage` may create/rotate/revoke provider Connections, while provider credential plaintext is persisted only as an AES-GCM ciphertext envelope inside the Adapter-owned Connection DO. **Production does not require a deployment-managed `NOTION_CONNECTIONS` token.** If no static map is configured, canonical deployment writes `{}` to the Adapter secret-shaped bootstrap slot, removing stale static references while keeping the dynamic product path fully operational. A nonempty production static map remains an explicit legacy/bootstrap option only.

Rollback to explicitly compatible reviewed platform/Adapter revisions, keep additive migrations and preserve working credential stores. Pause/disable affected Connections or Recurrence Plans when necessary. Shared-secret rotation updates one GitHub Environment value and both Workers in the canonical release; transient Provider interruption never justifies blind write retry. **Do not rotate `CONNECTION_VAULT_MASTER_KEY` by simply replacing the Secret while existing encrypted DO state remains on the old key.** Vault-key rotation requires a versioned decrypt/re-encrypt migration (or explicit credential reconnection) so old ciphertext remains readable until migrated. Keep `LIFESPACE_EXTERNAL_PROVIDER_ENABLED=1` for an active provider. Changing it to `0` removes the Binding on the next release and is an intentional outage, not rollback.

Keep feature release issues open until the exact candidate passes platform staging and the full self-service Console/browser acceptance. Update `docs/production/` only after successful production deployment of the exact SHA and verified capability availability.
