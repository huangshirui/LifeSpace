import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import {
  DAY_RECORD_MODEL_DEFINITION,
  EVENT_MODEL_DEFINITION,
  TASK_MODEL_DEFINITION,
} from "../src/builtin-models";
import type { Bindings } from "../src/env";
import { generateModelContract } from "../src/model-contract";
import type { ModelDefinition } from "../src/model-definition";
import type { PublishedModel } from "../src/model-registry";
import { projectModelSemanticFacts } from "../src/model-semantic-projection";

type TestEnv = { DB: D1Database };

type OpenApiParameter = {
  name?: string;
  schema?: Record<string, unknown>;
  [key: string]: unknown;
};

function published(definition: ModelDefinition): PublishedModel {
  return {
    id: `mdl_${definition.key}`,
    key: definition.key,
    route: definition.route,
    version: 7,
    state: "published",
    schemaHash: `sha_${definition.key}`,
    compatibility: "compatible",
    definition,
    publishedAt: "2026-09-07T00:00:00.000Z",
  };
}

function collectionParameters(contract: Awaited<ReturnType<typeof generateModelContract>>, model: PublishedModel): OpenApiParameter[] {
  const paths = contract.openapi.paths as Record<string, { get?: { parameters?: OpenApiParameter[] } }>;
  return paths[`/api/v1/spaces/{spaceId}/${model.route}`]?.get?.parameters ?? [];
}

function parameter(parameters: OpenApiParameter[], name: string): OpenApiParameter {
  const found = parameters.find((entry) => entry.name === name);
  if (!found) throw new Error(`Missing generated query parameter ${name}`);
  return found;
}

function pem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const binary = String.fromCharCode(...new Uint8Array(bytes));
  const base64 = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----`;
}

async function keys() {
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

async function userToken(privateKey: string, userId: string, clientId: string) {
  const iat = Math.floor(Date.now() / 1000);
  return sign({
    iss: "lifespace-identity",
    aud: "lifespace-core",
    sub: userId,
    azp: clientId,
    principal_type: "user",
    scope: "resources:read resources:write resources:manage",
    iat,
    exp: iat + 900,
    jti: `tok_${crypto.randomUUID()}`,
  }, privateKey, "RS256");
}

async function runtimeDiscoveryFixture() {
  const db = (env as unknown as TestEnv).DB;
  const { privateKey, publicKey } = await keys();
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const userId = `usr_${suffix}`;
  const clientId = `app_semantic_projection_${suffix}`;
  const spaceId = `spc_${suffix}`;
  const now = new Date().toISOString();

  await db.batch([
    db.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at,timezone)
      VALUES(?,?,?,?,?,?,?)`).bind(spaceId, "personal", "Semantic Projection", userId, now, now, "UTC"),
    db.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`mem_${suffix}`, spaceId, userId, "owner", now, now),
    db.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at)
      VALUES(?,?,?,?,?,?)`).bind(`per_${suffix}`, spaceId, userId, "Projection Tester", now, now),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, "task", "write", "service", "svc_projection_test"),
    db.prepare(`INSERT INTO application_model_access(application_id,model_key,max_access,created_by_type,created_by_id)
      VALUES(?,?,?,?,?)`).bind(clientId, "event", "write", "service", "svc_projection_test"),
  ]);

  const accessToken = await userToken(privateKey, userId, clientId);
  const response = await createApp().request(`http://localhost/api/v1/spaces/${spaceId}/_discovery`, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, {
    DB: db,
    IDENTITY_PUBLIC_KEY: publicKey,
    ENVIRONMENT: "test",
  } as Bindings);
  expect(response.status).toBe(200);
  return response.json<{ data: { models: Array<Record<string, unknown>> } }>();
}

