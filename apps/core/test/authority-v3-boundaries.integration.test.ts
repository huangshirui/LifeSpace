import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

type TestEnv = { DB: D1Database };
type KeyPair = { privateKey: string; publicKey: string };

type TokenInput = {
  principalType: "user" | "agent";
  principalId: string;
  actorId?: string;
  appId?: string;
  scopes?: string[];
};

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys(): Promise<KeyPair> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  return {
    privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)),
  };
}

async function token(privateKey: string, input: TokenInput) {
  const iat = Math.floor(Date.now() / 1000);
  const appId = input.appId ?? "authority-v3-boundary-app";
  const scopes = input.scopes ?? ["resources:read", "resources:write"];
  if (!input.actorId) {
    return sign({
      iss: "lifespace-identity",
      aud: "lifespace-core",
      sub: input.principalId,
      azp: appId,
      principal_type: input.principalType,
      scope: scopes.join(" "),
      iat,
      exp: iat + 900,
      jti: `tok_${crypto.randomUUID()}`,
    }, privateKey, "RS256");
  }
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: input.actorId,
    azp: appId,
    principal_type: input.principalType,
    principal_id: input.principalId,
    actor_type: "agent",
    actor_id: input.actorId,
    purpose: "agent_execution",
    scope: scopes.join(" "),
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function request(publicKey: string, path: string, bearer: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://localhost${path}`, { ...init, headers }, {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  });
}

async function payload(response: Response): Promise<any> {
  return response.json<any>();
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
  expect(response.status).toBe(status);
  expect((await payload(response)).error.code).toBe(code);
}

async function seed(userId: string, spaceId: string, applicationIds = ["authority-v3-boundary-app"]) {
  const db = (env as unknown as TestEnv).DB;
  const now = new Date().toISOString();
  const statements = [
    db.prepare(`INSERT INTO spaces(id,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?)`).bind(spaceId, "Authority v3 boundaries", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${crypto.randomUUID()}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${crypto.randomUUID()}`, spaceId, userId, "Owner", now, now),
  ];
  for (const applicationId of applicationIds) {
    for (const modelKey of ["event", "task"]) {
      statements.push(db.prepare(`INSERT INTO application_model_access(
        application_id,model_key,max_access,created_by_type,created_by_id,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(application_id,model_key) DO UPDATE SET max_access=excluded.max_access`)
        .bind(applicationId, modelKey, "write", "user", userId, now, now));
    }
  }
  await db.batch(statements);
}

async function issueRoot(
  publicKey: string,
  direct: string,
  spaceId: string,
  agentId: string,
  scope: { target: { type: "space" | "model" | "record"; id: string }; maxAccess: "read" | "write" },
  constraints?: { maxUses?: 1; expiresAt?: string; remainingRedelegationDepth?: number },
) {
  return request(publicKey, `/api/v1/spaces/${spaceId}/delegations`, direct, {
    method: "POST",
    body: JSON.stringify({ actor: { type: "agent", id: agentId }, scope, ...(constraints ? { constraints } : {}) }),
  });
}

async function issueChild(
  publicKey: string,
  representedIssuer: string,
  spaceId: string,
  parentDelegationId: string,
  agentId: string,
  scope: { target: { type: "space" | "model" | "record"; id: string }; maxAccess: "read" | "write" },
  constraints?: { maxUses?: 1; expiresAt?: string; remainingRedelegationDepth?: number },
) {
  return request(publicKey, `/api/v1/spaces/${spaceId}/delegations`, representedIssuer, {
    method: "POST",
    body: JSON.stringify({
      actor: { type: "agent", id: agentId },
      parentDelegationId,
      scope,
      ...(constraints ? { constraints } : {}),
    }),
  });
}

async function createTask(publicKey: string, bearer: string, spaceId: string, name: string) {
  const response = await request(publicKey, `/api/v1/spaces/${spaceId}/models/task/records`, bearer, {
    method: "POST",
    body: JSON.stringify({ name, assigneePersonIds: [] }),
  });
  expect(response.status).toBe(201);
  return (await payload(response)).data;
}

describe("Authority v3 bounded re-delegation boundaries", () => {
  it("rejects scope, access, expiry and depth widening plus invalid parents", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const representedA = await token(privateKey, {
      principalType: "user",
      principalId: userId,
      actorId: agentA,
    });
    const parentExpiry = new Date(Date.now() + 5 * 60_000).toISOString();
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { expiresAt: parentExpiry, remainingRedelegationDepth: 2 },
    );
    expect(rootResponse.status).toBe(201);
    const root = (await payload(rootResponse)).data;

    await expectError(await issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "task" }, maxAccess: "write" },
      { remainingRedelegationDepth: 1 },
    ), 403, "DELEGATION_SCOPE_INSUFFICIENT");

    const readRootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "read" },
      { remainingRedelegationDepth: 1 },
    );
    expect(readRootResponse.status).toBe(201);
    const readRoot = (await payload(readRootResponse)).data;
    await expectError(await issueChild(
      publicKey,
      representedA,
      spaceId,
      readRoot.id,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    ), 403, "DELEGATION_SCOPE_INSUFFICIENT");

    await expectError(await issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), remainingRedelegationDepth: 1 },
    ), 403, "DELEGATION_INVALID");

    await expectError(await issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 2 },
    ), 403, "DELEGATION_INVALID");

    await expectError(await issueChild(
      publicKey,
      representedA,
      spaceId,
      `dlg_${crypto.randomUUID().replaceAll("-", "")}`,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    ), 403, "DELEGATION_INVALID");

    await expectError(await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 4 },
    ), 400, "INVALID_REQUEST");
  });

  it("allows Root Principal and immediate issuer revocation without widening management authority", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentC = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 1 },
    );
    expect(rootResponse.status).toBe(201);
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentA });

    const childForIssuerResponse = await issueChild(
      publicKey, representedA, spaceId, root.id, agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    );
    expect(childForIssuerResponse.status).toBe(201);
    const childForIssuer = (await payload(childForIssuerResponse)).data;

    const childForRootResponse = await issueChild(
      publicKey, representedA, spaceId, root.id, agentC,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    );
    expect(childForRootResponse.status).toBe(201);
    const childForRoot = (await payload(childForRootResponse)).data;

    const unrelated = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentC });
    await expectError(await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/delegations/${childForIssuer.id}`,
      unrelated,
      { method: "DELETE" },
    ), 404, "DELEGATION_NOT_FOUND");

    const issuerRevoke = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/delegations/${childForIssuer.id}`,
      representedA,
      { method: "DELETE" },
    );
    expect(issuerRevoke.status).toBe(204);

    await expectError(await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/delegations/${root.id}`,
      representedA,
      { method: "DELETE" },
    ), 404, "DELEGATION_NOT_FOUND");

    const rootRevoke = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/delegations/${childForRoot.id}`,
      direct,
      { method: "DELETE" },
    );
    expect(rootRevoke.status).toBe(204);

    const rows = await (env as unknown as TestEnv).DB.prepare(
      "SELECT id,revoked_at FROM delegations WHERE id IN (?,?) ORDER BY id",
    ).bind(childForIssuer.id, childForRoot.id).all<{ id: string; revoked_at: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("supports the maximum depth and rejects propagation beyond it", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agents = Array.from({ length: 5 }, () => `agt_${crypto.randomUUID().replaceAll("-", "")}`);
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agents[0]!,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 3 },
    );
    expect(rootResponse.status).toBe(201);
    let parent = (await payload(rootResponse)).data;

    for (let index = 0; index < 3; index += 1) {
      const representedIssuer = await token(privateKey, {
        principalType: "user",
        principalId: userId,
        actorId: agents[index]!,
      });
      const childResponse = await issueChild(
        publicKey,
        representedIssuer,
        spaceId,
        parent.id,
        agents[index + 1]!,
        { target: { type: "model", id: "event" }, maxAccess: "write" },
        { remainingRedelegationDepth: 2 - index },
      );
      expect(childResponse.status).toBe(201);
      parent = (await payload(childResponse)).data;
    }

    const finalActor = await token(privateKey, {
      principalType: "user",
      principalId: userId,
      actorId: agents[3]!,
    });
    const create = await request(publicKey, `/api/v1/spaces/${spaceId}/models/event/records`, finalActor, {
      method: "POST",
      headers: { "x-lifespace-delegation-id": parent.id },
      body: JSON.stringify({
        summary: "Maximum-depth delegated event",
        when: { kind: "date", start: "2026-10-10", endExclusive: "2026-10-11" },
      }),
    });
    expect(create.status).toBe(201);

    const representedFinal = await token(privateKey, {
      principalType: "user",
      principalId: userId,
      actorId: agents[3]!,
    });
    await expectError(await issueChild(
      publicKey,
      representedFinal,
      spaceId,
      parent.id,
      agents[4]!,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    ), 403, "DELEGATION_INVALID");
  });

  it("keeps re-delegation inside the parent Application Context", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    const appA = "authority-v3-app-a";
    const appB = "authority-v3-app-b";
    await seed(userId, spaceId, [appA, appB]);

    const directA = await token(privateKey, { principalType: "user", principalId: userId, appId: appA });
    const rootResponse = await issueRoot(
      publicKey,
      directA,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 1 },
    );
    expect(rootResponse.status).toBe(201);
    const root = (await payload(rootResponse)).data;

    const representedAOtherApp = await token(privateKey, {
      principalType: "user",
      principalId: userId,
      actorId: agentA,
      appId: appB,
    });
    await expectError(await issueChild(
      publicKey,
      representedAOtherApp,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    ), 403, "DELEGATION_INVALID");
  });

  it("invalidates descendants when an ancestor expires", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), remainingRedelegationDepth: 1 },
    );
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentA });
    const childResponse = await issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { expiresAt: new Date(Date.now() + 4 * 60_000).toISOString(), remainingRedelegationDepth: 0 },
    );
    expect(childResponse.status).toBe(201);
    const child = (await payload(childResponse)).data;

    await (env as unknown as TestEnv).DB.prepare("UPDATE delegations SET expires_at=? WHERE id=?")
      .bind(new Date(Date.now() - 60_000).toISOString(), root.id).run();

    const representedB = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentB });
    await expectError(await request(publicKey, `/api/v1/spaces/${spaceId}/models/event/records`, representedB, {
      method: "POST",
      headers: { "x-lifespace-delegation-id": child.id },
      body: JSON.stringify({
        summary: "Expired ancestor must deny",
        when: { kind: "date", start: "2026-10-11", endExclusive: "2026-10-12" },
      }),
    }), 403, "DELEGATION_INVALID");
  });

  it("allows at most one concurrent descendant exercise of a shared single-use ancestor", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { maxUses: 1, remainingRedelegationDepth: 1 },
    );
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentA });

    const childResponses = await Promise.all(["one", "two"].map(() => issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "event" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    )));
    expect(childResponses.every((response) => response.status === 201)).toBe(true);
    const children = await Promise.all(childResponses.map(async (response) => (await payload(response)).data));
    const representedB = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentB });

    const attempts = await Promise.all(children.map((child, index) => request(
      publicKey,
      `/api/v1/spaces/${spaceId}/models/event/records`,
      representedB,
      {
        method: "POST",
        headers: { "x-lifespace-delegation-id": child.id },
        body: JSON.stringify({
          summary: `Concurrent descendant ${index}`,
          when: { kind: "date", start: `2026-10-${12 + index}`, endExclusive: `2026-10-${13 + index}` },
        }),
      },
    )));
    expect(attempts.filter((response) => response.status === 201)).toHaveLength(1);
    expect(attempts.filter((response) => response.status === 403)).toHaveLength(1);

    const consumed = await (env as unknown as TestEnv).DB.prepare(
      "SELECT consumed_at,consumed_by_change_id FROM delegations WHERE id=?",
    ).bind(root.id).first<{ consumed_at: string | null; consumed_by_change_id: string | null }>();
    expect(consumed?.consumed_at).toBeTruthy();
    expect(consumed?.consumed_by_change_id).toMatch(/^chg_/);
  });

  it("rejects an atomic Batch that exercises one shared single-use ancestor twice", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "task" }, maxAccess: "write" },
      { maxUses: 1, remainingRedelegationDepth: 1 },
    );
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentA });
    const childResponses = await Promise.all(["a", "b"].map(() => issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "task" }, maxAccess: "write" },
      { remainingRedelegationDepth: 0 },
    )));
    const children = await Promise.all(childResponses.map(async (response) => {
      expect(response.status).toBe(201);
      return (await payload(response)).data;
    }));
    const representedB = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentB });
    const before = await (env as unknown as TestEnv).DB.prepare(
      "SELECT COUNT(*) count FROM resource_records WHERE space_id=? AND model_key='task' AND deleted_at IS NULL",
    ).bind(spaceId).first<{ count: number }>();

    const batch = await request(publicKey, `/api/v1/spaces/${spaceId}/models/batch`, representedB, {
      method: "POST",
      body: JSON.stringify({
        operations: children.map((child, index) => ({
          operation: "create",
          modelKey: "task",
          delegationId: child.id,
          data: { name: `Shared ancestor ${index}`, assigneePersonIds: [] },
        })),
      }),
    });
    await expectError(batch, 403, "DELEGATION_INVALID");

    const state = await (env as unknown as TestEnv).DB.prepare(
      "SELECT consumed_at FROM delegations WHERE id=?",
    ).bind(root.id).first<{ consumed_at: string | null }>();
    expect(state?.consumed_at).toBeNull();
    const after = await (env as unknown as TestEnv).DB.prepare(
      "SELECT COUNT(*) count FROM resource_records WHERE space_id=? AND model_key='task' AND deleted_at IS NULL",
    ).bind(spaceId).first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });

  it("consumes every single-use Delegation in an ancestor chain on a successful read", async () => {
    const { privateKey, publicKey } = await keys();
    const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentA = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const agentB = `agt_${crypto.randomUUID().replaceAll("-", "")}`;
    const spaceId = `spc_${crypto.randomUUID().replaceAll("-", "")}`;
    await seed(userId, spaceId);

    const direct = await token(privateKey, { principalType: "user", principalId: userId });
    const task = await createTask(publicKey, direct, spaceId, "Single-use chain read");
    const rootResponse = await issueRoot(
      publicKey,
      direct,
      spaceId,
      agentA,
      { target: { type: "model", id: "task" }, maxAccess: "read" },
      { maxUses: 1, remainingRedelegationDepth: 1 },
    );
    const root = (await payload(rootResponse)).data;
    const representedA = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentA });
    const childResponse = await issueChild(
      publicKey,
      representedA,
      spaceId,
      root.id,
      agentB,
      { target: { type: "model", id: "task" }, maxAccess: "read" },
      { maxUses: 1, remainingRedelegationDepth: 0 },
    );
    expect(childResponse.status).toBe(201);
    const child = (await payload(childResponse)).data;
    const representedB = await token(privateKey, { principalType: "user", principalId: userId, actorId: agentB });

    const first = await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/models/task/records/${task.id}`,
      representedB,
      { headers: { "x-lifespace-delegation-id": child.id } },
    );
    expect(first.status).toBe(200);

    const states = await (env as unknown as TestEnv).DB.prepare(
      "SELECT id,consumed_at,consumed_by_change_id FROM delegations WHERE id IN (?,?) ORDER BY id",
    ).bind(root.id, child.id).all<{ id: string; consumed_at: string | null; consumed_by_change_id: string | null }>();
    expect(states.results).toHaveLength(2);
    expect(states.results.every((row) => row.consumed_at !== null && row.consumed_by_change_id === null)).toBe(true);

    await expectError(await request(
      publicKey,
      `/api/v1/spaces/${spaceId}/models/task/records/${task.id}`,
      representedB,
      { headers: { "x-lifespace-delegation-id": child.id } },
    ), 403, "DELEGATION_INVALID");
  });
});
