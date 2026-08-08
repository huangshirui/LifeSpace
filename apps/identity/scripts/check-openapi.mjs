import fs from "node:fs";
import YAML from "yaml";

const doc = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
if (doc.openapi !== "3.1.0" || doc.info?.version !== "0.1.1") {
  throw new Error("Identity OpenAPI version metadata is invalid");
}

for (const path of [
  "/health",
  "/api/v1/status",
  "/bootstrap/v1/applications",
  "/internal/v1/users",
  "/internal/v1/tokens",
]) {
  if (!doc.paths?.[path]) throw new Error(`Identity OpenAPI missing ${path}`);
}

if (doc.paths?.["/internal/v1/external-identities"]) {
  throw new Error("Application-owned external identity mappings must not be exposed by LifeSpace Identity");
}

console.log("Identity OpenAPI contract sanity check passed");
