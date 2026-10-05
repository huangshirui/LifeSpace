from pathlib import Path

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
path.write_text(text.replace(old, new, 1))

print("Aligned Core status contract version and preserved Service/Agent bearer formats")
