from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def replace(path: str, old: str, new: str) -> None:
    p = ROOT / path
    text = p.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected 1 match, got {count}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))

# README: current authentication and contract inventory.
replace("README.md",
        "Opaque revocable `lsp_svc_*` Service API Token (legacy `lsp_svc_*` remains accepted until rotate/revoke)",
        "Opaque revocable `lsp_svc_*` Service API Token (legacy `lsp_pat_*` remains accepted until rotate/revoke)")
replace("README.md",
        "| Agent execution | Application-authenticated short-lived Core-only Agent execution token; direct Agent uses its own Authority, represented Agent additionally requires current Delegation |",
        "| Agent execution / adapters / n8n | Opaque revocable `lsp_agt_*` Agent API credential; direct mode uses Agent Authority, User/Agent mode additionally supplies an explicit current `dlg_*` |")
replace("README.md",
        "The current repository Core Kernel contract is **0.43.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel 0.43.0 includes the generalized Authority v3 foundation plus bounded atomic 1..20 multi-Delegation issuance; every issued `dlg_*` remains an independent single-scope object. Production availability remains separately frozen under `docs/production/*`.",
        "The current repository Core Kernel contract is **0.44.0**. Ordinary business-model routes remain outside the Kernel OpenAPI and are pinned through immutable `mct_*` Model Contract revisions. Kernel 0.44.0 accepts first-class opaque `lsp_agt_*` Agent API credentials while keeping business Authority in current Data Grants/Delegations; represented execution resolves only `Principal=User / Actor=Agent` from an explicit `dlg_*`. Production availability remains separately frozen under `docs/production/*`.")
replace("README.md",
        "The current repository Identity Application Contract is **0.7.0**. It preserves the legacy delegated-Agent token request and adds generalized short-lived `purpose=agent_execution` Core-only credentials where the actual Agent Actor is authenticated independently from the signed Principal operation role. Identity verifies entity/application identity; Core remains authoritative for current Data Grant, Delegation-chain, Space/model authorization and governed Change semantics. The Access architecture also includes:",
        "The current repository Identity Application Contract is **0.10.0**. It adds first-class revocable opaque `lsp_agt_*` Agent API credentials bound to one active Application + Agent Actor; credential possession itself grants no Space/model/User Authority. Identity verifies credential, Agent and Application current state; Core remains authoritative for current Data Grant, Delegation-chain, Space/model authorization and governed Change semantics. The Access architecture also includes:")

# Contract strategy: top release note and current Kernel contract must agree with source.
replace("docs/contracts.md",
        "New opaque Service API Tokens are represented as `lsp_svc_*`. Existing `lsp_pat_*` tokens remain compatibility inputs and continue through the identical current-state introspection/revocation path until individually rotated or revoked. Service Principal identity, token-hash storage, scope ceilings, Data Grants, Application × Model Access and Core authorization semantics are unchanged.",
        "Identity 0.10.0 adds revocable opaque `lsp_agt_*` Agent API credentials bound to Application + Agent Actor. Credential possession grants no Space/model/User Authority: direct execution remains `Principal=Agent / Actor=Agent`, while represented execution requires an explicit current `dlg_*` and resolves only `Principal=User / Actor=Agent`. Platform Admin 0.4.0 adds create/list/reduce/revoke governance for the same credential lifecycle; one-time plaintext remains write-only. Canonical Service API Tokens remain `lsp_svc_*`, with legacy `lsp_pat_*` accepted only as migration input until rotate/revoke.")
replace("docs/contracts.md",
        "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.43.0` includes the generalized Authority v3 Root/Child Delegation model and adds bounded atomic `1..20` multi-Delegation issuance for one confirmed business intent.",
        "The checked-in contract is `apps/core/openapi.yaml`; Kernel `0.44.0` adds first-class opaque Agent API credential authentication on top of the generalized Authority v3 Root/Child Delegation model and bounded atomic `1..20` multi-Delegation issuance.")

# Console current-state docs: include Agent credentials in the same secure reveal/governance boundary.
replace("apps/console/README.md",
        "  Create / reduce / update / revoke Service API Token\n",
        "  Create / reduce / update / revoke Service API Token\n  Create / list / reduce / revoke Agent API credential\n")
replace("apps/console/README.md",
        "Newly issued **target** Application credentials and Service API Tokens use the separately documented operator reveal boundary",
        "Newly issued **target** Application credentials, Service API Tokens and Agent API credentials use the separately documented operator reveal boundary")

replace("docs/console-target-credential-reveal.md",
        "LifeSpace Console may present the plaintext of a **newly created target Application credential or Service API Token**",
        "LifeSpace Console may present the plaintext of a **newly created target Application credential, Service API Token or Agent API credential**")
replace("docs/console-target-credential-reveal.md",
        "Identity correctly returns newly created `lsa_*` and `lsp_svc_*` plaintext exactly once.",
        "Identity correctly returns newly created `lsa_*`, `lsp_svc_*` and `lsp_agt_*` plaintext exactly once.")
replace("docs/console-target-credential-reveal.md",
        "staging lifecycle acceptance proving generated Application credential / Service API Token plaintext does not appear in metadata or platform-admin audit.",
        "staging lifecycle acceptance proving generated Application credential / Service API Token / Agent API credential plaintext does not appear in metadata or platform-admin audit.")

# This is a historical MVP chronology page; #307 does not rewrite its old release vocabulary.
subprocess.run(["git", "checkout", "origin/main", "--", "docs/lifespace-console-mvp.md"], cwd=ROOT, check=True)

print("#307 documentation drift cleanup applied")
