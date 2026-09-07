import assert from "node:assert/strict";
import { test } from "node:test";
import { validateModelDefinitionConformance } from "./check-model-definition-conformance.mjs";

const SPEC = `
Conformance-ID: MDV1-FIELD-TYPES-01
Conformance-ID: MDV1-DEFAULTS-01
`;

const ORACLE = `
// Oracle-Fixture: ORC-FIELD-CORE-01
// Covers: MDV1-FIELD-TYPES-01, MDV1-DEFAULTS-01
`;

function errors(spec = SPEC, oracle = ORACLE) {
  return validateModelDefinitionConformance(spec, [{ path: "oracle.test.ts", text: oracle }]).errors;
}

test("accepts exact normative-to-Oracle coverage", () => {
  assert.deepEqual(errors(), []);
});

test("rejects uncovered normative IDs", () => {
  const result = errors(SPEC, `// Oracle-Fixture: ORC-FIELD-CORE-01\n// Covers: MDV1-FIELD-TYPES-01`);
  assert(result.some((error) => error.includes("MDV1-DEFAULTS-01")));
});

test("rejects unknown Oracle coverage IDs", () => {
  const result = errors(SPEC, `// Oracle-Fixture: ORC-FIELD-CORE-01\n// Covers: MDV1-FIELD-TYPES-01, MDV1-UNKNOWN-01`);
  assert(result.some((error) => error.includes("unknown Conformance-ID MDV1-UNKNOWN-01")));
});

test("rejects malformed and duplicate normative IDs", () => {
  const malformed = errors(`Conformance-ID: mdv1-bad\n${SPEC}`, ORACLE);
  assert(malformed.some((error) => error.includes("Malformed Conformance-ID")));

  const duplicate = errors(`${SPEC}\nConformance-ID: MDV1-FIELD-TYPES-01`, ORACLE);
  assert(duplicate.some((error) => error.includes("Duplicate normative Conformance-ID")));
});

test("rejects malformed and duplicate Oracle fixture ids", () => {
  const malformed = errors(SPEC, `// Oracle-Fixture: bad-id\n// Covers: MDV1-FIELD-TYPES-01, MDV1-DEFAULTS-01`);
  assert(malformed.some((error) => error.includes("Malformed Oracle-Fixture")));

  const duplicate = errors(SPEC, `${ORACLE}\n${ORACLE}`);
  assert(duplicate.some((error) => error.includes("Duplicate Oracle fixture id")));
});

test("rejects invalid Oracle fixture metadata shape", () => {
  const result = errors(SPEC, `// Oracle-Fixture: ORC-FIELD-CORE-01\nconst missingCovers = true;`);
  assert(result.some((error) => error.includes("must be followed by // Covers")));
});
