import assert from "node:assert/strict";
import test from "node:test";
import probeWorker, { handleProbeRequest } from "../performance-probe/worker.mjs";

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

test("APAC probe health reports observed ingress, not a hard-coded placement claim", async () => {
  const response = await handleProbeRequest(
    new Request("https://probe.example/health", {
      headers: { "x-lifespace-probe-token": env.PROBE_TOKEN },
    }),
    env,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, probeIngressColo: null });
});

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
  assert.equal(typeof payload.coreResponseBodyMs, "number");
  assert.equal(payload.probeIngressColo, null);
});

test("APAC probe reports Core fetch failures as JSON", async () => {
  const response = await handleProbeRequest(
    probeRequest({ method: "GET", path: "/api/v1/spaces/spc_test/models/task/records?limit=1" }),
    env,
    async () => { throw new Error("upstream transport failed: synthetic-secret /internal/private/path"); },
  );

  assert.equal(response.status, 502);
  const payload=await response.json();
  assert.equal(payload.error,"core_fetch_failed");
  assert.equal(payload.route,"GET /api/v1/spaces/spc_*/models/task/records");
  assert.match(payload.correlationId,/^[0-9a-f-]{36}$/u);
  assert.doesNotMatch(JSON.stringify(payload),/synthetic-secret|spc_test|private/u);
});

test("APAC probe reports Core response-body read failures instead of throwing a bare 500", async () => {
  const upstream = {
    status: 201,
    async text() { throw new Error("body stream reset: synthetic-secret /internal/private/path"); },
  };
  const response = await handleProbeRequest(
    probeRequest({ method: "POST", path: "/api/v1/spaces/spc_test/models/task/records", body: { name: "Probe task" } }),
    env,
    async () => upstream,
  );

  assert.equal(response.status, 502);
  const payload = await response.json();
  assert.equal(payload.error, "core_response_read_failed");
  assert.match(payload.correlationId,/^[0-9a-f-]{36}$/u);
  assert.doesNotMatch(JSON.stringify(payload), /synthetic-secret|internal\/private\/path/u);
  assert.equal(payload.upstreamStatus, 201);
  assert.equal(payload.route, "POST /api/v1/spaces/spc_*/models/task/records");
  assert.equal(typeof payload.elapsedMs, "number");
});

test("APAC probe internal exception never reaches the response", async () => {
  const response = await probeWorker.fetch({ headers: { get() { throw new Error("synthetic-secret /internal/private/path"); } } }, env);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "probe_internal_error", message: "Probe request failed" });
});

test("Editor probe credential is explicitly configured and restricted to exact read routes", async () => {
  const editorEnv={...env,MEMBER_BEARER:"editor-token"};
  const base="/api/v1/spaces/"+env.SPACE_ID;
  const allowed=[base+"/models/task/records?limit=10",base+"/models/task/records/rec_test",base+"/_discovery"];
  let called=0;
  const upstream=async(url,init)=>{
    called++;
    assert.equal(init.headers.authorization,"Bearer editor-token");
    assert.equal(init.method,"GET");
    assert.ok(allowed.some(path=>url==="https://core-staging.aisr.online"+path));
    return Response.json({data:{}});
  };
  for(const path of allowed){
    const response=await handleProbeRequest(probeRequest({credentialMode:"member",method:"GET",path}),editorEnv,upstream);
    assert.equal(response.status,200);
    assert.equal((await response.json()).credentialMode,"member");
  }
  for(const [method,path] of [
    ["POST",base+"/models/task/records"],["GET",base+"/members/usr_test/model-access"],
    ["GET",base+"/models/task/records/extra/rec_test"],["GET",base+"/models/task/records?limit=100"],
    ["GET","/api/v1/spaces/spc_other/models/task/records?limit=10"],["GET","https://evil.test"+allowed[0]],
    ["GET",base+"/models/event/records"],["GET","/api/v1/me/_discovery"],
  ]){
    assert.equal((await handleProbeRequest(probeRequest({credentialMode:"member",method,path}),editorEnv,upstream)).status,403);
  }
  assert.equal((await handleProbeRequest(probeRequest({credentialMode:"member",method:"GET",path:allowed[0]}),env,upstream)).status,503);
  assert.equal(called,3);
});

test("probe captures only validated placement metadata, preserving ingress as a separate field",async()=>{
  const request=probeRequest({method:"GET",path:"/api/v1/spaces/spc_test/models/task/records"});
  request.headers.set("cf-placement","remote-SIN");
  const response=await handleProbeRequest(request,env,async()=>new Response('{"data":[]}',{headers:{"cf-placement":"remote-SIN","cf-ray":"a5bef8dec811ce94-SIN"}}));
  const result=await response.json();assert.equal(result.probePlacement,"remote-SIN");assert.equal(result.corePlacement,"remote-SIN");assert.equal(result.probeIngressColo,null);
  const malformedRequest=probeRequest({method:"GET",path:"/api/v1/spaces/spc_test/models/task/records"});
  const malformed=await handleProbeRequest(malformedRequest,env,async()=>new Response('{"data":[]}',{headers:{"cf-placement":"secret invalid value"}}));
  assert.equal(malformed.status,200);
  assert.equal((await malformed.json()).corePlacement,null);
});
