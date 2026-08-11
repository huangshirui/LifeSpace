import fs from "node:fs/promises";

async function replaceOnce(file, before, after) {
  const source = await fs.readFile(file, "utf8");
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Patch target missing in ${file}: ${before.slice(0, 100)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch target not unique in ${file}: ${before.slice(0, 100)}`);
  await fs.writeFile(file, source.slice(0, first) + after + source.slice(first + before.length));
}

async function replaceAllRequired(file, before, after) {
  const source = await fs.readFile(file, "utf8");
  if (!source.includes(before)) throw new Error(`Patch target missing in ${file}: ${before}`);
  await fs.writeFile(file, source.replaceAll(before, after));
}

await replaceOnce(
  "apps/identity/src/service-auth.ts",
  `async function constantTimeEqual(left: string, right: string): Promise<boolean> {\n  const [a, b] = await Promise.all([sha256(left), sha256(right)]);\n  let diff = 0;\n  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);\n  return diff === 0;\n}\n`,
  `function constantTimeEqualDigest(left: string, right: string): boolean {\n  if (left.length !== right.length) return false;\n  let diff = 0;\n  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);\n  return diff === 0;\n}\n\nasync function constantTimeEqual(left: string, right: string): Promise<boolean> {\n  return constantTimeEqualDigest(await sha256(left), await sha256(right));\n}\n\nasync function matchesStoredHash(value: string, expectedHash: string): Promise<boolean> {\n  return constantTimeEqualDigest(await sha256(value), expectedHash);\n}\n`,
);
await replaceOnce(
  "apps/identity/src/service-auth.ts",
  `      if (body.maxScopes !== undefined && !scopeSubset(maxScopes, previousMax)) throw new Error("maxScopes may only be reduced after creation");\n`,
  `      // The principal ceiling may change within the registered application's ceiling.\n      // Existing opaque tokens keep their own scopes and therefore never auto-expand.\n`,
);
await replaceAllRequired(
  "apps/identity/src/service-auth.ts",
  `    const revokedByUserId = c.req.header("x-lifespace-actor-user-id")?.trim() || null;\n`,
  `    const revokedByUserId = await activeUser(c.env, c.req.header("x-lifespace-actor-user-id")?.trim() || null);\n`,
);
await replaceOnce(
  "apps/identity/src/service-auth.ts",
  `    if (!credential || credential.principalStatus !== "active" || credential.applicationStatus !== "active" || !await constantTimeEqual(await sha256(clientSecret), credential.secretHash)) {\n`,
  `    if (!credential || credential.principalStatus !== "active" || credential.applicationStatus !== "active" || !await matchesStoredHash(clientSecret, credential.secretHash)) {\n`,
);

await replaceOnce(
  "apps/identity/src/app.ts",
  `import { AvatarError, bestEffortDeleteUserAvatar, parseAvatarFile, storeUserAvatar } from "./avatar";\n`,
  `import { AvatarError, bestEffortDeleteUserAvatar, parseAvatarFile, storeUserAvatar } from "./avatar";\nimport { registerServiceAuthenticationRoutes } from "./service-auth";\n`,
);
await replaceOnce(
  "apps/identity/src/app.ts",
  `      contractVersion: "0.2.0",\n`,
  `      contractVersion: "0.3.0",\n`,
);
await replaceOnce(
  "apps/identity/src/app.ts",
  `  app.notFound((c) => c.json(fail("NOT_FOUND", "Route not found", c.get("requestId")), 404));\n`,
  `  registerServiceAuthenticationRoutes(app);\n\n  app.notFound((c) => c.json(fail("NOT_FOUND", "Route not found", c.get("requestId")), 404));\n`,
);

await replaceOnce(
  "apps/core/src/app.ts",
  `import { registerSpaceAvatarRoutes } from "./space-avatars";\n`,
  `import { registerSpaceAvatarRoutes } from "./space-avatars";\nimport { registerGrantRoutes } from "./grants";\n`,
);
await replaceOnce(
  "apps/core/src/app.ts",
  `    contractVersion: "0.9.0",\n`,
  `    contractVersion: "0.10.0",\n`,
);
await replaceOnce(
  "apps/core/src/app.ts",
  `  registerSpaceRoutes(app);\n  registerEventRoutes(app);\n`,
  `  registerSpaceRoutes(app);\n  registerGrantRoutes(app);\n  registerEventRoutes(app);\n`,
);

