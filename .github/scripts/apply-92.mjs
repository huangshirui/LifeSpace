import { createHash } from "node:crypto";
import fs from "node:fs";

function read(path) {
  return fs.readFileSync(path, "utf8");
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(text, from, to, label) {
  const first = text.indexOf(from);
  if (first < 0) throw new Error(`Missing expected ${label}`);
  if (text.indexOf(from, first + from.length) >= 0) throw new Error(`Expected exactly one ${label}`);
  return text.slice(0, first) + to + text.slice(first + from.length);
}

function replaceCount(text, from, to, expected, label) {
  const count = text.split(from).length - 1;
  if (count !== expected) throw new Error(`Expected ${expected} ${label}, found ${count}`);
  return text.split(from).join(to);
}

function operationDigest(openapi) {
  const httpMethods = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);
  const operations = [];
  for (const [path, item] of Object.entries(openapi.paths ?? {})) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    for (const method of Object.keys(item)) {
      if (httpMethods.has(method.toLowerCase())) operations.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return `sha256:${createHash("sha256").update([...new Set(operations)].sort().join("\n")).digest("hex")}`;
}

function migrateInviteJoinCalls(text, path) {
  const pattern = /request\(`\/api\/v1\/space-invites\/\$\{([^}]+)\}\/join`,/g;
  const matches = [...text.matchAll(pattern)];
  if (matches.length === 0) throw new Error(`No legacy invite join calls found in ${path}`);
  for (const match of matches.reverse()) {
    const tokenExpression = match[1];
    const matchIndex = match.index;
    const afterMatch = matchIndex + match[0].length;
    const bodyMarker = "body: JSON.stringify({ ";
    const bodyIndex = text.indexOf(bodyMarker, afterMatch);
    const nextLegacyCall = text.indexOf("/api/v1/space-invites/${", afterMatch);
    if (bodyIndex < 0 || (nextLegacyCall >= 0 && bodyIndex > nextLegacyCall)) {
      throw new Error(`Could not bind invite token to the matching request body in ${path}`);
    }
    text = text.slice(0, bodyIndex)
      + `body: JSON.stringify({ token: ${tokenExpression}, `
      + text.slice(bodyIndex + bodyMarker.length);
    text = text.slice(0, matchIndex)
      + 'request("/api/v1/space-invites/join",'
      + text.slice(matchIndex + match[0].length);
  }
  if (text.includes("/api/v1/space-invites/${")) throw new Error(`Legacy token-in-path invite call remains in ${path}`);
  return text;
}

// Canonical Core Kernel OpenAPI: contract first.
const openapiPath = "apps/core/openapi.yaml";
const openapi = JSON.parse(read(openapiPath));
if (openapi.info?.version !== "0.20.0") throw new Error(`Unexpected Core Kernel version ${openapi.info?.version}`);
const oldPreview = openapi.paths?.["/api/v1/space-invites/{token}"]?.get;
const oldJoin = openapi.paths?.["/api/v1/space-invites/{token}/join"]?.post;
if (!oldPreview || !oldJoin) throw new Error("Legacy invite paths are missing before #92 migration");

openapi.info.version = "0.21.0";
openapi.components.schemas.StatusResponse.properties.data.properties.contractVersion.const = "0.21.0";
delete openapi.paths["/api/v1/space-invites/{token}"];
delete openapi.paths["/api/v1/space-invites/{token}/join"];
openapi.paths["/api/v1/space-invites/preview"] = {
  post: {
    ...oldPreview,
    description: "Returns a limited authenticated invitation preview. The possession bearer token is supplied in the JSON request body so it is not exposed in the API URL.",
    requestBody: {
      required: true,
      content: { "application/json": { schema: { $ref: "#/components/schemas/PreviewInviteRequest" } } },
    },
  },
};
openapi.paths["/api/v1/space-invites/join"] = {
  post: {
    ...oldJoin,
    description: "Redeems an invitation and atomically activates membership plus Space Person. The possession bearer token is supplied in the JSON request body so it is not exposed in the API URL.",
  },
};
delete openapi.components.parameters.InviteToken;
openapi.components.schemas.PreviewInviteRequest = {
  type: "object",
  additionalProperties: false,
  required: ["token"],
  properties: { token: { type: "string", minLength: 1 } },
};
openapi.components.schemas.JoinInviteRequest = {
  type: "object",
  additionalProperties: false,
  required: ["token", "displayName"],
  properties: {
    token: { type: "string", minLength: 1 },
    displayName: { type: "string", minLength: 1, maxLength: 100 },
  },
};
write(openapiPath, JSON.stringify(openapi));

// Deliberately advance the operation-set evidence for the Candidate/Public invitation representation.
const baselinePath = "docs/contract-stability-baseline.json";
const baseline = JSON.parse(read(baselinePath));
const coreSource = (baseline.contractSources ?? []).find((entry) => entry.source === "apps/core/openapi.yaml");
if (!coreSource) throw new Error("Core Kernel stability source is missing");
const invitationGroup = coreSource.groups?.find((entry) => entry.id === "core-invitations");
if (!invitationGroup || invitationGroup.maturity !== "candidate" || invitationGroup.visibility !== "public") {
  throw new Error("Core invitation surface must remain Candidate/Public during #92 migration");
}
invitationGroup.operationPattern = "^(GET|POST) /api/v1/spaces/\\{spaceId\\}/invites$|^POST /api/v1/spaces/\\{spaceId\\}/invites/\\{inviteId\\}/revoke$|^POST /api/v1/space-invites/(preview|join)$";
coreSource.operationSetSha256 = operationDigest(openapi);
write(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);

// Runtime consumes the body-bound token without changing invite authorization/lifecycle semantics.
const spacesPath = "apps/core/src/spaces.ts";
let spaces = read(spacesPath);
spaces = replaceOnce(
  spaces,
  '  app.get("/api/v1/space-invites/:token", requireScope("spaces:read"), async (c) => {\n    requireUser(c.get("principal"));\n    const invite = await findInvite(c.env, c.req.param("token"));',
  '  app.post("/api/v1/space-invites/preview", requireScope("spaces:read"), async (c) => {\n    requireUser(c.get("principal"));\n    const input = await body(c);\n    fields(input, ["token"]);\n    const token = text(input.token, "token");\n    const invite = await findInvite(c.env, token);',
  "legacy invite preview route",
);
spaces = replaceOnce(
  spaces,
  '  app.post("/api/v1/space-invites/:token/join", requireScope("spaces:write"), async (c) => {',
  '  app.post("/api/v1/space-invites/join", requireScope("spaces:write"), async (c) => {',
  "legacy invite join route",
);
spaces = replaceOnce(
  spaces,
  '    const principal = c.get("principal");\n    requireUser(principal);\n    const invite = await findInvite(c.env, c.req.param("token"));\n    assertInvite(invite);',
  '    const principal = c.get("principal");\n    requireUser(principal);\n    const input = await body(c);\n    fields(input, ["token", "displayName"]);\n    const token = text(input.token, "token");\n    const displayName = text(input.displayName, "displayName");\n    const invite = await findInvite(c.env, token);\n    assertInvite(invite);',
  "invite join token lookup",
);
spaces = replaceOnce(
  spaces,
  '    const input = await body(c);\n    fields(input, ["displayName"]);\n    const displayName = text(input.displayName, "displayName");\n',
  "",
  "legacy join displayName-only body parse",
);
spaces = replaceOnce(
  spaces,
  '      const current = await findInvite(c.env, c.req.param("token"));',
  '      const current = await findInvite(c.env, token);',
  "invite replay token lookup",
);
if (spaces.includes('space-invites/:token') || spaces.includes('c.req.param("token")')) {
  throw new Error("Runtime still exposes/reads an invitation bearer token from the URL path");
}
write(spacesPath, spaces);

// Runtime version metadata.
const appPath = "apps/core/src/app.ts";
write(appPath, replaceOnce(read(appPath), 'contractVersion: "0.20.0"', 'contractVersion: "0.21.0"', "Core status contract version"));
const packagePath = "apps/core/package.json";
const corePackage = JSON.parse(read(packagePath));
if (corePackage.version !== "0.20.0") throw new Error(`Unexpected @lifespace/core version ${corePackage.version}`);
corePackage.version = "0.21.0";
write(packagePath, `${JSON.stringify(corePackage, null, 2)}\n`);

// OpenAPI contract checks prove the bearer token is no longer accepted in URL paths.
const checkOpenApiPath = "apps/core/scripts/check-openapi.mjs";
let checkOpenApi = read(checkOpenApiPath);
checkOpenApi = replaceCount(checkOpenApi, '"0.20.0"', '"0.21.0"', 2, "Core OpenAPI version checks");
checkOpenApi = replaceOnce(checkOpenApi, '  "/api/v1/space-invites/{token}",\n  "/api/v1/space-invites/{token}/join",', '  "/api/v1/space-invites/preview",\n  "/api/v1/space-invites/join",', "required invite paths");
checkOpenApi = replaceOnce(
  checkOpenApi,
  'if (schemas.JoinInviteRequest?.additionalProperties !== false || !schemas.JoinInviteRequest?.required?.includes("displayName")) {\n  throw new Error("Invitation join must create/reactivate a Space Person");\n}',
  'const previewInvite = document.paths?.["/api/v1/space-invites/preview"]?.post;\nconst joinInvite = document.paths?.["/api/v1/space-invites/join"]?.post;\nif (document.paths?.["/api/v1/space-invites/{token}"] || document.paths?.["/api/v1/space-invites/{token}/join"]) {\n  throw new Error("Invitation bearer tokens must not appear in API URL paths");\n}\nif (document.components?.parameters?.InviteToken) {\n  throw new Error("Invitation bearer token must not remain a path parameter");\n}\nif (previewInvite?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/PreviewInviteRequest"\n    || schemas.PreviewInviteRequest?.additionalProperties !== false\n    || !schemas.PreviewInviteRequest?.required?.includes("token")) {\n  throw new Error("Invitation preview must accept the possession token only through its bounded JSON body");\n}\nif (joinInvite?.requestBody?.content?.["application/json"]?.schema?.$ref !== "#/components/schemas/JoinInviteRequest"\n    || schemas.JoinInviteRequest?.additionalProperties !== false\n    || !schemas.JoinInviteRequest?.required?.includes("token")\n    || !schemas.JoinInviteRequest?.required?.includes("displayName")) {\n  throw new Error("Invitation join must accept token/displayName through its bounded JSON body and create/reactivate a Space Person");\n}',
  "invitation OpenAPI invariant checks",
);
write(checkOpenApiPath, checkOpenApi);

// Consumer-facing integration tests migrate all invite joins and exercise body-bound preview.
const familyTestPath = "apps/core/test/family-spaces.integration.test.ts";
let familyTest = migrateInviteJoinCalls(read(familyTestPath), familyTestPath);
const firstJoinIndex = familyTest.indexOf('    const joined = await request("/api/v1/space-invites/join",');
if (firstJoinIndex < 0) throw new Error("First invite join test not found after migration");
const previewBlock = '    const preview = await request("/api/v1/space-invites/preview", joiningToken, publicKey, {\n      method: "POST",\n      body: JSON.stringify({ token: invitation.data.token }),\n    });\n    expect(preview.status).toBe(200);\n    expect((await preview.json<{ data: { space: { id: string }; canJoin: boolean } }>()).data)\n      .toMatchObject({ space: { id: family.spaceId }, canJoin: true });\n\n';
familyTest = familyTest.slice(0, firstJoinIndex) + previewBlock + familyTest.slice(firstJoinIndex);
write(familyTestPath, familyTest);

const lifecycleTestPath = "apps/core/test/space-lifecycle.integration.test.ts";
let lifecycleTest = read(lifecycleTestPath);
lifecycleTest = replaceOnce(
  lifecycleTest,
  '    const preview = await request(`/api/v1/space-invites/${invite.data.token}`, memberToken, publicKey);',
  '    const preview = await request("/api/v1/space-invites/preview", memberToken, publicKey, {\n      method: "POST",\n      body: JSON.stringify({ token: invite.data.token }),\n    });',
  "closed-Space invite preview call",
);
if (lifecycleTest.includes("/api/v1/space-invites/${")) throw new Error("Legacy invite token path remains in lifecycle test");
write(lifecycleTestPath, lifecycleTest);

// Current-version documentation and explicit downstream migration evidence.
const coreAgentsPath = "apps/core/AGENTS.md";
write(coreAgentsPath, replaceOnce(read(coreAgentsPath), "current Kernel version: 0.20.0", "current Kernel version: 0.21.0", "Core AGENTS current version"));
const readmePath = "README.md";
let readme = read(readmePath);
readme = replaceOnce(readme, "The current repository Core Kernel contract is **0.20.0**.", "The current repository Core Kernel contract is **0.21.0**.", "README current Core version");
write(readmePath, readme);
const architecturePath = "docs/architecture.md";
write(architecturePath, replaceOnce(read(architecturePath), "current Kernel contract: 0.20.0", "current Kernel contract: 0.21.0", "architecture current Core version"));

const contractsPath = "docs/contracts.md";
let contracts = read(contractsPath);
contracts = replaceOnce(contracts, "As of Core Kernel `0.20.0`, ordinary model paths/schemas remain deliberately absent", "As of Core Kernel `0.21.0`, ordinary model paths/schemas remain deliberately absent", "contracts current Kernel version");
contracts = replaceOnce(
  contracts,
  "Kernel `0.20.0` makes Action semantic input and optimistic-concurrency metadata mechanically distinct in Runtime Discovery while keeping the current Action wire transport compatible.",
  "Kernel `0.20.0` makes Action semantic input and optimistic-concurrency metadata mechanically distinct in Runtime Discovery while keeping the current Action wire transport compatible. Kernel `0.21.0` removes Space invitation possession bearer tokens from API URL paths and carries them only in bounded JSON request bodies for preview/join; invitation authorization, expiry, exhaustion and replay semantics are unchanged.",
  "contracts Kernel evolution summary",
);
contracts = replaceOnce(
  contracts,
  "Kernel `0.20.0` separates Action semantic input from optimistic-concurrency metadata without changing the current body-based concurrency transport.",
  "Kernel `0.20.0` separates Action semantic input from optimistic-concurrency metadata without changing the current body-based concurrency transport; Kernel `0.21.0` moves Space invitation bearer tokens from URL paths to JSON request bodies as a Candidate/Public security migration without changing invitation lifecycle semantics.",
  "contracts Kernel chronology",
);
write(contractsPath, contracts);

const contractReadmePath = "packages/contracts/README.md";
let contractReadme = read(contractReadmePath);
contractReadme = replaceOnce(contractReadme, "Identity:       0.5.0\nCore Kernel:    0.15.0", "Identity:       0.6.0\nCore Kernel:    0.20.0", "HomeMew accepted handoff version labels");
contractReadme = replaceOnce(
  contractReadme,
  "Kernel 0.15.0 retains the existing HomeMew Mini Program Space/model surface while advancing platform Eventing from subscription-owned transport to reusable Webhook Endpoints plus model/event subscription filters. HomeMew Web can therefore configure one callback URL/signing secret for an external system and attach `event` and `task` filters to it without changing the ordinary model contract.\n\nThe Eventing configuration-shape correction does not require a new Model Contract revision because Webhook Endpoint/subscription APIs are explicit Kernel resources rather than ordinary Registry models. The corresponding Core deployment remains staging-first before HomeMew Web consumes the new Endpoint/filter API.",
  "The accepted HomeMew profile currently pins Core Kernel 0.20.0 / Identity 0.6.0. Kernel 0.21.0 is a Candidate/Public invitation-transport security migration: future invite preview/join callers must send the possession token in the JSON body instead of the URL path. Repository search found no current HomeMew application dependency on the invite preview/join routes, so no HomeMew code migration is required before validating the new Kernel in staging. The accepted integration profile remains on 0.20.0 until that downstream compatibility/staging decision is explicitly promoted; the exporter intentionally refuses to package newer Kernel source under the older accepted tuple.",
  "HomeMew current handoff explanation",
);
write(contractReadmePath, contractReadme);

console.log(`[apply-92] Core operation set ${coreSource.operationSetSha256}`);
console.log("[apply-92] migrated invite bearer token transport to body-bound POST endpoints");
