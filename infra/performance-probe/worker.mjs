const CORE_BASE_URL = "https://core-staging.aisr.online";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export function isAllowedBenchmarkRequest(path, method, spaceId) {
  let url;
  try {
    url = new URL(path, CORE_BASE_URL);
  } catch {
    return false;
  }
  if (url.origin !== CORE_BASE_URL || !path.startsWith("/")) return false;

  const base = "/api/v1/spaces/" + spaceId;
  const record = "rec_[A-Za-z0-9]+";
  const rules = [
    ["POST", new RegExp("^" + base + "/models/task/records$", "u")],
    ["GET", new RegExp("^" + base + "/models/task/records$", "u")],
    ["GET", new RegExp("^" + base + "/models/task/records/" + record + "$", "u")],
    ["PATCH", new RegExp("^" + base + "/models/task/records/" + record + "$", "u")],
    ["DELETE", new RegExp("^" + base + "/models/task/records/" + record + "$", "u")],
    ["POST", new RegExp("^" + base + "/models/task/records/" + record + "/actions/(complete|reopen)$", "u")],
    ["POST", new RegExp("^" + base + "/models/event/records$", "u")],
    ["GET", new RegExp("^" + base + "/models/event/records$", "u")],
    ["POST", new RegExp("^" + base + "/models/event/records/query$", "u")],
    ["DELETE", new RegExp("^" + base + "/models/event/records/" + record + "$", "u")],
    ["POST", new RegExp("^" + base + "/models/day_record/records$", "u")],
    ["GET", new RegExp("^" + base + "/models/day_record/records$", "u")],
    ["DELETE", new RegExp("^" + base + "/models/day_record/records/" + record + "$", "u")],
    ["POST", new RegExp("^" + base + "/models/wish/records$", "u")],
    ["GET", new RegExp("^" + base + "/models/wish/records$", "u")],
    ["DELETE", new RegExp("^" + base + "/models/wish/records/" + record + "$", "u")],
  ];

  return rules.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(url.pathname));
}

export async function handleProbeRequest(request, env, fetchImpl = fetch) {
  if (!env.PROBE_TOKEN || !env.USER_BEARER || !env.SERVICE_BEARER || !env.SPACE_ID) {
    return json({ error: "probe_not_configured" }, 503);
  }

  if (request.headers.get("x-lifespace-probe-token") !== env.PROBE_TOKEN) {
    return json({ error: "not_found" }, 404);
  }

  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, probeIngressColo: request.cf?.colo ?? null });
  }
  if (request.method !== "POST" || url.pathname !== "/run") {
    return json({ error: "not_found" }, 404);
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json({ error: "invalid_json" }, 400);
  }

  const method = typeof input?.method === "string" ? input.method.toUpperCase() : "GET";
  const path = typeof input?.path === "string" ? input.path : "";
  const credentialMode = input?.credentialMode ?? "user";
  if (!["user", "service", "member"].includes(credentialMode)) {
    return json({ error: "benchmark_credential_mode_not_allowed" }, 403);
  }
  // The extra credential is a run-scoped Editor, never the owner. Its probe
  // can read only the exact synthetic Space's Task records and Discovery.
  // No control-plane mutations, arbitrary model keys, or credential fallback.
  const memberPath = credentialMode === "member" && method === "GET"
    && typeof env.SPACE_ID === "string" && /^spc_[A-Za-z0-9_]+$/u.test(env.SPACE_ID)
    && (path === "/api/v1/spaces/" + env.SPACE_ID + "/_discovery"
      || path === "/api/v1/spaces/" + env.SPACE_ID + "/models/task/records?limit=10"
      || (path.startsWith("/api/v1/spaces/" + env.SPACE_ID + "/models/task/records/")
        && /^rec_[A-Za-z0-9]+$/u.test(path.split("/").at(-1))));
  if (credentialMode === "member" ? !memberPath : !isAllowedBenchmarkRequest(path, method, env.SPACE_ID)) {
    return json({ error: "benchmark_request_not_allowed" }, 403);
  }
  const bearer = credentialMode === "member" ? env.MEMBER_BEARER
    : credentialMode === "service" ? env.SERVICE_BEARER : env.USER_BEARER;
  if (!bearer) return json({ error: "probe_not_configured" }, 503);

  const correlationId = crypto.randomUUID();
  const started = performance.now();
  let response;
  try {
    response = await fetchImpl(CORE_BASE_URL + path, {
      method,
      headers: {
        authorization: "Bearer " + bearer,
        "x-request-id": correlationId,
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch {
    return json({
      error: "core_fetch_failed",
      message: "Core request failed",
      method,
      path,
    }, 502);
  }

  // Preserve the existing release-gate metric: upstream fetch until response headers.
  // The response-body phase is diagnostic only and must not change P50/P90 gates.
  const elapsedMs = performance.now() - started;
  const bodyStarted = performance.now();
  let text;
  try {
    text = await response.text();
  } catch {
    return json({
      error: "core_response_read_failed",
      message: "Core response could not be read",
      upstreamStatus: response.status,
      elapsedMs,
      method,
      path,
    }, 502);
  }

  const coreResponseBodyMs = performance.now() - bodyStarted;
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      return json({ error: "core_returned_non_json", status: response.status, elapsedMs, method, path }, 502);
    }
  }

  return json({ status: response.status, payload, elapsedMs, credentialMode,
    coreRequestId: response.headers.get("x-request-id") === correlationId ? correlationId : null,
    coreResponseBodyMs,
    // Incoming colo is NOT proof of Workers runtime placement (including Smart Placement).
    probeIngressColo: request.cf?.colo ?? null,
  });
}

export default {
  async fetch(request, env) {
    try {
      return await handleProbeRequest(request, env);
    } catch {
      return json({ error: "probe_internal_error", message: "Probe request failed" }, 500);
    }
  },
};