await replaceAllRequired("apps/core/openapi.yaml", "0.9.0", "0.10.0");
await replaceOnce(
  "apps/core/openapi.yaml",
  `  description: Native LifeSpace Space, authorization, avatar, event, task, day-record and wish APIs. HomeMew runtime compatibility facades were retired after Phase 2.6; applications consume this native contract.\n`,
  `  description: Native LifeSpace Space, authorization, service-authenticated Data Grant, avatar, event, task, day-record and wish APIs. HomeMew runtime compatibility facades were retired after Phase 2.6; applications consume this native contract.\n`,
);
await replaceOnce(
  "apps/core/openapi.yaml",
  `  /api/v1/spaces/{spaceId}/grants:\n    parameters:\n      - $ref: "#/components/parameters/SpaceId"\n    post:\n      tags: [Data Grants]\n      operationId: createDataGrant\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: "#/components/schemas/CreateGrantRequest" }\n      responses:\n        "201": { description: Data Grant created }\n        "400": { $ref: "#/components/responses/InvalidRequest" }\n        "401": { $ref: "#/components/responses/Unauthorized" }\n        "403": { $ref: "#/components/responses/Forbidden" }\ncomponents:\n`,
  `  /api/v1/spaces/{spaceId}/grants:\n    parameters:\n      - $ref: "#/components/parameters/SpaceId"\n    get:\n      tags: [Data Grants]\n      operationId: listDataGrants\n      description: List Space-level Data Grants. Requires a user principal with grants:manage and current manage permission on the Space.\n      parameters:\n        - { name: includeRevoked, in: query, schema: { type: boolean, default: false } }\n      responses:\n        "200": { description: Data Grant list, content: { application/json: { schema: { $ref: "#/components/schemas/DataGrantListResponse" } } } }\n        "401": { $ref: "#/components/responses/Unauthorized" }\n        "403": { $ref: "#/components/responses/Forbidden" }\n    post:\n      tags: [Data Grants]\n      operationId: createDataGrant\n      description: Create a Space-level Grant. A service grantee authenticates separately and gains no access without a current Grant.\n      requestBody:\n        required: true\n        content:\n          application/json:\n            schema: { $ref: "#/components/schemas/CreateGrantRequest" }\n      responses:\n        "201": { description: Data Grant created }\n        "400": { $ref: "#/components/responses/InvalidRequest" }\n        "401": { $ref: "#/components/responses/Unauthorized" }\n        "403": { $ref: "#/components/responses/Forbidden" }\n  /api/v1/spaces/{spaceId}/grants/{grantId}:\n    parameters:\n      - $ref: "#/components/parameters/SpaceId"\n      - $ref: "#/components/parameters/GrantId"\n    patch:\n      tags: [Data Grants]\n      operationId: updateDataGrant\n      description: Update the permission or expiry of an active Space-level Grant.\n      requestBody:\n        required: true\n        content: { application/json: { schema: { $ref: "#/components/schemas/UpdateGrantRequest" } } }\n      responses:\n        "200": { description: Data Grant updated, content: { application/json: { schema: { $ref: "#/components/schemas/DataGrantResponse" } } } }\n        "400": { $ref: "#/components/responses/InvalidRequest" }\n        "401": { $ref: "#/components/responses/Unauthorized" }\n        "403": { $ref: "#/components/responses/Forbidden" }\n        "404": { $ref: "#/components/responses/NotFound" }\n    delete:\n      tags: [Data Grants]\n      operationId: revokeDataGrant\n      description: Revoke an active Grant; authorization changes take effect on the next Core request.\n      responses:\n        "204": { description: Data Grant revoked }\n        "401": { $ref: "#/components/responses/Unauthorized" }\n        "403": { $ref: "#/components/responses/Forbidden" }\n        "404": { $ref: "#/components/responses/NotFound" }\ncomponents:\n`,
);
await replaceOnce(
  "apps/core/openapi.yaml",
  `    bearerAuth:\n      type: http\n      scheme: bearer\n      bearerFormat: JWT\n`,
  `    bearerAuth:\n      type: http\n      scheme: bearer\n      bearerFormat: JWT or lsp_pat_\n      description: Short-lived LifeSpace JWT or opaque lsp_pat_* Service API Token. Opaque tokens are introspected against current Identity state.\n`,
);
await replaceOnce(
  "apps/core/openapi.yaml",
  `    WishId: { name: wishId, in: path, required: true, schema: { type: string, pattern: ^wsh_ } }\n`,
  `    WishId: { name: wishId, in: path, required: true, schema: { type: string, pattern: ^wsh_ } }\n    GrantId: { name: grantId, in: path, required: true, schema: { type: string, pattern: ^grt_ } }\n`,
);
await replaceOnce(
  "apps/core/openapi.yaml",
  `    CreateGrantRequest:\n      type: object\n      additionalProperties: false\n      required: [granteeType, granteeId, permission]\n      properties:\n        granteeType: { type: string, enum: [user, space, service, device] }\n        granteeId: { type: string }\n        permission: { $ref: "#/components/schemas/Permission" }\n        expiresAt: { type: [string, "null"], format: date-time }\n`,
  `    DataGrant:\n      type: object\n      additionalProperties: false\n      required: [id, sourceSpaceId, granteeType, granteeId, resourceType, resourceId, permission, createdByUserId, createdAt, expiresAt, revokedAt]\n      properties:\n        id: { type: string, pattern: ^grt_ }\n        sourceSpaceId: { type: string, pattern: ^spc_ }\n        granteeType: { type: string, enum: [user, space, service, device] }\n        granteeId: { type: string }\n        resourceType: { type: string, const: space }\n        resourceId: { type: "null" }\n        permission: { $ref: "#/components/schemas/Permission" }\n        createdByUserId: { type: string, pattern: ^usr_ }\n        createdAt: { type: string, format: date-time }\n        expiresAt: { type: [string, "null"], format: date-time }\n        revokedAt: { type: [string, "null"], format: date-time }\n    CreateGrantRequest:\n      type: object\n      additionalProperties: false\n      required: [granteeType, granteeId, permission]\n      properties:\n        granteeType: { type: string, enum: [user, space, service, device] }\n        granteeId: { type: string }\n        permission: { $ref: "#/components/schemas/Permission" }\n        expiresAt: { type: [string, "null"], format: date-time }\n    UpdateGrantRequest:\n      type: object\n      additionalProperties: false\n      minProperties: 1\n      properties:\n        permission: { $ref: "#/components/schemas/Permission" }\n        expiresAt: { type: [string, "null"], format: date-time }\n    DataGrantResponse: { type: object, required: [data], properties: { data: { $ref: "#/components/schemas/DataGrant" } } }\n    DataGrantListResponse: { type: object, required: [data], properties: { data: { type: array, items: { $ref: "#/components/schemas/DataGrant" } } } }\n`,
);

