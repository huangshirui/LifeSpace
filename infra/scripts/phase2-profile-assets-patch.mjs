import { readFile, writeFile } from "node:fs/promises";

async function replaceOnce(file, before, after) {
  const source = await readFile(file, "utf8");
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Expected patch target not found in ${file}: ${before.slice(0, 80)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch target is not unique in ${file}: ${before.slice(0, 80)}`);
  await writeFile(file, source.slice(0, first) + after + source.slice(first + before.length));
}

const spaces = "apps/core/src/spaces.ts";
await replaceOnce(
  spaces,
  'type SpaceRow = { id: string; kind: "personal" | "family" | "team"; name: string; timezone: string; version: number };',
  'type SpaceRow = { id: string; kind: "personal" | "family" | "team"; name: string; timezone: string; avatar_key: string | null; version: number };',
);
await replaceOnce(
  spaces,
  `async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {\n  const row = await env.DB.prepare("SELECT id,kind,name,timezone,version FROM spaces WHERE id=? AND deleted_at IS NULL")\n    .bind(spaceId).first<SpaceRow>();\n  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);\n  return row;\n}`,
  `async function findSpace(env: Bindings, spaceId: string): Promise<SpaceRow> {\n  const row = await env.DB.prepare("SELECT id,kind,name,timezone,avatar_key,version FROM spaces WHERE id=? AND deleted_at IS NULL")\n    .bind(spaceId).first<SpaceRow>();\n  if (!row) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);\n  return row;\n}\n\nfunction spaceAvatarUrl(requestUrl: string, spaceId: string, avatarKey: string | null): string | null {\n  if (!avatarKey) return null;\n  return new URL(\`/assets/spaces/\${encodeURIComponent(spaceId)}/avatar\`, requestUrl).toString();\n}\n\nfunction spaceDto<T extends SpaceRow>(requestUrl: string, row: T) {\n  const { avatar_key: avatarKey, ...rest } = row;\n  return { ...rest, avatarUrl: spaceAvatarUrl(requestUrl, row.id, avatarKey) };\n}`,
);
await replaceOnce(
  spaces,
  `    const result = principal.type === "user"\n      ? await c.env.DB.prepare(\`SELECT s.id,s.kind,s.name,s.timezone,m.role,s.version\n          FROM spaces s JOIN space_memberships m ON m.space_id=s.id\n          WHERE m.user_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY m.created_at\`)\n        .bind(principal.id).all()\n      : { results: [] };\n    return c.json(success(result.results));`,
  `    const result = principal.type === "user"\n      ? await c.env.DB.prepare(\`SELECT s.id,s.kind,s.name,s.timezone,s.avatar_key,m.role,s.version\n          FROM spaces s JOIN space_memberships m ON m.space_id=s.id\n          WHERE m.user_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY m.created_at\`)\n        .bind(principal.id).all<SpaceRow & { role: SpaceRole }>()\n      : { results: [] as (SpaceRow & { role: SpaceRole })[] };\n    return c.json(success(result.results.map((row) => spaceDto(c.req.url, row))));`,
);
await replaceOnce(
  spaces,
  '    return c.json(success({ id: spaceId, kind, name, timezone: zone, role: "owner", ownerPersonId: personId, version: 1 }), 201);',
  '    return c.json(success({ id: spaceId, kind, name, timezone: zone, avatarUrl: null, role: "owner", ownerPersonId: personId, version: 1 }), 201);',
);
await replaceOnce(
  spaces,
  '    return c.json(success({ ...await findSpace(c.env, spaceId), access }));',
  '    return c.json(success({ ...spaceDto(c.req.url, await findSpace(c.env, spaceId)), access }));',
);
await replaceOnce(
  spaces,
  '    return c.json(success(await findSpace(c.env, spaceId)));',
  '    return c.json(success(spaceDto(c.req.url, await findSpace(c.env, spaceId))));',
);

const openapi = "apps/core/openapi.yaml";
await replaceOnce(openapi, "  version: 0.8.0", "  version: 0.9.0");
await replaceOnce(
  openapi,
  "  description: Native LifeSpace Space, authorization, event, task, day-record and wish APIs. HomeMew runtime compatibility facades were retired after Phase 2.6; applications consume this native contract.",
  "  description: Native LifeSpace Space, authorization, avatar, event, task, day-record and wish APIs. HomeMew runtime compatibility facades were retired after Phase 2.6; applications consume this native contract.",
);
await replaceOnce(
  openapi,
  "  /api/v1/me:\n",
  `  /assets/spaces/{spaceId}/avatar:\n    parameters:\n      - $ref: "#/components/parameters/SpaceId"\n    get:\n      tags: [Spaces]\n      operationId: getPublicSpaceAvatar\n      security: []\n      responses:\n        "200":\n          description: Current Space avatar bytes\n          content:\n            image/jpeg: { schema: { type: string, contentEncoding: binary } }\n            image/png: { schema: { type: string, contentEncoding: binary } }\n            image/webp: { schema: { type: string, contentEncoding: binary } }\n        "404": { $ref: "#/components/responses/NotFound" }\n  /api/v1/me:\n`,
);
await replaceOnce(
  openapi,
  "  /api/v1/spaces/{spaceId}/members:\n",
  `  /api/v1/spaces/{spaceId}/avatar:\n    parameters:\n      - $ref: "#/components/parameters/SpaceId"\n    put:\n      tags: [Spaces]\n      operationId: replaceSpaceAvatar\n      description: Replace the Space avatar under optimistic concurrency. Requires spaces:manage. JPEG, PNG or WebP up to 5 MB.\n      requestBody:\n        required: true\n        content:\n          multipart/form-data:\n            schema:\n              type: object\n              additionalProperties: false\n              required: [file, version]\n              properties:\n                file: { type: string, contentEncoding: binary }\n                version: { type: integer, minimum: 1 }\n      responses:\n        "200":\n          description: Space avatar replaced\n          content:\n            application/json:\n              schema: { $ref: "#/components/schemas/SpaceAvatarResponse" }\n        "400": { $ref: "#/components/responses/InvalidRequest" }\n        "401": { $ref: "#/components/responses/Unauthorized" }\n        "403": { $ref: "#/components/responses/Forbidden" }\n        "404": { $ref: "#/components/responses/NotFound" }\n        "409": { $ref: "#/components/responses/Conflict" }\n        "413": { description: Avatar is larger than 5 MB }\n        "415": { description: Avatar content type is not JPEG, PNG or WebP }\n  /api/v1/spaces/{spaceId}/members:\n`,
);
await replaceOnce(
  openapi,
  "      required: [id, kind, name, timezone, version]",
  "      required: [id, kind, name, timezone, avatarUrl, version]",
);
await replaceOnce(
  openapi,
  "        timezone: { $ref: \"#/components/schemas/IanaTimezone\" }\n        version: { type: integer, minimum: 1 }",
  "        timezone: { $ref: \"#/components/schemas/IanaTimezone\" }\n        avatarUrl: { type: [string, \"null\"], format: uri }\n        version: { type: integer, minimum: 1 }",
);
await replaceOnce(
  openapi,
  '            contractVersion: { type: string, const: 0.8.0 }',
  '            contractVersion: { type: string, const: 0.9.0 }',
);
await replaceOnce(
  openapi,
  `    SpaceResponse:\n      type: object\n      required: [data]\n      properties: { data: { $ref: "#/components/schemas/Space" } }\n`,
  `    SpaceResponse:\n      type: object\n      required: [data]\n      properties: { data: { $ref: "#/components/schemas/Space" } }\n    SpaceAvatarResponse:\n      type: object\n      required: [data]\n      properties:\n        data:\n          type: object\n          additionalProperties: false\n          required: [avatarUrl, version]\n          properties:\n            avatarUrl: { type: string, format: uri }\n            version: { type: integer, minimum: 2 }\n`,
);

const transform = "apps/core/scripts/homemew-family-transform.mjs";
await replaceOnce(
  transform,
  `function deterministicId(prefix, namespace, legacyId) {\n  return \`\${prefix}_\${createHash("sha256").update(\`\${namespace}\\0\${legacyId}\`).digest("hex").slice(0, 32)}\`;\n}`,
  `function deterministicId(prefix, namespace, legacyId) {\n  return \`\${prefix}_\${createHash("sha256").update(\`\${namespace}\\0\${legacyId}\`).digest("hex").slice(0, 32)}\`;\n}\n\nfunction avatarTargetKey(legacyKey, expectedPrefix, targetPrefix, field) {\n  if (legacyKey === null || legacyKey === undefined || legacyKey === "") return null;\n  const key = string(legacyKey, field);\n  if (!key.startsWith(expectedPrefix)) fail(\`\${field} must start with \${expectedPrefix}\`);\n  const filename = path.posix.basename(key);\n  if (!/^[A-Za-z0-9._-]+\\.(jpg|png|webp)$/i.test(filename)) fail(\`\${field} has unsupported avatar filename\`);\n  return \`\${targetPrefix}/\${filename}\`;\n}`,
);
await replaceOnce(
  transform,
  `  const identity = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];\n  for (const user of users) {\n    identity.push(\`INSERT INTO users(id,display_name,status,created_at,updated_at) VALUES(\${[\n      userMaps.get(user.id), user.displayName.trim(), user.status, user.createdAt, user.updatedAt,\n    ].map(sql).join(",")});\`);\n  }`,
  `  const objectCopies = [];\n  const identity = ["PRAGMA foreign_keys = ON;", "BEGIN TRANSACTION;"];\n  for (const user of users) {\n    const targetUserId = userMaps.get(user.id);\n    const avatarKey = avatarTargetKey(user.avatarKey, \`avatars/\${user.id}/\`, \`avatars/users/\${targetUserId}\`, \`user \${user.id}.avatarKey\`);\n    if (avatarKey) objectCopies.push({ sourceKey: user.avatarKey, targetKey: avatarKey, ownerType: "user", legacyOwnerId: user.id, targetOwnerId: targetUserId });\n    identity.push(\`INSERT INTO users(id,display_name,avatar_key,status,created_at,updated_at) VALUES(\${[\n      targetUserId, user.displayName.trim(), avatarKey, user.status, user.createdAt, user.updatedAt,\n    ].map(sql).join(",")});\`);\n  }`,
);
await replaceOnce(
  transform,
  `    const deletedAt = family.status === "archived" ? family.updatedAt : null;\n    core.push(\`INSERT INTO spaces(id,kind,name,timezone,created_by_user_id,created_at,updated_at,version,deleted_at) VALUES(\${[\n      spaceId, "family", family.name.trim(), family.timezone, userMaps.get(family.createdBy), family.createdAt, family.updatedAt, 1, deletedAt,\n    ].map(sql).join(",")});\`);`,
  `    const deletedAt = family.status === "archived" ? family.updatedAt : null;\n    const avatarKey = avatarTargetKey(family.avatarKey, \`avatars/families/\${family.id}/\`, \`avatars/spaces/\${spaceId}\`, \`family \${family.id}.avatarKey\`);\n    if (avatarKey) objectCopies.push({ sourceKey: family.avatarKey, targetKey: avatarKey, ownerType: "space", legacyOwnerId: family.id, targetOwnerId: spaceId });\n    core.push(\`INSERT INTO spaces(id,kind,name,timezone,avatar_key,created_by_user_id,created_at,updated_at,version,deleted_at) VALUES(\${[\n      spaceId, "family", family.name.trim(), family.timezone, avatarKey, userMaps.get(family.createdBy), family.createdAt, family.updatedAt, 1, deletedAt,\n    ].map(sql).join(",")});\`);`,
);
await replaceOnce(transform, "    version: 1,", "    version: 2,");
await replaceOnce(
  transform,
  "    memberships: membershipManifest,\n  };",
  "    memberships: membershipManifest,\n    objects: objectCopies,\n  };",
);
await replaceOnce(
  transform,
  `    collapsedHistoricalInviteRedemptions: collapsedRedemptions,\n    deferredObjects: {\n      userAvatars: users.filter((user) => user.avatarKey).length,\n      familyAvatars: families.filter((family) => family.avatarKey).length,\n    },`,
  `    collapsedHistoricalInviteRedemptions: collapsedRedemptions,\n    objects: {\n      total: objectCopies.length,\n      userAvatars: objectCopies.filter((item) => item.ownerType === "user").length,\n      spaceAvatars: objectCopies.filter((item) => item.ownerType === "space").length,\n    },`,
);
await replaceOnce(
  transform,
  "  return { identitySql: `${identity.join(\"\\n\")}\\n`, coreSql: `${core.join(\"\\n\")}\\n`, manifest, report };",
  "  return { identitySql: `${identity.join(\"\\n\")}\\n`, coreSql: `${core.join(\"\\n\")}\\n`, manifest, objectManifest: objectCopies, report };",
);
await replaceOnce(
  transform,
  `    writeFile(path.join(outputDir, "mapping-manifest.json"), \`\${JSON.stringify(result.manifest, null, 2)}\\n\`),\n    writeFile(path.join(outputDir, "migration-report.json"), \`\${JSON.stringify(result.report, null, 2)}\\n\`),`,
  `    writeFile(path.join(outputDir, "mapping-manifest.json"), \`\${JSON.stringify(result.manifest, null, 2)}\\n\`),\n    writeFile(path.join(outputDir, "object-copy-manifest.json"), \`\${JSON.stringify(result.objectManifest, null, 2)}\\n\`),\n    writeFile(path.join(outputDir, "migration-report.json"), \`\${JSON.stringify(result.report, null, 2)}\\n\`),`,
);

const smoke = "infra/scripts/initialize-staging-runtime.mjs";
await replaceOnce(
  smoke,
  `  await wranglerSecretBulk("apps/identity", {\n    TOKEN_PRIVATE_KEY: privateKey,\n    BOOTSTRAP_SECRET: bootstrapSecret,\n  });`,
  `  await wranglerSecretBulk("apps/identity", {\n    TOKEN_PRIVATE_KEY: privateKey,\n    TOKEN_PUBLIC_KEY: publicKey,\n    BOOTSTRAP_SECRET: bootstrapSecret,\n  });`,
);
await replaceOnce(
  smoke,
  `  "profile:read",\n  "spaces:read",\n  "spaces:write",`,
  `  "profile:read",\n  "profile:write",\n  "spaces:read",\n  "spaces:write",\n  "spaces:manage",`,
);
await replaceOnce(
  smoke,
  `if (coreProbe?.response.status !== 200) {\n  throw new Error(\`Core token verification failed: \${coreProbe?.response.status} \${JSON.stringify(coreProbe?.payload)}\`);\n}\n\nconst coreStatus = await requestJson`,
  `if (coreProbe?.response.status !== 200) {\n  throw new Error(\`Core token verification failed: \${coreProbe?.response.status} \${JSON.stringify(coreProbe?.payload)}\`);\n}\n\nconst profile = await requestJson(\`\${identityBase}/api/v1/me\`, { headers: { authorization: \`Bearer \${accessToken}\` } }, 200);\nif (profile?.data?.id !== userId || profile?.data?.displayName !== displayName || profile?.data?.avatarUrl !== null) {\n  throw new Error(\`Unexpected Identity profile: \${JSON.stringify(profile)}\`);\n}\nconst updatedProfileName = \`\${displayName} Updated\`;\nconst updatedProfile = await requestJson(\`\${identityBase}/api/v1/me\`, {\n  method: "PATCH", headers: { authorization: \`Bearer \${accessToken}\`, "content-type": "application/json" },\n  body: JSON.stringify({ displayName: updatedProfileName }),\n}, 200);\nif (updatedProfile?.data?.displayName !== updatedProfileName) throw new Error(\`Identity profile update failed: \${JSON.stringify(updatedProfile)}\`);\nconst png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2dAAAAABJRU5ErkJggg==", "base64");\nconst userAvatarForm = new FormData();\nuserAvatarForm.set("file", new Blob([png], { type: "image/png" }), "avatar.png");\nconst uploadedUserAvatar = await requestJson(\`\${identityBase}/api/v1/me/avatar\`, {\n  method: "PUT", headers: { authorization: \`Bearer \${accessToken}\` }, body: userAvatarForm,\n}, 200);\nconst userAvatarUrl = uploadedUserAvatar?.data?.avatarUrl;\nif (!userAvatarUrl) throw new Error(\`Identity avatar upload did not return a URL: \${JSON.stringify(uploadedUserAvatar)}\`);\nconst userAvatarResponse = await fetch(userAvatarUrl);\nif (userAvatarResponse.status !== 200 || userAvatarResponse.headers.get("content-type") !== "image/png") {\n  throw new Error(\`Identity public avatar read failed: \${userAvatarResponse.status} \${userAvatarResponse.headers.get("content-type")}\`);\n}\n\nconst identityStatus = await requestJson(\`\${identityBase}/api/v1/status\`, {}, 200);\nif (identityStatus?.data?.environment !== "staging" || identityStatus?.data?.schemaVersion !== "3" || identityStatus?.data?.contractVersion !== "0.2.0") {\n  throw new Error(\`Unexpected Identity staging status: \${JSON.stringify(identityStatus)}\`);\n}\n\nconst coreStatus = await requestJson`,
);
await replaceOnce(smoke, 'coreStatus?.data?.schemaVersion !== "7"', 'coreStatus?.data?.schemaVersion !== "8"');
await replaceOnce(smoke, 'coreStatus?.data?.contractVersion !== "0.8.0"', 'coreStatus?.data?.contractVersion !== "0.9.0"');
await replaceOnce(
  smoke,
  `if (!spaceId) throw new Error("Core did not return a Space id");\nif (!ownerPersonId) throw new Error("Core did not return the owner Space Person id");\n\nawait requestJson(\`\${coreBase}/api/v1/spaces/\${spaceId}\`, {\n  headers: { authorization: \`Bearer \${accessToken}\` },\n}, 200);`,
  `if (!spaceId) throw new Error("Core did not return a Space id");\nif (!ownerPersonId) throw new Error("Core did not return the owner Space Person id");\nif (space?.data?.avatarUrl !== null || space?.data?.version !== 1) throw new Error(\`Unexpected initial Space avatar state: \${JSON.stringify(space)}\`);\n\nconst spaceAvatarForm = new FormData();\nspaceAvatarForm.set("file", new Blob([png], { type: "image/png" }), "space-avatar.png");\nspaceAvatarForm.set("version", "1");\nconst uploadedSpaceAvatar = await requestJson(\`\${coreBase}/api/v1/spaces/\${spaceId}/avatar\`, {\n  method: "PUT", headers: { authorization: \`Bearer \${accessToken}\` }, body: spaceAvatarForm,\n}, 200);\nif (!uploadedSpaceAvatar?.data?.avatarUrl || uploadedSpaceAvatar?.data?.version !== 2) {\n  throw new Error(\`Space avatar upload failed: \${JSON.stringify(uploadedSpaceAvatar)}\`);\n}\nconst spaceAvatarResponse = await fetch(uploadedSpaceAvatar.data.avatarUrl);\nif (spaceAvatarResponse.status !== 200 || spaceAvatarResponse.headers.get("content-type") !== "image/png") {\n  throw new Error(\`Space public avatar read failed: \${spaceAvatarResponse.status} \${spaceAvatarResponse.headers.get("content-type")}\`);\n}\nconst spaceRead = await requestJson(\`\${coreBase}/api/v1/spaces/\${spaceId}\`, {\n  headers: { authorization: \`Bearer \${accessToken}\` },\n}, 200);\nif (spaceRead?.data?.avatarUrl !== uploadedSpaceAvatar.data.avatarUrl || spaceRead?.data?.version !== 2) {\n  throw new Error(\`Space avatar was not reflected in Space DTO: \${JSON.stringify(spaceRead)}\`);\n}`,
);

console.log("Phase 2 profile/assets one-shot patch applied");
