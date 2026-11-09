import { test } from "node:test";
import assert from "node:assert/strict";
import { accountFetch } from "../worker/index.mjs";

const id = "oar_" + "a".repeat(32);
const arq = "arq_" + "f".repeat(32);
const space = "spc_" + "b".repeat(32);
const agent = "agt_" + "c".repeat(32);
const app = "app_" + "d".repeat(32);
const access = "a".repeat(50) + ".b.c";
const issuerToken = "test-identity-user-token";
const dlg = "dlg_" + "e".repeat(32);

function fixture(requestedScopes = ["resources:read"]) {
  const calls = [];
  const identity = {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      calls.push({ service: "identity", path, authorization: req.headers.get("authorization") });
      if (path === "/internal/v1/access/tokens") {
        assert.equal(req.headers.get("authorization"), "Bearer account-lsa-test");
        const body = await req.json();
        assert.equal(body.accessAssertion, access);
        assert.deepEqual(body.requestedScopes, ["profile:read", "spaces:read", "spaces:manage"]);
        return Response.json({ data: { accessToken: issuerToken } });
      }
      if (path === "/api/v1/me") return Response.json({ data: {
        id: "usr_test123", displayName: "Account tester", status: "active",
      } });
      if (path === "/api/v1/me/oauth/requests/" + id) return Response.json({ data: {
        id, client: { name: "Claimed ChatGPT", id: "ocli_client1", redirectOrigin: "https://client.example.test", verifiedVendor: false },
        resource: "https://mcp.example.test/mcp/tasks", requestedScopes,
        expiresAt: "2026-11-04T12:00:00.000Z",
      } });
      throw new Error("Unknown Identity route: " + path);
    },
  };
  const core = {
    fetch: async (req) => {
      const path = new URL(req.url).pathname;
      calls.push({ service: "core", path, authorization: req.headers.get("authorization") });
      assert.equal(req.headers.get("authorization"), "Bearer " + issuerToken);
      if (path === "/api/v1/me/oauth/delegation-requests/" + arq) return Response.json({ data: {
        id: arq, status:"pending", applicationId:app,spaceId:space,agentId:agent,
        clientId:"ocli_client1", resource:"https://mcp.example.test/mcp/tasks",
        modelKey:"task", operation:"create", reason:"Create one authorized task",
        expiresAt:"2030-11-08T12:00:00.000Z",
      } });
      if (path === "/api/v1/me/oauth/delegation-requests/" + arq + "/approve"
        || path === "/api/v1/me/oauth/delegation-requests/" + arq + "/deny") {
        assert.equal(req.method,"POST");
        const approval=await req.json();
        if(path.endsWith("/deny"))assert.deepEqual(approval,{});
        else assert.ok(JSON.stringify(approval)==="{}"
          || approval.mode==="once"
          || approval.mode==="until_revoked"
          || (approval.mode==="timed" && [60,1440,10080].includes(approval.durationMinutes)));
        calls.push({service:"core-approval",path,payload:approval});
        return Response.json({data:{id:arq,status:path.endsWith("/approve")?"approved":"denied"}});
      }
      if (path === "/api/v1/me/oauth/delegations") {
        assert.equal(new URL(req.url).searchParams.get("offset"),"0");
        return Response.json({data:{items:[{
          id:dlg,applicationId:app,spaceId:space,agentId:agent,clientId:"ocli_client1",
          resource:"https://mcp.example.test/mcp/tasks",modelKey:"task",
          operation:"create",createdAt:"2026-11-09T00:00:00.000Z",
          expiresAt:null,mode:"until_revoked",
        }],nextOffset:null}});
      }
      if (path === "/api/v1/me/oauth/delegations/" + dlg + "/revoke") {
        assert.equal(req.method,"POST");
        assert.deepEqual(await req.json(),{});
        calls.push({service:"core-revoke",path});
        return Response.json({data:{id:dlg,revoked:true}});
      }
      if (path === "/api/v1/me/oauth/capabilities") {
        const query = new URL(req.url).searchParams;
        assert.equal(query.get("applicationId"), app);
        assert.equal(query.get("spaceId"), space);
        assert.equal(query.get("agentId"), agent);
        assert.equal(query.get("resource"), "https://mcp.example.test/mcp/tasks");
        return Response.json({ data: {
          kind: "pre_policy_upper_bound",
          nativeModelsOnly: true, modelPolicyApplied: false,
          resourceCapabilityApplied: true,
          models: [{ key: "task", name: "Task", access: ["read", "write"],
            operations: ["query", "create", "update"] }],
          truncated: false,
        } });
      }
      if (path === "/api/v1/me/oauth/choices") return Response.json({ data: { candidates: [
        { applicationId: app, applicationName: "ALOHA", spaceId: space, spaceName: "Personal Space",
          agentId: agent, agentName: "ALOHA Agent" },
      ] } });
      if (path === "/api/v1/me/oauth/requests/" + id + "/deny") {
        assert.deepEqual(await req.json(), {});
        return Response.json({ data: {
          redirectUrl: "https://client.example.test/callback?error=access_denied&state=someopaque&iss=https%3A%2F%2Fauth-staging.example.test",
        } });
      }
      if (path === "/api/v1/me/oauth/requests/" + id + "/confirm") {
        const input = await req.json();
        assert.deepEqual(input, {
          applicationId: app, spaceId: space, agentId: agent, allowUserAuthorization: false,
        });
        return Response.json({ data: {
          authorizationId: "oaz_" + "e".repeat(32),
          redirectUrl: "https://client.example.test/callback?code=lsp_oac_sample&state=someopaque",
        } });
      }
      throw new Error("Unknown Core route: " + path);
    },
  };
  const env = {
    ENVIRONMENT: "staging",
    IDENTITY_APPLICATION_CREDENTIAL: "account-lsa-test",
    ACCOUNT_CSRF_SECRET: "long-test-csrf-secret-should-be-more-than-32-characters",
    IDENTITY_BASE_URL: "https://auth-staging.example.test",
    CORE_BASE_URL: "https://core-staging.example.test",
    IDENTITY: identity, CORE: core,
    ASSETS: { fetch: async () => new Response("<html>static</html>", {
      headers: { "content-type": "text/html" },
    }) },
  };
  const url = (path) => "https://account-staging.example.test" + path;
  const request = (path, init = {}) => accountFetch(new Request(url(path), {
    ...init, headers: { [ "cf-access-jwt-assertion" ]: access, ...(init.headers || {}) },
  }), env);
  return { env, request, calls };
}
function consentBody() {
  return JSON.stringify({
    intent: "confirm-oauth-authorization", requestId: id,
    applicationId: app, spaceId: space, agentId: agent, allowUserAuthorization: false,
  });
}
function mutatingHeaders(csrf, cookie) {
  return {
    "content-type": "application/json",
    "origin": "https://account-staging.example.test",
    "sec-fetch-site": "same-origin",
    "x-lifespace-csrf": csrf,
    "cookie": cookie,
  };
}
test("Access exchange is server-only and a user-bound signed CSRF cookie allows explicit authorization", async () => {
  const t = fixture();
  const session = await t.request("/api/session");
  assert.equal(session.status, 200);
  const sessionData = await session.json();
  assert.equal(sessionData.data.user.id, "usr_test123");
  assert.ok(!JSON.stringify(sessionData).includes(issuerToken));
  assert.ok(!JSON.stringify(sessionData).includes("account-lsa-test"));
  const csrf = sessionData.data.csrfToken;
  const setCookie = session.headers.get("set-cookie");
  assert.match(setCookie, /^__Host-lifespace-consent=/u);
  assert.match(setCookie, /HttpOnly; SameSite=Strict/u);
  assert.match(setCookie, /Path=\/; Secure/u);
  assert.ok(csrf.length > 60);
  const cookie = setCookie.split(";")[0];
  const choices = await t.request("/api/oauth/choices");
  assert.equal(choices.status, 200);
  assert.deepEqual((await choices.json()).data.candidates[0].spaceId, space);
  const preview = await t.request("/api/oauth/request?request_id=" + id);
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).data.client.verifiedVendor, false);
  const confirmed = await t.request("/api/oauth/confirm", {
    method: "POST", headers: mutatingHeaders(csrf, cookie), body: consentBody(),
  });
  assert.equal(confirmed.status, 200);
  assert.match((await confirmed.json()).data.redirectUrl, /^https:\/\/client\.example\.test\/callback\?code=/u);
  assert.equal(t.calls.filter((c) => c.service === "core" && c.path.endsWith("/confirm")).length, 1);
});

