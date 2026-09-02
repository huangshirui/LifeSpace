import fs from "node:fs";
import YAML from "yaml";

const document = YAML.parse(fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8"));
const declared = JSON.parse(fs.readFileSync(new URL("../kernel-space-route-segments.json", import.meta.url), "utf8"));

if (!Array.isArray(declared) || declared.some((segment) => typeof segment !== "string" || !segment)) {
  throw new Error("Kernel Space route namespace manifest must be a non-empty string array");
}
if (new Set(declared).size !== declared.length) {
  throw new Error("Kernel Space route namespace manifest must not contain duplicates");
}

const prefix = "/api/v1/spaces/{spaceId}/";
const contractSegments = [...new Set(
  Object.keys(document.paths ?? {})
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length).split("/")[0])
    .filter(Boolean),
)].sort();
const declaredSegments = [...declared].sort();

if (JSON.stringify(contractSegments) !== JSON.stringify(declaredSegments)) {
  const missing = contractSegments.filter((segment) => !declaredSegments.includes(segment));
  const stale = declaredSegments.filter((segment) => !contractSegments.includes(segment));
  throw new Error(
    `Kernel Space route namespace drifted from Core OpenAPI; add=${JSON.stringify(missing)} remove=${JSON.stringify(stale)}`,
  );
}

console.log(JSON.stringify({ ok: true, kernelSpaceRouteSegments: declaredSegments }, null, 2));
