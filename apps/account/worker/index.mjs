// LifeSpace Account: same-origin OAuth Consent BFF, no independent data store.
// Access JWT and LifeSpace tokens must never enter browser responses or logs.
const ACCESS_HEADER = "cf-access-jwt-assertion";
const CSRF_COOKIE = "__Host-lifespace-consent";
const CSRF_TTL_SECONDS = 600;
const SCOPES = ["profile:read", "spaces:read", "spaces:manage"];
const REQUEST = /^oar_[A-Za-z0-9_-]{16,128}$/u;
const SPACE = /^spc_[A-Za-z0-9_-]{3,128}$/u;
const AGENT = /^agt_[A-Za-z0-9_-]{3,128}$/u;
const APPLICATION = /^app_[A-Za-z0-9_-]{3,128}$/u;
const JSON_TYPE = "application/json; charset=utf-8";

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
  return { token: userToken, user: { id: profile.id, displayName: profile.displayName } };
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
  if (!path.startsWith("/api/")) {
    if (!env.ASSETS?.fetch) return fail(503, "ACCOUNT_ASSETS_MISSING", "Account 页面不可用");
    const asset = await env.ASSETS.fetch(req);
    const headers = new Headers(asset.headers);
    headers.set("referrer-policy", "no-referrer");
    headers.set("x-content-type-options", "nosniff");
    headers.set("content-security-policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers });
  }
  if (req.method !== "GET" && req.method !== "POST") return fail(405, "METHOD_NOT_ALLOWED", "不支持此请求方式");
  if (req.method === "POST" && !sameOriginMutation(req)) {
    return fail(403, "INVALID_ORIGIN", "请从当前 Account 页面确认授权");
  }
  if (path !== "/api/session" && path !== "/api/oauth/request"
    && path !== "/api/oauth/choices"
    && path !== "/api/oauth/confirm") return fail(404, "NOT_FOUND", "接口不存在");
  if ((path === "/api/oauth/confirm") !== (req.method === "POST")) {
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
  // POST: every confirmation must be a user interaction bound to this Account session.
  if (!await validCsrf(req, env, linked.user.id)) {
    return fail(403, "INVALID_CSRF", "授权确认已过期，请重新打开确认页面");
  }
  const raw = await req.text();
  if (raw.length > 2048) return fail(413, "REQUEST_TOO_LARGE", "授权内容过大");
  let input;
  try { input = JSON.parse(raw); } catch { return fail(400, "INVALID_REQUEST", "授权内容无效"); }
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
