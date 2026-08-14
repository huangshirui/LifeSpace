const CLIENT_TYPES = new Set(["web", "mini_program", "service", "device"]);
const ACCESS_LEVELS = new Set(["read", "write", "manage"]);
const APPLICATION_ID_PREFIX = "app_";

function fail(code, message, status, details = undefined) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  throw error;
}

function uniqueStrings(value, field) {
  if (!Array.isArray(value)) fail("VALIDATION_ERROR", `${field} must be an array`, 422);
  const result = value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry.trim().length > 100) {
      fail("VALIDATION_ERROR", `${field} contains an invalid value`, 422);
    }
    return entry.trim();
  });
  if (new Set(result).size !== result.length) fail("VALIDATION_ERROR", `${field} must not contain duplicates`, 422);
  return result;
}

export function validateOnboardingInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("INVALID_REQUEST", "JSON body is required", 400);
  const allowed = new Set(["name", "clientType", "trustedBackend", "allowedScopes", "accessTokenTtlSeconds", "modelAccess"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) fail("INVALID_REQUEST", "Unsupported application onboarding field", 400);

  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 100) {
    fail("VALIDATION_ERROR", "name must contain 1-100 characters", 422);
  }
  if (!CLIENT_TYPES.has(value.clientType)) fail("VALIDATION_ERROR", "clientType is invalid", 422);
  if (typeof value.trustedBackend !== "boolean") fail("VALIDATION_ERROR", "trustedBackend must be boolean", 422);
  const allowedScopes = uniqueStrings(value.allowedScopes ?? [], "allowedScopes");
  const ttl = value.accessTokenTtlSeconds ?? 900;
  if (!Number.isInteger(ttl) || ttl < 300 || ttl > 3600) {
    fail("VALIDATION_ERROR", "accessTokenTtlSeconds must be an integer between 300 and 3600", 422);
  }
  if (!Array.isArray(value.modelAccess)) fail("VALIDATION_ERROR", "modelAccess must be an array", 422);
  const seen = new Set();
  const modelAccess = value.modelAccess.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("VALIDATION_ERROR", "modelAccess entry is invalid", 422);
    if (Object.keys(raw).some((key) => key !== "modelKey" && key !== "maxAccess")) {
      fail("VALIDATION_ERROR", "modelAccess entries may contain only modelKey and maxAccess", 422);
    }
    if (typeof raw.modelKey !== "string" || !/^[a-z][a-z0-9_]{1,62}$/u.test(raw.modelKey)) {
      fail("VALIDATION_ERROR", "modelAccess modelKey is invalid", 422);
    }
    if (!ACCESS_LEVELS.has(raw.maxAccess)) fail("VALIDATION_ERROR", "modelAccess maxAccess is invalid", 422);
    if (seen.has(raw.modelKey)) fail("VALIDATION_ERROR", `Duplicate model access ${raw.modelKey}`, 422);
    seen.add(raw.modelKey);
    return { modelKey: raw.modelKey, maxAccess: raw.maxAccess };
  });
  return {
    name: value.name.trim(),
    clientType: value.clientType,
    trustedBackend: value.trustedBackend,
    allowedScopes,
    accessTokenTtlSeconds: ttl,
    modelAccess,
  };
}

function createApplicationId() {
  return `${APPLICATION_ID_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
}

async function jsonResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

async function identityRequest(env, path, init = {}) {
  if (!env.IDENTITY_BOOTSTRAP_SECRET) fail("ADMIN_NOT_CONFIGURED", "Identity bootstrap credential is not configured", 500);
  const headers = new Headers(init.headers);
  headers.set("x-bootstrap-secret", env.IDENTITY_BOOTSTRAP_SECRET);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return env.IDENTITY.fetch(new Request(`https://identity.internal${path}`, { ...init, headers }));
}

async function coreRequest(env, path, init = {}) {
  if (!env.CORE_ADMIN_TOKEN) fail("ADMIN_NOT_CONFIGURED", "Core admin credential is not configured", 500);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.CORE_ADMIN_TOKEN}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return env.CORE.fetch(new Request(`https://core.internal${path}`, { ...init, headers }));
}

async function disableApplication(env, applicationId) {
  try {
    await identityRequest(env, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "disabled" }),
    });
    const credentialsResponse = await identityRequest(env, `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials`);
    if (!credentialsResponse.ok) return;
    const credentials = await jsonResponse(credentialsResponse);
    for (const credential of credentials?.data ?? []) {
      if (credential?.status !== "active" || typeof credential.id !== "string") continue;
      await identityRequest(
        env,
        `/bootstrap/v1/applications/${encodeURIComponent(applicationId)}/credentials/${encodeURIComponent(credential.id)}`,
        { method: "DELETE" },
      );
    }
  } catch {
    // The original onboarding failure remains authoritative. We report whether compensation succeeded separately.
  }
}

export async function listPublishedModels(env) {
  const response = await coreRequest(env, "/api/v1/model-admin/models");
  const payload = await jsonResponse(response);
  if (!response.ok || !Array.isArray(payload?.data)) {
    fail("CORE_ADMIN_FAILED", "Could not read published models from Core", 502, { upstreamStatus: response.status });
  }
  return payload.data;
}

export async function onboardApplication(env, rawInput, operator) {
  const input = validateOnboardingInput(rawInput);
  const applicationId = createApplicationId();
  const identityResponse = await identityRequest(env, "/bootstrap/v1/applications", {
    method: "POST",
    body: JSON.stringify({
      id: applicationId,
      name: input.name,
      clientType: input.clientType,
      allowedScopes: input.allowedScopes,
      trustedBackend: input.trustedBackend,
      accessTokenTtlSeconds: input.accessTokenTtlSeconds,
    }),
  });
  const identityPayload = await jsonResponse(identityResponse);
  if (identityResponse.status !== 201 || identityPayload?.data?.id !== applicationId) {
    fail("IDENTITY_APPLICATION_CREATE_FAILED", "Identity could not register the application", 502, {
      upstreamStatus: identityResponse.status,
    });
  }

  const coreResponse = await coreRequest(env, `/api/v1/model-admin/applications/${encodeURIComponent(applicationId)}/access`, {
    method: "PUT",
    body: JSON.stringify({ models: input.modelAccess }),
  });
  const corePayload = await jsonResponse(coreResponse);
  if (!coreResponse.ok) {
    await disableApplication(env, applicationId);
    fail("CORE_APPLICATION_ACCESS_FAILED", "Core could not configure application model access; Identity application was disabled", 502, {
      applicationId,
      upstreamStatus: coreResponse.status,
    });
  }

  return {
    applicationId,
    name: input.name,
    clientType: input.clientType,
    trustedBackend: input.trustedBackend,
    allowedScopes: input.allowedScopes,
    accessTokenTtlSeconds: input.accessTokenTtlSeconds,
    modelAccess: corePayload?.data?.models ?? input.modelAccess,
    clientSecret: identityPayload.data.clientSecret ?? null,
    operatorEmail: operator.email,
    coreUrl: env.PUBLIC_CORE_URL ?? null,
    identityUrl: env.PUBLIC_IDENTITY_URL ?? null,
  };
}

export function adminError(error) {
  return {
    status: Number.isInteger(error?.status) ? error.status : 500,
    body: {
      error: {
        code: typeof error?.code === "string" ? error.code : "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : "Internal server error",
        ...(error?.details === undefined ? {} : { details: error.details }),
      },
    },
  };
}
