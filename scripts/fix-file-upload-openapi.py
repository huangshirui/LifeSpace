from pathlib import Path
import json

path = Path("apps/core/openapi.yaml")
api = json.loads(path.read_text())
api["info"]["version"] = "0.53.0"
api["components"]["schemas"]["StatusResponse"]["properties"]["data"]["properties"]["contractVersion"]["const"] = "0.53.0"
path.write_text(json.dumps(api, separators=(",", ":")) + "\n")