await replaceAllRequired("apps/core/scripts/check-openapi.mjs", "0.9.0", "0.10.0");
await replaceOnce(
  "apps/core/scripts/check-openapi.mjs",
  `  "/api/v1/spaces/{spaceId}/grants",\n];\n`,
  `  "/api/v1/spaces/{spaceId}/grants",\n  "/api/v1/spaces/{spaceId}/grants/{grantId}",\n];\n`,
);
await replaceOnce(
  "apps/core/scripts/check-openapi.mjs",
  `if (schemas.JoinInviteRequest?.additionalProperties !== false || !schemas.JoinInviteRequest?.required?.includes("displayName")) throw new Error("Invitation join must create/reactivate a Space Person");\n\n`,
  `if (schemas.JoinInviteRequest?.additionalProperties !== false || !schemas.JoinInviteRequest?.required?.includes("displayName")) throw new Error("Invitation join must create/reactivate a Space Person");\nif (document.components?.securitySchemes?.bearerAuth?.bearerFormat !== "JWT or lsp_pat_") throw new Error("Core bearer contract must expose JWT and opaque service-token authentication");\nif (!schemas.CreateGrantRequest?.properties?.granteeType?.enum?.includes("service")) throw new Error("Data Grants must support service principals");\nif (!document.paths?.["/api/v1/spaces/{spaceId}/grants"]?.get || !document.paths?.["/api/v1/spaces/{spaceId}/grants/{grantId}"]?.delete) throw new Error("Data Grant management lifecycle is incomplete");\n\n`,
);

console.log("Phase 2 service-auth finalization applied");
