import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
const doc=parse(readFileSync(new URL("../mcp-operations.openapi.yaml",import.meta.url),"utf8"));
assert.equal(doc.openapi,"3.1.0");
assert.equal(doc.info.version,"0.3.0");
const get=doc.paths["/api/v1/spaces/{spaceId}/_discovery/operations"].get;
assert.deepEqual(get.parameters.filter(p=>p.in==="query").map(p=>p.name),["modelKey","operation"]);
for(const p of get.parameters.filter(p=>p.in==="query")) {
  assert.equal(p.required,false);
  assert.ok(new RegExp(p.schema.pattern).test(p.name==="modelKey"?"task":"action:complete"));
}
assert.ok(get.responses["400"]);
const descriptor=doc.components.schemas.OperationDescriptor;
assert.deepEqual(Object.keys(descriptor.properties).sort(),[...descriptor.required].sort());
assert.ok(new RegExp(descriptor.properties.operationRef.pattern).test("op_"+"a".repeat(64)));
assert.ok(doc.paths["/api/v1/spaces/{spaceId}/_operations/{operationRef}/invoke"].post);
console.log("Generic Operations OpenAPI syntax and target projection checks passed");
