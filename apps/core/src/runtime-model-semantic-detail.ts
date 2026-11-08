import { getExternalModel,isExternalModelKey,externalAuthorityModel } from "./external-model";
import { externalSemanticDetail } from "./external-runtime";
import { getActiveModelContract } from "./model-contract-store";
import { getOrCreateActiveModelContract } from "./model-contract-service";
import { versionRequestSchema, type JsonSchema } from "./model-contract";
import type { Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import type { ModelAccess } from "./model-definition";
import { consumeSingleUseRead, requireModelAccess, type ModelAccessDecision } from "./model-authorization";
import { getRuntimeModel, type PublishedModel } from "./model-registry";
import { projectModelSemanticFacts } from "./model-semantic-projection";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

const accessOrder: ModelAccess[] = ["read", "write", "manage"];
const scopeForAccess: Record<ModelAccess, string> = {
  read: "resources:read",
  write: "resources:write",
  manage: "resources:manage",
};

function opaqueNotFound(): ApiError {
  return new ApiError("NOT_FOUND", "Resource not found", 404);
}

function lowestScopedDeclaredAccess(principal: Principal, model: PublishedModel): ModelAccess | null {
  return accessOrder.find((access) => model.definition.access.includes(access)
    && principal.scopes.includes(scopeForAccess[access])) ?? null;
}

async function requireCurrentVisibility(
  env: Bindings,
  principal: Principal,
  spaceId: string,
  model: PublishedModel,
  delegationId?: string | null,
): Promise<ModelAccessDecision> {
  const required = lowestScopedDeclaredAccess(principal, model);
  if (!required) throw opaqueNotFound();
  try {
    return await requireModelAccess(env, principal, spaceId, model, required, { delegationId });
  } catch (error) {
    if (error instanceof ApiError && [403, 404, 405].includes(error.status)) throw opaqueNotFound();
    throw error;
  }
}

export function registerRuntimeModelSemanticDetailRoutes(app: App): void {

  // Batch-only optimization for Identity OAuth Agent Direct MCP discovery.
  // One short-lived signed execution token; every requested Model still passes
  // current Core Server policy, Space restriction, and ordinary Data Grant checks.
  // Native write schemas are included only with Staging + live write consent and Grants.
  // External Models and implicit User Delegation remain excluded.
  app.post("/api/v1/spaces/:spaceId/_discovery/models/batch", async (context) => {
    const principal = context.get("principal");
    const spaceId = context.req.param("spaceId");
    const execution = principal.oauthExecution;
    if (principal.purpose !== "oauth_agent_execution" || !execution
      || execution.spaceId !== spaceId || !execution.queryModelKeys) {
      throw new ApiError("FORBIDDEN", "OAuth MCP batch discovery is not available", 403);
    }
    const raw = await context.req.text();
    if (raw.length > 4096) throw new ApiError("INVALID_REQUEST", "Batch discovery payload is too large", 400);
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch {
      throw new ApiError("INVALID_REQUEST", "Invalid batch discovery JSON", 400);
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)
      || Object.keys(payload).length !== 1 || !("modelKeys" in payload)) {
      throw new ApiError("INVALID_REQUEST", "Only modelKeys is supported", 400);
    }
    const keys = (payload as { modelKeys?: unknown }).modelKeys;
    if (!Array.isArray(keys) || !keys.length || keys.length > 32
      || keys.some(key => typeof key !== "string" || !/^[a-z][a-z0-9_]{1,62}$/u.test(key))
      || new Set(keys).size !== keys.length) {
      throw new ApiError("INVALID_REQUEST", "Invalid or repeated model keys", 400);
    }
    const exposed = new Set(execution.queryModelKeys);
    if (keys.some(key => !exposed.has(key))) throw opaqueNotFound();
    // Do not leak partial visibility: any missing/retired/ungranted Model
    // rejects the entire batch, without exposing other semantic definitions.
    const models = [];
    let contract: Awaited<ReturnType<typeof getOrCreateActiveModelContract>> | undefined;
    for (const key of keys as string[]) {
      if (isExternalModelKey(key)) throw opaqueNotFound();
      const model = await getRuntimeModel(context.env, key);
      if (!model || model.definition.origin === "external") throw opaqueNotFound();
      const decision = await requireCurrentVisibility(context.env, principal, spaceId, model);
      const detail = projectModelSemanticFacts(model);
      await consumeSingleUseRead(context.env, decision);
      let mutations: Record<string, unknown> | undefined;
      const operations = execution.modelOperations?.[key]?.filter(op => ["create", "update", "delete"].includes(op)) ?? [];
      if (context.env.ENVIRONMENT === "staging" && principal.scopes.includes("resources:write") && operations.length) {
        const writable = await requireModelAccess(context.env, principal, spaceId, model, "write").catch(error => {
          if (error instanceof ApiError && [403, 404, 405].includes(error.status)) return null;
          throw error;
        });
        if (writable) {
          contract ??= await getActiveModelContract(context.env) ?? await getOrCreateActiveModelContract(context.env);
          const metadata = (contract.jsonSchema["x-lifespace-models"] as Record<string, Record<string, unknown>>)[key];
          if (!metadata || metadata.version !== model.version || metadata.schemaHash !== model.schemaHash) throw opaqueNotFound();
          const defs = contract.jsonSchema.$defs as Record<string, JsonSchema>;
          const selectedDefs: Record<string, JsonSchema> = {};
          const include = (ref: string): void => {
            if (!ref.startsWith("#/$defs/")) throw opaqueNotFound();
            const name = ref.slice(8);
            if (selectedDefs[name]) return;
            if (!defs[name]) throw opaqueNotFound();
            selectedDefs[name] = defs[name];
            for (const match of JSON.stringify(defs[name]).matchAll(/"\$ref":"([^"]+)"/gu)) include(match[1]);
          };
          const inputs: Record<string, unknown> = {};
          for (const op of operations) {
            // Delete uses the same canonical version metadata as Update.
            const ref = String(op === "create" ? metadata.createSchema : metadata.updateSchema);
            if (op === "delete") inputs[op] = versionRequestSchema();
            else { include(ref); inputs[op] = { $ref: ref }; }
          }
          mutations = { contractId: contract.id, modelVersion: model.version, schemaHash: model.schemaHash,
            operations: inputs, $defs: selectedDefs };
        }
      }
      models.push({ modelKey: key, detail: { ...detail, ...(mutations ? { mutations } : {}) } });
    }
    return context.json(success({ models }), 200, { "cache-control": "no-store" });
  });

  app.get("/api/v1/spaces/:spaceId/_discovery/models/:modelKey", async (context) => {
    const principal = context.get("principal");
    const spaceId = context.req.param("spaceId");
    const key = context.req.param("modelKey");
    if (isExternalModelKey(key) || (await getRuntimeModel(context.env, key))?.definition.origin === "external") {
      const external = await getExternalModel(context.env,spaceId,key);
      if (!external) throw opaqueNotFound();
      const access = await requireModelAccess(context.env,principal,spaceId,externalAuthorityModel(external),"read",{delegationId:context.req.header("x-lifespace-delegation-id")}).catch(error=>{if(error instanceof ApiError&&[403,404,405].includes(error.status))throw opaqueNotFound();throw error;});
      const allowed: ModelAccess[] = ["read"];
      if(externalAuthorityModel(external).definition.access.includes("write")) {
        const write = await requireModelAccess(context.env,principal,spaceId,externalAuthorityModel(external),"write",{delegationId:context.req.header("x-lifespace-delegation-id")}).catch(()=>null);
        if(write)allowed.push("write");
      }
      await consumeSingleUseRead(context.env,access);
      return context.json(success(externalSemanticDetail(external,allowed)));
    }
    const model = await getRuntimeModel(context.env,key);
    if (!model) throw opaqueNotFound();

    const access = await requireCurrentVisibility(
      context.env,
      principal,
      spaceId,
      model,
      context.req.header("x-lifespace-delegation-id"),
    );
    const response = success(projectModelSemanticFacts(model));
    await consumeSingleUseRead(context.env, access);
    return context.json(response);
  });
}
