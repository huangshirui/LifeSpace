import type { Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { oauthMcpServerId } from "./mcp-oauth-server-policy";
import { getRuntimeModel } from "./model-registry";
import { getExternalModel } from "./external-model";
import { requirePersonDirectoryPermission } from "./authorization";
import { delegationIssueStatements, delegationIssueDtos, prepareDelegationIssues } from "./delegation-routes";

// This is a transport-specific pending-approval bridge, NOT a second
// Delegation authority. Trusted in-app / WeCom arq_* routes are untouched.
type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
type Op = "get" | "query" | "create" | "update" | "delete" | `action:${string}`;
type Access = "read" | "write";
type Binding = {
  channel: "oauth_mcp"; authorizationId: string; clientId: string;
  resource: string; modelKey: string; operation: Op; reason: string;
  requestedAccess?: Access;
};
type RequestRow = {
  id: string; application_id: string; requesting_agent_id: string;
  intended_user_id: string; source_space_id: string; correlation_json: string | null;
  created_at: string; expires_at: string; transition_status: string | null;
};
type ItemRow = {
  ordinal: number; target_type: string; target_id: string; max_access: "read" | "write";
  max_uses: 1 | null; delegation_expires_at: string | null; remaining_redelegation_depth: number;
};
const ARQ = /^arq_[a-f0-9]{32}$/u;
const MODEL = /^[a-z][a-z0-9_]{1,62}$/u;
const PERSON_MODEL = "person";
const PERSON_TARGET = "person_directory";
const delegationTarget = (modelKey: string) => modelKey === PERSON_MODEL ? PERSON_TARGET : modelKey;
const OPS = new Set<string>(["get","query","create","update","delete"]);
const ACTION = /^action:([a-z][a-z0-9_-]{0,62})$/u;
const validOp = (value: unknown): value is Op => typeof value === "string"
  && (OPS.has(value) || ACTION.test(value));
const ACCOUNT_TIMEOUT_MINUTES = 10;
const DELEGATION_TIMEOUT_MINUTES = 30;
const APPROVAL_LIMIT = 10;
const fail = () => new ApiError("OAUTH_DELEGATION_NOT_FOUND", "Delegation request is not available", 404);
const statusOf = (row: RequestRow) => row.transition_status ||
  (Date.parse(row.expires_at) <= Date.now() ? "expired" : "pending");
const accessOf = (operation: Op, actual?: Access): Access => {
  if (ACTION.test(operation)) {
    if (actual !== "read" && actual !== "write") throw fail();
    return actual;
  }
  return operation === "get" || operation === "query" ? "read" : "write";
};
const uuid = (prefix: string) => prefix + "_" + crypto.randomUUID().replaceAll("-", "");

function agent(principal: Principal) {
  const x = principal.oauthExecution;
  if (principal.purpose !== "oauth_agent_execution" || principal.type !== "agent"
    || principal.actor || !x || x.agentId !== principal.id || x.applicationId !== principal.clientId
    || !x.allowUserAuthorization || !x.userId) throw new ApiError("FORBIDDEN", "Explicit User Delegation is unavailable", 403);
  return x;
}
function account(principal: Principal, env: Bindings) {
  if (!env.OAUTH_ACCOUNT_APPLICATION_ID || principal.type !== "user" || principal.actor
    || principal.purpose || principal.clientId !== env.OAUTH_ACCOUNT_APPLICATION_ID
    || !principal.scopes.includes("profile:read")) {
    throw new ApiError("FORBIDDEN", "An authenticated LifeSpace Account User is required", 403);
  }
  return principal.id;
}
function approvalOrigin(env: Bindings): string {
  // These are deployment routes, not authorization semantics.
  // An explicit owner-configured override may replace the canonical host.
  const value = env.MCP_DELEGATION_ACCOUNT_ORIGIN ||
    (env.ENVIRONMENT === "staging" ? "https://account-staging.aisr.online"
      : env.ENVIRONMENT === "production" ? "https://account.aisr.online" : "");
  if (typeof value !== "string") throw new ApiError("OAUTH_NOT_CONFIGURED", "Delegation confirmation page is unavailable", 503);
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError("OAUTH_NOT_CONFIGURED", "Invalid approval origin", 503); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash
    || url.username || url.password) throw new ApiError("OAUTH_NOT_CONFIGURED", "Invalid approval origin", 503);
  return url.origin;
}
async function serverOperation(env: Bindings, resource: string, spaceId: string, modelKey: string, operation: Op) {
  const serverId = oauthMcpServerId(resource);
  if (!serverId) throw fail();
  const row = await env.DB.prepare("SELECT enabled,config_json FROM mcp_server_definitions WHERE id=?")
    .bind(serverId).first<{enabled:number;config_json:string}>();
  if (!row || row.enabled !== 1) throw fail();
  let config: unknown;
  try { config = JSON.parse(row.config_json); } catch { throw fail(); }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw fail();
  // Person is exposed as an ordinary consumer-facing "person" model, but
  // the exact Kernel target and current Grant stay Core-private.
  if (modelKey === PERSON_MODEL) {
    if (ACTION.test(operation)) throw fail();
    const resources = (config as {resources?: unknown}).resources;
    if (!Array.isArray(resources)) throw fail();
    const person = resources.find(r => r && typeof r === "object" && !Array.isArray(r)
      && (r as {resourceKey?:unknown}).resourceKey === PERSON_TARGET) as
        {operations?:unknown} | undefined;
    const selected = operation === "query" ? "list" : operation;
    if (!person || !Array.isArray(person.operations) || !person.operations.includes(selected)) throw fail();
    return accessOf(operation);
  }
  const entry = (config as {models?: unknown}).models;
  if (!Array.isArray(entry) || entry.length > 32) throw fail();
  const chosen = entry.find(x => x && typeof x === "object" && !Array.isArray(x)
    && (x as {modelKey?:unknown}).modelKey === modelKey) as {operations?: unknown} | undefined;
  if (!chosen || !Array.isArray(chosen.operations) || !chosen.operations.includes(operation)) throw fail();
  // OAuth Account approval must never issue an unusable Delegation just
  // because an MCP Server configuration lists an operation. Use the same
  // published Model origin and current Provider capability as Core runtime.
  const model=await getRuntimeModel(env,modelKey);
  if (!model) throw fail();
  if (model.definition.origin === "external") {
    if (ACTION.test(operation)) throw fail();
    const bound=await getExternalModel(env,spaceId,modelKey);
    const externalOperation=operation as "get"|"query"|"create"|"update"|"delete";
    if (!bound || bound.status!=="active" || !bound.snapshot.capabilities[externalOperation]
      || (accessOf(operation)==="write" && bound.declared_access!=="write")) throw fail();
    // Single-use External mutations are permitted. The Core External
    // Runtime consumes current Delegation in D1 BEFORE one Provider write
    // attempt; error/timeout never releases the Delegation. The Account
    // approval binds the same exact operation, scope, Client and Space.
  } else {
    const action=ACTION.exec(operation);
    const required:Access = action
      ? model.definition.actions?.[action[1]]?.access as Access
      : accessOf(operation);
    if ((required!=="read" && required!=="write")
      || !model.definition.access.includes(required)) throw fail();
    return required;
  }
  return accessOf(operation);
}
async function load(env: Bindings, id: string) {
  if (!ARQ.test(id)) throw fail();
  const row = await env.DB.prepare(
    "SELECT r.id,r.application_id,r.requesting_agent_id,r.intended_user_id,r.source_space_id," +
    "r.correlation_json,r.created_at,r.expires_at,t.status AS transition_status " +
    "FROM authorization_requests r LEFT JOIN authorization_request_transitions t ON t.request_id=r.id WHERE r.id=?"
  ).bind(id).first<RequestRow>();
  if (!row) throw fail();
  let binding: Binding | null = null;
  try { binding = JSON.parse(row.correlation_json || "null") as Binding; } catch { throw fail(); }
  if (!binding || binding.channel !== "oauth_mcp"
    || typeof binding.authorizationId !== "string" || !/^oaz_[A-Za-z0-9_-]{10,128}$/u.test(binding.authorizationId)
    || typeof binding.resource !== "string" || !oauthMcpServerId(binding.resource)
    || typeof binding.clientId !== "string"
    || typeof binding.modelKey !== "string" || !MODEL.test(binding.modelKey)
    || !validOp(binding.operation) || typeof binding.reason !== "string") throw fail();
  const details = await env.DB.prepare(
    "SELECT ordinal,target_type,target_id,max_access,max_uses,delegation_expires_at,remaining_redelegation_depth " +
    "FROM authorization_request_items WHERE request_id=? ORDER BY ordinal"
  ).bind(id).all<ItemRow>();
  if (details.results.length !== 1 || details.results[0]?.target_type !== "model"
    || details.results[0]?.target_id !== delegationTarget(binding.modelKey)
    || details.results[0]?.max_access !== accessOf(binding.operation,binding.requestedAccess)
    || details.results[0]?.max_uses !== 1 || details.results[0]?.remaining_redelegation_depth !== 0) throw fail();
  return {row, binding, item:details.results[0]!};
}
async function delegationId(env: Bindings, id: string): Promise<string|null> {
  const row = await env.DB.prepare("SELECT delegation_id FROM authorization_request_delegations WHERE request_id=? AND ordinal=0")
    .bind(id).first<{delegation_id:string}>();
  return row?.delegation_id || null;
}
function summary(row: RequestRow, binding: Binding, delegation: string|null) {
  return { id:row.id, status:statusOf(row), applicationId:row.application_id,
    agentId:row.requesting_agent_id, spaceId:row.source_space_id, resource:binding.resource,
    clientId:binding.clientId, modelKey:binding.modelKey, operation:binding.operation,
    reason:binding.reason, expiresAt:row.expires_at,
    ...(delegation ? {delegationId:delegation} : {}) };
}
async function liveConsent(env: Bindings, row: RequestRow, binding: Binding) {
  if (!env.IDENTITY || !env.CORE_IDENTITY_SHARED_SECRET) throw new ApiError("OAUTH_NOT_CONFIGURED", "OAuth introspection unavailable", 503);
  let response: Response;
  try {
    response = await env.IDENTITY.fetch("https://identity.internal/introspection/v1/oauth-delegation-authorizations", {
      method:"POST",
      headers: {"content-type":"application/json","x-lifespace-internal-secret":env.CORE_IDENTITY_SHARED_SECRET},
      body:JSON.stringify({
        authorizationId:binding.authorizationId,clientId:binding.clientId,resource:binding.resource,
        applicationId:row.application_id,agentId:row.requesting_agent_id,
        userId:row.intended_user_id,spaceId:row.source_space_id,
      }),
    });
  } catch { throw new ApiError("OAUTH_UNAVAILABLE", "Current OAuth authorization cannot be verified", 503); }
  const result = response.ok ? await response.json<{data?:{active?:boolean;scopes?:unknown}}>().catch(()=>null) : null;
  const scopes = result?.data?.scopes;
  if (result?.data?.active !== true || !Array.isArray(scopes)
    || !scopes.includes("resources:" + accessOf(binding.operation,binding.requestedAccess))) {
    throw new ApiError("OAUTH_AUTHORIZATION_REVOKED", "OAuth authorization is unavailable", 403);
  }
  const current=await serverOperation(env,binding.resource,row.source_space_id,binding.modelKey,binding.operation);
  if (current !== accessOf(binding.operation,binding.requestedAccess)) throw fail();
  return scopes as string[];
}
function assertAgentOwner(principal: Principal, row: RequestRow, binding: Binding) {
  const x=agent(principal);
  if (row.application_id !== principal.clientId || row.requesting_agent_id !== principal.id
    || row.intended_user_id !== x.userId || row.source_space_id !== x.spaceId
    || binding.clientId !== x.clientId || binding.authorizationId !== x.authorizationId
    || binding.resource !== x.resource) throw fail();
}
function assertAccountOwner(principal: Principal, env: Bindings, row: RequestRow) {
  const userId=account(principal,env);
  if (row.intended_user_id !== userId) throw fail();
}

