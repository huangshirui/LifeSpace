from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

openapi_path = ROOT / "apps/core/openapi.yaml"
doc = json.loads(openapi_path.read_text(encoding="utf-8"))
if doc.get("info", {}).get("version") != "0.43.0":
    raise SystemExit("expected Core Kernel OpenAPI 0.43.0")
status = doc["components"]["schemas"]["StatusResponse"]["properties"]["data"]["properties"]["contractVersion"]
status["const"] = doc["info"]["version"]
openapi_path.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

check_path = ROOT / "apps/core/scripts/check-openapi.mjs"
text = check_path.read_text(encoding="utf-8")
old = '''if (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== "0.42.0") {\n  throw new Error("Core Kernel status contract version drifted");\n}\n'''
new = '''const runtimeKernelContract = fs.readFileSync(new URL("../src/kernel-contract.ts", import.meta.url), "utf8")\n  .match(/CORE_KERNEL_CONTRACT_VERSION\\s*=\\s*"([^"]+)"/)?.[1];\nif (runtimeKernelContract !== document.info?.version) {\n  throw new Error("Core runtime Kernel contract version must match OpenAPI info.version");\n}\nif (schemas.StatusResponse?.properties?.data?.properties?.contractVersion?.const !== document.info?.version) {\n  throw new Error("Core Kernel status response contract version must match OpenAPI info.version");\n}\n'''
if old not in text:
    raise SystemExit("expected old status-version contract check was not found")
check_path.write_text(text.replace(old, new, 1), encoding="utf-8")

print("Aligned runtime/OpenAPI Status contract version with Core Kernel 0.43.0")