test("explicit OAuth decline requires same-origin signed CSRF and returns an issuer-bound error without a Grant", async () => {
  const t = fixture();
  const session = await t.request("/api/session");
  const { data } = await session.json();
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const good = {
    method: "POST",
    headers: mutatingHeaders(data.csrfToken, cookie),
    body: JSON.stringify({ intent: "deny-oauth-authorization", requestId: id }),
  };
  assert.equal((await t.request("/api/oauth/deny", {
    ...good, headers: mutatingHeaders("bad-token", cookie),
  })).status, 403);
  assert.equal((await t.request("/api/oauth/deny", {
    ...good, body: JSON.stringify({ intent: "deny-oauth-authorization", requestId: id, userId: "usr_other" }),
  })).status, 400);
  const denied = await t.request("/api/oauth/deny", good);
  assert.equal(denied.status, 200);
  const uri = new URL((await denied.json()).data.redirectUrl);
  assert.equal(uri.searchParams.get("error"), "access_denied");
  assert.equal(uri.searchParams.get("iss"), "https://auth-staging.example.test");
  assert.equal(uri.searchParams.has("code"), false);
  assert.equal(t.calls.filter(c => c.service === "core" && c.path.endsWith("/deny")).length, 1);
  assert.equal(t.calls.filter(c => c.service === "core" && c.path.endsWith("/confirm")).length, 0);
});

