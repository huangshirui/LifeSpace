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

function kind(value) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function differences(expected, actual, path = "$") {
  if (Object.is(expected, actual)) return [];
  const expectedKind = kind(expected);
  const actualKind = kind(actual);
  if (expectedKind !== actualKind) return [`${path}: kind ${expectedKind} -> ${actualKind}`];
  if (expectedKind === "array") {
    const result = [];
    const max = Math.max(expected.length, actual.length);
    for (let index = 0; index < max; index += 1) {
      if (index >= expected.length) result.push(`${path}[${index}]: unexpected ${JSON.stringify(actual[index])}`);
      else if (index >= actual.length) result.push(`${path}[${index}]: missing ${JSON.stringify(expected[index])}`);
      else result.push(...differences(expected[index], actual[index], `${path}[${index}]`));
    }
    return result;
  }
  if (expectedKind === "object") {
    const result = [];
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    for (const key of keys) {
      const nextPath = `${path}.${key}`;
      if (!Object.prototype.hasOwnProperty.call(actual, key)) result.push(`${nextPath}: missing ${JSON.stringify(expected[key])}`);
      else if (!Object.prototype.hasOwnProperty.call(expected, key)) result.push(`${nextPath}: unexpected ${JSON.stringify(actual[key])}`);
      else result.push(...differences(expected[key], actual[key], nextPath));
    }
    return result;
  }
  return [`${path}: ${JSON.stringify(expected)} -> ${JSON.stringify(actual)}`];
}

const drift = differences(base, current);
if (drift.length) {
  console.error("Unexpected Kernel OpenAPI semantic drift beyond 0.19.0 defaults change:");
  for (const entry of drift.slice(0, 100)) console.error(`- ${entry}`);
  if (drift.length > 100) console.error(`- ... ${drift.length - 100} more differences`);
  throw new Error(`Kernel OpenAPI contains ${drift.length} unexpected semantic difference(s)`);
}

console.log("Temporary OpenAPI base semantic diff audit passed");
