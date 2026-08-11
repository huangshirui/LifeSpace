import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import type { Bindings } from "../src/env";
import { publishModelDefinition } from "../src/model-registry";
import { processRegistryCreationDraftQueue, type RegistryCreationDraftQueueMessage } from "../src/registry-creation-draft-jobs";

type TestEnv = { DB: D1Database };

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}
async function keys() {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  return { privateKey: pem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)), publicKey: pem("PUBLIC KEY", await crypto.subtle.exportKey("spki", pair.publicKey)) };
}
async function token(privateKey: string, userId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({ iss: "lifespace-identity", aud: "lifespace-core", sub: userId, azp: "homemew-miniprogram", principal_type: "user", scope: "spaces:read spaces:write creation-drafts:read creation-drafts:write", iat, exp: iat + 900, jti: `tok_${crypto.randomUUID()}` }, privateKey, "RS256");
}
function runtime(publicKey: string, queueMessages: RegistryCreationDraftQueueMessage[]): Bindings {
  return {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    CREATION_DRAFT_QUEUE: { send: async (message: RegistryCreationDraftQueueMessage) => { queueMessages.push(message); } } as unknown as Queue,
    AI_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  } as Bindings;
}
async function call(path: string, bearer: string, publicKey: string, queueMessages: RegistryCreationDraftQueueMessage[], init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://core.test${path}`, { ...init, headers }, runtime(publicKey, queueMessages));
}
function batch(message: RegistryCreationDraftQueueMessage) {
  let acked = false; let retried = false;
  const item = { body: message, ack: () => { acked = true; }, retry: () => { retried = true; } };
  return { batch: { messages: [item] } as unknown as MessageBatch<RegistryCreationDraftQueueMessage>, state: () => ({ acked, retried }) };
}
async function createSpace(privateKey: string, publicKey: string, queued: RegistryCreationDraftQueueMessage[]) {
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const bearer = await token(privateKey, userId);
  const response = await call("/api/v1/spaces", bearer, publicKey, queued, { method: "POST", body: JSON.stringify({ kind: "family", name: "Draft Test", ownerDisplayName: "Alex", timezone: "Asia/Shanghai" }) });
  expect(response.status).toBe(201);
  const payload = await response.json() as { data: { id: string; ownerPersonId: string } };
  return { userId, bearer, spaceId: payload.data.id, ownerPersonId: payload.data.ownerPersonId };
}
async function publishModel(key: string, withPerson = false) {
  const principal = { type: "service" as const, id: `svc_${key}`, clientId: "lifespace-platform-admin", scopes: ["models:manage"], tokenId: `tok_${key}` };
  const db = (env as unknown as TestEnv).DB;
  const model = await publishModelDefinition({ DB: db } as Bindings, principal, {
    definitionVersion: 1,
    key,
    route: `${key.replaceAll("_", "-")}s`,
    description: `A dynamic ${key} record created only by this test`,
    display: { singular: key, plural: `${key}s` },
    fields: {
      title: { type: "string", description: "Short title", required: true, maxLength: 100 },
      ...(withPerson ? { ownerPersonId: { type: "person", description: "Person this record belongs to", required: true } } : {}),
    },
    access: ["read", "write"],
    lifecycle: { optimisticConcurrency: true, softDelete: true },
  }, "initial");
  await db.prepare(`INSERT OR REPLACE INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
    VALUES(?,?,?,?,?)`).bind("homemew-miniprogram", model.key, "write", "service", "svc_creation_draft_test").run();
  return model;
}

describe("Registry-driven creation drafts", () => {
  it("discovers a newly published model and resolves Person refs without source-code changes", async () => {
    const { privateKey, publicKey } = await keys(); const queued: RegistryCreationDraftQueueMessage[] = [];
    const home = await createSpace(privateKey, publicKey, queued);
    const model = await publishModel(`journal_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`, true);

    const create = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts`, home.bearer, publicKey, queued, { method: "POST", body: JSON.stringify({ text: "给我记一条今天很开心", viewingTimezone: "Asia/Shanghai" }) });
    expect(create.status).toBe(202);
    const created = await create.json() as { data: { draftId: string; modelContractRevision: string } };
    expect(created.data.modelContractRevision).toMatch(/^mct_/);
    expect(queued).toHaveLength(1);

    const work = batch(queued.shift()!);
    await processRegistryCreationDraftQueue(work.batch, runtime(publicKey, queued), {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      createProvider: () => ({
        generate: async (input) => {
          const descriptors = input.models as Array<{ key: string }>;
          expect(descriptors.some((item) => item.key === model.key)).toBe(true);
          expect(JSON.stringify(input.responseSchema)).toContain(model.key);
          return { output: { status: "ready", modelKey: model.key, draft: { title: "今天很开心", ownerPersonId: "p1" }, missingFields: [], warnings: [] }, metadata: { providerStatus: 200 } };
        },
      }),
    });
    expect(work.state()).toEqual({ acked: true, retried: false });

    const poll = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${created.data.draftId}`, home.bearer, publicKey, queued);
    expect(await poll.json()).toMatchObject({ data: { status: "ready", modelKey: model.key, modelVersion: 1, draft: { title: "今天很开心", ownerPersonId: home.ownerPersonId }, missingFields: [] } });
    const row = await (env as unknown as TestEnv).DB.prepare("SELECT input_text FROM creation_draft_jobs WHERE id=?").bind(created.data.draftId).first<{ input_text: string | null }>();
    expect(row?.input_text).toBeNull();
  });

  it("returns dynamic model ambiguity and requeues the chosen model", async () => {
    const { privateKey, publicKey } = await keys(); const queued: RegistryCreationDraftQueueMessage[] = [];
    const home = await createSpace(privateKey, publicKey, queued);
    const left = await publishModel(`idea_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`);
    const right = await publishModel(`note_${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`);
    const create = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts`, home.bearer, publicKey, queued, { method: "POST", body: JSON.stringify({ text: "以后也许去海边", viewingTimezone: "Asia/Shanghai" }) });
    const created = await create.json() as { data: { draftId: string } };

    await processRegistryCreationDraftQueue(batch(queued.shift()!).batch, runtime(publicKey, queued), {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      createProvider: () => ({ generate: async () => ({ output: { status: "choose_model", candidateModels: [left.key, right.key] }, metadata: { providerStatus: 200 } }) }),
    });
    const choosePoll = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${created.data.draftId}`, home.bearer, publicKey, queued);
    expect(await choosePoll.json()).toMatchObject({ data: { status: "choose_model", candidateModels: [left.key, right.key] } });

    const choose = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${created.data.draftId}/choose-model`, home.bearer, publicKey, queued, { method: "POST", body: JSON.stringify({ targetModelKey: right.key }) });
    expect(choose.status).toBe(202);
    expect(queued).toHaveLength(1);
    await processRegistryCreationDraftQueue(batch(queued.shift()!).batch, runtime(publicKey, queued), {
      now: () => new Date("2026-08-11T10:01:00.000Z"),
      createProvider: () => ({ generate: async (input) => {
        expect(input.targetModelKey).toBe(right.key);
        return { output: { status: "ready", modelKey: right.key, draft: { title: "以后也许去海边" }, missingFields: [], warnings: [] }, metadata: { providerStatus: 200 } };
      } }),
    });
    const ready = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${created.data.draftId}`, home.bearer, publicKey, queued);
    expect(await ready.json()).toMatchObject({ data: { status: "ready", modelKey: right.key, draft: { title: "以后也许去海边" } } });
  });
});
