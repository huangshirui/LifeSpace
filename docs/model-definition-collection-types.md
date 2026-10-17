# Canonical collection field types / Canonical 集合字段类型

Status: **Normative companion to Model Definition Specification v1**

This document closes the specification gap for the provider-neutral collection types already present in the Model Definition v1 validator/runtime. It is normative together with `docs/model-definition-spec.md`; if either document, validator, runtime, generated Model Contract or tests disagree, that is contract drift to fix.

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
- it is not searchable or sortable in Model Definition v1;
- External Adapters may advertise a bounded Provider-native `contains` operator when they can execute it faithfully; this does not create a second field type or imply a Native JSON-array scan.

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
- it is not searchable or sortable; no generic Native content query is inferred from the URL/reference array;
- a Provider Adapter may expose it read-only when the Provider can supply references but LifeSpace cannot safely write the Provider-specific file object;
- Provider-hosted bytes stay at the Provider unless a separate explicit product workflow copies them.

## Physical and contract projection

Both collection types are logical Canonical values. Current Native typed storage encodes them as validated JSON arrays in one typed column and does not create a scalar index for that column. Generated Model Contracts expose their logical JSON-array shape; physical representation is not public API.

External Models use the same logical definitions. Provider-specific option IDs, colors, signed-URL implementation details or other UI/storage metadata remain Adapter metadata unless they have a separate provider-neutral canonical semantic.

Conformance-ID: MDV1-COLLECTION-FIELD-TYPES-01
