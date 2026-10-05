from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[1]

# Core version invariant: runtime constant = OpenAPI info.version = StatusResponse.contractVersion.
path = ROOT / "apps/core/openapi.yaml"
text = path.read_text()
old = '"contractVersion":{"const":"0.43.0"}'
new = '"contractVersion":{"const":"0.44.0"}'
if text.count(old) != 1:
    raise SystemExit(f"expected one Core StatusResponse contractVersion match, got {text.count(old)}")
path.write_text(text.replace(old, new, 1))

# Phase A inserts agentCredential after the serviceToken scheme header. Restore the
# existing #311 Service bearerFormat to serviceToken and give Agent its own format.
path = ROOT / "apps/identity/openapi.yaml"
text = path.read_text()
old = '''    serviceToken:
      type: http
      scheme: bearer
    agentCredential:
      type: http
      scheme: bearer
      description: Opaque lsp_agt_* Agent API credential; accepted only on the internal introspection route.
      bearerFormat: lsp_svc_ opaque token
'''
new = '''    serviceToken:
      type: http
      scheme: bearer
      bearerFormat: lsp_svc_ opaque token
    agentCredential:
      type: http
      scheme: bearer
      bearerFormat: lsp_agt_ opaque credential
      description: Opaque lsp_agt_* Agent API credential; accepted only on the internal introspection route.
'''
if text.count(old) != 1:
    raise SystemExit(f"expected one Identity Service/Agent security-scheme match, got {text.count(old)}")
text = text.replace(old, new, 1)
path.write_text(text)

# Contract Stability classification is explicit. Agent credential lifecycle is an
# adapter-facing Candidate Public Identity surface; Core-only Agent introspection is
# Candidate Internal. The existing Stable Service-token introspection lock remains
# exactly one operation and therefore preserves its stable group digest.
baseline_path = ROOT / "docs/contract-stability-baseline.json"
baseline = json.loads(baseline_path.read_text())
identity = next(source for source in baseline["contractSources"] if source["id"] == "identity-application")
agent_group = next(group for group in identity["groups"] if group["id"] == "identity-agent-execution")
agent_group["operationPattern"] = (
    r"^(GET|POST) /internal/v1/agents$|^POST /internal/v1/agent-execution-tokens$|"
    r"^(GET|POST) /internal/v1/agents/\{agentId\}/api-credentials$|"
    r"^(PATCH|DELETE) /internal/v1/agents/\{agentId\}/api-credentials/\{credentialId\}$"
)
core_introspection = next(group for group in identity["groups"] if group["id"] == "identity-core-introspection")
core_introspection["operationPattern"] = r"^POST /introspection/v1/service-tokens$"
if not any(group["id"] == "identity-agent-credential-introspection" for group in identity["groups"]):
    index = identity["groups"].index(core_introspection) + 1
    identity["groups"].insert(index, {
        "id": "identity-agent-credential-introspection",
        "maturity": "candidate",
        "visibility": "internal",
        "operationPattern": r"^POST /introspection/v1/agent-credentials$",
    })

# Mirror check-contract-stability's YAML operation extraction to initialize only the
# source-level operation-set digest. Stable group digests are intentionally untouched.
lines = (ROOT / identity["source"]).read_text().splitlines()
paths_index = lines.index("paths:")
ops = []
current_path = None
for line in lines[paths_index + 1:]:
    if re.match(r"^[A-Za-z0-9_-]+:\s*$", line):
        break
    match = re.match(r"^  (/.*):\s*$", line)
    if match:
        current_path = match.group(1)
        continue
    match = re.match(r"^    (get|post|put|patch|delete|options|head|trace):\s*$", line, re.I)
    if match and current_path:
        ops.append(f"{match.group(1).upper()} {current_path}")
ops = sorted(set(ops))
identity["operationSetSha256"] = "sha256:" + hashlib.sha256("\n".join(ops).encode()).hexdigest()
baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n")

print("Aligned versions, bearer formats, and explicit Agent credential contract classifications")
