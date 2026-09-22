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

const errors = compareStablePublicBaselines(accepted, current);
console.log(`[stable-schema] checked ${Object.keys(current.operations).length} Stable Public operations across ${current.classifiedGroups.length} representation groups`);
if (errors.length > 0) {
  throw new Error(`[stable-schema] backward compatibility check failed:\n- ${errors.join("\n- ")}\nStable Public breaking changes require explicit deprecation/migration rather than refreshing this baseline.`);
}
console.log("[stable-schema] backward compatibility verified");