describe("shared Model semantic projection", () => {
  it("matches generated Generic Query parameter semantics", async () => {
    for (const definition of [TASK_MODEL_DEFINITION, EVENT_MODEL_DEFINITION, DAY_RECORD_MODEL_DEFINITION]) {
      const model = published(definition);
      const facts = projectModelSemanticFacts(model);
      const contract = await generateModelContract([model]);
      const parameters = collectionParameters(contract, model);
      const names = new Set(parameters.map((entry) => entry.name));

      if (facts.query.search) expect(names.has(facts.query.search.parameter)).toBe(true);
      for (const filter of facts.query.filters) {
        expect(names.has(filter.parameter), `${model.key}:${filter.parameter}`).toBe(true);
        if (filter.range) {
          expect(names.has(filter.range.fromParameter)).toBe(true);
          expect(names.has(filter.range.toParameter)).toBe(true);
        }
      }
      for (const capabilityParameter of facts.query.capabilityParameters) {
        const generated = parameter(parameters, capabilityParameter.parameter);
        if (capabilityParameter.pairedWith) {
          expect(generated["x-lifespace-paired-with"]).toBe(capabilityParameter.pairedWith);
        }
      }

      const generatedSort = parameter(parameters, "sort").schema!;
      const generatedSortText = JSON.stringify(generatedSort);
      for (const value of facts.query.sort.genericValues) expect(generatedSortText).toContain(value);
      for (const value of facts.query.sort.semantic.values) expect(generatedSortText).toContain(value);
      expect(parameter(parameters, "limit").schema).toMatchObject({
        minimum: facts.query.pagination.limit.minimum,
        maximum: facts.query.pagination.limit.maximum,
        default: facts.query.pagination.limit.default,
      });
      expect(names.has(facts.query.pagination.cursor.parameter)).toBe(true);
    }
  });

  it("matches generated Workflow and Temporal Capability Action semantics", async () => {
    const task = published(TASK_MODEL_DEFINITION);
    const taskFacts = projectModelSemanticFacts(task);
    const taskContract = await generateModelContract([task]);
    const taskPaths = taskContract.openapi.paths as Record<string, { post?: Record<string, unknown> }>;
    const complete = taskFacts.actions.find((action) => action.key === "complete")!;
    expect(complete.kind).toBe("workflow");
    expect(complete.input.fields).toEqual([]);
    expect(taskPaths[complete.invocation.pathTemplate]?.post?.["x-lifespace-concurrency"]).toEqual(complete.concurrency);

    const temporal = published(DAY_RECORD_MODEL_DEFINITION);
    const temporalFacts = projectModelSemanticFacts(temporal);
    const temporalContract = await generateModelContract([temporal]);
    const temporalPaths = temporalContract.openapi.paths as Record<string, { post?: Record<string, unknown> }>;
    const occurrence = temporalFacts.actions.find((action) => action.key === "record-occurrence")!;
    expect(occurrence.kind).toBe("capability");
    expect(occurrence.input.fields.map((field) => field.key)).toEqual(["occurredOn", "note"]);
    expect(occurrence.input.fields.some((field) => field.key === "version")).toBe(false);
    expect(temporalPaths[occurrence.invocation.pathTemplate]?.post?.["x-lifespace-concurrency"]).toEqual(occurrence.concurrency);
  });

  it("matches generated structural field relation/default evidence without leaking Kernel hydration operations into mct_*", async () => {
    const event = published(EVENT_MODEL_DEFINITION);
    const facts = projectModelSemanticFacts(event);
    const contract = await generateModelContract([event]);
    const jsonSchema = contract.jsonSchema as { $defs: Record<string, { properties?: Record<string, Record<string, unknown>> }> };
    const create = jsonSchema.$defs.EventCreate;
    const resource = jsonSchema.$defs.EventResource;

    const attendee = facts.fields.find((field) => field.key === "attendeePersonIds")!;
    const generatedRelation = resource.properties?.attendeePersonIds?.["x-lifespace-relation"] as Record<string, unknown>;
    expect(generatedRelation).toEqual({
      targetModel: attendee.relation?.targetModel,
      cardinality: attendee.relation?.cardinality,
    });
    expect(generatedRelation).not.toHaveProperty("lookup");
    expect(generatedRelation).not.toHaveProperty("resolution");
    expect(attendee.relation?.resolution).toEqual({
      supported: true,
      method: "POST",
      pathTemplate: "/api/v1/spaces/{spaceId}/_reference-resolutions/{modelKey}/{fieldKey}",
      maxIds: 50,
    });
    for (const [key, value] of Object.entries(facts.defaults)) {
      if (create.properties?.[key]) expect(create.properties[key].default).toEqual(value);
    }
  });

  it("matches representative current Runtime Discovery output without current authority leaking into static facts", async () => {
    const payload = await runtimeDiscoveryFixture();
    const taskRuntime = payload.data.models.find((entry) => entry.key === "task")!;
    const eventRuntime = payload.data.models.find((entry) => entry.key === "event")!;
    const taskFacts = projectModelSemanticFacts(published(TASK_MODEL_DEFINITION));
    const eventFacts = projectModelSemanticFacts(published(EVENT_MODEL_DEFINITION));

    expect(taskRuntime.defaults).toEqual(taskFacts.defaults);
    expect((taskRuntime.fields as Array<Record<string, unknown>>).map(({ key, type, title, description, required, nullable, immutable, readOnly }) => ({
      key, type, title, description, required, nullable, immutable, readOnly,
    }))).toEqual(taskFacts.fields.map(({ key, type, title, description, required, nullable, immutable, readOnly }) => ({
      key, type, title, description, required, nullable, immutable, readOnly,
    })));

    const runtimeQuery = taskRuntime.query as {
      searchable: string[]; filterable: string[]; sortable: string[];
      sort: Record<string, unknown>;
    };
    expect(runtimeQuery.searchable).toEqual(taskFacts.query.searchable);
    expect(runtimeQuery.filterable).toEqual(taskFacts.query.filterable);
    expect(runtimeQuery.sortable).toEqual(taskFacts.query.sortable);
    expect(runtimeQuery.sort).toEqual({
      parameter: taskFacts.query.sort.parameter,
      syntax: taskFacts.query.sort.syntax,
      repeatable: taskFacts.query.sort.repeatable,
      ordered: taskFacts.query.sort.ordered,
      maxCriteria: taskFacts.query.sort.maxCriteria,
      default: taskFacts.query.sort.genericDefault,
      envelopeFields: taskFacts.query.sort.envelopeFields,
    });

    const runtimeActions = taskRuntime.actions as Array<Record<string, unknown>>;
    for (const action of runtimeActions) {
      const shared = taskFacts.actions.find((entry) => entry.key === action.key)!;
      expect(action).toEqual({
        key: shared.key,
        access: shared.access,
        kind: shared.kind,
        input: shared.input,
        concurrency: shared.concurrency,
      });
    }

    expect(eventRuntime.capabilities).toEqual(eventFacts.capabilities);
    const runtimeBindings = eventRuntime.capabilityBindings as { calendar?: unknown };
    expect(runtimeBindings.calendar).toEqual(eventFacts.capabilityBindings.calendar);
    expect(taskRuntime.access).toEqual(["read", "write"]);
    expect(taskFacts.declaredAccess).toEqual(TASK_MODEL_DEFINITION.access);
    expect(taskFacts).not.toHaveProperty("spaceId");
    expect(taskFacts).not.toHaveProperty("delegationId");
  });
});