export async function requireOAuthMcpDelegatedOperation(
  env: Bindings, principal: Principal, method: string, path: string, providedId: string,
): Promise<void> {
  const x = principal.oauthExecution;
  if (!x?.delegationId || providedId !== x.delegationId || principal.type !== "user"
    || principal.id !== x.userId || principal.actor?.id !== x.agentId || !x.allowUserAuthorization) throw fail();
  const bindingRow = await env.DB.prepare(
    "SELECT r.id,r.application_id,r.requesting_agent_id,r.intended_user_id,r.source_space_id," +
    "r.correlation_json,r.created_at,r.expires_at,t.status AS transition_status " +
    "FROM authorization_request_delegations d JOIN authorization_requests r ON r.id=d.request_id " +
    "JOIN authorization_request_transitions t ON t.request_id=r.id " +
    "WHERE d.delegation_id=? AND t.status='approved'"
  ).bind(providedId).first<RequestRow>();
  if (!bindingRow) throw fail();
  const loaded=await load(env,bindingRow.id);
  if (loaded.row.application_id !== principal.clientId
    || loaded.row.intended_user_id !== principal.id || loaded.row.requesting_agent_id !== x.agentId
    || loaded.row.source_space_id !== x.spaceId || loaded.binding.authorizationId !== x.authorizationId
    || loaded.binding.clientId !== x.clientId || loaded.binding.resource !== x.resource) throw fail();
  const op:Op=loaded.binding.operation;
  const personPrefix="/api/v1/spaces/" + x.spaceId + "/people";
  if (loaded.binding.modelKey === PERSON_MODEL) {
    const personRecord=new RegExp("^"+personPrefix+"/per_[A-Za-z0-9_-]+$","u").test(path);
    const validPerson = op === "query" ? method === "GET" && path === personPrefix
      : op === "create" ? method === "POST" && path === personPrefix
      : op === "get" ? method === "GET" && personRecord
      : op === "update" ? method === "PATCH" && personRecord
      : op === "delete" ? method === "DELETE" && personRecord : false;
    if (!validPerson) throw fail();
    await liveConsent(env,loaded.row,loaded.binding);
    return;
  }
  const prefix="/api/v1/spaces/" + x.spaceId + "/models/" + loaded.binding.modelKey + "/records";
  const action=ACTION.exec(op);
  const valid = action
    ? method==="POST" && path.startsWith(prefix+"/")
      && /^rec_[A-Za-z0-9_-]+$/u.test(path.slice(prefix.length+1).split("/")[0])
      && path === prefix+"/"+path.slice(prefix.length+1).split("/")[0]+"/actions/"+action[1]
    : op==="query" ? method==="POST" && path===prefix+"/query"
    : op==="create" ? method==="POST" && path===prefix
    : op==="get" ? method==="GET" && /^rec_[A-Za-z0-9_-]+$/u.test(path.slice(prefix.length+1)) && path.startsWith(prefix+"/")
    : (op==="update" || op==="delete") && method===(op==="update"?"PATCH":"DELETE")
      && path.startsWith(prefix+"/") && /^rec_[A-Za-z0-9_-]+$/u.test(path.slice(prefix.length+1));
  if (!valid) throw fail();
  await liveConsent(env,loaded.row,loaded.binding);
}

