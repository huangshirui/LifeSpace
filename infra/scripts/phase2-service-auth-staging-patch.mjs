import fs from "node:fs/promises";

async function replaceOnce(file, before, after) {
  const source = await fs.readFile(file, "utf8");
  const first = source.indexOf(before);
  if (first < 0) throw new Error(`Patch target missing in ${file}: ${before.slice(0, 100)}`);
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Patch target not unique in ${file}: ${before.slice(0, 100)}`);
  await fs.writeFile(file, source.slice(0, first) + after + source.slice(first + before.length));
}

const file = "infra/scripts/initialize-staging-runtime.mjs";
await replaceOnce(
  file,
  `import { generateKeyPairSync } from "node:crypto";\n`,
  `import { generateKeyPairSync, randomBytes } from "node:crypto";\n`,
);
await replaceOnce(
  file,
  `await wranglerSecretBulk("apps/identity", {\n  BOOTSTRAP_SECRET: bootstrapSecret,\n});\nconsole.log("Staging bootstrap secret synchronized and activated");\n`,
  `const coreIdentitySharedSecret = randomBytes(32).toString("base64url");\nawait wranglerSecretBulk("apps/identity", {\n  BOOTSTRAP_SECRET: bootstrapSecret,\n  CORE_IDENTITY_SHARED_SECRET: coreIdentitySharedSecret,\n});\nawait wranglerSecretBulk("apps/core", {\n  CORE_IDENTITY_SHARED_SECRET: coreIdentitySharedSecret,\n});\nconsole.log("Staging bootstrap and Core↔Identity introspection secrets synchronized and activated");\n`,
);
await replaceOnce(
  file,
  `  "spaces:manage",\n  "events:read",\n`,
  `  "spaces:manage",\n  "grants:manage",\n  "events:read",\n`,
);
await replaceOnce(
  file,
  `if (identityStatus?.data?.environment !== "staging" || identityStatus?.data?.schemaVersion !== "3" || identityStatus?.data?.contractVersion !== "0.2.0") {\n`,
  `if (identityStatus?.data?.environment !== "staging" || identityStatus?.data?.schemaVersion !== "4" || identityStatus?.data?.contractVersion !== "0.3.0") {\n`,
);
await replaceOnce(
  file,
  `  || coreStatus?.data?.contractVersion !== "0.9.0"\n`,
  `  || coreStatus?.data?.contractVersion !== "0.10.0"\n`,
);
await replaceOnce(
  file,
  `if (space?.data?.avatarUrl !== null || space?.data?.version !== 1) throw new Error(\`Unexpected initial Space avatar state: \${JSON.stringify(space)}\`);\n\nconst spaceAvatarForm = new FormData();\n`,
  `if (space?.data?.avatarUrl !== null || space?.data?.version !== 1) throw new Error(\`Unexpected initial Space avatar state: \${JSON.stringify(space)}\`);\n\nconst servicePrincipal = await requestJson(\`${identityBase}/api/v1/service-principals\`, {\n  method: "POST",\n  headers: { authorization: \`Bearer \${clientSecret}\`, "content-type": "application/json" },\n  body: JSON.stringify({\n    displayName: \`Staging n8n \${smokeId}\`,\n    description: "Phase 2 service-auth staging smoke",\n    maxScopes: ["spaces:read"],\n    createdByUserId: userId,\n  }),\n}, 201);\nconst servicePrincipalId = servicePrincipal?.data?.id;\nif (!servicePrincipalId?.startsWith("svc_")) throw new Error(\`Identity did not return a service principal: \${JSON.stringify(servicePrincipal)}\`);\n\nconst serviceTokenCreated = await requestJson(\`${identityBase}/api/v1/service-principals/\${servicePrincipalId}/tokens\`, {\n  method: "POST",\n  headers: { authorization: \`Bearer \${clientSecret}\`, "content-type": "application/json" },\n  body: JSON.stringify({ label: "staging n8n PAT", scopes: ["spaces:read"], createdByUserId: userId }),\n}, 201);\nconst serviceToken = serviceTokenCreated?.data?.token;\nconst serviceTokenId = serviceTokenCreated?.data?.id;\nif (!serviceToken?.startsWith("lsp_pat_") || !serviceTokenId?.startsWith("sat_")) throw new Error(\`Identity did not return a one-time lsp_pat token: \${JSON.stringify(serviceTokenCreated)}\`);\nconst tokenMetadata = await requestJson(\`${identityBase}/api/v1/service-principals/\${servicePrincipalId}/tokens\`, {\n  headers: { authorization: \`Bearer \${clientSecret}\` },\n}, 200);\nif (JSON.stringify(tokenMetadata).includes(serviceToken)) throw new Error("Service token listing leaked plaintext");\n\nconst serviceGrant = await requestJson(\`${coreBase}/api/v1/spaces/\${spaceId}/grants\`, {\n  method: "POST",\n  headers: { authorization: \`Bearer \${accessToken}\`, "content-type": "application/json" },\n  body: JSON.stringify({ granteeType: "service", granteeId: servicePrincipalId, permission: "read", expiresAt: null }),\n}, 201);\nconst serviceGrantId = serviceGrant?.data?.id;\nif (!serviceGrantId?.startsWith("grt_")) throw new Error(\`Core did not return a service Data Grant: \${JSON.stringify(serviceGrant)}\`);\n\nconst serviceRead = await requestJson(\`${coreBase}/api/v1/spaces/\${spaceId}\`, {\n  headers: { authorization: \`Bearer \${serviceToken}\` },\n}, 200);\nif (serviceRead?.data?.id !== spaceId || serviceRead?.data?.access !== "grant") throw new Error(\`Opaque Service API Token did not reach Core through current Grant: \${JSON.stringify(serviceRead)}\`);\n\nconst oauthCredential = await requestJson(\`${identityBase}/api/v1/service-principals/\${servicePrincipalId}/oauth-credentials\`, {\n  method: "POST",\n  headers: { authorization: \`Bearer \${clientSecret}\`, "content-type": "application/json" },\n  body: JSON.stringify({ label: "staging OAuth", createdByUserId: userId }),\n}, 201);\nconst oauthClientSecret = oauthCredential?.data?.clientSecret;\nconst oauthCredentialId = oauthCredential?.data?.id;\nif (!oauthClientSecret?.startsWith("lsp_client_") || !oauthCredentialId?.startsWith("soc_")) throw new Error(\`Identity did not return OAuth client credentials: \${JSON.stringify(oauthCredential)}\`);\nconst oauthForm = new URLSearchParams({ grant_type: "client_credentials", client_id: servicePrincipalId, client_secret: oauthClientSecret, scope: "spaces:read" });\nconst oauthToken = await requestJson(\`${identityBase}/oauth/token\`, {\n  method: "POST",\n  headers: { "content-type": "application/x-www-form-urlencoded" },\n  body: oauthForm.toString(),\n}, 200);\nconst oauthAccessToken = oauthToken?.access_token;\nif (!oauthAccessToken) throw new Error(\`OAuth client_credentials did not return an access token: \${JSON.stringify(oauthToken)}\`);\nconst oauthRead = await requestJson(\`${coreBase}/api/v1/spaces/\${spaceId}\`, { headers: { authorization: \`Bearer \${oauthAccessToken}\` } }, 200);\nif (oauthRead?.data?.id !== spaceId || oauthRead?.data?.access !== "grant") throw new Error(\`OAuth service token did not use the current Data Grant: \${JSON.stringify(oauthRead)}\`);\n\nawait requestJson(\`${coreBase}/api/v1/spaces/\${spaceId}/grants/\${serviceGrantId}\`, {\n  method: "DELETE", headers: { authorization: \`Bearer \${accessToken}\` },\n}, 204);\nconst opaqueAfterGrantRevoke = await fetchJson(\`${coreBase}/api/v1/spaces/\${spaceId}\`, { headers: { authorization: \`Bearer \${serviceToken}\` } });\nif (opaqueAfterGrantRevoke.response.status !== 403) throw new Error(\`Opaque service Grant revocation did not take effect immediately: \${opaqueAfterGrantRevoke.response.status} \${JSON.stringify(opaqueAfterGrantRevoke.payload)}\`);\nconst oauthAfterGrantRevoke = await fetchJson(\`${coreBase}/api/v1/spaces/\${spaceId}\`, { headers: { authorization: \`Bearer \${oauthAccessToken}\` } });\nif (oauthAfterGrantRevoke.response.status !== 403) throw new Error(\`OAuth service Grant revocation did not take effect immediately: \${oauthAfterGrantRevoke.response.status} \${JSON.stringify(oauthAfterGrantRevoke.payload)}\`);\n\nawait requestJson(\`${identityBase}/api/v1/service-principals/\${servicePrincipalId}/tokens/\${serviceTokenId}\`, {\n  method: "DELETE", headers: { authorization: \`Bearer \${clientSecret}\`, "x-lifespace-actor-user-id": userId },\n}, 204);\nconst opaqueAfterTokenRevoke = await fetchJson(\`${coreBase}/api/v1/spaces/\${spaceId}\`, { headers: { authorization: \`Bearer \${serviceToken}\` } });\nif (opaqueAfterTokenRevoke.response.status !== 401) throw new Error(\`Opaque token revocation did not take effect immediately: \${opaqueAfterTokenRevoke.response.status} \${JSON.stringify(opaqueAfterTokenRevoke.payload)}\`);\nawait requestJson(\`${identityBase}/api/v1/service-principals/\${servicePrincipalId}/oauth-credentials/\${oauthCredentialId}\`, {\n  method: "DELETE", headers: { authorization: \`Bearer \${clientSecret}\`, "x-lifespace-actor-user-id": userId },\n}, 204);\nconsole.log(\`Phase 2 service authentication staging E2E passed for \${servicePrincipalId} / \${spaceId}\`);\n\nconst spaceAvatarForm = new FormData();\n`,
);

console.log("Phase 2 service-auth staging smoke patch applied");
