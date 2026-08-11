import { readFile, writeFile } from "node:fs/promises";

const file = "infra/scripts/phase2-profile-assets-patch.mjs";
let source = await readFile(file, "utf8");
const needle = `await replaceOnce(\n  openapi,\n  "        timezone: { $ref: \\\"#/components/schemas/IanaTimezone\\\" }\\n        version: { type: integer, minimum: 1 }",`;
const start = source.indexOf(needle);
if (start < 0) throw new Error("OpenAPI Space avatar patch target was not found in finalizer");
if (source.indexOf(needle, start + needle.length) >= 0) throw new Error("OpenAPI Space avatar finalizer target is not unique");
const endMarker = "\n);";
const endStart = source.indexOf(endMarker, start);
if (endStart < 0) throw new Error("OpenAPI Space avatar finalizer block is malformed");
const end = endStart + endMarker.length;
const replacement = `await replaceOnce(\n  openapi,\n  \`    Space:\\n      type: object\\n      required: [id, kind, name, timezone, avatarUrl, version]\\n      properties:\\n        id: { type: string, pattern: ^spc_ }\\n        kind: { $ref: \\\"#/components/schemas/SpaceKind\\\" }\\n        name: { type: string, minLength: 1, maxLength: 100 }\\n        timezone: { $ref: \\\"#/components/schemas/IanaTimezone\\\" }\\n        version: { type: integer, minimum: 1 }\`,\n  \`    Space:\\n      type: object\\n      required: [id, kind, name, timezone, avatarUrl, version]\\n      properties:\\n        id: { type: string, pattern: ^spc_ }\\n        kind: { $ref: \\\"#/components/schemas/SpaceKind\\\" }\\n        name: { type: string, minLength: 1, maxLength: 100 }\\n        timezone: { $ref: \\\"#/components/schemas/IanaTimezone\\\" }\\n        avatarUrl: { type: [string, \\\"null\\\"], format: uri }\\n        version: { type: integer, minimum: 1 }\`,\n);`;
source = source.slice(0, start) + replacement + source.slice(end);
await writeFile(file, source);
console.log("Scoped Space avatar OpenAPI finalizer to the Space schema");