export function registerOAuthDelegationRoutes(app: App): void {
  app.post("/api/v1/spaces/:spaceId/oauth-delegation-requests", async c=>{
    const principal=c.get("principal"), x=agent(principal);
    const spaceId=c.req.param("spaceId");
    if (x.spaceId!==spaceId) throw fail();
    const raw=await c.req.text();
    if (raw.length>1200) throw new ApiError("INVALID_REQUEST","Request too large",413);
    let input:unknown;
    try {input=JSON.parse(raw);} catch {throw new ApiError("INVALID_REQUEST","Invalid request",400);}
    if (!input || typeof input!=="object" || Array.isArray(input)) throw new ApiError("INVALID_REQUEST","Invalid request",400);
    const v=input as Record<string,unknown>;
    if (Object.keys(v).some(key=>!["modelKey","operation","reason"].includes(key))
      || typeof v.modelKey!=="string" || !MODEL.test(v.modelKey)
      || !validOp(v.operation)
      || typeof v.reason!=="string" || v.reason.trim().length<4 || v.reason.trim().length>250)
      throw new ApiError("INVALID_REQUEST","A model, supported operation and concise reason are required",400);
    const operation=v.operation as Op, modelKey=v.modelKey;
    const requestedAccess=await serverOperation(c.env,x.resource,spaceId,modelKey,operation);
    if (!principal.scopes.includes("resources:"+requestedAccess))
      throw new ApiError("FORBIDDEN","Client did not request the operation's OAuth Scope",403);
    const origin=approvalOrigin(c.env);
    const now=new Date();
    const count=await c.env.DB.prepare(
      "SELECT COUNT(*) AS n FROM authorization_requests r LEFT JOIN authorization_request_transitions t ON t.request_id=r.id "+
      "WHERE r.requesting_agent_id=? AND r.intended_user_id=? AND r.source_space_id=? AND r.created_at>? AND t.request_id IS NULL"
    ).bind(x.agentId,x.userId,spaceId,new Date(now.getTime()-15*60000).toISOString()).first<{n:number}>();
    if ((count?.n||0)>=APPROVAL_LIMIT) throw new ApiError("RATE_LIMITED","Too many pending approvals",429);
    const requestId=uuid("arq");
    const expiration=new Date(now.getTime()+ACCOUNT_TIMEOUT_MINUTES*60000).toISOString();
    const delegationExpiresAt=new Date(now.getTime()+DELEGATION_TIMEOUT_MINUTES*60000).toISOString();
    const binding:Binding={channel:"oauth_mcp",authorizationId:x.authorizationId,clientId:x.clientId,
      resource:x.resource,modelKey,operation,requestedAccess,reason:v.reason.trim()};
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO authorization_requests(id,application_id,requesting_agent_id,intended_user_id,source_space_id,"+
        "request_ttl_minutes,fingerprint,reuse_key,correlation_json,created_at,expires_at) "+
        "VALUES(?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(requestId,principal.clientId,x.agentId,x.userId,spaceId,ACCOUNT_TIMEOUT_MINUTES,
        uuid("fingerprint"),uuid("oauth_reuse"),JSON.stringify(binding),now.toISOString(),expiration),
      c.env.DB.prepare(
        "INSERT INTO authorization_request_items(request_id,ordinal,target_type,target_id,max_access,max_uses,delegation_expires_at,remaining_redelegation_depth) "+
        "VALUES(?,0,'model',?,?,1,?,0)"
      ).bind(requestId,delegationTarget(modelKey),requestedAccess,delegationExpiresAt),
    ]);
    c.header("Cache-Control","no-store");
    return c.json(success({id:requestId,status:"pending",approvalUrl:origin+"/delegation?request_id="+requestId,
      expiresAt:expiration,modelKey,operation}),201);
  });
  app.get("/api/v1/spaces/:spaceId/oauth-delegation-requests/:requestId",async c=>{
    const principal=c.get("principal");
    const loaded=await load(c.env,c.req.param("requestId"));
    assertAgentOwner(principal,loaded.row,loaded.binding);
    if (loaded.row.source_space_id!==c.req.param("spaceId")) throw fail();
    c.header("Cache-Control","no-store");
    return c.json(success(summary(loaded.row,loaded.binding,
      statusOf(loaded.row)==="approved"?await delegationId(c.env,loaded.row.id):null)));
  });
  app.get("/api/v1/me/oauth/delegation-requests/:requestId",async c=>{
    const loaded=await load(c.env,c.req.param("requestId"));
    assertAccountOwner(c.get("principal"),c.env,loaded.row);
    await liveConsent(c.env,loaded.row,loaded.binding);
    c.header("Cache-Control","no-store");
    return c.json(success(summary(loaded.row,loaded.binding,
      statusOf(loaded.row)==="approved"?await delegationId(c.env,loaded.row.id):null)));
  });
  app.post("/api/v1/me/oauth/delegation-requests/:requestId/:decision",async c=>{
    const loaded=await load(c.env,c.req.param("requestId"));
    const principal=c.get("principal"),userId=account(principal,c.env);
    if (loaded.row.intended_user_id!==userId) throw fail();
    if (c.req.param("decision")!=="approve" && c.req.param("decision")!=="deny") throw fail();
    const body=await c.req.text();
    if (body!=="{}") throw new ApiError("INVALID_REQUEST","Only an explicit Account decision is allowed",400);
    const current=statusOf(loaded.row);
    if (current!=="pending") throw new ApiError("AUTHORIZATION_REQUEST_NOT_PENDING","Approval is no longer pending",409);
    const scopes=await liveConsent(c.env,loaded.row,loaded.binding);
    const now=new Date().toISOString();
    const isApprove=c.req.param("decision")==="approve";
    if (!isApprove) {
      await c.env.DB.prepare(
        "INSERT INTO authorization_request_transitions(request_id,status,transitioned_at,actor_type,actor_id) VALUES(?,'denied',?,'user',?)"
      ).bind(loaded.row.id,now,userId).run();
      return c.json(success({id:loaded.row.id,status:"denied"}));
    }
    const delegated:Principal={type:"user",id:userId,clientId:loaded.row.application_id,
      scopes,tokenId:principal.tokenId};
    const constraints={maxUses:1 as const,expiresAt:loaded.item.delegation_expires_at,remainingRedelegationDepth:0};
    const issues=await prepareDelegationIssues(c.env,delegated,loaded.row.source_space_id,[{
      actor:{type:"agent",id:loaded.row.requesting_agent_id},
      scope:{target:{type:"model",id:delegationTarget(loaded.binding.modelKey)},maxAccess:loaded.item.max_access},
      constraints,
    }],{type:"user",id:userId});
    const issue=issues[0]!;
    await c.env.DB.batch([
      c.env.DB.prepare(
        "INSERT INTO authorization_request_transitions(request_id,status,transitioned_at,actor_type,actor_id) VALUES(?,'approved',?,'user',?)"
      ).bind(loaded.row.id,now,userId),
      ...delegationIssueStatements(c.env,delegated,loaded.row.source_space_id,issues),
      c.env.DB.prepare(
        "INSERT INTO authorization_request_delegations(request_id,ordinal,delegation_id) VALUES(?,0,?)"
      ).bind(loaded.row.id,issue.delegationId),
    ]);
    c.header("Cache-Control","no-store");
    return c.json(success({id:loaded.row.id,status:"approved",
      delegations:delegationIssueDtos(delegated,loaded.row.source_space_id,issues)}));
  });
}
