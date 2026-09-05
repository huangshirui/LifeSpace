import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]


def patch(path: str, old: str, new: str) -> None:
    target = ROOT / path
    text = target.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one anchor, found {count}: {old[:120]!r}")
    target.write_text(text.replace(old, new), encoding="utf-8")


patch(
    "README.md",
    "The current repository Core Kernel contract is **0.22.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel evolution since 0.13.0 has added Agent Delegation/governed Change, cross-Space Runtime Discovery, authoritative server defaults, explicit Action semantic-input/concurrency metadata, ordered multi-field Generic Query sorting, and canonical human-facing field titles while preserving the Stable Spine invariants.",
    "The current repository Core Kernel contract is **0.23.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel evolution since 0.13.0 has added Agent Delegation/governed Change, cross-Space Runtime Discovery, authoritative server defaults, explicit Action semantic-input/concurrency metadata, ordered multi-field Generic Query sorting, canonical human-facing field titles, and authorized source-field-aware Person relation target lookup while preserving the Stable Spine invariants. Relation lookup returns only minimal `{id,label}` references and remains a current capability projection rather than mutation authority.",
)

patch(
    "docs/contracts.md",
    "As of Core Kernel `0.22.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`.",
    "As of Core Kernel `0.23.0`, ordinary model paths/schemas remain deliberately absent from `apps/core/openapi.yaml`.",
)
patch(
    "docs/contracts.md",
    "Kernel `0.22.0` adds ordered repeatable Generic Query sort metadata and canonical human-facing field `title` metadata to Runtime Discovery while preserving stable machine field keys; generated Model Contracts project the same titles and keep relation target/cardinality metadata structurally separate.",
    "Kernel `0.22.0` adds ordered repeatable Generic Query sort metadata and canonical human-facing field `title` metadata to Runtime Discovery while preserving stable machine field keys; generated Model Contracts project the same titles and keep relation target/cardinality metadata structurally separate. Kernel `0.23.0` adds source-field-aware Relation Target Lookup for `person` / `person_list`: callers with current source-model read authority can resolve active Space Person references as minimal `{id,label}` values without Space membership-management authority. Discovery advertises the lookup contract; lookup is not proof of create/update authority, and mutation-time Policy/relation validation remains authoritative. `record` / `record_list` lookup is explicitly unsupported until canonical record reference-label semantics are defined rather than guessed from model-specific field names.",
)
patch(
    "docs/contracts.md",
    "- single-Space and cross-Space Runtime Discovery capability previews;\n",
    "- single-Space and cross-Space Runtime Discovery capability previews;\n- authorized source-field-aware Relation Target Lookup for generated clients;\n",
)
patch(
    "docs/contracts.md",
    "The cross-Space response is deliberately minimal: each Space entry contains only `spaceId` and effective model metadata. A model-collection Data Grant can therefore make a source Space discoverable as an authorization target without granting Space-detail metadata such as name, kind, timezone or membership data. Clients that are separately authorized for Space details use the normal Space APIs.\n",
    "The cross-Space response is deliberately minimal: each Space entry contains only `spaceId` and effective model metadata. A model-collection Data Grant can therefore make a source Space discoverable as an authorization target without granting Space-detail metadata such as name, kind, timezone or membership data. Clients that are separately authorized for Space details use the normal Space APIs.\n\nKernel `0.23.0` extends this projection with relation-target resolution. A relation field's stable structural semantics remain in Model Definition / generated JSON Schema (`targetModel` + cardinality); Runtime Discovery adds whether the current relation kind has a generic target lookup. For `person` / `person_list`, `GET /api/v1/spaces/{spaceId}/_relation-targets/{modelKey}/{fieldKey}` returns only active Space Person `{id,label}` references under the caller's current source-model read authority, with bounded search and cursor pagination. The result does not expose membership roles/global user IDs and does not establish mutation authority: create/update policies and relation integrity are rechecked when a write executes. Dynamic relation targets are therefore never serialized as static JSON Schema `enum` values.\n",
)

