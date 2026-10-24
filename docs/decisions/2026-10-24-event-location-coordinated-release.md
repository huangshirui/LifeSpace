# Decision: Event Location v1 breaking cutover and consumer coordination

Date: 2026-10-24  
Status: Development candidate — blocked by staging and upstream schema 73  
Tracking: LifeSpace #235 / #405 / #406, PR #404; HomeMew #143 / #144; n8n nodes #113

## Purpose / 目标

The platform's provider-neutral `location` type exists as a Kernel primitive in PR #405. This decision replaces the *published Event model's* nullable legacy Location string with a canonical first-class Location value, without making a HomeMew-specific model or adding hidden geocoding.

## Canonical Event field contract

```json
{
  "location": {
    "name": "文来中学足球场",
    "address": "上海市闵行区",
    "coordinates": { "latitude": 31.0, "longitude": 121.0 }
  }
}
```

Only `name` is required inside a non-null Location; `address` and `coordinates` are independently optional. Historical strings are backfilled as `{name:trimmedValue}` or null for previously null/empty values, with no guessed coordinate or address. Coordinates use WGS84.

Event retains existing `when: temporal_range`, `status`, `attendeePersonIds`, audit semantics, model identity and authorization. The field change must be explicitly labeled `compatibility: breaking`, must publish a new Registry version/hash, and must not rewrite earlier Registry rows. All existing records adopt the new model version under the migration.

`query.searchable` keeps `location`, searching **explicit `location.name` only** to avoid a regression of HomeMew's venue keyword search. `query.filterable` additionally adds `location` for `withinDistance`, `isNull`, and `isNotNull`; null and name-only fields never match spatial predicates. Sort semantics remain unchanged.

## Physical migration and dependency

The baseline model catalogue remains the sole source for Event's current logical schema. A checked-in schema `0074_event_location.sql` performs guarded backfill into four typed columns (`name/address/latitude/longitude`), recreates D1 indexes, updates `resource_records.model_version`, increments Registry revision, invalidates active Model Contract, and verifies row counts and schema hash.

**Hard dependency**: schema `0073` belongs to separate PR #404; applying schema 74 before 73 is forbidden. Schema 74 preflight requires metadata schema version 73 and the exact prior Event schema hash `be9bdea442a30108a22a2da77a96ab23aba5122ec3c2b1de20a6312cebb0cc8a`. Target canonical Event schema hash `7b189b870a3da40ecc6d4ae7926c600f8beec5bc3af342539279d934da3243c6` is computed using the repository canonical sorted JSON process and must be verified by tests.

## Application and n8n consumer release

HomeMew Mini's reviewed `Event.location: string | null` product DTO remains unchanged; its BFF maps between old/new schemas using an explicit trusted deployment-controlled switch, never arbitrary caller parameters. Web can display both and preserve untouched rich points. The n8n nodes must use Discovery's new `location` field and its canonical JSON Schema for Agent write queries, not duplicate a place model.

## Release gates

1. Merge/deploy schema 73 and the Location primitive to LifeSpace Staging in the approved order.
2. Run schema 74 and Stage integration tests, test old Event legacy-name backfill, nullable Location, name-only data, address/coords, `withinDistance`, name search, temporal queries, authorization and Model Contract revision.
3. Deploy HomeMew Web Preview with PR #143 and #144 for real UI verification, exercise the Mini stable DTO against staging in tests while preserving the production Mini client path.
4. Confirm n8n nodes CI and Agent Human Workflow queries against the staged contract.
5. Obtain approved coordinated production release window. Snapshot/backup D1 and inventory Event row/name counts. Apply the Core schema migration and switch HomeMew Worker production `LIFESPACE_EVENT_LOCATION_FORMAT` to `location` with bounded mixed-version window. Validate production Event CRUD and Mini BFF. Do not publish n8n npm until its version-sync/main-branch CI/tag gate.
6. Do not mark the feature Production or close Issue #406 until exact release SHA and end-to-end smoke evidence are recorded.

**Rollback warning**: redeploying the previous Core alone cannot undo a breaking typed-storage/schema change. Roll back the verified D1 snapshot and matching Core + HomeMew artifact pair, or review a compensating migration; never silently discard coordinates.
