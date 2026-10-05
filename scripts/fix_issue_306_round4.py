from pathlib import Path
import hashlib
import json

ROOT = Path(__file__).resolve().parents[1]
baseline_path = ROOT / "docs/contract-stability-baseline.json"
openapi_path = ROOT / "apps/core/openapi.yaml"

# #306 adds a new Candidate Public API family. Keep the operation classifier and
# full Core operation-set digest aligned with the generated OpenAPI in the same gate.
baseline = json.loads(baseline_path.read_text())
core = next((item for item in baseline.get("contractSources", []) if item.get("id") == "core-kernel"), None)
if core is None:
    raise SystemExit("core-kernel contract source missing")

group_id = "core-authorization-requests"
pattern = r"^(GET|POST) /api/v1/spaces/\{spaceId\}/authorization-requests$|^(GET|POST) /api/v1/spaces/\{spaceId\}/authorization-requests/\{requestId\}$|^POST /api/v1/spaces/\{spaceId\}/authorization-requests/\{requestId\}/(confirm|deny|cancel)$"
existing = next((group for group in core.get("groups", []) if group.get("id") == group_id), None)
if existing is None:
    delegation_index = next(
        (index for index, group in enumerate(core["groups"]) if group.get("id") == "core-delegation"),
        None,
    )
    if delegation_index is None:
        raise SystemExit("core-delegation classification anchor missing")
    core["groups"].insert(delegation_index + 1, {
        "id": group_id,
        "maturity": "candidate",
        "visibility": "public",
        "operationPattern": pattern,
    })
else:
    existing.update({
        "maturity": "candidate",
        "visibility": "public",
        "operationPattern": pattern,
    })

# The stability baseline intentionally fingerprints the complete operation set.
# Recompute it from the generated #306 OpenAPI rather than hand-maintaining a hash.
doc = json.loads(openapi_path.read_text())
methods = {"get", "post", "put", "patch", "delete", "options", "head", "trace"}
operations = []
for path, item in (doc.get("paths") or {}).items():
    if not isinstance(item, dict):
        continue
    for method in item.keys():
        if method.lower() in methods:
            operations.append(f"{method.upper()} {path}")
operations = sorted(set(operations))
if not operations:
    raise SystemExit("generated Core OpenAPI contains no operations")
digest = hashlib.sha256("\n".join(operations).encode()).hexdigest()
core["operationSetSha256"] = f"sha256:{digest}"

baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n")
print(f"Classified #306 Authorization Request APIs as Candidate Public; core-kernel={core['operationSetSha256']}")
