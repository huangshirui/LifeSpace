# External Provider deployment and staging acceptance

This development runbook covers External/Federated Truth, Semantic Relations and Recurrence. Committed deployment support is not production availability evidence. The owner starts **Deploy LifeSpace platform staging** manually from `main`; no additional Adapter workflow needs to be started.

## One-time staging preparation

Use a dedicated synthetic Notion data source that has never been bound to a real LifeSpace Space. Give the staging integration access only to this test source, including read, insert and update permissions. It must have `Name` as the title property and `Amount` as a number property. Acceptance creates, updates and trashes its own pages. Select the concrete data source ID under Notion API `2025-09-03`; a multi-source database does not select itself. Do not reuse real data, a production integration or a pre-existing LifeSpace binding.

Configure the LifeSpace repository's **staging GitHub Environment**:

| Kind | Name | Value / purpose |
| --- | --- | --- |
| Variable | `LIFESPACE_EXTERNAL_PROVIDER_ENABLED` | `1`; unset/`0` keeps optional Native-only deployment and does **not** accept External |
| Variable | `LIFESPACE_EXTERNAL_ADAPTER_WORKER` | Dedicated Worker name ending in `-staging`, separate from Core/Identity/Console |
| Secret | `EXTERNAL_ADAPTER_SHARED_SECRET` | Independent random value of at least 32 characters; never bootstrap or production secret |
| Secret | `NOTION_CONNECTIONS` | JSON map of opaque references to `{token,read:true,write:boolean,disabled?:boolean}` |
| Variable | `LIFESPACE_EXTERNAL_SMOKE_CREDENTIAL_REF` | Reference of the active read/write synthetic test connection in that map |
| Secret | `LIFESPACE_EXTERNAL_SMOKE_RESOURCE_ID` | Concrete synthetic Notion data source UUID |
| Variable | `LIFESPACE_EXTERNAL_SMOKE_SYNTHETIC_CONFIRMED` | `1`, confirming a dedicated synthetic-only source |

Existing Cloudflare credentials/account and staging bootstrap settings remain required. The deploy token must manage/read Worker settings and secrets and read workers.dev/preview exposure, alongside existing platform permissions. Invalid prerequisites fail before deployment mutation, without printing tokens or provider payloads. Core receives only the independent shared secret and opaque reference; Notion tokens are injected exclusively into the private Adapter Worker, never D1 or the Console browser.

`infra/external-provider.json` pins the reviewed Adapter to a full immutable SHA. Updating it requires a reviewed code change and both environment packaging checks. Live identifiers stay out of the public Adapter repository. The platform workflow overrides its synthetic packaging names only in the ephemeral deployment checkout.

## Single manual staging release

The workflow validates the repository/configuration, resolves staging D1, deploys the private pinned Adapter and secrets, migrates/deploys Core with `EXTERNAL_ADAPTER`, synchronizes the matching Core secret, verifies live wiring/private URLs, then migrates/deploys compatible Identity. The existing Core-first → Identity order is preserved. Enabled releases regenerate the Binding every time; dashboard-only configuration cannot silently disappear on a later canonical release.

Remote Core profiles explicitly configure schema refresh every 300 seconds. This is a scheduling setting, not a measured freshness/latency SLO. The existing one-minute Scheduled trigger drains bounded indexed work.

After preparing bounded smoke authority, the workflow checks:

- Recurrence semantic discovery, real enrollment/current Identity root checks, first Task, completion successor and pause. Removing the rule precedes Task/Plan cleanup.
- Real Notion connection, business-definition publication, Space binding and dynamic discovery.
- Provider create/get/query/update/delete with no fabricated Native version. Only bounded read/query convergence may retry.
- Native→External relation creation/hydration, atomic rejection, and a non-atomic batch where an invalid External item fails while an independent Native create and relation succeed.
- Manual refresh and a **real Scheduled refresh**: only this run's binding is made due; its observed timestamp must advance within the 150-second smoke window.
- Source disable/reactivation and confirmed Provider deletion cleaning local edges.
- Run-scoped cleanup: trash confirmed returned page IDs, retire temporary definitions, retain Registry/audit history, and remove only this run's new binding/source/identity metadata. This permits repeated acceptance using the dedicated source without changing global resource ownership.

Unknown Provider writes are never retried. If a create has no confirmed returned ID, inspect the dedicated source for that run's synthetic marker before rerunning; the script cannot safely guess an ID. Cleanup failure fails acceptance too. Already applied additive migrations/deployments are retained; fix the indicated failure and rerun the canonical entry point. Do not remove migrations or bypass a failing gate.

Recorded latency is a staging-runner observation, not APAC p50/p95 acceptance or proof of a real 429. Deterministic Adapter tests cover Retry-After, denial and unknown writes. Do not flood a live integration to force rate limits. Scheduled freshness acceptance is scoped to the dedicated binding, not a universal SLO.

## Console acceptance

After platform staging succeeds, run **Deploy LifeSpace Console staging** from `main` to ship the binding UI and refresh its trusted Application scope ceiling, including `spaces:manage`. Platform deployment does not ship Console assets. Use an established staging user/admin to verify External definition validation/publication, Space definition + provisioned Source + data source binding, descriptor-driven fields, conflict/validation errors and disabled/unbound states. Use a second dedicated synthetic source for the UI exercise; reserve the automatic source for automatic acceptance. Verify non-admin/non-manager and stale authority denial. Existing Console configuration/boundary checks remain required; human Access/browser acceptance needs the deployed Console.

## Production and rollback

Production is an independent opt-in GitHub Environment with its own Worker name (not ending in `-staging`), integrations/connections and shared secret. Never reuse staging connections/tokens/test UUID/Worker. Production uses the same pinned packaging and live wiring verification after the existing exact-candidate staging/APAC gate; it does not run destructive Provider smoke on production data. Source provisioning remains service-only Model Admin; runtime authority remains Core-owned.

Rollback to explicitly compatible reviewed platform/Adapter revisions, keep additive migrations and preserve working credentials. Pause/disable affected Sources or Recurrence Plans when necessary. Shared-secret rotation updates one GitHub Environment value and both Workers in the canonical release; transient Provider interruption never justifies blind write retry. Keep `LIFESPACE_EXTERNAL_PROVIDER_ENABLED=1` for an active provider. Changing it to `0` removes the Binding on the next release and is an intentional outage, not rollback.

Keep feature release issues open until the exact candidate passes staging and Console acceptance. Update `docs/production/` only after successful production deployment of the exact SHA and verified capability availability.
