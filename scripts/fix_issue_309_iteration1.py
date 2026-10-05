from pathlib import Path
import json

ROOT = Path('.')

def read(path):
    return (ROOT / path).read_text()

def write(path, content):
    (ROOT / path).write_text(content)

def replace_once(path, old, new):
    s = read(path)
    if s.count(old) != 1:
        raise SystemExit(f'{path}: expected one marker {old!r}, got {s.count(old)}')
    write(path, s.replace(old, new, 1))

# Keep the runtime/OpenAPI/status contract invariant exact.
spec_path = ROOT / 'apps/core/openapi.yaml'
spec = json.loads(spec_path.read_text())
spec['info']['version'] = '0.46.0'
status_contract = spec['components']['schemas']['StatusResponse']['properties']['data']['properties']['contractVersion']
status_contract.clear()
status_contract['const'] = '0.46.0'
spec_path.write_text(json.dumps(spec, ensure_ascii=False, separators=(',', ':')) + '\n')

replace_once(
    'apps/core/scripts/check-openapi.mjs',
    'document.info?.version !== "0.45.0"',
    'document.info?.version !== "0.46.0"',
)
replace_once(
    'apps/core/AGENTS.md',
    'current Kernel version: 0.45.0',
    'current Kernel version: 0.46.0',
)

# Preserve 0.45 history while documenting the new contract surface.
contracts = read('docs/contracts.md')
anchor = '- Kernel 0.45.0 adds transport-independent `arq_*` Authorization Request lifecycle endpoints.'
if anchor not in contracts:
    raise SystemExit('docs/contracts.md: 0.45 authorization-request anchor missing')
line_end = contracts.index('\n', contracts.index(anchor))
insert = '\n- Kernel 0.46.0 adds first-class non-atomic ordinary-model Bulk mutation through generated Model Contracts. `/models/bulk` is a bounded 1..20 transport/performance grouping with independent per-item results and `blk_*` correlation; existing `/models/batch` remains atomic `cgs_*` ChangeSet semantics.'
contracts = contracts[:line_end] + insert + contracts[line_end:]
write('docs/contracts.md', contracts)

# The caller already creates the durable Bulk row before entering the single-use
# contention fallback. Remove an earlier placeholder no-op insert.
bulk_path = 'apps/core/src/generic-bulk-routes.ts'
bulk = read(bulk_path)
placeholder = '''  await env.DB.prepare(`INSERT INTO resource_bulk_requests(\n    id,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at\n  ) SELECT ?,space_id,application_id,principal_type,principal_id,actor_type,actor_id,operation_count,occurred_at\n    FROM resource_bulk_requests WHERE 0`).run().catch(() => undefined);\n'''
if placeholder not in bulk:
    raise SystemExit('generic-bulk-routes.ts: fallback placeholder missing')
bulk = bulk.replace(placeholder, '', 1)
write(bulk_path, bulk)
