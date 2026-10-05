import assert from "node:assert/strict";
import test from "node:test";
import { handleProbeRequest } from "../performance-probe/worker.mjs";

const env = {
  PROBE_TOKEN: "probe-token",
  USER_BEARER: "user-token",
  SERVICE_BEARER: "service-token",
  SPACE_ID: "spc_test",
};

function probeRequest(body) {
  return new Request("https://probe.example/run", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-lifespace-probe-token": env.PROBE_TOKEN,
    },
    body: JSON.stringify(body),
  });
}

test("APAC probe returns the Core result envelope on success", async () => {
  const response = await handleProbeRequest(
    probeRequest({ method: "GET", path: "/api/v1/spaces/spc_test/models/task/records?limit=1" }),
    env,
    async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.status, 200);
  assert.deepEqual(payload.payload, { data: [] });
  assert.equal(payload.credentialMode, "user");
  assert.equal(typeof payload.elapsedMs, "number");
});

test("APAC probe reports Core fetch failures as JSON", async () => {
  const response = await handleProbeRequest(
    probeRequest({ method: "GET", path: "/api/v1/spaces/spc_test/models/task/records?limit=1" }),
    env,
    async () => { throw new Error("upstream transport failed"); },
  );

  assert.equal(response.status, 502);
  assert.deepEqual(await response.json(), {
    error: "core_fetch_failed",
    message: "upstream transport failed",
    method: "GET",
    path: "/api/v1/spaces/spc_test/models/task/records?limit=1",
  });
});

test("APAC probe reports Core response-body read failures instead of throwing a bare 500", async () => {
  const upstream = {
    status: 201,
    async text() { throw new Error("body stream reset"); },
  };
  const response = await handleProbeRequest(
    probeRequest({ method: "POST", path: "/api/v1/spaces/spc_test/models/task/records", body: { name: "Probe task" } }),
    env,
    async () => upstream,
  );

  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error, "core_response_read_failed");
  assert.equal(payload.message, "body stream reset");
  assert.equal(payload.upstreamStatus, 201);
  assert.equal(payload.method, "POST");
  assert.equal(payload.path, "/api/v1/spaces/spc_test/models/task/records");
  assert.equal(typeof payload.elapsedMs, "number");
});
