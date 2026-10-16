import { readFileSync, writeFileSync } from "node:fs";

function replaceExact(path, before, after) {
  const current = readFileSync(path, "utf8");
  if (!current.includes(before)) {
    throw new Error(`Expected text not found in ${path}: ${before.slice(0, 120)}`);
  }
  const next = current.replace(before, after);
  if (next === current) throw new Error(`No change produced for ${path}`);
  writeFileSync(path, next);
}

replaceExact(
  "apps/core/src/external-runtime.ts",
  `  return {\n    id: r.id,\n    spaceId: m.space_id,\n    modelKey: externalBusinessKey(m),\n    origin: "external",\n    schemaHash: m.schema_hash,\n    ...normalizedData,`,
  `  return {\n    id: r.id,\n    spaceId: m.space_id,\n    modelKey: externalBusinessKey(m),\n    ...normalizedData,`,
);

replaceExact(
  "apps/core/src/external-batch.ts",
  `    const bulkId = "ebl_" + crypto.randomUUID().replaceAll("-", "");`,
  `    const bulkId = "blk_" + crypto.randomUUID().replaceAll("-", "");`,
);

replaceExact(
  "apps/core/external-model.openapi.yaml",
  `    "version": "0.4.0",`,
  `    "version": "0.5.0",`,
);
replaceExact(
  "apps/core/external-model.openapi.yaml",
  `        "required": ["id", "spaceId", "modelKey", "origin", "schemaHash"],\n        "properties": { "id": { "type": "string" }, "spaceId": { "type": "string" }, "modelKey": { "type": "string" }, "origin": { "const": "external" }, "schemaHash": { "type": "string" }, "createdAt": { "type": "string" }, "updatedAt": { "type": "string" } },\n        "additionalProperties": true,\n        "description": "Flattened fields are constrained by the current compatible External Model snapshot. No Native version or audit fields are fabricated."`,
  `        "required": ["id", "spaceId", "modelKey"],\n        "properties": { "id": { "type": "string" }, "spaceId": { "type": "string" }, "modelKey": { "type": "string" }, "createdAt": { "type": "string" }, "updatedAt": { "type": "string" } },\n        "additionalProperties": true,\n        "description": "Flattened fields are constrained by the current compatible External Model snapshot. Provider/storage identity metadata such as origin and schemaHash belongs to Discovery/configuration, not ordinary record responses. No Native version or audit fields are fabricated."`,
);

replaceExact(
  "apps/core/scripts/check-external-model-contract.mjs",
  `assert.equal(api.info.version, "0.4.0");`,
  `assert.equal(api.info.version, "0.5.0");`,
);
replaceExact(
  "apps/core/scripts/check-external-model-contract.mjs",
  `assert(!api.components.schemas.DynamicRecord.properties.version);`,
  `assert(!api.components.schemas.DynamicRecord.properties.version);\nassert(!api.components.schemas.DynamicRecord.properties.origin);\nassert(!api.components.schemas.DynamicRecord.properties.schemaHash);\nassert.deepEqual(api.components.schemas.DynamicRecord.required, ["id", "spaceId", "modelKey"]);`,
);

