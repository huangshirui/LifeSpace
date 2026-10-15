# External Provider deployment and staging acceptance

This development runbook covers External/Federated Truth, Semantic Relations, Recurrence and the Space-scoped External Connection product flow. Committed deployment support is not production availability evidence. The owner starts **Deploy LifeSpace platform staging** manually from `main`; no additional Adapter workflow needs to be started.

## Provider routing / Provider 路由

LifeSpace Core owns one provider-neutral External API and a deployment-owned routing table. Runtime/configuration calls resolve `providerKey` to a **provider-specific private Service Binding + provider-specific Core↔Adapter shared secret**. Provider Adapters own their own Connection Vault implementation and their own vault master key. A future Airtable Adapter therefore adds a new manifest entry/Worker/binding/secrets without changing the public External Connection or External Model lifecycle.

Current staging routes only `notion`:

```text
Core EXTERNAL_PROVIDER_ROUTES
  notion
    -> EXTERNAL_ADAPTER_NOTION
    -> EXTERNAL_ADAPTER_NOTION_SHARED_SECRET
         |
         v
private Notion Adapter Worker
    -> per-connection cnx_* Durable Object
    -> NOTION_CONNECTION_VAULT_MASTER_KEY (deployment source name)
    -> Notion API
```

The Adapter-internal runtime secret name remains `CONNECTION_VAULT_MASTER_KEY`; `NOTION_CONNECTION_VAULT_MASTER_KEY` is the LifeSpace GitHub Environment/deployment-source name. GitHub Secrets are used only by the deployment job to synchronize Cloudflare Worker Secrets. Runtime DO code reads the Cloudflare Worker Secret and never calls GitHub. Keep the GitHub copy because every canonical redeploy revalidates/resynchronizes the runtime secret.

Core has an independent `EXTERNAL_CURSOR_SECRET` for External query cursor HMACs. It must not reuse a Provider transport shared secret, Provider vault key, bootstrap secret or Provider token.

The legacy generic `EXTERNAL_ADAPTER` Service Binding is compatibility-only for old local/tests. Canonical staging/production verification rejects it; remote Provider traffic must use provider-specific bindings.

## One-time staging preparation

Keep a dedicated synthetic Notion Data Source for automatic platform acceptance. It must contain synthetic data only and be accessible to the staging Notion integration. The source must have `Name` as the title property and `Amount` as a number property; acceptance creates, updates and trashes its own pages. Under Notion API `2025-09-03`, use the concrete Data Source identity.

Configure the LifeSpace repository's **staging GitHub Environment**:

| Kind | Name | Value / purpose |
| --- | --- | --- |
| Variable | `LIFESPACE_EXTERNAL_PROVIDER_ENABLED` | `1`; unset/`0` keeps optional Native-only deployment and does **not** accept External |
| Secret | `EXTERNAL_CURSOR_SECRET` | Independent 32–512 printable-character Core secret used only for External cursor HMAC |
| Variable | `LIFESPACE_NOTION_ADAPTER_WORKER` | Dedicated Notion Worker name ending in `-staging`, separate from Core/Identity/Console |
| Secret | `NOTION_ADAPTER_SHARED_SECRET` | Independent Core↔Notion Adapter shared secret, 32–512 printable characters |
| Secret | `NOTION_CONNECTION_VAULT_MASTER_KEY` | Independent 32 random bytes encoded as exactly 64 hexadecimal characters; deployment source for the Notion Adapter Worker runtime `CONNECTION_VAULT_MASTER_KEY`. Generate independently, e.g. `openssl rand -hex 32` |
| Secret | `NOTION_CONNECTIONS` | **Staging bootstrap/smoke only**: JSON map containing the synthetic static smoke connection. Normal product Connections do not use this map |
| Variable | `LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF` | Reference of the active read/write automatic-smoke connection in that map |
| Secret | `LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID` | Concrete synthetic Notion Data Source UUID |
| Variable | `LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED` | `1`, confirming the source is synthetic-only |

Every secret above must be independent. `NOTION_CONNECTIONS` is retained only to prove the deployment-managed bootstrap compatibility path and to supply the same synthetic token as **request input** to the dynamic product smoke. The dynamic smoke does not expose or provision that static `credentialRef`; it calls the public Connection API so Core generates a fresh `cnx_*` and the routed Notion Adapter persists a fresh encrypted DO vault.

Provider credential plaintext exists only transiently across the browser/app request path and the matching Connection DO execution. Before DO persistence, the Notion credential projection is encrypted with AES-256-GCM under the Adapter runtime `CONNECTION_VAULT_MASTER_KEY`; storage contains only a versioned `{version,algorithm,iv,ciphertext}` envelope. Core D1 stores only secret-free connection metadata plus the opaque `cnx_*` reference.

Existing Cloudflare credentials/account and staging bootstrap settings remain required. The deploy token must manage/read Worker settings and secrets and read workers.dev/preview exposure, alongside existing platform permissions. Invalid prerequisites fail before deployment mutation, without printing tokens, vault keys or provider payloads.

`infra/external-provider.json` pins the reviewed adapter repository/revision and owns the provider-routing manifest. Updating the provider set or adapter revision requires a reviewed code change. Live identifiers stay out of the public Adapter repository. Canonical deployment verifies Core routing, every provider-specific Service Binding/shared secret, private Adapter exposure, vault Worker Secret and Durable Object binding.

## Single manual staging release

