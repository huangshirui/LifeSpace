import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildStablePublicSchemaBaseline,
  compareStablePublicBaselines,
  parseContractDocument,
} from "./stable-contract-compatibility.mjs";

const root = resolve(import.meta.dirname, "../../..");
const classificationPath = resolve(root, "docs/contract-stability-baseline.json");
const acceptedPath = resolve(root, "docs/stable-public-schema-baseline.json");

const classification = JSON.parse(await readFile(classificationPath, "utf8"));
const documentsBySource = {};
for (const source of classification.contractSources ?? []) {
  documentsBySource[source.source] = parseContractDocument(
    await readFile(resolve(root, source.source), "utf8"),
  );
}

const current = buildStablePublicSchemaBaseline(classification, documentsBySource);

if (process.argv.includes("--write")) {
  await writeFile(acceptedPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(`[stable-schema] wrote ${Object.keys(current.operations).length} Stable Public operation snapshots to docs/stable-public-schema-baseline.json`);
  process.exit(0);
}

let accepted;
try {
  accepted = JSON.parse(await readFile(acceptedPath, "utf8"));
} catch (error) {
  throw new Error(`[stable-schema] accepted baseline is missing or invalid; run pnpm --filter @lifespace/core stable-contract:baseline after review: ${error instanceof Error ? error.message : String(error)}`);
}

const errors = compareStablePublicBaselines(accepted, current);
console.log(`[stable-schema] checked ${Object.keys(current.operations).length} Stable Public operations across ${current.classifiedGroups.length} representation groups`);
if (errors.length > 0) {
  throw new Error(`[stable-schema] backward compatibility check failed:\n- ${errors.join("\n- ")}\nStable Public breaking changes require explicit deprecation/migration rather than refreshing this baseline.`);
}
console.log("[stable-schema] backward compatibility verified");
