import { getRuntimeModel } from "./model-registry";
import type { Context, Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { requireScope } from "./auth";
import { ApiError, success } from "./http";
import { initializeSpaceEncryption, readSpaceEncryption, readModelSpaceEncryption, rewrapSpaceEncryption } from "./space-encryption";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const MAX_BODY_BYTES = 4096;

// Key envelope operations accept small JSON only; never buffer an unbounded body.
async function readBody(c: Context<AppEnv>): Promise<unknown> {
  if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError("INVALID_REQUEST", "Expected application/json", 415);
  }
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new ApiError("INVALID_REQUEST", "Request body is required", 400);
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
  let size = 0, body = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new ApiError("INVALID_REQUEST", "Encryption configuration body is too large", 413);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError("INVALID_REQUEST", "Invalid encryption configuration JSON", 400);
  } finally {
    reader.releaseLock();
  }
}

export function registerSpaceEncryptionRoutes(app: Hono<AppEnv>): void {
  const path = "/api/v1/spaces/:spaceId/encryption";
  app.get(path, async c => {
    c.header("cache-control", "no-store");
    const modelKeys = new URL(c.req.url).searchParams.getAll("modelKey");
    const principal = c.get("principal");
    const spaceId = c.req.param("spaceId");
    if (!modelKeys.length) return c.json(success(await readSpaceEncryption(c.env, principal, spaceId)));
    const modelKey = modelKeys[0]!;
    if (modelKeys.length !== 1 || !/^[a-z][a-z0-9_]{1,62}$/u.test(modelKey) || modelKey.trim() !== modelKey) {
      throw new ApiError("INVALID_REQUEST", "Expected one canonical modelKey", 400);
    }
    if (c.req.header("x-lifespace-delegation-id")) throw new ApiError("FORBIDDEN", "Direct User authority is required for Space encryption", 403);
    if (principal.type !== "user" || principal.actor || principal.purpose || principal.oauthExecution || !principal.scopes.includes("resources:read")) {
      throw new ApiError("FORBIDDEN", "Direct User authority is required for Space encryption", 403);
    }
    return c.json(success(await readModelSpaceEncryption(c.env, principal, spaceId, await getRuntimeModel(c.env, modelKey))));
  });
  app.post(path, requireScope("spaces:manage"), async c => {
    c.header("cache-control", "no-store");
    const input = await readBody(c);
    return c.json(success(await initializeSpaceEncryption(c.env, c.get("principal"), c.req.param("spaceId"), input)), 201);
  });
  app.patch(path, requireScope("spaces:manage"), async c => {
    c.header("cache-control", "no-store");
    const input = await readBody(c);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).length !== 2 || !("expectedRevision" in input) || !("envelope" in input)) {
      throw new ApiError("INVALID_REQUEST", "Expected expectedRevision and envelope", 400);
    }
    return c.json(success(await rewrapSpaceEncryption(c.env, c.get("principal"), c.req.param("spaceId"), input.expectedRevision, input.envelope)));
  });
}
