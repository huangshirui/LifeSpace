import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { cleanupExpiredCreationDraftJobs } from "../src/creation-draft-cleanup";
import { processCreationDraftQueue, type CreationDraftQueueMessage } from "../src/creation-draft-jobs";

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
async function token(privateKey: string, userId: string, scopes = "spaces:read spaces:write creation-drafts:read creation-drafts:write") {
  const iat = Math.floor(Date.now() / 1000);
  return sign({ iss: "lifespace-identity", aud: "lifespace-core", sub: userId, azp: "homemew-miniprogram", principal_type: "user", scope: scopes, iat, exp: iat + 900, jti: `tok_${crypto.randomUUID()}` }, privateKey, "RS256");
}

function runtime(publicKey: string, queueMessages: CreationDraftQueueMessage[]) {
  return {
    DB: (env as unknown as TestEnv).DB,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
    CREATION_DRAFT_QUEUE: { send: async (message: CreationDraftQueueMessage) => { queueMessages.push(message); } } as unknown as Queue,
    AI_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit,
  };
}
async function call(path: string, bearer: string, publicKey: string, queueMessages: CreationDraftQueueMessage[], init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${bearer}`);
  if (init.body) headers.set("content-type", "application/json");
  return createApp().request(`http://core.test${path}`, { ...init, headers }, runtime(publicKey, queueMessages));
}
function batch(message: CreationDraftQueueMessage) {
  let acked = false;
  let retried = false;
  const item = { body: message, ack: () => { acked = true; }, retry: () => { retried = true; } };
  return { batch: { messages: [item] } as unknown as MessageBatch<CreationDraftQueueMessage>, state: () => ({ acked, retried }) };
}

async function createSpace(privateKey: string, publicKey: string, queueMessages: CreationDraftQueueMessage[]) {
  const userId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
  const bearer = await token(privateKey, userId);
  const response = await call("/api/v1/spaces", bearer, publicKey, queueMessages, {
    method: "POST",
    body: JSON.stringify({ kind: "family", name: "Draft Test", ownerDisplayName: "Alex", timezone: "Asia/Shanghai" }),
  });
  expect(response.status).toBe(201);
  const payload = await response.json() as { data: { id: string; ownerPersonId: string } };
  return { userId, bearer, spaceId: payload.data.id, ownerPersonId: payload.data.ownerPersonId };
}

describe("native Space creation drafts", () => {
  it("queues, polls and resolves person refs without exposing input after ready", async () => {
    const { privateKey, publicKey } = await keys();
    const queued: CreationDraftQueueMessage[] = [];
    const home = await createSpace(privateKey, publicKey, queued);

    const create = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts`, home.bearer, publicKey, queued, {
      method: "POST", body: JSON.stringify({ text: "明天下午和我开会", viewingTimezone: "Asia/Shanghai" }),
    });
    expect(create.status).toBe(202);
    const created = await create.json() as { data: { draftId: string; status: string } };
    expect(created.data.status).toBe("processing");
    expect(queued).toHaveLength(1);

    const pending = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${created.data.draftId}`, home.bearer, publicKey, queued);
    expect(await pending.json()).toMatchObject({ data: { status: "processing" } });

    const work = batch(queued[0]!);
    await processCreationDraftQueue(work.batch, runtime(publicKey, queued) as never, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      createProvider: () => ({
        generate: async () => ({
          output: {
            status: "ready", kind: "event", missingFields: [], warnings: [],
            draft: {
              summary: "开会", description: null, isAllDay: true, startDate: "2026-08-12", endDate: null,
              endDateExclusive: "2026-08-13", startTime: null, endTime: null, startTimezone: null, endTimezone: null,
              location: null, attendeeRefs: ["p1"],
            },
          },
          metadata: { providerStatus: 200 },
        }),
      }) as never,
    });
    expect(work.state()).toEqual({ acked: true, retried: false });

    const ready = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${created.data.draftId}`, home.bearer, publicKey, queued);
    expect(await ready.json()).toMatchObject({ data: { status: "ready", kind: "event", draft: { attendeePersonIds: [home.ownerPersonId] } } });
    const stored = await (env as unknown as TestEnv).DB.prepare("SELECT input_text,status FROM creation_draft_jobs WHERE id=?").bind(created.data.draftId).first<{ input_text: string | null; status: string }>();
    expect(stored).toEqual({ input_text: null, status: "ready" });
  });

  it("keeps ambiguous-kind input only until the user selects a kind and enforces draft ownership", async () => {
    const { privateKey, publicKey } = await keys();
    const queued: CreationDraftQueueMessage[] = [];
    const home = await createSpace(privateKey, publicKey, queued);
    const create = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts`, home.bearer, publicKey, queued, {
      method: "POST", body: JSON.stringify({ text: "买牛奶", viewingTimezone: "Asia/Shanghai" }),
    });
    const draftId = ((await create.json()) as { data: { draftId: string } }).data.draftId;
    const firstWork = batch(queued.shift()!);
    await processCreationDraftQueue(firstWork.batch, runtime(publicKey, queued) as never, {
      now: () => new Date("2026-08-11T10:00:00.000Z"),
      createProvider: () => ({ generate: async () => ({ output: { status: "choose_kind", candidateKinds: ["task", "wish"] }, metadata: { providerStatus: 200 } }) }) as never,
    });
    const chooseState = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${draftId}`, home.bearer, publicKey, queued);
    expect(await chooseState.json()).toMatchObject({ data: { status: "choose_kind", candidateKinds: ["task", "wish"] } });
    const retained = await (env as unknown as TestEnv).DB.prepare("SELECT input_text FROM creation_draft_jobs WHERE id=?").bind(draftId).first<{ input_text: string | null }>();
    expect(retained?.input_text).toBe("买牛奶");

    const choose = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${draftId}/choose-kind`, home.bearer, publicKey, queued, {
      method: "POST", body: JSON.stringify({ targetKind: "task" }),
    });
    expect(choose.status).toBe(202);
    expect(queued).toHaveLength(1);

    const strangerId = `usr_${crypto.randomUUID().replaceAll("-", "")}`;
    const strangerToken = await token(privateKey, strangerId);
    const stranger = await call(`/api/v1/spaces/${home.spaceId}/creation-drafts/${draftId}`, strangerToken, publicKey, queued);
    expect(stranger.status).toBe(403);
  });

  it("physically cleans expired ephemeral jobs", async () => {
    const db = (env as unknown as TestEnv).DB;
    await db.prepare(`INSERT INTO creation_draft_jobs(id,space_id,requested_by_user_id,status,generation,input_text,viewing_timezone,expires_at)
      SELECT 'drf_expired',id,'usr_cleanup','queued',1,'test','UTC','2026-01-01T00:00:00.000Z' FROM spaces LIMIT 1`).run();
    const result = await cleanupExpiredCreationDraftJobs({ DB: db } as never, new Date("2026-08-11T12:00:00.000Z"));
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await db.prepare("SELECT id FROM creation_draft_jobs WHERE id='drf_expired'").first()).toBeNull();
  });
});
