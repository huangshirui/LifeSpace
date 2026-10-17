from pathlib import Path
import json

path = Path("apps/core/openapi.yaml")
api = json.loads(path.read_text())
api["info"]["version"] = "0.53.0"
api["components"]["schemas"]["StatusResponse"]["properties"]["data"]["properties"]["contractVersion"]["const"] = "0.53.0"
path.write_text(json.dumps(api, separators=(",", ":")) + "\n")

check_path = Path("apps/core/scripts/check-external-model-contract.mjs")
check = check_path.read_text()
check = check.replace('assert.equal(api.info.version, "0.5.0");', 'assert.equal(api.info.version, "0.6.0");')
check = check.replace('["connection", "discover", "get", "query", "create", "update", "delete"]', '["connection", "discover", "get", "query", "create", "update", "delete", "upload"]')
check_path.write_text(check)
