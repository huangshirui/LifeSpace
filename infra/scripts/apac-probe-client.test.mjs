import assert from "node:assert/strict";
import test from "node:test";
import { createApacProbeRequestAdapter } from "./apac-probe-client.mjs";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("retries a non-JSON workers.dev 404 and preserves benchmark result validation", async () => {
  const responses = [
    new Response("<!DOCTYPE html><title>Page not found</title>", { status: 404 }),
    jsonResponse({ status: 200, payload: { data: [] }, elapsedMs: 42.5, credentialMode: "user" }),
  ];
  let fetchCount = 0;
  const sleeps = [];

  const request = createApacProbeRequestAdapter({
    probeUrl: "https://probe.example",
    probeToken: "probe-token",
    credentialMode: "user",
    routeAttempts: 3,
    routeDelayMs: 7,
    fetchImpl: async () => {
      fetchCount += 1;
      return responses.shift();
    },
    sleepImpl: async (ms) => { sleeps.push(ms); },
  });

  const result = await request("/api/v1/spaces/spc_test/models/task/records?limit=1");
  assert.equal(fetchCount, 2);
  assert.deepEqual(sleeps, [7]);
  assert.equal(result.status, 200);
  assert.equal(result.elapsedMs, 42.5);
  assert.equal(result.credentialMode, "user");
});

test("does not retry a JSON 404 produced by the probe itself", async () => {
  let fetchCount = 0;
  const request = createApacProbeRequestAdapter({
    probeUrl: "https://probe.example",
    probeToken: "probe-token",
    credentialMode: "user",
    routeAttempts: 3,
    routeDelayMs: 0,
    fetchImpl: async () => {
      fetchCount += 1;
      return jsonResponse({ error: "not_found" }, 404);
    },
    sleepImpl: async () => {},
  });

  await assert.rejects(
    request("/api/v1/spaces/spc_test/models/task/records?limit=1"),
    /APAC probe failed 404/u,
  );
  assert.equal(fetchCount, 1);
});

test("bounds repeated non-JSON route 404 retries", async () => {
  let fetchCount = 0;
  let sleepCount = 0;
  const request = createApacProbeRequestAdapter({
    probeUrl: "https://probe.example",
    probeToken: "probe-token",
    credentialMode: "service",
    routeAttempts: 3,
    routeDelayMs: 0,
    fetchImpl: async () => {
      fetchCount += 1;
      return new Response("<html>Page not found</html>", { status: 404 });
    },
    sleepImpl: async () => { sleepCount += 1; },
  });

  await assert.rejects(
    request("/api/v1/spaces/spc_test/models/task/records?limit=1"),
    /non-JSON 404 after 3 attempt\(s\)/u,
  );
  assert.equal(fetchCount, 3);
  assert.equal(sleepCount, 2);
});


test("exposes secret-free per-call transport diagnostics without changing latency acceptance", async () => {
  const request = createApacProbeRequestAdapter({
    probeUrl: "https://probe.example",
    probeToken: "probe-secret",
    credentialMode: "service",
    fetchImpl: async () => jsonResponse({
      status: 200,
      payload: { data: {} },
      elapsedMs: 121.5,
      coreResponseBodyMs: 3.4,
      coreRequestId: "35a880fa-33d3-4732-8cfb-961bfb83e9e2",
      probeIngressColo: "SIN",
      credentialMode: "service",
    }),
  });
  const result = await request("/api/v1/spaces/spc_private/models/task/records/rec_private", { method: "PATCH", body: { name: "secret data" } });
  assert.equal(result.elapsedMs, 121.5, "the original release gate measures only core fetch-to-headers");
  const observations = request.diagnostics();
  assert.equal(observations.length, 1);
  assert.equal(observations[0].route, "PATCH /api/v1/spaces/spc_*/models/task/records/rec_*");
  assert.equal(observations[0].coreHeadersMs, 121.5);
  assert.equal(observations[0].coreBodyMs, 3.4);
  assert.equal(observations[0].coreRequestId, "35a880fa-33d3-4732-8cfb-961bfb83e9e2");
  assert.equal(observations[0].probeIngressColo, "SIN");
  assert.ok(Number.isFinite(observations[0].runnerToProbeMs));
  assert.doesNotMatch(JSON.stringify(observations), /probe-secret|secret data|private/u);
});

test("member adapter requires matching credential mode",async()=>{
  const adapter=createApacProbeRequestAdapter({probeUrl:"https://probe.example",probeToken:"probe-token",credentialMode:"member",
    fetchImpl:async(_url,init)=>{
      assert.equal(JSON.parse(init.body).credentialMode,"member");
      return jsonResponse({status:200,elapsedMs:40,payload:{data:[]},credentialMode:"user"});
    }});
  await assert.rejects(adapter("/api/v1/spaces/spc_test/models/task/records?limit=10"),/credential mode mismatch/u);
});

test("transport and response-body reset retain completed observations and do not retry ambiguous mutations", async()=>{
  for(const stage of ["runner_fetch_failed","runner_response_read_failed"]){
    let calls=0;const error=Object.assign(Error("private token and path"),{cause:{code:"ECONNRESET"}});
    const request=createApacProbeRequestAdapter({probeUrl:"https://probe.example",probeToken:"private-token",credentialMode:"service",
      fetchImpl:async()=>{calls++;if(calls===1)return jsonResponse({status:200,elapsedMs:40,credentialMode:"service",coreRequestId:"35a880fa-33d3-4732-8cfb-961bfb83e9e2",corePlacement:"remote-SIN",probePlacement:"local-SIN",probeIngressColo:"DFW"});if(stage==="runner_fetch_failed")throw error;return {status:200,headers:new Headers({"cf-ray":"a5bef8dec811ce94-SIN"}),text:async()=>{throw error;}};},
      sleepImpl:async()=>{throw Error("must not retry reset");}});
    await request("/api/v1/spaces/spc_test/models/task/records");
    await assert.rejects(()=>request("/api/v1/spaces/spc_test/models/task/records/rec_test",{method:"PATCH",body:{name:"private data"}}),new RegExp(stage));
    assert.equal(calls,2);assert.equal(request.diagnostics().length,1);assert.equal(request.diagnostics()[0].corePlacement,"remote-SIN");
    const failures=request.failures();assert.equal(failures.length,1);assert.equal(failures[0].stage,stage);assert.equal(failures[0].transportCode,"ECONNRESET");
    assert.equal(failures[0].route,"PATCH /api/v1/spaces/spc_*/models/task/records/rec_*");
    assert.doesNotMatch(JSON.stringify(failures),/private|spc_test|rec_test/u);
  }
});
