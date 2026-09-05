import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceOnce(content, before, after, label) {
  if (!content.includes(before)) throw new Error(`Missing expected snippet: ${label}`);
  return content.replace(before, after);
}

// Core Runtime Discovery: carry the Space label only along already-authorized runtime context.
{
  const path = 'apps/core/src/runtime-discovery.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    'type MembershipAccessRow = MembershipRow & { space_id: string };',
    'type MembershipAccessRow = MembershipRow & { space_id: string; space_name: string };',
    'membership access row',
  );
  content = replaceOnce(
    content,
    'type GrantAccessRow = GrantRow & { source_space_id: string };',
    'type GrantAccessRow = GrantRow & { source_space_id: string; space_name: string };',
    'grant access row',
  );
  content = replaceOnce(
    content,
    'SELECT m.space_id,m.role\n        FROM space_memberships m',
    'SELECT m.space_id,m.role,s.name space_name\n        FROM space_memberships m',
    'aggregate membership Space label',
  );
  content = replaceOnce(
    content,
    'SELECT g.source_space_id,g.resource_type,g.resource_id,g.permission\n      FROM data_grants g',
    'SELECT g.source_space_id,g.resource_type,g.resource_id,g.permission,s.name space_name\n      FROM data_grants g',
    'aggregate grant Space label',
  );
  content = replaceOnce(
    content,
    `    const memberships = membershipIndex >= 0 ? (results[membershipIndex].results ?? []) as MembershipAccessRow[] : [];\n    const membershipsBySpace = new Map(memberships.map((row) => [row.space_id, { role: row.role }]));\n    const grantsBySpace = new Map<string, GrantRow[]>();\n    for (const row of (results[grantsIndex].results ?? []) as GrantAccessRow[]) pushGrant(grantsBySpace, row);`,
    `    const memberships = membershipIndex >= 0 ? (results[membershipIndex].results ?? []) as MembershipAccessRow[] : [];\n    const membershipsBySpace = new Map(memberships.map((row) => [row.space_id, { role: row.role }]));\n    const spaceNamesById = new Map(memberships.map((row) => [row.space_id, row.space_name]));\n    const grantsBySpace = new Map<string, GrantRow[]>();\n    for (const row of (results[grantsIndex].results ?? []) as GrantAccessRow[]) {\n      pushGrant(grantsBySpace, row);\n      if (!spaceNamesById.has(row.source_space_id)) spaceNamesById.set(row.source_space_id, row.space_name);\n    }`,
    'aggregate Space label map',
  );
  content = replaceOnce(
    content,
    '        return visible.length ? [{ spaceId, models: visible }] : [];',
    '        return visible.length ? [{ spaceId, spaceName: spaceNamesById.get(spaceId)!, models: visible }] : [];',
    'aggregate discovery result',
  );
  content = replaceOnce(
    content,
    'context.env.DB.prepare("SELECT id FROM spaces WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(spaceId),',
    'context.env.DB.prepare("SELECT id,name FROM spaces WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(spaceId),',
    'single Space discovery query',
  );
  content = replaceOnce(
    content,
    '    const space = (results[0].results ?? [])[0] as { id: string } | undefined;',
    '    const space = (results[0].results ?? [])[0] as { id: string; name: string } | undefined;',
    'single Space row type',
  );
  content = replaceOnce(
    content,
    '    return context.json(success({ spaceId, models: visible }));',
    '    return context.json(success({ spaceId, spaceName: visible.length ? space.name : null, models: visible }));',
    'single Space discovery result',
  );
  write(path, content);
}

