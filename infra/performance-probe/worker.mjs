const CORE_BASE_URL = "https://core-staging.aisr.online";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function isAllowedBenchmarkRequest(path, method, spaceId) {
  let url;
  try {
    url = new URL(path, CORE_BASE_URL);
  } catch {
    return false;
  }
  if (url.origin !== CORE_BASE_URL || !path.startsWith("/")) return false;

  const base = `/api/v1/spaces/${spaceId}`;
  const pathname = url.pathname;
  const record = "rec_[A-Za-z0-9]+";

  const rules = [
    ["POST", new RegExp(`^${base}/tasks$`, "u")],
    ["GET", new RegExp(`^${base}/tasks$`, "u")],
    ["GET", new RegExp(`^${base}/tasks/${record}$`, "u")],
    ["PATCH", new RegExp(`^${base}/tasks/${record}$`, "u")],
    ["DELETE", new RegExp(`^${base}/tasks/${record}$`, "u")],
    ["POST", new RegExp(`^${base}/tasks/${record}/actions/(complete|reopen)$`, "u")],
    ["POST", new RegExp(`^${base}/events$`, "u")],
    ["GET", new RegExp(`^${base}/events$`, "u")],
    ["DELETE", new RegExp(`^${base}/events/${record}$`, "u")],
    ["POST", new RegExp(`^${base}/day-records$`, "u")],
    ["GET", new RegExp(`^${base}/day-records$`, "u")],
    ["DELETE", new RegExp(`^${base}/day-records/${record}$`, "u")],
    ["POST", new RegExp(`^${base}/wishes$`, "u")],
    ["GET", new RegExp(`^${base}/wishes$`, "u")],
    ["DELETE", new RegExp(`^${base}/wishes/${record}$`, "u")],
  ];

  return rules.some(([allowedMethod, pattern]) => allowedMethod === method && pattern.test(pathname));
}

export default {
  async fetch(request, env) {
    if (!env.PROBE_TOKEN || !env.USER_BEARER || !env.SPACE_ID) {
      return json({ error: "probe_not_configured" }, 503);
    }

    if (request.headers.get("x-lifespace-probe-token") !== env.PROBE_TOKEN) {
      return json({ error: "not_found" }, 404);
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, placementRegion: "aws:ap-southeast-1" });
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
    if (!isAllowedBenchmarkRequest(path, method, env.SPACE_ID)) {
      return json({ error: "benchmark_request_not_allowed" }, 403);
    }

    const started = performance.now();
    const response = await fetch(`${CORE_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.USER_BEARER}`,
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    const elapsedMs = performance.now() - started;
    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        return json({ error: "core_returned_non_json", status: response.status, elapsedMs }, 502);
      }
    }

    return json({ status: response.status, payload, elapsedMs });
  },
};