test("permission projection is bounded by current Identity OAuth scopes, not user-supplied scope claims", async () => {
  const t = fixture();
  const suffix = new URLSearchParams({
    request_id: id, application_id: app, space_id: space, agent_id: agent,
  });
  const result = await t.request("/api/oauth/capabilities?" + suffix);
  assert.equal(result.status, 200);
  const data = (await result.json()).data;
  assert.equal(data.kind, "pre_policy_upper_bound");
  assert.equal(data.resourceCapabilityApplied, true);
  assert.equal(data.modelPolicyApplied, false);
  assert.deepEqual(data.models, [{ key: "task", name: "Task", access: ["read"], operations: ["query"] }]);
  assert.deepEqual(data.requestedScopes, ["resources:read"]);
  assert.equal((await t.request("/api/oauth/capabilities?" + suffix + "&scope=resources:write")).status, 400);
  assert.equal((await t.request("/api/oauth/capabilities?" + suffix + "&agent_id=" + agent)).status, 400);
  assert.equal(t.calls.filter((c) => c.service === "core" && c.path === "/api/v1/me/oauth/capabilities").length, 1);
});

test("explicit read+write client consent previews only Core-selected supported operations", async () => {
  const t = fixture(["resources:read", "resources:write"]);
  const suffix = new URLSearchParams({
    request_id: id, application_id: app, space_id: space, agent_id: agent,
  });
  const result = await t.request("/api/oauth/capabilities?" + suffix);
  assert.equal(result.status, 200);
  const data = (await result.json()).data;
  assert.equal(data.resourceCapabilityApplied, true);
  assert.deepEqual(data.models, [{
    key: "task", name: "Task", access: ["read", "write"],
    operations: ["query", "create", "update"],
  }]);
  assert.deepEqual(data.requestedScopes, ["resources:read", "resources:write"]);
});

test("third-party web Delegation requires signed Account session, CSRF and explicit approve/deny", async () => {
  const t=fixture();
  const link=await t.request("/api/delegation/request?request_id="+arq);
  assert.equal(link.status,200);
  const request=(await link.json()).data;
  assert.equal(request.operation,"create");
  assert.equal(request.clientId,"ocli_client1");
  assert.equal(request.reason,"Create one authorized task");
  assert.ok(!JSON.stringify(request).includes(issuerToken));
  assert.equal((await t.request("/api/delegation/request?request_id=arq_forged")).status,400);
  assert.equal((await t.request("/api/delegation/approve",{method:"POST",headers:{
    "content-type":"application/json","origin":"https://account-staging.example.test",
    "sec-fetch-site":"same-origin"},body:JSON.stringify({
      intent:"approve-user-delegation",requestId:arq,
    })})).status,403);
  const session=await t.request("/api/session");
  const proof=(await session.json()).data.csrfToken;
  const cookie=session.headers.get("set-cookie").split(";")[0];
  const valid=mutatingHeaders(proof,cookie);
  const approval=await t.request("/api/delegation/approve",{method:"POST",headers:valid,
    body:JSON.stringify({intent:"approve-user-delegation",requestId:arq})});
  assert.equal(approval.status,200);
  assert.deepEqual((await approval.json()).data,{requestId:arq,status:"approved"});
  const refusal=await t.request("/api/delegation/deny",{method:"POST",headers:valid,
    body:JSON.stringify({intent:"deny-user-delegation",requestId:arq})});
  assert.equal(refusal.status,200);
  assert.deepEqual((await refusal.json()).data,{requestId:arq,status:"denied"});
  const forged=await t.request("/api/delegation/approve",{method:"POST",headers:valid,
    body:JSON.stringify({intent:"approve-user-delegation",requestId:arq,principalUserId:"usr_other"})});
  assert.equal(forged.status,400);
  // Existing OAuth consent and trusted n8n/WeCom routes remain independent.
  assert.equal(t.calls.filter(x=>x.path.includes("/authorization-requests/")).length,0);
});

