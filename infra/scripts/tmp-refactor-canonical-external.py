from pathlib import Path
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2]


def run(*args: str) -> str:
    return subprocess.check_output(args, cwd=ROOT, text=True)


# Restore the hand-maintained formatting from main, then apply only semantic edits.
external_contract = ROOT / "apps/core/external-model.openapi.yaml"
main_contract = run("git", "show", "origin/main:apps/core/external-model.openapi.yaml")
contract = json.loads(main_contract)
field = contract["components"]["schemas"]["ExternalField"]
field["properties"]["type"] = {
    "type": "string",
    "description": "Canonical LifeSpace field type. External Models reuse the same Canonical Field Language as Native Models; Provider adapters choose only types they can map losslessly."
}
contract["components"]["schemas"]["DynamicRecord"]["additionalProperties"] = True
contract["components"]["schemas"]["ExternalWriteData"]["additionalProperties"] = True
contract["components"]["schemas"]["ExternalFilterPredicate"]["properties"]["value"] = {}
external_contract.write_text(json.dumps(contract, ensure_ascii=False, indent=2) + "\n")

# Remove temporary implementation machinery before the final branch commit.
for relative in [
    ".github/workflows/tmp-canonical-external-field-language.yml",
    "infra/scripts/tmp-refactor-canonical-external.py",
]:
    path = ROOT / relative
    if path.exists():
        path.unlink()