The workflow validates repository/configuration, resolves staging D1, deploys the private pinned Notion Adapter and its secrets/DO binding, migrates/deploys Core with generated `EXTERNAL_PROVIDER_ROUTES` + `EXTERNAL_ADAPTER_NOTION`, synchronizes the independent Core cursor and Notion transport secrets, verifies live routing/private exposure, then migrates/deploys compatible Identity. The existing Core-first → Identity order is preserved. After Identity convergence, the same canonical platform release reconciles the staging Console Application scope ceiling, including ordinary `spaces:manage`, without rotating installed Console credentials.

Remote Core profiles configure schema refresh every 300 seconds. This is a scheduling setting, not a measured freshness/latency SLO. The existing one-minute Scheduled trigger drains bounded indexed work.

The staging release proves **two distinct External paths**:

1. **bootstrap compatibility smoke** — service-only static Source provisioning through `NOTION_CONNECTIONS`; this proves legacy/deployment-managed wiring and the broad External runtime/relations/scheduled-refresh regression suite;
2. **dynamic product smoke** — `Provider Discovery → public Connection create → encrypted cnx_* DO Vault → Resource Discovery → business-definition binding → runtime CRUD → schema refresh → Connection write→read downgrade → binding ceiling propagation → credential rotation → disable/enable → revoke`.

The dynamic product smoke additionally proves:

- the public Connection response/list never exposes Provider token or server-owned `credentialRef`;
- Core D1 stores only the generated `cnx_*` reference and secret-free metadata;
- Resource Discovery reaches the same synthetic Data Source through the dynamic DO vault;
- Runtime execution routes from persisted `source.provider_key` to the Notion-specific private Adapter;
- Connection write→read synchronously narrows every write binding to read through a D1 invariant;
- attempting to raise a binding above a read-only Connection ceiling fails before Provider write;
- rotating the token writes a new encrypted envelope in the same Connection DO;
- disabling a Connection removes runtime availability and re-enabling restores it;
- revoking the Connection deletes the DO credential state and disables bindings;
- run-scoped Core metadata is removed only after API revoke/cleanup so repeated smoke runs do not claim the Provider resource permanently.

Unknown Provider writes are never retried. If a create has no confirmed returned ID, inspect the dedicated synthetic source for that run's marker before rerunning; the script cannot safely guess an ID. Cleanup failure fails acceptance too. Already applied additive migrations/deployments are retained; fix the indicated failure and rerun the canonical entry point. Do not remove migrations or bypass a failing gate.

Recorded latency is a staging-runner observation, not APAC p50/p95 acceptance or proof of a real 429. Deterministic Adapter tests cover Retry-After, denial and unknown writes. Do not flood a live integration to force rate limits.

## Console and application configuration

After platform staging succeeds, run **Deploy LifeSpace Console staging (isolated)** from the exact candidate on `main`; platform deployment does not ship Console assets. The Console deploy reads current Core/Identity health and deploys only Console. It does not migrate/deploy Core or Identity, reconcile Identity scopes, or install Provider credentials/Sources.

Console is a first-party proving client of the same Space APIs that ALOHA, HomeMew or another application can use. The public `apps/core/external-connection.openapi.yaml` contract covers:

- list configured Providers;
- create/list/update/disable/re-enable/rotate/revoke dynamic Connections;
- discover Provider Resources;
- list bindable External Model Definitions;
- create/reactivate bindings;
- list current/disabled bindings;
- change binding read/write ceiling;
- disable a binding;
- refresh the latest Provider schema snapshot.

Console exposes this lifecycle through exactly one standard Space surface: **`Configure → External data`**. The `连接` tab owns Connection lifecycle; `模型绑定` owns binding create/list, schema refresh, read/write changes and disable. Disabled bindings are restored through the same normal re-bind form so Provider identity/schema are revalidated. There is no second `External bindings` fallback UI/BFF. Console does not receive platform-executor authority for this flow; its BFF exchanges the verified browser Access assertion for an ordinary User token with `spaces:manage`, and Core rechecks current Space `manage` permission.

Creating a Connection grants no Membership, Data Grant, Application × Model Access or model binding. Runtime execution still applies the same Application × Model Access, Membership/Data Grant, scope and Delegation intersection as Native.

The service-only `/api/v1/model-admin/external-sources` path and deployment-managed static references remain available only for smoke/bootstrap/legacy operations. They are intentionally absent from normal Console/application setup and must not be presented as product setup.

## Production and rollback

Production is an independent opt-in GitHub Environment. Each Provider requires its own Worker, Core↔Adapter shared secret and vault master key; never reuse staging values or another Provider's keys. Core also has its own production `EXTERNAL_CURSOR_SECRET`. Production uses the same manifest/pinned Adapter packaging and private-routing/vault verification after the exact-candidate staging/APAC gate; it does not run destructive automatic Provider smoke against real production data.

Normal production product setup uses the same Space-scoped dynamic External Connection API as staging. Production does not require a deployment-managed `NOTION_CONNECTIONS` token; an empty `{}` static map is valid. A nonempty static map remains an explicit legacy/bootstrap option only.

Rollback to explicitly compatible reviewed platform/Adapter revisions, keep additive migrations and preserve working credential stores. Pause/disable affected Connections or Recurrence Plans when necessary. Provider shared-secret rotation updates the relevant GitHub Environment value and is synchronized to both Core's provider-specific secret binding and that Adapter Worker. **Do not rotate a Provider vault master key by simply replacing its Secret while encrypted DO state remains on the old key.** Vault-key rotation requires a versioned decrypt/re-encrypt migration or explicit credential reconnection. Changing `LIFESPACE_EXTERNAL_PROVIDER_ENABLED` to `0` removes provider routing on the next release and is an intentional outage, not rollback.

Keep feature release work open until the exact candidate passes platform staging and Console/browser acceptance where required. Update `docs/production/` only after successful production deployment of the exact SHA and verified capability availability.