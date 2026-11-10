// LifeSpace Account: same-origin OAuth Consent BFF, no independent data store.
// Access JWT and LifeSpace tokens must never enter browser responses or logs.
const ACCESS_HEADER = "cf-access-jwt-assertion";
const CSRF_COOKIE = "__Host-lifespace-consent";
const CSRF_TTL_SECONDS = 600;
const SCOPES = ["profile:read", "spaces:read", "spaces:manage"];
const REQUEST = /^oar_[A-Za-z0-9_-]{16,128}$/u;
const DELEGATION_REQUEST = /^arq_[a-f0-9]{32}$/u;
const DELEGATION_ID = /^dlg_[A-Za-z0-9_-]+$/u;
const APPROVAL_MODES = new Set(["once","timed","until_revoked"]);
const APPROVAL_DURATIONS = new Set([60,1440,10080]);
const SPACE = /^spc_[A-Za-z0-9_-]{3,128}$/u;
const AGENT = /^agt_[A-Za-z0-9_-]{3,128}$/u;
const APPLICATION = /^app_[A-Za-z0-9_-]{3,128}$/u;
const JSON_TYPE = "application/json; charset=utf-8";
const ACCOUNT_EXTERNAL = /^\/api\/account\/spaces\/(spc_[A-Za-z0-9_-]{3,128})\/external-connections$/u;
const ACCOUNT_AUTHORIZATION = /^\/api\/account\/authorizations\/(oaz_[A-Za-z0-9_-]{16,128})(?:\/(revoke))?$/u;
const ACCOUNT_SPACE_DETAIL = /^\/api\/account\/spaces\/(spc_[A-Za-z0-9_-]{3,128})(?:\/(members))?$/u;
const SPACE_ROLES = new Set(["owner","admin","editor","viewer"]);
function validAuthorization(item) {
  return isObject(item) && /^oaz_[A-Za-z0-9_-]{16,128}$/u.test(item.id||"")
    && safeText(item.clientId,1024) && safeText(item.clientName,200)
    && safeText(item.resource,1024) && APPLICATION.test(item.applicationId||"")
    && SPACE.test(item.spaceId||"") && AGENT.test(item.agentId||"")
    && typeof item.allowUserAuthorization==="boolean"
    && Array.isArray(item.scopes) && item.scopes.length<=2
    && item.scopes.every(scope=>["resources:read","resources:write"].includes(scope))
    && ["active","revoked"].includes(item.status) && safeText(item.createdAt,80)
    && (item.revokedAt===null || safeText(item.revokedAt,80));
}
function avatarFromIdentity(profile, env) {
  if (!safeText(profile?.avatarUrl, 2048)) return null;
  try {
    const parsed = new URL(profile.avatarUrl);
    const base = new URL(env.IDENTITY_BASE_URL);
    return parsed.origin === base.origin
      && parsed.pathname === "/assets/users/" + encodeURIComponent(profile.id) + "/avatar"
      && !parsed.search && !parsed.hash ? parsed.href : null;
  } catch { return null; }
}

