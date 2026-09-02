import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import YAML from "yaml";

if (process.env.GITHUB_ACTIONS !== "true") {
  console.log("OpenAPI base diff audit skipped outside GitHub Actions");
  process.exit(0);
}

execFileSync("git", ["fetch", "--quiet", "--depth=1", "origin", "main"], { stdio: "inherit" });
const baseText = execFileSync("git", ["show", "FETCH_HEAD:apps/core/openapi.yaml"], { encoding: "utf8" });
const currentText = fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const base = YAML.parse(baseText);
const current = YAML.parse(currentText);

current.info.version = base.info.version;
current.components.schemas.StatusResponse.properties.data.properties.contractVersion.const =
  base.components.schemas.StatusResponse.properties.data.properties.contractVersion.const;

const model = current.components.schemas.RuntimeDiscoveryModel;
delete model.properties.defaults;
model.required = model.required.filter((key) => key !== "defaults");

try {
  assert.deepStrictEqual(current, base);
  console.log("Temporary OpenAPI base semantic diff audit passed");
} catch (error) {
  console.error("Unexpected Kernel OpenAPI semantic drift beyond 0.19.0 defaults change");
  throw error;
}
