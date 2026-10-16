from pathlib import Path
import json
import subprocess


def replace(path, old, new):
    p = Path(path)
    s = p.read_text()
    if old not in s:
        raise SystemExit(f"missing expected text in {path}: {old[:140]!r}")
    p.write_text(s.replace(old, new, 1))


# Keep the companion OpenAPI in its existing compact checked-in representation.
p = Path("apps/core/external-model.openapi.yaml")
api = json.loads(p.read_text())
p.write_text(json.dumps(api, ensure_ascii=False, separators=(",", ":")) + "\n")

# Generic consumers see one field language regardless of origin.
replace(
    "docs/generic-consumer-contract.md",
    "Kernel 0.52.0 adds globally registered External business definitions and Space-local bindings beside the unchanged Native shapes. Native entries without `origin` continue to mean Native. External detail/inventory binds `(spaceId,key,schemaHash)`, has dynamic contract metadata and explicit runtime capabilities, and has no Native record `version` or immutable Provider schema revision. Unsupported Provider fields are absent; normal requests must use the current fields/operator subset. External sorting/null placement/ties are Provider-defined. Configuration-time `/me/_discovery/models` exposes published business semantics with `origin: external` and `fieldsDynamic: true`; concrete Provider fields require the source Space visibility gate. MCP/n8n consumers must intentionally support dynamic contracts before advertising External operations; raw API uses the same model-addressed paths.\n",
    "Kernel 0.52.0 adds globally registered External business definitions and Space-local bindings beside the unchanged Native shapes. Native entries without `origin` continue to mean Native. External detail/inventory binds `(spaceId,key,schemaHash)`, has dynamic contract metadata and explicit runtime capabilities, and has no Native record `version` or immutable Provider schema revision. Unsupported Provider fields are absent; normal requests must use the current fields/operator subset. External sorting/null placement/ties are Provider-defined. Configuration-time `/me/_discovery/models` exposes published business semantics with `origin: external` and `fieldsDynamic: true`; concrete Provider fields require the source Space visibility gate. MCP/n8n consumers must intentionally support dynamic contracts before advertising External operations; raw API uses the same model-addressed paths.\n\nNative and External models use **one Canonical Field Language**. `origin` selects storage/provider execution behavior, never a second field-type vocabulary. An External Adapter may expose any subset of the current LifeSpace `CanonicalFieldType` values that it can map losslessly and stably, plus narrower provider capabilities such as writable/filter/sort support. Core validates those canonical field definitions and values; consumers project the same field semantics for either origin. Adding a new Provider that maps to already-existing canonical types must not require another Core field-type allowlist change.\n",
)

# External docs describe provider capability as a subset of the canonical language, not an External whitelist.
replace(
    "docs/external-models.md",
    "Snapshot contains only supported fields: stable canonical key, source field identity, canonical type, title, nullable/readable/writable/filter operators/sortable and optional enum values. Private bounded `adapterState` holds codecs for **supported** fields only; it is never exposed by Discovery. Unsupported fields do not appear anywhere in the LifeSpace model. Stable source property identity survives rename; types are automatically replaced, without request/data coercion. A schema hash identifies current semantics, not a revision history.\n",
    "Snapshot contains only supported fields. Its field definition uses the **same LifeSpace Canonical Field Language as Native models** (`CanonicalFieldType` plus the applicable canonical field constraints); External does not own a second type enum or a provider-independent type allowlist. Provider metadata adds stable source-field identity and narrower runtime capability such as readable/writable/operators/sortable. Each Adapter exposes only the canonical types and capabilities it can map losslessly and stably; unsupported Provider fields remain absent rather than leaking Provider-native JSON/types into Core. Private bounded `adapterState` holds codecs for supported fields only and is never exposed by Discovery. Stable source property identity survives rename; types are automatically replaced, without request/data coercion. A schema hash identifies current semantics, not a revision history.\n",
)