// Cross-Space tests: readable labels are allowed, administration metadata remains hidden.
{
  const path = 'apps/core/test/me-runtime-discovery.integration.test.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    'it("discovers effective models across membership and grant-only Spaces without leaking Space detail", async () => {',
    'it("discovers effective models across membership and grant-only Spaces with minimal labels but no Space administration detail", async () => {',
    'aggregate discovery test title',
  );
  content = replaceOnce(
    content,
    'const payload = await response.json<{ data: { spaces: Array<{ spaceId: string; models: Array<{ key: string; access: string[] }>; name?: string }> } }>();',
    'const payload = await response.json<{ data: { spaces: Array<{ spaceId: string; spaceName: string; models: Array<{ key: string; access: string[] }>; name?: string; kind?: string; timezone?: string; role?: string }> } }>();',
    'aggregate payload type',
  );
  content = replaceOnce(
    content,
    `    for (const space of payload.data.spaces) {\n      expect(space.models).toEqual(expect.arrayContaining([\n        expect.objectContaining({ key: f.modelKey, access: ["read", "write"] }),\n      ]));\n      expect(space).not.toHaveProperty("name");\n    }`,
    `    expect(Object.fromEntries(payload.data.spaces.map((space) => [space.spaceId, space.spaceName]))).toEqual({\n      [f.memberSpaceId]: "Member Space",\n      [f.sharedSpaceId]: "Shared Space",\n    });\n    for (const space of payload.data.spaces) {\n      expect(space.models).toEqual(expect.arrayContaining([\n        expect.objectContaining({ key: f.modelKey, access: ["read", "write"] }),\n      ]));\n      expect(space).not.toHaveProperty("name");\n      expect(space).not.toHaveProperty("kind");\n      expect(space).not.toHaveProperty("timezone");\n      expect(space).not.toHaveProperty("role");\n    }`,
    'aggregate label assertions',
  );
  content = replaceOnce(
    content,
    'const firstPayload = await first.json<{ data: { spaces: Array<{ spaceId: string; models: Array<{ key: string; access: string[] }> }> } }>();',
    'const firstPayload = await first.json<{ data: { spaces: Array<{ spaceId: string; spaceName: string; models: Array<{ key: string; access: string[] }> }> } }>();',
    'service payload type',
  );
  content = replaceOnce(
    content,
    '        spaceId: f.sharedSpaceId,\n        models: expect.arrayContaining([expect.objectContaining({ key: f.modelKey, access: ["read"] })]),',
    '        spaceId: f.sharedSpaceId,\n        spaceName: "Shared Space",\n        models: expect.arrayContaining([expect.objectContaining({ key: f.modelKey, access: ["read"] })]),',
    'service label assertion',
  );
  // The Agent test has the same structural expectation; add its label too.
  const agentNeedle = '        spaceId: f.sharedSpaceId,\n        models: expect.arrayContaining([expect.objectContaining({ key: f.modelKey, access: ["read"] })]),';
  if (content.includes(agentNeedle)) {
    content = content.replace(agentNeedle, '        spaceId: f.sharedSpaceId,\n        spaceName: "Shared Space",\n        models: expect.arrayContaining([expect.objectContaining({ key: f.modelKey, access: ["read"] })]),');
  }
  write(path, content);
}

// Single-Space discovery: label is present only while an effective model capability exists.
{
  const path = 'apps/core/test/runtime-discovery.integration.test.ts';
  let content = read(path);
  content = replaceOnce(
    content,
    'const payload = await response.json<{ data: { models: Array<{',
    'const payload = await response.json<{ data: { spaceName: string | null; models: Array<{',
    'single Space payload type',
  );
  content = replaceOnce(
    content,
    '    const model = payload.data.models.find((entry) => entry.key === f.modelKey);',
    '    expect(payload.data.spaceName).toBe("Discovery Test");\n    const model = payload.data.models.find((entry) => entry.key === f.modelKey);',
    'single Space label assertion',
  );
  content = replaceOnce(
    content,
    '    const firstPayload = await first.json<{ data: { models: Array<{ key: string }> } }>();\n    expect(firstPayload.data.models.some((model) => model.key === f.modelKey)).toBe(true);',
    '    const firstPayload = await first.json<{ data: { spaceName: string | null; models: Array<{ key: string }> } }>();\n    expect(firstPayload.data.spaceName).toBe("Discovery Test");\n    expect(firstPayload.data.models.some((model) => model.key === f.modelKey)).toBe(true);',
    'service single Space label',
  );
  content = replaceOnce(
    content,
    '    const secondPayload = await second.json<{ data: { models: Array<{ key: string }> } }>();\n    expect(secondPayload.data.models.some((model) => model.key === f.modelKey)).toBe(false);',
    '    const secondPayload = await second.json<{ data: { spaceName: string | null; models: Array<{ key: string }> } }>();\n    expect(secondPayload.data.spaceName).toBeNull();\n    expect(secondPayload.data.models.some((model) => model.key === f.modelKey)).toBe(false);',
    'revoked single Space label',
  );
  write(path, content);
}

// Kernel version bump for the additive public Runtime Discovery contract change.
{
  const packagePath = 'apps/core/package.json';
  const pkg = JSON.parse(read(packagePath));
  if (pkg.version !== '0.23.0') throw new Error(`Unexpected Core package version ${pkg.version}`);
  pkg.version = '0.24.0';
  write(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);

  const appPath = 'apps/core/src/app.ts';
  let app = read(appPath);
  app = replaceOnce(app, 'contractVersion: "0.23.0"', 'contractVersion: "0.24.0"', 'Core status version');
  write(appPath, app);
}

// OpenAPI is checked in as JSON-compatible YAML; update the exact public projection mechanically.
{
  const path = 'apps/core/openapi.yaml';
  const document = JSON.parse(read(path));
  if (document.info?.version !== '0.23.0') throw new Error(`Unexpected Kernel OpenAPI version ${document.info?.version}`);
  document.info.version = '0.24.0';

  const statusVersion = document.components?.schemas?.StatusResponse?.properties?.data?.properties?.contractVersion;
  if (!statusVersion || statusVersion.const !== '0.23.0') throw new Error('StatusResponse contractVersion shape drifted');
  statusVersion.const = '0.24.0';

  const aggregate = document.paths?.['/api/v1/me/_discovery']?.get;
  if (!aggregate?.description) throw new Error('Aggregate Runtime Discovery path missing');
  aggregate.description = aggregate.description.replace(
    'Each Space entry exposes only its spaceId plus effective model metadata and does not grant Space-detail authority.',
    'Each Space entry exposes its stable spaceId plus a minimal current spaceName label and effective model metadata. The label is Runtime Context Projection only and does not grant Space-detail, membership or administration authority.',
  );
  if (!aggregate.description.includes('spaceName')) throw new Error('Aggregate Runtime Discovery description patch failed');

  const single = document.paths?.['/api/v1/spaces/{spaceId}/_discovery']?.get;
  if (!single?.description) throw new Error('Single-Space Runtime Discovery path missing');
  single.description += ' When the caller currently has at least one effective model capability in the Space, data.spaceName carries the minimal current human-readable Space label; otherwise it is null so this route does not become a Space-detail side channel.';

  const schemas = document.components?.schemas;
  const aggregateSpace = schemas?.RuntimeDiscoverySpace;
  if (!aggregateSpace?.properties?.spaceId || !aggregateSpace?.properties?.models) throw new Error('RuntimeDiscoverySpace schema drifted');
  aggregateSpace.required = ['spaceId', 'spaceName', 'models'];
  aggregateSpace.properties = {
    spaceId: aggregateSpace.properties.spaceId,
    spaceName: {
      type: 'string',
      minLength: 1,
      maxLength: 100,
      description: 'Current human-readable label for this already-authorized runtime Space reference. This is not Space-management authority.',
    },
    models: aggregateSpace.properties.models,
  };

  const singleData = schemas?.RuntimeDiscoveryResponse?.properties?.data;
  if (!singleData?.properties?.spaceId || !singleData?.properties?.models) throw new Error('RuntimeDiscoveryResponse data schema drifted');
  singleData.required = Array.from(new Set([...(singleData.required ?? []), 'spaceName']));
  singleData.properties = {
    spaceId: singleData.properties.spaceId,
    spaceName: {
      type: ['string', 'null'],
      minLength: 1,
      maxLength: 100,
      description: 'Current human-readable Space label when at least one effective model capability is visible; null otherwise.',
    },
    models: singleData.properties.models,
  };

  write(path, JSON.stringify(document));
}

// Contract sanity checks must lock the new bounded projection rather than the old raw-ID-only shape.
{
  const path = 'apps/core/scripts/check-openapi.mjs';
  let content = read(path);
  content = replaceOnce(content, 'document.info?.version !== "0.23.0"', 'document.info?.version !== "0.24.0"', 'OpenAPI checker version');
  content = replaceOnce(content, 'contractVersion?.const !== "0.23.0"', 'contractVersion?.const !== "0.24.0"', 'status checker version');
  content = replaceOnce(
    content,
    `if (schemas.RuntimeDiscoverySpace?.additionalProperties !== false\n    || JSON.stringify(schemas.RuntimeDiscoverySpace?.required) !== JSON.stringify(["spaceId", "models"])\n    || Object.keys(schemas.RuntimeDiscoverySpace?.properties ?? {}).some((key) => !["spaceId", "models"].includes(key))) {\n  throw new Error("Cross-Space discovery must expose only Space identity and effective model metadata");\n}`,
    `if (schemas.RuntimeDiscoverySpace?.additionalProperties !== false\n    || JSON.stringify(schemas.RuntimeDiscoverySpace?.required) !== JSON.stringify(["spaceId", "spaceName", "models"])\n    || schemas.RuntimeDiscoverySpace?.properties?.spaceName?.type !== "string"\n    || schemas.RuntimeDiscoverySpace?.properties?.spaceName?.maxLength !== 100\n    || Object.keys(schemas.RuntimeDiscoverySpace?.properties ?? {}).some((key) => !["spaceId", "spaceName", "models"].includes(key))) {\n  throw new Error("Cross-Space discovery must expose only stable Space identity, minimal label and effective model metadata");\n}\nconst singleDiscoveryData = schemas.RuntimeDiscoveryResponse?.properties?.data;\nif (!singleDiscoveryData?.required?.includes("spaceName")\n    || JSON.stringify(singleDiscoveryData?.properties?.spaceName?.type) !== JSON.stringify(["string", "null"])\n    || singleDiscoveryData?.properties?.spaceName?.maxLength !== 100) {\n  throw new Error("Single-Space discovery must expose a nullable bounded Space label without creating a Space-detail side channel");\n}`,
    'Runtime Discovery schema checks',
  );
  content = replaceOnce(
    content,
    'if (!aggregateDiscovery?.description?.includes("cross-Space")\n    || !aggregateDiscovery?.description?.includes("capability preview")',
    'if (!aggregateDiscovery?.description?.includes("cross-Space")\n    || !aggregateDiscovery?.description?.includes("spaceName")\n    || !aggregateDiscovery?.description?.includes("capability preview")',
    'aggregate description check',
  );
  content = replaceOnce(
    content,
    'if (!discovery?.description?.includes("semantic/domain input")',
    'if (!discovery?.description?.includes("spaceName")\n    || !discovery?.description?.includes("semantic/domain input")',
    'single discovery description check',
  );
  write(path, content);
}

// Keep documentation/version declarations aligned while preserving 0.23 as historical relation-lookup provenance.
{
  const path = 'apps/core/AGENTS.md';
  let content = read(path);
  content = replaceOnce(content, 'current Kernel version: 0.23.0', 'current Kernel version: 0.24.0', 'Core AGENTS version');
  write(path, content);
}
{
  const path = 'README.md';
  let content = read(path);
  content = replaceOnce(content, 'current repository Core Kernel contract is **0.23.0**', 'current repository Core Kernel contract is **0.24.0**', 'README Kernel version');
  write(path, content);
}
{
  const path = 'docs/architecture.md';
  let content = read(path);
  content = replaceOnce(content, 'current Kernel contract: 0.23.0', 'current Kernel contract: 0.24.0', 'architecture Kernel version');
  content = replaceOnce(
    content,
    'Record-relation lookup remains explicitly unavailable until LifeSpace has canonical record reference-label semantics instead of adapter heuristics such as guessing `name`, `title` or `summary`.',
    'Record-relation lookup remains explicitly unavailable until LifeSpace has canonical record reference-label semantics instead of adapter heuristics such as guessing `name`, `title` or `summary`. Kernel `0.24.0` also projects a minimal current human-readable Space label alongside an already-authorized Runtime Discovery Space reference, so n8n, MCP, Agents and generated UI can present the same Space without acquiring Space membership-management metadata or authority.',
    'architecture 0.24 context projection',
  );
  write(path, content);
}
{
  const path = 'docs/contracts.md';
  let content = read(path);
  content = replaceOnce(content, 'As of Core Kernel `0.23.0`', 'As of Core Kernel `0.24.0`', 'contracts current Kernel version');
  content = replaceOnce(
    content,
    '`record` / `record_list` lookup is explicitly unsupported until canonical record reference-label semantics are defined rather than guessed from model-specific field names.\n\nA concrete environment/build handoff',
    '`record` / `record_list` lookup is explicitly unsupported until canonical record reference-label semantics are defined rather than guessed from model-specific field names. Kernel `0.24.0` adds a minimal current `spaceName` label to already-authorized Runtime Discovery Space references; the label is Context Projection, not Space-detail or membership-management authority.\n\nA concrete environment/build handoff',
    'contracts 0.24 history',
  );
  content = replaceOnce(
    content,
    'The cross-Space response is deliberately minimal: each Space entry contains only `spaceId` and effective model metadata. A model-collection Data Grant can therefore make a source Space discoverable as an authorization target without granting Space-detail metadata such as name, kind, timezone or membership data. Clients that are separately authorized for Space details use the normal Space APIs.',
    'The cross-Space response is deliberately minimal but human-readable: each already-reachable Space entry contains stable `spaceId`, the current `spaceName` label and effective model metadata. The label is a bounded Runtime Context Projection so generated clients can identify an authorized Space without a second adapter-specific lookup. It does not expose kind, timezone, membership roles, owners or members and does not grant Space-management authority. The single-Space discovery response carries the same label only while at least one effective model capability is visible; otherwise `spaceName` is `null`. Clients that need actual Space administration/detail continue to use the normal Space APIs under their separate authority.',
    'Runtime Discovery minimal label contract',
  );
  write(path, content);
}

console.log('Issue #160 patch applied');