patch(
    "docs/architecture.md",
    "A Worker isolate loads the published model set and compiles Runtime Model Descriptors indexed by model key and route. Those descriptors precompute stable field/query/relation/access metadata. Normal hot-path model requests do not need a Registry D1 read for every request.\n",
    "A Worker isolate loads the published model set and compiles Runtime Model Descriptors indexed by model key and route. Those descriptors precompute stable field/query/relation/access metadata. Normal hot-path model requests do not need a Registry D1 read for every request.\n\nRelation structure and relation instances deliberately live at different layers. Model Definition / generated JSON Schema owns stable relation target/cardinality semantics; Runtime Context Projection resolves current relation targets under live authority. Kernel `0.23.0` provides source-field-aware Person target lookup as minimal `{id,label}` references for generated clients without exposing Space membership-management data. This lookup is not a UI widget contract and is not mutation authority; adapters decide presentation, while create/update Policy and relation integrity are rechecked at execution. Record-relation lookup remains explicitly unavailable until LifeSpace has canonical record reference-label semantics instead of adapter heuristics such as guessing `name`, `title` or `summary`.\n",
)
patch(
    "docs/architecture.md",
    "  current Kernel contract: 0.22.0",
    "  current Kernel contract: 0.23.0",
)

patch(
    "docs/model-definition-spec.md",
    "Representative reserved segments include `members`, `invites`, `grants`, `creation-drafts`, `agent-delegations` and `changes`.",
    "Representative reserved segments include `_discovery`, `_relation-targets`, `members`, `invites`, `grants`, `creation-drafts`, `agent-delegations` and `changes`.",
)
patch(
    "docs/model-definition-spec.md",
    "- `targetModel` is required only for `record` / `record_list`; it remains structural relation semantics and is not encoded into `title`. Generated contracts may project relation target/cardinality metadata separately so human-readable naming and machine relation semantics remain orthogonal.\n",
    "- `targetModel` is required only for `record` / `record_list`; it remains structural relation semantics and is not encoded into `title`. Generated contracts may project relation target/cardinality metadata separately so human-readable naming and machine relation semantics remain orthogonal.\n\nRelation metadata defines **what may be referenced structurally**, not a static list of current target instances. Generated JSON Schema therefore projects stable relation target/cardinality through `x-lifespace-relation` and must not encode mutable Space-specific targets as `enum`. Runtime Discovery / Relation Target Lookup may resolve current targets under current authorization for clients such as n8n, Agents/MCP and generated UI. A lookup result is a capability/reference projection only: it does not bypass create/update Policy or mutation-time relation validation. `person` / `person_list` have canonical Space Person labels (`displayName`) and can be resolved generically; `record` / `record_list` remain lookup-unsupported until a canonical record reference-label semantic is defined rather than guessed from model-specific field names.\n",
)

patch(
    "apps/core/AGENTS.md",
    "current Kernel version: 0.22.0",
    "current Kernel version: 0.23.0",
)

baseline_path = ROOT / "docs" / "contract-stability-baseline.json"
baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
core = next(source for source in baseline["contractSources"] if source["id"] == "core-kernel")
if any(group["id"] == "core-relation-target-lookup" for group in core["groups"]):
    raise RuntimeError("core-relation-target-lookup is already classified")
insert_at = next(index for index, group in enumerate(core["groups"]) if group["id"] == "core-agent-delegation")
core["groups"].insert(insert_at, {
    "id": "core-relation-target-lookup",
    "maturity": "candidate",
    "visibility": "public",
    "operationPattern": r"^GET /api/v1/spaces/\{spaceId\}/_relation-targets/\{modelKey\}/\{fieldKey\}$",
})

openapi = json.loads((ROOT / "apps" / "core" / "openapi.yaml").read_text(encoding="utf-8"))
methods = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
operations = []
for route, item in openapi.get("paths", {}).items():
    if not isinstance(item, dict):
        continue
    for method in item:
        if method.lower() in methods:
            operations.append(f"{method.upper()} {route}")
operations = sorted(set(operations))
core["operationSetSha256"] = "sha256:" + hashlib.sha256("\n".join(operations).encode()).hexdigest()
baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