# Normative Model Definition spec names the complete canonical vocabulary and its External reuse.
replace(
    "docs/model-definition-spec.md",
    "| `temporal_range` | controlled half-open `Range<Date> | Range<Instant>` value with canonical `kind: \"date\" | \"instant\"` tagging |\n| `timezone` | valid IANA timezone |",
    "| `temporal_range` | controlled half-open `Range<Date> | Range<Instant>` value with canonical `kind: \"date\" | \"instant\"` tagging |\n| `recurrence_rule` | canonical structured recurrence rule |\n| `entity_ref` | canonical structured Person/native-record reference |\n| `timezone` | valid IANA timezone |",
)
replace(
    "docs/model-definition-spec.md",
    "Canonical Model Definition syntax uses **`instant`**, not `datetime`. The string `datetime` is retained only as a **legacy published spelling** so immutable Registry rows and their historical schema hashes remain readable.",
    "The table above is the single **Canonical Field Language** for LifeSpace. Native published model fields and Space-local External dynamic field snapshots both use this vocabulary and the same canonical field constraints. External adapters may expose a Provider-specific subset and narrower execution capabilities, but they must not define a second field-type list or introduce Provider-native field types into Core. A new Provider that can map to an existing canonical type requires only Adapter work; Canonical Field Language changes are reserved for genuinely Provider-neutral semantics that LifeSpace cannot already express.\n\nCanonical Model Definition syntax uses **`instant`**, not `datetime`. The string `datetime` is retained only as a **legacy published spelling** so immutable Registry rows and their historical schema hashes remain readable.",
)

# Companion contract version and wording.
replace(
    "docs/contracts.md",
    "`apps/core/external-model.openapi.yaml` 0.3.0 owns provider-neutral External model binding/runtime representation, while `apps/core/external-adapter.contract.json` version 1 owns authenticated internal Adapter execution.",
    "`apps/core/external-model.openapi.yaml` 0.4.0 owns provider-neutral External model binding/runtime representation and reuses the same LifeSpace Canonical Field Language as Native models, while `apps/core/external-adapter.contract.json` version 1 owns authenticated internal Adapter execution.",
)

# Runtime regression: structured canonical values must actually pass the External record boundary.
p = Path("apps/core/test/external-canonical-field-language.test.ts")
s = p.read_text()
s = s.replace(
    'import { validateExternalSnapshot } from "../src/external-model";\n',
    'import { validateExternalSnapshot } from "../src/external-model";\nimport { externalRecordDto } from "../src/external-runtime";\n',
)
needle = '''  it("rejects the legacy Native datetime alias because External speaks canonical types only", () => {\n'''
extra = '''  it("uses the canonical structured value validator at the External record boundary", async () => {\n    const snapshot = validateExternalSnapshot(baseSnapshot("range<date>"));\n    const field = snapshot.fields[0]!;\n    const dto = await externalRecordDto(\n      {\n        space_id: "spc_test",\n        model_key: "ext_test",\n        schema_hash: "schema",\n        snapshot,\n      } as never,\n      {\n        id: "rec_external_test",\n        data: {\n          [field.key]: { start: "2026-10-01", endExclusive: "2026-10-02" },\n        },\n      },\n    );\n    expect(dto[field.key]).toEqual({\n      start: "2026-10-01",\n      endExclusive: "2026-10-02",\n    });\n  });\n\n  it("uses the same entity_ref value semantics for External records", async () => {\n    const snapshot = validateExternalSnapshot(baseSnapshot("entity_ref"));\n    const field = snapshot.fields[0]!;\n    const dto = await externalRecordDto(\n      {\n        space_id: "spc_test",\n        model_key: "ext_test",\n        schema_hash: "schema",\n        snapshot,\n      } as never,\n      {\n        id: "rec_external_test",\n        data: { [field.key]: { kind: "record", modelKey: "task", recordId: "rec_test" } },\n      },\n    );\n    expect(dto[field.key]).toEqual({ kind: "record", modelKey: "task", recordId: "rec_test" });\n  });\n\n'''
if extra not in s:
    if needle not in s:
        raise SystemExit("test insertion marker missing")
    s = s.replace(needle, extra + needle, 1)
p.write_text(s)

# Make docs part of the helper commit; the workflow stages code separately afterwards.
subprocess.run(
    [
        "git", "add",
        "docs/generic-consumer-contract.md",
        "docs/external-models.md",
        "docs/model-definition-spec.md",
        "docs/contracts.md",
    ],
    check=True,
)