function responseJson(payload, status = 200, extra = {}) {
  return new Response(JSON.stringify(payload), {
    status, headers: { "content-type": JSON_TYPE, "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
      "vary": "Cookie, Cf-Access-Jwt-Assertion", ...extra },
  });
}
const fail = (status, code, message) => responseJson({ error: { code, message } }, status);
const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function safeText(value, max = 150) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}
function encodedPath(value) { return encodeURIComponent(value); }
function serviceBinding(env, which) {
  const service = env[which];
  if (service && typeof service.fetch === "function") return service;
  // Production/Staging must use explicit private Service Bindings.
  if (env.ENVIRONMENT !== "local") throw new Error("Account Service Binding missing");
  return { fetch: (request) => fetch(request) };
}
async function service(env, which, path, init = {}) {
  const base = which === "IDENTITY" ? env.IDENTITY_BASE_URL : env.CORE_BASE_URL;
  if (!base || !/^https?:\/\//u.test(base)) throw new Error("Account upstream not configured");
  const url = new URL(path, base.endsWith("/") ? base : base + "/");
  return serviceBinding(env, which).fetch(new Request(url, init));
}
async function data(response) {
  const parsed = await response.json().catch(() => null);
  return isObject(parsed) && isObject(parsed.data) ? parsed.data : null;
}
async function arrayData(response) {
  const parsed = await response.json().catch(() => null);
  return isObject(parsed) && Array.isArray(parsed.data) ? parsed.data : null;
}
function accessAssertion(req) {
  const assertion = req.headers.get(ACCESS_HEADER)?.trim() || "";
  return assertion.length > 40 && assertion.length <= 32768 && assertion.split(".").length === 3 ? assertion : null;
}
async function session(req, env) {
  const assertion = accessAssertion(req);
  if (!assertion) return fail(401, "ACCESS_REQUIRED", "请先通过 Cloudflare Access 登录");
  if (!safeText(env.IDENTITY_APPLICATION_CREDENTIAL, 1000)) {
    return fail(503, "ACCOUNT_NOT_CONFIGURED", "Account Application 尚未配置");
  }
  let exchanged;
  try {
    exchanged = await service(env, "IDENTITY", "/internal/v1/access/tokens", {
      method: "POST",
      headers: { authorization: "Bearer " + env.IDENTITY_APPLICATION_CREDENTIAL, "content-type": JSON_TYPE },
      body: JSON.stringify({ accessAssertion: assertion, requestedScopes: SCOPES }),
    });
  } catch {
    return fail(503, "IDENTITY_UNAVAILABLE", "Identity 登录验证不可用");
  }
  if (exchanged.status === 409) return fail(409, "ACCOUNT_LINK_REQUIRED", "该 Access 身份尚未关联 LifeSpace 用户");
  if (!exchanged.ok) return fail(403, "ACCESS_DENIED", "未能验证本次 Account 登录");
  const exchangedData = await data(exchanged);
  const userToken = exchangedData?.accessToken;
  if (!safeText(userToken, 8192)) return fail(502, "IDENTITY_INVALID_RESPONSE", "Identity 未返回有效用户凭据");
  let profileResponse;
  try {
    profileResponse = await service(env, "IDENTITY", "/api/v1/me", {
      headers: { authorization: "Bearer " + userToken },
    });
  } catch {
    return fail(503, "IDENTITY_UNAVAILABLE", "无法获取 LifeSpace 用户资料");
  }
  const profile = profileResponse.ok ? await data(profileResponse) : null;
  if (!profile || !/^usr_[A-Za-z0-9_-]+$/u.test(profile.id || "")
    || typeof profile.displayName !== "string" || profile.status !== "active") {
    return fail(403, "ACCOUNT_USER_UNAVAILABLE", "LifeSpace 用户不存在或不可用");
  }
  return { token: userToken, user: { id: profile.id, displayName: profile.displayName, avatarUrl: avatarFromIdentity(profile, env) } };
}
const toUrl = (origin, path) => new URL(path, origin).href;
function sameOriginMutation(req) {
  const url = new URL(req.url);
  return req.headers.get("origin") === url.origin
    && req.headers.get("sec-fetch-site") === "same-origin"
    && /^application\/json(?:\s*;|$)/iu.test(req.headers.get("content-type") || "");
}
function b64(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
function decodeB64(value) {
  try {
    const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
    const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch { return null; }
}
async function key(env) {
  const secret = env.ACCOUNT_CSRF_SECRET;
  if (typeof secret !== "string" || secret.length < 32) return null;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function newCsrf(env, userId) {
  const hmac = await key(env);
  if (!hmac) return null;
  const expiry = Math.floor(Date.now() / 1000) + CSRF_TTL_SECONDS;
  const nonce = b64(crypto.getRandomValues(new Uint8Array(24)));
  const base = "v1." + expiry + "." + nonce;
  const signature = await crypto.subtle.sign("HMAC", hmac, new TextEncoder().encode(base + "." + userId));
  return base + "." + b64(new Uint8Array(signature));
}
function cookie(req, name) {
  const field = req.headers.get("cookie") || "";
  for (const component of field.split(";")) {
    const [key, ...values] = component.trim().split("=");
    if (key === name) return values.join("=");
  }
  return "";
}
async function validCsrf(req, env, userId) {
  const header = req.headers.get("x-lifespace-csrf") || "";
  const stored = cookie(req, CSRF_COOKIE);
  if (!header || header.length > 300 || !stored || header !== stored) return false;
  const parts = header.split(".");
  if (parts.length !== 4 || parts[0] !== "v1" || !/^\d{10}$/u.test(parts[1])
    || !/^[A-Za-z0-9_-]{32}$/u.test(parts[2])) return false;
  const expires = Number(parts[1]), now = Math.floor(Date.now() / 1000);
  if (expires <= now || expires > now + CSRF_TTL_SECONDS) return false;
  const hmac = await key(env);
  const signature = decodeB64(parts[3]);
  return !!(hmac && signature && await crypto.subtle.verify(
    "HMAC", hmac, signature, new TextEncoder().encode(parts.slice(0, 3).join(".") + "." + userId),
  ));
}
async function boundedUpstream(env, which, path, token) {
  try { return await service(env, which, path, { headers: { authorization: "Bearer " + token, accept: JSON_TYPE } }); }
  catch { return null; }
}
function parseConfirm(body) {
  if (!isObject(body) || Object.keys(body).some((k) =>
    !["intent", "requestId", "applicationId", "spaceId", "agentId", "allowUserAuthorization"].includes(k))
    || body.intent !== "confirm-oauth-authorization"
    || !REQUEST.test(body.requestId || "") || !APPLICATION.test(body.applicationId || "")
    || !SPACE.test(body.spaceId || "") || !AGENT.test(body.agentId || "")
    || typeof body.allowUserAuthorization !== "boolean") return null;
  return body;
}
function callbackValid(value) {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || (url.protocol === "http:"
      && (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
      && !url.username && !url.password && url.searchParams.has("code");
  } catch { return false; }
}
export async function accountFetch(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  // The Account Center owns the root; OAuth Consent remains an isolated transaction at /oauth/consent.
  if (path === "/" && req.method === "GET") {
    return Response.redirect(new URL("/center", url), 302);
  }
  if (!path.startsWith("/api/")) {
    if (!env.ASSETS?.fetch) return fail(503, "ACCOUNT_ASSETS_MISSING", "Account 页面不可用");
    // Static Assets' default HTML handling already maps extensionless URLs
    // such as /delegation to delegation.html. Rewriting to the .html file here
    // makes ASSETS redirect back to /delegation, creating an infinite loop.
    // Keep the original URL (including the opaque request_id query) intact.
    const asset = await env.ASSETS.fetch(req);
    const headers = new Headers(asset.headers);
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://auth-staging.aisr.online https://auth.aisr.online; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  }
  if (req.method !== "GET" && req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "不支持此请求方式");
  if (req.method === "POST" && !sameOriginMutation(req)) {
    return fail(403, "INVALID_ORIGIN", "请从当前 Account 页面确认授权");
  }
  if (path !== "/api/session" && path !== "/api/oauth/request"
    && path !== "/api/oauth/choices"
    && path !== "/api/oauth/capabilities"
    && path !== "/api/delegation/request"
    && path !== "/api/delegation/approve" && path !== "/api/delegation/deny"
    && path !== "/api/delegations" && path !== "/api/delegations/revoke"
    && path !== "/api/account/spaces" && path !== "/api/account/login-email"
    && path !== "/api/account/authorizations" && !ACCOUNT_AUTHORIZATION.test(path)
    && !ACCOUNT_SPACE_DETAIL.test(path) && !ACCOUNT_EXTERNAL.test(path)
    && path !== "/api/oauth/confirm" && path !== "/api/oauth/deny") return fail(404, "NOT_FOUND", "接口不存在");
  if ((path === "/api/oauth/confirm" || path === "/api/oauth/deny"
    || path === "/api/delegation/approve" || path === "/api/delegation/deny"
    || path === "/api/delegations/revoke"
    || ACCOUNT_AUTHORIZATION.exec(path)?.[2] === "revoke") !== (req.method === "POST")) {
    return fail(405, "METHOD_NOT_ALLOWED", "不支持此请求方式");
  }
  const linked = await session(req, env);
  if (linked instanceof Response) return linked;
  if (path === "/api/session") {
    const csrfToken = await newCsrf(env, linked.user.id);
    if (!csrfToken) return fail(503, "ACCOUNT_NOT_CONFIGURED", "Account CSRF 安全配置缺失");
    return responseJson({ data: { user: linked.user, csrfToken } }, 200, {
      "set-cookie": CSRF_COOKIE + "=" + csrfToken
        + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + CSRF_TTL_SECONDS,
    });
  }
  if (path === "/api/account/login-email") {
    if (url.search) return fail(400, "INVALID_REQUEST", "账号信息不接受额外参数");
    const upstream = await boundedUpstream(env, "IDENTITY", "/api/v1/me/web-login", linked.token);
    if (!upstream?.ok) return fail(upstream?.status === 403 ? 403 : 503,
      "ACCOUNT_EMAIL_UNAVAILABLE", "无法读取已声明的登录邮箱");
    const state = await data(upstream);
    if (!state || !["linked", "pending", "unlinked"].includes(state.status)
      || !(state.email === null || safeText(state.email, 254))
      || typeof state.linked !== "boolean") {
      return fail(502, "IDENTITY_INVALID_RESPONSE", "账号邮箱响应异常");
    }
    return responseJson({ data: { email: state.email, status: state.status, linked: state.linked } });
  }
  if (path === "/api/account/spaces") {
    if (url.search) return fail(400, "INVALID_REQUEST", "空间列表不接受额外参数");
    const upstream = await boundedUpstream(env, "CORE", "/api/v1/me/spaces", linked.token);
    if (!upstream?.ok) return fail(upstream?.status === 403 ? 403 : 503,
      "ACCOUNT_SPACES_UNAVAILABLE", "无法读取当前用户的空间");
    const spaces = await arrayData(upstream);
    if (!spaces || spaces.length > 200 || spaces.some(item => !isObject(item)
      || !SPACE.test(item.id || "") || !safeText(item.name, 160)
      || !safeText(item.timezone, 100) || !SPACE_ROLES.has(item.role))) {
      return fail(502, "CORE_INVALID_RESPONSE", "空间列表格式异常");
    }
    return responseJson({ data: spaces.map(item => ({
      id: item.id, name: item.name, timezone: item.timezone, role: item.role,
    })) });
  }
  if (path === "/api/account/authorizations") {
    const offset = url.searchParams.get("offset") ?? "0";
    if ((url.searchParams.size && (url.searchParams.size!==1 || !url.searchParams.has("offset")))
      || !/^(0|[1-9][0-9]{0,3})$/u.test(offset))
      return fail(400,"INVALID_REQUEST","授权记录页码无效");
    const upstream = await boundedUpstream(env,"IDENTITY",
      "/api/v1/me/oauth/authorizations?offset="+offset,linked.token);
    if(!upstream?.ok)return fail(upstream?.status===403?403:503,
      "AUTHORIZATIONS_UNAVAILABLE","无法读取当前用户的 OAuth 授权记录");
    const result=await data(upstream);
    if(!result || !Array.isArray(result.items) || result.items.length>20
      || result.items.some(item=>!validAuthorization(item))
      || !(result.nextOffset===null || (Number.isInteger(result.nextOffset) && result.nextOffset>=0)))
      return fail(502,"IDENTITY_INVALID_RESPONSE","OAuth 授权列表格式异常");
    return responseJson({data:{items:result.items,nextOffset:result.nextOffset}});
  }
  const ownedAuthorization=ACCOUNT_AUTHORIZATION.exec(path);
  if(ownedAuthorization && !ownedAuthorization[2]) {
    if(url.search)return fail(400,"INVALID_REQUEST","授权详情不接受额外参数");
    const upstream=await boundedUpstream(env,"IDENTITY",
      "/api/v1/me/oauth/authorizations/"+encodedPath(ownedAuthorization[1]),linked.token);
    if(!upstream?.ok)return fail([403,404].includes(upstream?.status)?upstream.status:503,
      "AUTHORIZATION_UNAVAILABLE","授权不存在或不属于当前用户");
    const item=await data(upstream);
    if(!validAuthorization(item) || item.id!==ownedAuthorization[1])
      return fail(502,"IDENTITY_INVALID_RESPONSE","OAuth 授权详情格式异常");
    return responseJson({data:item});
  }
  const external = ACCOUNT_EXTERNAL.exec(path);
  if (external) {
    if (url.search) return fail(400,"INVALID_REQUEST","外部数据源列表不接受额外参数");
    const source=await boundedUpstream(env,"CORE",
      "/api/v1/spaces/"+encodedPath(external[1])+"/external-connections",linked.token);
    if(!source?.ok) return fail([403,404].includes(source?.status)?source.status:503,
      "EXTERNAL_CONNECTIONS_UNAVAILABLE","当前用户无法读取这个 Space 的外部数据源");
    const payload=await data(source);
    if(!payload || !Array.isArray(payload.items) || payload.items.length>500
      || payload.items.some(item=>!isObject(item)
        || !/^exs_[A-Za-z0-9_-]{8,128}$/u.test(item.id||"")
        || item.spaceId!==external[1] || !safeText(item.providerKey,100)
        || !safeText(item.displayName,100)
        || !["active","disabled","revoked"].includes(item.status)
        || !["read","write",null].includes(item.access)
        || !safeText(item.createdAt,80))) {
      return fail(502,"CORE_INVALID_RESPONSE","外部数据源列表响应异常");
    }
    return responseJson({data:{items:payload.items.map(item=>({
      id:item.id,spaceId:item.spaceId,providerKey:item.providerKey,
      displayName:item.displayName,status:item.status,access:item.access,
      createdAt:item.createdAt,
    }))}});
  }
  const spaceDetail = ACCOUNT_SPACE_DETAIL.exec(path);
  if (spaceDetail) {
    if (url.search) return fail(400, "INVALID_REQUEST", "空间详情不接受额外参数");
    const spaceId = spaceDetail[1];
    const members = spaceDetail[2] === "members";
    const upstream = await boundedUpstream(env, "CORE",
      "/api/v1/spaces/" + encodedPath(spaceId) + (members ? "/members" : ""), linked.token);
    if (!upstream?.ok) return fail([403, 404].includes(upstream?.status) ? upstream.status : 503,
      "ACCOUNT_SPACE_UNAVAILABLE", "空间不存在或当前用户无权访问");
    if (members) {
      const rows = await arrayData(upstream);
      if (!rows || rows.length > 500 || rows.some(item => !isObject(item)
        || !safeText(item.userId, 150) || !SPACE_ROLES.has(item.role)
        || !safeText(item.displayName, 160))) {
        return fail(502, "CORE_INVALID_RESPONSE", "空间成员列表格式异常");
      }
      return responseJson({ data: rows.map(item => ({
        userId: item.userId, displayName: item.displayName, role: item.role,
      })) });
    }
    const item = await data(upstream);
    if (!item || item.id !== spaceId || !safeText(item.name, 160)
      || !safeText(item.timezone, 100) || !Number.isInteger(item.version)
      || !["owner","admin","editor","viewer","grant"].includes(item.access)) {
      return fail(502, "CORE_INVALID_RESPONSE", "空间详情格式异常");
    }
    return responseJson({ data: {
      id: item.id, name: item.name, timezone: item.timezone,
      version: item.version, access: item.access,
    } });
  }
  if (path === "/api/delegation/request") {
    const requestId = url.searchParams.get("request_id");
    if (url.searchParams.size !== 1 || !DELEGATION_REQUEST.test(requestId || "")) {
      return fail(400, "INVALID_REQUEST", "委托申请编号无效");
    }
    const source = await boundedUpstream(env, "CORE",
      "/api/v1/me/oauth/delegation-requests/" + encodedPath(requestId), linked.token);
    if (!source?.ok) return fail(source?.status === 404 ? 404 : source?.status === 403 ? 403 : 503,
      "DELEGATION_REQUEST_UNAVAILABLE", "委托申请已失效或不属于当前用户");
    const preview = await data(source);
    if (!preview || preview.id !== requestId || !DELEGATION_REQUEST.test(preview.id)
      || !SPACE.test(preview.spaceId || "") || !AGENT.test(preview.agentId || "")
      || !APPLICATION.test(preview.applicationId || "") || !safeText(preview.clientId, 1024)
      || !safeText(preview.modelKey, 70)
      || !["get", "query", "create", "update", "delete"].includes(preview.operation)
      || !["pending", "approved", "denied", "expired"].includes(preview.status)
      || !safeText(preview.resource, 1024) || !safeText(preview.reason, 300)
      || !safeText(preview.expiresAt, 80)) {
      return fail(502, "CORE_INVALID_RESPONSE", "无法验证委托申请详情");
    }
    return responseJson({ data: {
      id:preview.id, status:preview.status, applicationId:preview.applicationId,
      spaceId:preview.spaceId, agentId:preview.agentId,
      clientId:preview.clientId, resource:preview.resource, modelKey:preview.modelKey,
      operation:preview.operation, reason:preview.reason,
      expiresAt:preview.expiresAt,
    } });
  }

  if (path === "/api/delegations") {
    const offset = url.searchParams.get("offset") ?? "0";
    if ((url.searchParams.size && (url.searchParams.size!==1 || !url.searchParams.has("offset")))
      || !/^(0|[1-9][0-9]{0,3})$/u.test(offset))
      return fail(400,"INVALID_REQUEST","授权列表页码无效");
    const response=await boundedUpstream(env,"CORE",
      "/api/v1/me/oauth/delegations?offset="+offset,linked.token);
    if (!response?.ok) return fail(503,"DELEGATIONS_UNAVAILABLE","无法读取当前委托授权");
    const page=await data(response);
    if (!page || !Array.isArray(page.items) || page.items.length>50
      || (page.nextOffset!==null && (!Number.isInteger(page.nextOffset) || page.nextOffset<0))
      || page.items.some(item=>!isObject(item) || !DELEGATION_ID.test(item.id||"")
        || !APPLICATION.test(item.applicationId||"") || !SPACE.test(item.spaceId||"")
        || !AGENT.test(item.agentId||"") || !safeText(item.clientId,1024)
        || !safeText(item.resource,1024) || !safeText(item.modelKey,70)
        || !safeText(item.operation,90) || !safeText(item.createdAt,80)
        || !(item.expiresAt===null || safeText(item.expiresAt,80))
        || !APPROVAL_MODES.has(item.mode))) {
      return fail(502,"CORE_INVALID_RESPONSE","委托授权列表格式无效");
    }
    return responseJson({data:{items:page.items,nextOffset:page.nextOffset}});
  }
  if (path === "/api/oauth/request") {
    const requestId = url.searchParams.get("request_id");
    if (!REQUEST.test(requestId || "") || url.searchParams.size !== 1) {
      return fail(400, "INVALID_REQUEST", "OAuth 授权请求无效");
    }
    const source = await boundedUpstream(env, "IDENTITY",
      "/api/v1/me/oauth/requests/" + encodedPath(requestId), linked.token);
    if (!source || !source.ok) return fail(source?.status === 400 ? 409 : 503,
      "OAUTH_REQUEST_UNAVAILABLE", "授权请求已过期或无法读取");
    const preview = await data(source);
    if (!preview || preview.id !== requestId || !isObject(preview.client)
      || !safeText(preview.client.name) || !safeText(preview.client.redirectOrigin, 1024)
      || !safeText(preview.resource, 1024) || !Array.isArray(preview.requestedScopes)
      || !preview.requestedScopes.every((v) => typeof v === "string" && v.length < 120)) {
      return fail(502, "IDENTITY_INVALID_RESPONSE", "授权请求信息异常");
    }
    return responseJson({ data: {
      id: preview.id, client: {
        name: preview.client.name, id: preview.client.id, verifiedVendor: false,
        redirectOrigin: preview.client.redirectOrigin,
      }, resource: preview.resource, requestedScopes: preview.requestedScopes, expiresAt: preview.expiresAt,
    } });
  }
  if (path === "/api/oauth/choices") {
    if (url.search) return fail(400, "INVALID_REQUEST", "候选选择不接受额外参数");
    const upstream = await boundedUpstream(env, "CORE", "/api/v1/me/oauth/choices", linked.token);
    if (!upstream || !upstream.ok) return fail(upstream?.status === 403 ? 403 : 503,
      "OAUTH_CHOICES_UNAVAILABLE", "无法读取当前可用的应用与 Agent");
    const result = await data(upstream);
    if (!result || !Array.isArray(result.candidates) || result.candidates.length > 100)
      return fail(502, "CORE_INVALID_RESPONSE", "候选授权数据异常");
    const choices = result.candidates.filter((r) => isObject(r)
      && SPACE.test(r.spaceId || "") && APPLICATION.test(r.applicationId || "")
      && AGENT.test(r.agentId || "") && typeof r.spaceName === "string"
      && typeof r.agentName === "string" && typeof r.applicationName === "string");
    if (choices.length !== result.candidates.length) {
      return fail(502, "CORE_INVALID_RESPONSE", "候选授权数据异常");
    }
    return responseJson({ data: { candidates: choices.map((r) => ({
      spaceId: r.spaceId, spaceName: r.spaceName,
      applicationId: r.applicationId, applicationName: r.applicationName,
      agentId: r.agentId, agentName: r.agentName,
    })) } });
  }
  if (path === "/api/oauth/capabilities") {
    const requestId = url.searchParams.get("request_id");
    const appId = url.searchParams.get("application_id");
    const spaceId = url.searchParams.get("space_id");
    const agentId = url.searchParams.get("agent_id");
    if (url.searchParams.size !== 4 || !REQUEST.test(requestId || "")
      || !APPLICATION.test(appId || "") || !SPACE.test(spaceId || "") || !AGENT.test(agentId || "")) {
      return fail(400, "INVALID_REQUEST", "授权能力预览参数无效");
    }
    // Account obtains the immutable pending client scope limit from Identity,
    // never trusting a supplied scope list to render an effective permission.
    const pending = await boundedUpstream(env, "IDENTITY",
      "/api/v1/me/oauth/requests/" + encodedPath(requestId), linked.token);
    if (!pending || !pending.ok) {
      return fail(409, "OAUTH_REQUEST_EXPIRED", "OAuth 授权请求已过期或不可用");
    }
    const requestInfo = await data(pending);
    if (!requestInfo || requestInfo.id !== requestId || !Array.isArray(requestInfo.requestedScopes)
      || !safeText(requestInfo.resource, 1024)
      || requestInfo.requestedScopes.some((scope) => typeof scope !== "string" || scope.length > 128)) {
      return fail(502, "IDENTITY_INVALID_RESPONSE", "OAuth Scope 信息不可用");
    }
    const target = "/api/v1/me/oauth/capabilities?" + new URLSearchParams({
      applicationId: appId, spaceId, agentId, resource: requestInfo.resource,
    });
    const source = await boundedUpstream(env, "CORE", target, linked.token);
    if (!source || !source.ok) return fail(source?.status === 403 ? 403 : 503,
      "CAPABILITY_UNAVAILABLE", "无法读取当前 Agent 授权范围");
    const projection = await data(source);
    if (!projection || projection.kind !== "pre_policy_upper_bound"
      || projection.resourceCapabilityApplied !== true
      || !Array.isArray(projection.models) || projection.models.length > 50
      || projection.models.some((item) => !isObject(item) || !safeText(item.key, 80)
        || !safeText(item.name, 150) || !Array.isArray(item.access)
        || item.access.some((access) => !["read", "write", "manage"].includes(access))
        || !Array.isArray(item.operations) || item.operations.length > 5
        || item.operations.some((op) => !["get", "query", "create", "update", "delete"].includes(op)))) {
      return fail(502, "CORE_INVALID_RESPONSE", "权限投影格式无效");
    }
    const scopes = new Set(requestInfo.requestedScopes);
    return responseJson({ data: {
      kind: "pre_policy_upper_bound",
      resourceCapabilityApplied: true,
      modelPolicyApplied: false,
      nativeModelsOnly: true,
      models: projection.models.map((model) => ({
        key: model.key, name: model.name,
        access: model.access.filter((operation) => scopes.has("resources:" + operation)),
        operations: model.operations.filter((operation) =>
          scopes.has(["get", "query"].includes(operation) ? "resources:read" : "resources:write")),
      })).filter((model) => model.operations.length > 0),
      truncated: projection.truncated === true,
      requestedScopes: [...scopes],
    } });
  }
  // POST: every confirmation must be a user interaction bound to this Account session.
  if (!await validCsrf(req, env, linked.user.id)) {
    return fail(403, "INVALID_CSRF", "授权确认已过期，请重新打开确认页面");
  }
  const raw = await req.text();
  if (raw.length > 2048) return fail(413, "REQUEST_TOO_LARGE", "授权内容过大");
  let input;
  try { input = JSON.parse(raw); } catch { return fail(400, "INVALID_REQUEST", "授权内容无效"); }
  if (ownedAuthorization?.[2] === "revoke") {
    if(!isObject(input) || Object.keys(input).length!==2
      || input.intent!=="revoke-oauth-authorization"
      || input.authorizationId!==ownedAuthorization[1])
      return fail(400,"INVALID_REQUEST","撤销 OAuth 授权请求无效");
    let source;
    try {
      source=await service(env,"IDENTITY",
        "/api/v1/me/oauth/authorizations/"+encodedPath(input.authorizationId)+"/revoke",{
          method:"POST",headers:{authorization:"Bearer "+linked.token,"content-type":JSON_TYPE},
          body:"{}",
        });
    } catch {return fail(503,"IDENTITY_UNAVAILABLE","无法撤销 OAuth 授权");}
    if(!source.ok)return fail([403,404,409].includes(source.status)?source.status:503,
      "OAUTH_REVOKE_FAILED","授权已失效、不属于当前用户或已被撤销");
    const result=await data(source);
    if(!result || result.id!==input.authorizationId || result.revoked!==true)
      return fail(502,"IDENTITY_INVALID_RESPONSE","OAuth 撤销结果异常");
    return responseJson({data:{id:result.id,revoked:true}});
  }
  if (path === "/api/delegation/approve" || path === "/api/delegation/deny") {
    const approve = path.endsWith("/approve");
    const fields=Object.keys(input||{});
    if (!isObject(input) || fields.some(k=>!["intent","requestId","mode","durationMinutes"].includes(k))
      || input.intent !== (approve ? "approve-user-delegation" : "deny-user-delegation")
      || !DELEGATION_REQUEST.test(input.requestId || "")
      || (!approve && fields.length!==2)
      || (approve && !(
        (input.mode===undefined && fields.length===2)
        || (input.mode==="once" && fields.length===3)
        || (input.mode==="until_revoked" && fields.length===3)
        || (input.mode==="timed" && fields.length===4 && APPROVAL_DURATIONS.has(input.durationMinutes))
      ))) {
      return fail(400, "INVALID_REQUEST", "委托确认请求无效");
    }
    let decision;
    try {
      decision = await service(env, "CORE",
        "/api/v1/me/oauth/delegation-requests/" + encodedPath(input.requestId)
        + (approve ? "/approve" : "/deny"), {
          method: "POST",
          headers: { authorization: "Bearer " + linked.token, "content-type": JSON_TYPE },
          body: approve ? JSON.stringify(input.mode===undefined ? {} : {
            mode:input.mode,...(input.mode==="timed"?{durationMinutes:input.durationMinutes}:{})
          }) : "{}",
        });
    } catch { return fail(503, "CORE_UNAVAILABLE", "无法完成本次委托确认"); }
    if (!decision.ok) return fail([400, 403, 404, 409].includes(decision.status) ? decision.status : 503,
      "DELEGATION_DECISION_FAILED", "委托申请已失效或当前用户无权确认");
    const result = await data(decision);
    if (!result || result.id !== input.requestId
      || result.status !== (approve ? "approved" : "denied")) {
      return fail(502, "CORE_INVALID_RESPONSE", "委托确认结果无效");
    }
    return responseJson({ data: { requestId: result.id, status: result.status } });
  }

  if (path === "/api/delegations/revoke") {
    if (!isObject(input) || Object.keys(input).length!==2
      || input.intent!=="revoke-user-delegation" || !DELEGATION_ID.test(input.delegationId||""))
      return fail(400,"INVALID_REQUEST","撤销委托请求无效");
    let revoked;
    try {
      revoked=await service(env,"CORE",
        "/api/v1/me/oauth/delegations/"+encodedPath(input.delegationId)+"/revoke",{
          method:"POST",headers:{authorization:"Bearer "+linked.token,"content-type":JSON_TYPE},
          body:"{}",
        });
    } catch { return fail(503,"CORE_UNAVAILABLE","无法撤销委托授权"); }
    if (!revoked.ok) return fail([403,404].includes(revoked.status)?revoked.status:503,
      "DELEGATION_REVOKE_FAILED","委托不存在、已失效或不属于当前用户");
    const result=await data(revoked);
    if (!result || result.id!==input.delegationId || result.revoked!==true)
      return fail(502,"CORE_INVALID_RESPONSE","委托撤销结果无效");
    return responseJson({data:{id:result.id,revoked:true}});
  }
  if (path === "/api/oauth/deny") {
    if (!isObject(input) || Object.keys(input).some(k => !["intent", "requestId"].includes(k))
      || input.intent !== "deny-oauth-authorization" || !REQUEST.test(input.requestId || "")) {
      return fail(400, "INVALID_REQUEST", "拒绝授权请求无效");
    }
    let rejected;
    try {
      rejected = await service(env, "CORE",
        "/api/v1/me/oauth/requests/" + encodedPath(input.requestId) + "/deny", {
          method: "POST",
          headers: { authorization: "Bearer " + linked.token, "content-type": JSON_TYPE },
          body: "{}",
        });
    } catch { return fail(503, "CORE_UNAVAILABLE", "无法完成拒绝授权"); }
    if (!rejected.ok) return fail([400, 403, 409].includes(rejected.status) ? rejected.status : 503,
      "OAUTH_DENIAL_FAILED", "授权请求已过期或不可用");
    const result = await data(rejected);
    let redirect;
    try { redirect = new URL(result?.redirectUrl); } catch { return fail(502, "CORE_INVALID_RESPONSE", "OAuth 拒绝回调异常"); }
    if (!(redirect.protocol === "https:" ||
      (redirect.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(redirect.hostname)))
      || redirect.username || redirect.password || redirect.searchParams.get("error") !== "access_denied"
      || redirect.searchParams.has("code") || !redirect.searchParams.get("iss")) {
      return fail(502, "CORE_INVALID_RESPONSE", "OAuth 拒绝回调异常");
    }
    return responseJson({ data: { redirectUrl: redirect.href } });
  }
  const selected = parseConfirm(input);
  if (!selected) return fail(400, "INVALID_REQUEST", "授权选择不完整");
  let approval;
  try {
    approval = await service(env, "CORE",
      "/api/v1/me/oauth/requests/" + encodedPath(selected.requestId) + "/confirm", {
        method: "POST",
        headers: { authorization: "Bearer " + linked.token, "content-type": JSON_TYPE },
        body: JSON.stringify({
          applicationId: selected.applicationId, spaceId: selected.spaceId,
          agentId: selected.agentId, allowUserAuthorization: selected.allowUserAuthorization,
        }),
      });
  } catch {
    return fail(503, "CORE_UNAVAILABLE", "无法完成授权确认");
  }
  if (!approval.ok) return fail([400, 403, 409].includes(approval.status) ? approval.status : 503,
    "OAUTH_CONFIRMATION_FAILED", "授权已失效或你当前没有所选权限");
  const result = await data(approval);
  if (!result || !/^oaz_[A-Za-z0-9_-]+$/u.test(result.authorizationId || "")
    || !callbackValid(result.redirectUrl)) {
    return fail(502, "CORE_INVALID_RESPONSE", "OAuth 回调地址异常");
  }
  return responseJson({ data: { redirectUrl: result.redirectUrl } });
}
export default { fetch: accountFetch };
