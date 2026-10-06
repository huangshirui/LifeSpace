# Space Person Directory

Status: Candidate for Core Kernel 0.47.0

Space Person (`per_*`) is Kernel-owned Shared Reality. It is the stable same-Space identity anchor used by metadata-driven `person` / `person_list` fields, Reference Projection, Membership linkage and Person-facing applications. It is not an ordinary Model Registry model.

## Identity and names

- `space_people.display_name` is the one canonical display/reference label.
- A Person may have 0–20 active alternate names in `space_person_names`.
- Alternate names are lookup keys only. Matching an alternate name still returns the canonical `displayName` as the reference label.
- Names are trimmed and NFC-normalized before Person Directory persistence.
- Alternate names must be unique within one Person under case-insensitive comparison and must not duplicate the current canonical display name.
- `linked_user_id` is never writable through Person Directory. Only Membership/Invite lifecycle may establish or reactivate User ↔ Space Person linkage.

## Kernel API

The Kernel Person Directory surface is:

```text
GET    /api/v1/spaces/{spaceId}/people
POST   /api/v1/spaces/{spaceId}/people
GET    /api/v1/spaces/{spaceId}/people/{personId}
PATCH  /api/v1/spaces/{spaceId}/people/{personId}
DELETE /api/v1/spaces/{spaceId}/people/{personId}
```

List/search accepts `q`, opaque `cursor`, and `limit` (1–100, default 50). `q` matches the active canonical display name or any active alternate name in the same Space. Pagination is keyset-based on canonical display name + Person ID.

Create accepts `displayName` and optional `alternateNames`; it always creates an unlinked Person. Update accepts `version` plus one or both of `displayName` / `alternateNames`. Supplying `alternateNames` replaces the active alternate-name set atomically. Delete accepts `version` and soft-deletes the unlinked Person plus its active alternate names.

A Person response intentionally exposes only:

```json
{
  "id": "per_*",
  "displayName": "Canonical label",
  "alternateNames": ["nickname"],
  "linkedUser": false,
  "version": 1,
  "createdAt": "...",
  "updatedAt": "..."
}
```

`linkedUser` is a boolean boundary fact. Person Directory does not expose the global `usr_*` identifier, Membership role, email or other Identity metadata.

## Authority

Person Directory is Shared Reality, not Membership administration.

Read requires:

```text
resources:read credential scope
∩ current Space read Authority
∩ explicit current Space-target dlg_* when execution is represented
```

Create/delete of unlinked Persons requires:

```text
resources:write credential scope
∩ current Space write Authority
∩ explicit current Space-target write/manage dlg_* when represented
```

Update uses the same write credential/delegation boundary, then applies target-specific Space authority:

- the linked User may update their own Space Person while retaining only current Space read access;
- owner/admin may update any linked Space Person;
- another Principal/Actor must have current Space `manage` Authority to update a linked Person;
- an unlinked Person requires current Space `write` Authority.

A linked Person cannot be deleted through Person Directory. Membership lifecycle owns deactivation/reactivation. An unlinked Person also cannot be deleted while an active ordinary record still references it.

Direct Agent execution may use current Agent Data Grant Authority. `User / Agent` represented execution requires an explicit current Space-target Delegation; Person Directory does not treat Agent credential possession as Space Authority.

## Optimistic concurrency and governed change

`space_people.version` is monotonic. Person Directory `PATCH` and `DELETE` require the expected current version. Canonical-name and alternate-name changes are one logical Person update and advance the Person version exactly once.

Membership/Space lifecycle changes that rename, deactivate or reactivate a linked Space Person also advance the same version, so Person Directory concurrency cannot silently overwrite a lifecycle change.

Committed Person Directory mutations write durable `pchg_*` evidence containing operation, version before/after, Principal, Actor, Application, Delegation selector and changed field keys. Delegation-chain evidence is stored separately. Single-use Delegations are consumed by D1 trigger in the same transaction as the committed Person change; a failed Person mutation cannot consume a single-use Delegation by itself.

## Search performance boundary

Person lookup is always Space-scoped and set-based. Listing/searching one page must not cause one D1 query per Person or per alternate name.

Current strategy:

- partial active index on `(space_id, display_name COLLATE NOCASE, id)`;
- partial active alternate-name lookup index on `(space_id, name COLLATE NOCASE, person_id)`;
- one Person Directory list/search statement that pages Persons first and joins active alternate names for that page;
- Relation Target Lookup uses one set-based Person statement and returns only `{id,label}`.

Substring search currently uses escaped `LIKE '%q%'`. Ordinary B-tree indexes cannot seek on a leading wildcard, but the Space prefix and active-row index still bound the working set. LifeSpace deliberately does not introduce FTS5/trigram in this release: common Chinese Person queries are frequently two characters, while SQLite trigram acceleration requires at least three consecutive Unicode characters for an indexed substring constraint. FTS introduces additional storage, write amplification, synchronization triggers and migration cost. It should be introduced only when measured directory scale/latency evidence justifies it.

CI includes a 500-Person lookup probe covering a 1-item page, a 100-item page, canonical-name search and short Chinese alternate-name search. The acceptance invariant is constant Worker→D1 request shape with no per-Person waterfall and bounded D1 bindings; local wall-clock time is diagnostic only and is not treated as APAC production latency evidence.

## Explicitly out of scope

- typed interpersonal Relationship model;
- a `person_profile` model before the Model Definition DSL can express its required one-Person/one-Profile invariant cleanly;
- assigning a global User identity through Person Directory;
- fuzzy/phonetic/semantic search ranking;
- FTS5 until measured need justifies its operational cost.
