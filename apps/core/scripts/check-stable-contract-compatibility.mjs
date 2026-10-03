import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  buildStablePublicSchemaBaseline,
  compareStablePublicBaselines,
  parseContractDocument,
} from "./stable-contract-compatibility.mjs";

const root = resolve(import.meta.dirname, "../../..");
const classificationPath = resolve(root, "docs/contract-stability-baseline.json");
const acceptedPath = resolve(root, "docs/stable-public-schema-baseline.json.gz.b64");
const agentGrantDecisionPath = resolve(root, "docs/decisions/2026-10-03-agent-grantee-stable-contract.md");

const classification = JSON.parse(await readFile(classificationPath, "utf8"));
const documentsBySource = {};
for (const source of classification.contractSources ?? []) {
  documentsBySource[source.source] = parseContractDocument(
    await readFile(resolve(root, source.source), "utf8"),
  );
}

const current = buildStablePublicSchemaBaseline(classification, documentsBySource);

const encodedCurrent = () => gzipSync(
  Buffer.from(`${JSON.stringify(current, null, 2)}\n`, "utf8"),
  { level: 9 },
).toString("base64");

if (process.argv.includes("--write")) {
  await writeFile(acceptedPath, `${encodedCurrent()}\n`, "utf8");
  console.log(`[stable-schema] wrote ${Object.keys(current.operations).length} Stable Public operation snapshots to docs/stable-public-schema-baseline.json.gz.b64`);
  process.exit(0);
}

let accepted;
try {
  const encoded = (await readFile(acceptedPath, "utf8")).trim();
  accepted = JSON.parse(gunzipSync(Buffer.from(encoded, "base64")).toString("utf8"));
} catch (error) {
  throw new Error(`[stable-schema] accepted baseline is missing or invalid; run pnpm --filter @lifespace/core stable-contract:baseline after review: ${error instanceof Error ? error.message : String(error)}`);
}

if (process.argv.includes("--print-accepted")) {
  console.log(JSON.stringify(accepted, null, 2));
  process.exit(0);
}

let errors = compareStablePublicBaselines(accepted, current);
console.log(`[stable-schema] checked ${Object.keys(current.operations).length} Stable Public operations across ${current.classifiedGroups.length} representation groups`);

// Kernel 0.41.0 intentionally widens Stable/Public Data Grant granteeType responses
// with `agent`. Keep the ordinary accepted baseline unchanged while the rest of
// the implementation is being proven, but allow only this reviewed migration and
// only when the explicit accepted decision is present. Before 0.41.0 is finalized,
// the baseline is regenerated and this temporary migration gate is removed.
if (documentsBySource["apps/core/openapi.yaml"]?.info?.version === "0.41.0") {
  const decision = await readFile(agentGrantDecisionPath, "utf8").catch(() => "");
  if (!decision.includes("Status: **Accepted**")) {
    throw new Error("Kernel 0.41.0 Agent Data Grant enum migration requires an accepted decision record");
  }
  const acceptedAgentGrantErrors = new Set([
    'core-kernel::GET /api/v1/spaces/{spaceId}/grants.responses.200.application/json.properties.data.items.properties.granteeType: response enum added unsupported value "agent"',
    'core-kernel::PATCH /api/v1/spaces/{spaceId}/grants/{grantId}.responses.200.application/json.properties.data.properties.granteeType: response enum added unsupported value "agent"',
    'core-kernel::POST /api/v1/spaces/{spaceId}/grants.responses.201.application/json.properties.data.properties.granteeType: response enum added unsupported value "agent"',
  ]);
  const acceptedCount = errors.filter((error) => acceptedAgentGrantErrors.has(error)).length;
  if (acceptedCount > 0) {
    console.log(`[stable-schema] temporarily accepted ${acceptedCount} reviewed Agent Data Grant enum migration delta(s) for Kernel 0.41.0`);
    errors = errors.filter((error) => !acceptedAgentGrantErrors.has(error));
  }
}

if (errors.length > 0) {
  throw new Error(`[stable-schema] backward compatibility check failed:\n- ${errors.join("\n- ")}\nStable Public breaking changes require explicit deprecation/migration rather than refreshing this baseline.`);
}
console.log("[stable-schema] backward compatibility verified");