test("Account lifetime selection is explicit, bounded, CSRF-protected, and revocable", async () => {
  const t=fixture();
  const session=await t.request("/api/session");
  const valid=mutatingHeaders((await session.json()).data.csrfToken,
    session.headers.get("set-cookie").split(";")[0]);
  const approve=async mode=>t.request("/api/delegation/approve",{
    method:"POST",headers:valid,
    body:JSON.stringify({intent:"approve-user-delegation",requestId:arq,...mode}),
  });
  for(const mode of [{mode:"once"},{mode:"timed",durationMinutes:60},
    {mode:"timed",durationMinutes:1440},{mode:"timed",durationMinutes:10080},
    {mode:"until_revoked"}]) {
    assert.equal((await approve(mode)).status,200);
  }
  for(const invalid of [
    {mode:"timed",durationMinutes:15},{mode:"timed",durationMinutes:10081},
    {mode:"until_revoked",durationMinutes:60},{mode:"unknown"},
    {mode:"once",durationMinutes:60},{mode:"timed",durationMinutes:"60"},
    {mode:"until_revoked",principalUserId:"usr_other"},
  ])assert.equal((await approve(invalid)).status,400);
  assert.equal(t.calls.filter(x=>x.service==="core-approval").length,5);
  const listing=await t.request("/api/delegations?offset=0");
  assert.equal(listing.status,200);
  const listed=(await listing.json()).data.items[0];
  assert.equal(listed.mode,"until_revoked");
  assert.equal(listed.clientId,"ocli_client1");
  assert.equal(listed.resource,"https://mcp.example.test/mcp/tasks");
  assert.equal((await t.request("/api/delegations?offset=-1")).status,400);
  assert.equal((await t.request("/api/delegations/revoke",{method:"POST",
    headers:valid,body:JSON.stringify({intent:"revoke-user-delegation",delegationId:"dlg_forged"})})).status,503);
  assert.equal((await t.request("/api/delegations/revoke",{method:"POST",headers:valid,
    body:JSON.stringify({intent:"revoke-user-delegation",delegationId:dlg,userId:"usr_other"})})).status,400);
  const revoked=await t.request("/api/delegations/revoke",{method:"POST",headers:valid,
    body:JSON.stringify({intent:"revoke-user-delegation",delegationId:dlg})});
  assert.equal(revoked.status,200);
  assert.equal((await revoked.json()).data.revoked,true);
  assert.equal(t.calls.filter(x=>x.service==="core-revoke").length,1);
});

test("missing Access proof and missing Account configuration fail closed", async () => {
  const t = fixture();
  const notLogged = await accountFetch(new Request("https://account-staging.example.test/api/session"), t.env);
  assert.equal(notLogged.status, 401);
  t.env.IDENTITY_APPLICATION_CREDENTIAL = undefined;
  assert.equal((await t.request("/api/session")).status, 503);
});

test("same-origin, CSRF, explicit-intent, shape and client-controlled upstream protections", async () => {
  const t = fixture();
  const session = await t.request("/api/session");
  const { data } = await session.json();
  const cookie = session.headers.get("set-cookie").split(";")[0];
  const base = { method: "POST", body: consentBody() };
  const failCases = [
    { headers: mutatingHeaders("wrong", cookie), status: 403 },
    { headers: mutatingHeaders(data.csrfToken, ""), status: 403 },
    { headers: { ...mutatingHeaders(data.csrfToken, cookie), origin: "https://evil.example.test" }, status: 403 },
    { headers: { ...mutatingHeaders(data.csrfToken, cookie), "sec-fetch-site": "cross-site" }, status: 403 },
    { headers: mutatingHeaders(data.csrfToken, cookie), body: JSON.stringify({ ...JSON.parse(consentBody()), principalUserId: "usr_admin" }), status: 400 },
    { headers: mutatingHeaders(data.csrfToken, cookie), body: JSON.stringify({ ...JSON.parse(consentBody()), intent: "some-other-intent" }), status: 400 },
    { headers: mutatingHeaders(data.csrfToken, cookie), body: JSON.stringify({ ...JSON.parse(consentBody()), agentId: "invalid" }), status: 400 },
  ];
  for (const entry of failCases) {
    const res = await t.request("/api/oauth/confirm", { ...base, ...entry });
    assert.equal(res.status, entry.status);
  }
  assert.equal(t.calls.filter((c) => c.service === "core" && c.path.endsWith("/confirm")).length, 0);
  assert.equal((await t.request("/api/oauth/request?request_id=" + id + "&admin=1")).status, 400);
  assert.equal((await t.request("/api/private/admin")).status, 404);
  assert.equal((await t.request("/api/oauth/confirm", { method: "GET" })).status, 405);
});

test("Account static responses enforce CSP and no-referrer", async () => {
  const t = fixture();
  const res = await t.request("/oauth/consent");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /frame-ancestors 'none'/u);
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});
