# Canonical collection field types / Canonical 集合字段类型

Status: **Normative companion to Model Definition Specification v1**

This document extends the Canonical Field Language table in `docs/model-definition-spec.md` for the provider-neutral collection types already present in Model Definition v1. It is normative together with that specification; if either document, publication validator, runtime, generated Model Contract or tests disagree, that is contract drift to fix.

## `enum_list`

`enum_list` is a list of declared enum string values.

Canonical value:

```json
["alpha", "beta"]
```

Rules:

- value must be an array;
- every item must be a string present in `FieldDefinition.values`;
- items must be unique;
- `values` is required for the field and follows the same maximum of 50 declared options as `enum`;
- a default, when declared, must itself be a unique array containing only declared values;
- `nullable` remains an ordinary field declaration choice; a Provider Adapter may map a source list to non-nullable canonical list semantics when the Provider represents “no selection” as an empty list;
- Native Model Definition v1 does not permit this field in `query.searchable`, `query.filterable` or `query.sortable`: current Native storage has no bounded collection index/query projection and must not fall back to JSON-array scans;
- External Adapters may advertise a bounded Provider-native `contains` operator when they can execute it faithfully; this does not create a second field type or imply a Native JSON-array scan.


## `file` / `file_list`

`file` and `file_list` are Native LifeSpace File identity references. They store stable `fil_*` IDs only; file bytes and temporary access URLs never enter ordinary Model record storage.

Canonical values:

```json
"fil_0123456789abcdef0123456789abcdef"
```

```json
["fil_0123456789abcdef0123456789abcdef"]
```

Rules:

- `file` is one stable LifeSpace File ID; `file_list` is an ordered unique array of at most 100 File IDs;
- referenced Files must be `ready` and belong to the same Space; Runtime validates this against the File resource store before record mutation;
- File bytes are owned by LifeSpace and stored outside typed record tables (R2 in the Cloudflare deployment);
- URLs are short-lived access projections and are never the field identity/value;
- Model Definition v1 does not allow defaults or generic searchable/filterable/sortable declarations for these types;
- upload/download are separate File capabilities and are not encoded as arbitrary binary/URL values in ordinary Record mutation.

## `file_ref_list`

`file_ref_list` is a bounded list of file references. It represents references only and does not imply that LifeSpace stores or mirrors file bytes.

Canonical value:

```json
[
  {
    "name": "report.pdf",
    "url": "https://provider.example/report.pdf",
    "expiresAt": "2026-10-17T12:30:00Z"
  }
]
```

Rules:

- value must be an array with at most 100 entries;
- each entry contains exactly `name`, `url`, and optional `expiresAt`;
- `name` is non-empty after trimming and at most 512 characters;
- `url` must be an HTTP(S) URI and at most 8192 characters;
- `expiresAt`, when present, is an RFC 3339 absolute instant;
- `values`, string-length constraints, numeric constraints and `targetModel` do not apply;
- Model Definition v1 does not allow a default for this type;
- Native Model Definition v1 does not permit this field in `query.searchable`, `query.filterable` or `query.sortable`; no generic Native content query is inferred from the URL/reference array;
- a Provider Adapter may expose it read-only when the Provider can supply references but LifeSpace cannot safely write the Provider-specific file object;
- Provider-hosted bytes stay at the Provider unless a separate explicit product workflow copies them.

## Physical and contract projection

Both collection types are logical Canonical values. Current Native typed storage encodes them as validated JSON arrays in one typed column and does not create a scalar index for that column. Generated Model Contracts expose their logical JSON-array shape; physical representation is not public API.

External Models use the same logical definitions. Provider-specific option IDs, colors, signed-URL implementation details or other UI/storage metadata remain Adapter metadata unless they have a separate provider-neutral canonical semantic.

Conformance-ID: MDV1-COLLECTION-FIELD-TYPES-01
