import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const file = new URL("../unified-connection.contract.json", import.meta.url);
const doc = new URL("../../../docs/unified-connections.md", import.meta.url);
const schema = JSON.parse(readFileSync(file, "utf8"));
const guide = readFileSync(doc, "utf8");

assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
assert.equal(schema.type, "object");
assert.equal(schema.additionalProperties, false);
assert.deepEqual(schema.properties.kind.enum, ["agent", "service", "event_push", "external_data"]);
assert.deepEqual(schema.properties.status.enum, ["pending", "active", "disabled", "revoked"]);

for (const field of ["connectionId", "applicationId", "spaceId", "kind", "name", "status", "owner"]) {
  assert(schema.required.includes(field), "required metadata missing: " + field);
}
assert.equal(schema.properties.connectionId.pattern, "^conn_[A-Za-z0-9_-]+$");
assert.equal(schema.properties.spaceId.pattern, "^spc_[A-Za-z0-9_-]+$");
assert.equal(schema.properties.name.type, "string");
assert.equal(schema.properties.note.type, "string");
assert(!schema.required.includes("note"), "note must remain optional");
assert(schema.properties.note.maxLength > 0);

// Secrets and grants are never duplicated into a generic Connection metadata payload.
for (const forbidden of [
  "credential", "credentials", "credentialRef", "credentialSecret",
  "signingSecret", "token", "accessToken", "dataGrants", "delegations",
]) {
  assert(!Object.hasOwn(schema.properties, forbidden), "unapproved metadata field: " + forbidden);
}

const branches = schema.allOf ?? [];
const getBranch = kind => branches.find(x =>
  x.if?.properties?.kind?.const === kind ||
  x.if?.properties?.kind?.enum?.includes(kind)
);
for (const [kind, type, prefix] of [["agent", "agent", "^agt_"], ["service", "service", "^svc_"]]) {
  const branch = getBranch(kind);
  assert(branch, "missing dedicated identity condition: " + kind);
  assert(!branch.then.required?.includes("identity"), "pending connections may await identity provisioning");
  assert.equal(branch.then.properties.identity.properties.type.const, type);
  assert(branch.then.properties.identity.properties.id.pattern.startsWith(prefix));
}
const activeIdentity = branches.find(x =>
  x.if?.properties?.status?.const === "active" && x.if?.properties?.kind?.enum?.includes("agent"));
assert(activeIdentity?.then?.required?.includes("identity"),
  "active Agent/Service connections must have a dedicated identity");

for (const kind of ["event_push", "external_data"]) {
  assert(getBranch(kind)?.then?.not?.required?.includes("identity"), "non-identity kind must not expose dedicated identity: " + kind);
}

// These words are the safety-sensitive boundaries this planned contract must preserve.
for (const invariant of [
  "not implemented or deployed", "LifeSpace Core", "Cloudflare Managed OAuth",
  "nonsecret locator", "Agent Direct", "Delegation", "cnx_*",
  "Staging POC", "No compatibility layer",
]) {
  assert(guide.toLowerCase().includes(invariant.toLowerCase()), "documentation invariant missing: " + invariant);
}

console.log("Draft unified Connection metadata contract invariants passed (design only, no runtime APIs)");