replaceExact(
  "apps/core/test/external-model.integration.test.ts",
  `    expect(record.modelKey).toBe("external_document_test"); expect(record.version).toBeUndefined();\n    f.state.calls = [];`,
  `    expect(record.modelKey).toBe("external_document_test");\n    expect(record.origin).toBeUndefined();\n    expect(record.schemaHash).toBeUndefined();\n    expect(record.version).toBeUndefined();\n    const queried = await f.request(\`${'${f.path}'}/query\`, "POST", {});\n    expect(queried.status).toBe(200);\n    const queriedRecord = (await queried.json<any>()).data.items[0];\n    expect(queriedRecord.origin).toBeUndefined();\n    expect(queriedRecord.schemaHash).toBeUndefined();\n    f.state.calls = [];`,
);
replaceExact(
  "apps/core/test/external-model.integration.test.ts",
  `    expect(result.status).toBe(200); expect((await result.json<any>()).data.items[0].status).toBe("succeeded"); expect(f.state.calls).toEqual(["create"]);`,
  `    expect(result.status).toBe(200);\n    const bulk = (await result.json<any>()).data;\n    expect(bulk.bulkId).toMatch(/^blk_/);\n    expect(bulk.items[0].status).toBe("succeeded");\n    expect(f.state.calls).toEqual(["create"]);`,
);
replaceExact(
  "apps/core/test/external-model.integration.test.ts",
  `    const edge = (await hydrated.json<any>()).data; expect(edge.targetRecord.origin).toBe("external"); expect(edge.targetRecord.version).toBeUndefined();`,
  `    const edge = (await hydrated.json<any>()).data;\n    expect(edge.targetRecord.origin).toBeUndefined();\n    expect(edge.targetRecord.schemaHash).toBeUndefined();\n    expect(edge.targetRecord.version).toBeUndefined();`,
);
replaceExact(
  "apps/core/test/external-model.integration.test.ts",
  `    await reconcileExternalModels(f.bindings);\n    expect(f.state.calls).toEqual(["discover"]);\n    const plan = await f.db.prepare("EXPLAIN QUERY PLAN SELECT space_id,model_key FROM external_models m WHERE status!='disabled' AND next_refresh_at IS NOT NULL AND next_refresh_at<=? AND EXISTS(SELECT 1 FROM external_sources s WHERE s.id=m.source_id AND s.status='active') AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=m.space_id AND s.deleted_at IS NULL) ORDER BY next_refresh_at,model_key LIMIT 20").bind(new Date().toISOString()).all<any>();`,
  `    await reconcileExternalModels(f.bindings);\n    // Identity observation shares the scheduler but is an independent queue; this test\n    // asserts only that the due schema binding is discovered exactly once.\n    expect(f.state.calls.filter(call => call === "discover")).toEqual(["discover"]);\n    const plan = await f.db.prepare("EXPLAIN QUERY PLAN SELECT space_id,model_key FROM external_models m WHERE status!='disabled' AND next_refresh_at IS NOT NULL AND next_refresh_at<=? AND EXISTS(SELECT 1 FROM external_sources s WHERE s.id=m.source_id AND s.status='active') AND EXISTS(SELECT 1 FROM spaces s WHERE s.id=m.space_id AND s.deleted_at IS NULL) ORDER BY next_refresh_at,model_key LIMIT 20").bind(new Date().toISOString()).all<any>();`,
);
replaceExact(
  "apps/core/test/external-model.integration.test.ts",
  `    expect(data.origin).toBe("external");\n    expect(data.version).toBeUndefined();`,
  `    expect(data.origin).toBeUndefined();\n    expect(data.schemaHash).toBeUndefined();\n    expect(data.version).toBeUndefined();`,
);

replaceExact(
  "docs/external-models.md",
  `Read/query/write use the same \`/models/{modelKey}/records\` paths. Response is an External envelope (\`id,spaceId,modelKey,origin,schemaHash,data fields,provider timestamps\`); it omits fabricated version/createdBy/updatedBy. Query pushes a declared typed subset to the Provider and rejects unsupported operators/values. No unbounded scans. Opaque authenticated cursor binds Space/model/schema/query/provider continuation. Pagination is live, not a snapshot; Provider sorting/null placement/tie behavior is explicitly Provider-defined rather than Native-guaranteed.`,
  `Read/query/write use the same \`/models/{modelKey}/records\` paths. Ordinary record responses use the same public record identity envelope as Native where the Provider can support it honestly: \`id,spaceId,modelKey\`, flattened canonical fields, and real Provider timestamps when available. Provider/storage identity metadata such as \`origin\` and \`schemaHash\` is confined to Discovery/configuration/internal execution and is not returned on ordinary CRUD/Query records; Native-only \`modelVersion/version/createdBy/updatedBy\` is never fabricated. Query pushes a declared typed subset to the Provider and rejects unsupported operators/values. No unbounded scans. Opaque authenticated cursor binds Space/model/schema/query/provider continuation internally. Pagination is live, not a snapshot; Provider sorting/null placement/tie behavior is explicitly Provider-defined rather than Native-guaranteed.`,
);

replaceExact(
  "docs/contracts.md",
  `\`apps/core/external-model.openapi.yaml\` 0.4.0 owns provider-neutral External model binding/runtime representation`,
  `\`apps/core/external-model.openapi.yaml\` 0.5.0 owns provider-neutral External model binding/runtime representation`,
);
replaceExact(
  "apps/core/AGENTS.md",
  `current External Model version: 0.4.0`,
  `current External Model version: 0.5.0`,
);

const runtime = readFileSync("apps/core/src/external-runtime.ts", "utf8");
if (runtime.includes(`modelKey: externalBusinessKey(m),\n    origin: "external",\n    schemaHash: m.schema_hash`)) {
  throw new Error("External record DTO still leaks origin/schemaHash");
}
const batch = readFileSync("apps/core/src/external-batch.ts", "utf8");
if (batch.includes('const bulkId = "ebl_"')) throw new Error("External bulk still uses ebl_ prefix");
if (!batch.includes('const bulkId = "blk_"')) throw new Error("External bulk blk_ correlation missing");

console.log("External runtime envelope and bulk correlation patch applied.");
