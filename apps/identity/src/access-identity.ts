import { currentAccessLink, linkVersion, claimLinkRevision, completeAccessLink, linkAudit } from './access-account-link';
import { normalizeLoginEmail } from "./web-login-email";
import type { Context, Hono } from "hono";
import { sign } from "hono/jwt";
import {
  AccessAssertionError,
  configuredAccessIssuer,
  verifyAccessAssertion,
  type AccessAssertionFetch,
  type VerifiedAccessAssertion,
} from "./access-auth";
import type { Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };

const TOKEN_ISSUER = "lifespace-identity";
const TOKEN_AUDIENCES = ["lifespace-core", "lifespace-identity"] as const;
const LINK_CHALLENGE_TTL_MS = 10 * 60 * 1000;

type AccessAudienceRow = {
  id: string;
  application_id: string;
  issuer: string;
  audience: string;
  status: string;
  created_at: string;
  revoked_at: string | null;
};

type AccessApplicationRow = {
  id: string;
  trusted_backend: number;
  status: string;
};

type AccessPrincipalRow = {
  id: string;
  user_id: string;
  principal_status: string;
  user_status: string;
  linked_via_email: number;
};

type AccessLinkChallengeRow = {
  id: string;
  application_id: string;
  issuer: string;
  subject: string;
  audience: string;
  email_snapshot: string | null;
  expires_at: string;
};

type AccessRequestBody = {
  accessAssertion?: unknown;
  requestedScopes?: unknown;
};

type AccessRegistrationBody = AccessRequestBody & {
  displayName?: unknown;
};

export type AccessRouteOptions = {
  accessFetch?: AccessAssertionFetch;
};

type VerifiedApplicationAccess = VerifiedAccessAssertion & { audience: string };

const ok = <T>(data: T) => ({ data });
const fail = (code: string, message: string, requestId: string) => ({ error: { code, message, requestId } });
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
const newChallengeId = () => `alc_${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;

function audienceDto(row: AccessAudienceRow) {
  return {
    id: row.id,
    applicationId: row.application_id,
    issuer: row.issuer,
    audience: row.audience,
    status: row.status,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

function normalizeAudience(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const audience = value.trim();
  if (!audience || audience.length > 256 || /\s/.test(audience)) return null;
  return audience;
}

function normalizeScopes(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  if (value.some((entry) => typeof entry !== "string" || !entry.trim() || entry.length > 100)) return null;
  const scopes = value.map((entry) => (entry as string).trim());
  if (new Set(scopes).size !== scopes.length) return null;
  return scopes;
}

function normalizeDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim();
  return name && name.length <= 50 ? name : null;
}

function accessErrorResponse(c: Context<AppEnv>, error: unknown) {
  if (!(error instanceof AccessAssertionError)) throw error;
  if (error.kind === "not_configured") {
    return c.json(fail("ACCESS_NOT_CONFIGURED", "Cloudflare Access verification is not configured", c.get("requestId")), 500);
  }
  if (error.kind === "unavailable") {
    return c.json(fail("ACCESS_VERIFIER_UNAVAILABLE", "Cloudflare Access signing keys are unavailable", c.get("requestId")), 503);
  }
  return c.json(fail("INVALID_ACCESS_ASSERTION", "Cloudflare Access assertion is invalid", c.get("requestId")), 401);
}

async function loadApplication(db: D1Database, applicationId: string): Promise<AccessApplicationRow | null> {
  return db.prepare(`
    SELECT id,trusted_backend,status
    FROM applications WHERE id=?
  `).bind(applicationId).first<AccessApplicationRow>();
}

async function verifyForCurrentApplication(
  c: Context<AppEnv>,
  assertion: unknown,
  accessFetch?: AccessAssertionFetch,
): Promise<VerifiedApplicationAccess | Response> {
  if (typeof assertion !== "string") {
    return c.json(fail("VALIDATION_ERROR", "accessAssertion is required", c.get("requestId")), 422);
  }

  let verified: VerifiedAccessAssertion;
  try {
    verified = await verifyAccessAssertion(assertion, {
      teamDomain: c.env.ACCESS_TEAM_DOMAIN,
      fetcher: accessFetch,
    });
  } catch (error) {
    return accessErrorResponse(c, error);
  }

  const registrations = await c.env.DB.prepare(`
    SELECT audience FROM access_audiences
    WHERE application_id=? AND issuer=? AND status='active'
  `).bind(c.get("currentApplicationId"), verified.issuer).all<{ audience: string }>();
  const registered = new Set(registrations.results.map((row) => row.audience));
  const audience = verified.audiences.find((entry) => registered.has(entry));
  if (!audience) {
    return c.json(fail("ACCESS_AUDIENCE_MISMATCH", "Access audience is not registered to the calling application", c.get("requestId")), 403);
  }
  return { ...verified, audience };
}

function parseRequestedScopes(c: Context<AppEnv>, value: unknown): string[] | Response {
  const scopes = normalizeScopes(value);
  if (!scopes) {
    return c.json(fail("VALIDATION_ERROR", "requestedScopes must contain unique non-empty scope strings", c.get("requestId")), 422);
  }
  const allowed = c.get("currentApplicationScopes");
  if (scopes.some((scope) => !allowed.includes(scope))) {
    return c.json(fail("FORBIDDEN", "Requested scope is not allowed for this application", c.get("requestId")), 403);
  }
  return scopes;
}

async function issueUserToken(c: Context<AppEnv>, userId: string, scopes: string[]) {
  if (!c.env.TOKEN_PRIVATE_KEY) {
    return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token signing key is not configured", c.get("requestId")), 500);
  }
  const tokenTtlSeconds = c.get("currentApplicationTokenTtlSeconds");
  const iat = Math.floor(Date.now() / 1000);
  const token = await sign({
    iss: TOKEN_ISSUER,
    aud: [...TOKEN_AUDIENCES],
    sub: userId,
    azp: c.get("currentApplicationId"),
    principal_type: "user",
    scope: scopes.join(" "),
    iat,
    exp: iat + tokenTtlSeconds,
    jti: id("tok"),
  }, c.env.TOKEN_PRIVATE_KEY, "RS256");
  return c.json(ok({ accessToken: token, tokenType: "Bearer", expiresIn: tokenTtlSeconds, scope: scopes.join(" ") }));
}

async function findPrincipal(db: D1Database, issuer: string, subject: string): Promise<AccessPrincipalRow | null> {
  return db.prepare(`
    SELECT p.id,p.user_id,p.status principal_status,u.status user_status,p.linked_via_email
    FROM access_principals p JOIN users u ON u.id=p.user_id
    WHERE p.issuer=? AND p.subject=?
  `).bind(issuer, subject).first<AccessPrincipalRow>();
}

// A login mailbox is globally owned by one usr_*, independent of the
// Application whose Access audience was used to enter the platform.
// Access verifies email; Identity owns its unique declaration and principal.
async function resolveLogin(c: Context<AppEnv>, verified: VerifiedApplicationAccess): Promise<string | Response> {
  let principal=await findPrincipal(c.env.DB,verified.issuer,verified.subject);
  const email=normalizeLoginEmail(verified.email);
  if(principal) {
    if(principal.user_status!=='active'||principal.principal_status!=='active')
      return c.json(fail('FORBIDDEN','Access principal or user is inactive',c.get('requestId')),403);
    if(principal.linked_via_email===1) {
      // A principal created by mailbox pre-link ceases to authorize when that
      // mailbox is replaced or unbound; code-linked principals are independent.
      const binding=email ? await c.env.DB.prepare('SELECT user_id FROM user_login_emails WHERE email=?')
        .bind(email).first<{user_id:string}>():null;
      if(binding?.user_id!==principal.user_id)
        return c.json(fail('FORBIDDEN','Login mailbox is no longer linked',c.get('requestId')),403);
    }
    return principal.user_id;
  }
  const reservation=email ? await c.env.DB.prepare(`
    SELECT e.user_id,u.access_link_version version FROM user_login_emails e
    JOIN users u ON u.id=e.user_id AND u.status='active'
    WHERE e.email=?`).bind(email).first<{user_id:string;version:number}>():null;
  if(!reservation)
    return c.json(fail('ACCESS_PRINCIPAL_UNLINKED','Access principal is not linked to a LifeSpace user',c.get('requestId')),409);
  const now=new Date().toISOString(),operationId=crypto.randomUUID();
  try {
    const results=await c.env.DB.batch([
      claimLinkRevision(c.env.DB,reservation.user_id,reservation.version,operationId),
      completeAccessLink(c.env.DB,{id:id('acp'),issuer:verified.issuer,subject:verified.subject,
        email,userId:reservation.user_id,operationId,now,viaEmail:true}),
      linkAudit(c.env.DB,reservation.user_id,c.get('currentApplicationId'),operationId,c.get('requestId'),now),
    ]);
    if(results[0].meta.changes!==1||results[1].meta.changes!==1)
      return c.json(fail('ACCESS_LINK_CONFLICT','Email binding changed; retry login',c.get('requestId')),409);
  }catch(error){if(!/UNIQUE constraint/.test(String(error)))throw error;}
  principal=await findPrincipal(c.env.DB,verified.issuer,verified.subject);
  if(!principal||principal.user_id!==reservation.user_id)
    return c.json(fail('ACCESS_LINK_CONFLICT','Access identity changed; retry linking',c.get('requestId')),409);
  if(principal.principal_status!=='active'||principal.user_status!=='active')
    return c.json(fail('FORBIDDEN','Access principal or user is inactive',c.get('requestId')),403);
  return principal.user_id;
}

export function registerAccessIdentityRoutes(app: Hono<AppEnv>, options: AccessRouteOptions = {}) {
  app.get("/bootstrap/v1/applications/:applicationId/access-audiences", async (c) => {
    const application = await loadApplication(c.env.DB, c.req.param("applicationId"));
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    const rows = await c.env.DB.prepare(`
      SELECT id,application_id,issuer,audience,status,created_at,revoked_at
      FROM access_audiences WHERE application_id=? ORDER BY created_at,id
    `).bind(application.id).all<AccessAudienceRow>();
    return c.json(ok(rows.results.map(audienceDto)));
  });

  app.post("/bootstrap/v1/applications/:applicationId/access-audiences", async (c) => {
    const application = await loadApplication(c.env.DB, c.req.param("applicationId"));
    if (!application) return c.json(fail("APPLICATION_NOT_FOUND", "Application not found", c.get("requestId")), 404);
    if (application.trusted_backend !== 1) {
      return c.json(fail("APPLICATION_NOT_TRUSTED", "Access audiences require a trusted application backend", c.get("requestId")), 409);
    }
    if (application.status !== "active") {
      return c.json(fail("APPLICATION_DISABLED", "Application is disabled", c.get("requestId")), 409);
    }

    const body = await c.req.json<{ audience?: unknown }>().catch(() => ({} as { audience?: unknown }));
    const audience = normalizeAudience(body.audience);
    if (!audience) return c.json(fail("VALIDATION_ERROR", "audience must be a non-empty token without whitespace", c.get("requestId")), 422);

    let issuer: string;
    try {
      issuer = configuredAccessIssuer(c.env.ACCESS_TEAM_DOMAIN);
    } catch (error) {
      return accessErrorResponse(c, error);
    }

    const existing = await c.env.DB.prepare(`
      SELECT id,application_id,issuer,audience,status,created_at,revoked_at
      FROM access_audiences WHERE issuer=? AND audience=? AND status='active'
    `).bind(issuer, audience).first<AccessAudienceRow>();
    if (existing) {
      if (existing.application_id !== application.id) {
        return c.json(fail("ACCESS_AUDIENCE_IN_USE", "Access audience is already registered to another application", c.get("requestId")), 409);
      }
      return c.json(ok(audienceDto(existing)));
    }

    const row: AccessAudienceRow = {
      id: id("aud"),
      application_id: application.id,
      issuer,
      audience,
      status: "active",
      created_at: new Date().toISOString(),
      revoked_at: null,
    };
    try {
      await c.env.DB.prepare(`
        INSERT INTO access_audiences(id,application_id,issuer,audience,status,created_at,revoked_at)
        VALUES(?,?,?,?,?,?,NULL)
      `).bind(row.id, row.application_id, row.issuer, row.audience, row.status, row.created_at).run();
    } catch (error) {
      const raced = await c.env.DB.prepare(`
        SELECT id,application_id,issuer,audience,status,created_at,revoked_at
        FROM access_audiences WHERE issuer=? AND audience=? AND status='active'
      `).bind(issuer, audience).first<AccessAudienceRow>();
      if (raced) {
        if (raced.application_id !== application.id) {
          return c.json(fail("ACCESS_AUDIENCE_IN_USE", "Access audience became registered to another application concurrently", c.get("requestId")), 409);
        }
        return c.json(ok(audienceDto(raced)));
      }
      throw error;
    }
    return c.json(ok(audienceDto(row)), 201);
  });

  app.delete("/bootstrap/v1/applications/:applicationId/access-audiences/:audienceId", async (c) => {
    const revokedAt = new Date().toISOString();
    const result = await c.env.DB.prepare(`
      UPDATE access_audiences SET status='revoked',revoked_at=?
      WHERE id=? AND application_id=? AND status='active'
    `).bind(revokedAt, c.req.param("audienceId"), c.req.param("applicationId")).run();
    if (!result.meta.changes) {
      return c.json(fail("ACCESS_AUDIENCE_NOT_FOUND", "Active Access audience registration not found", c.get("requestId")), 404);
    }
    return c.body(null, 204);
  });

  app.post("/internal/v1/access/tokens", async (c) => {
    const body = await c.req.json<AccessRequestBody>().catch(() => ({} as AccessRequestBody));
    const scopes = parseRequestedScopes(c, body.requestedScopes);
    if (scopes instanceof Response) return scopes;
    const verified = await verifyForCurrentApplication(c, body.accessAssertion, options.accessFetch);
    if (verified instanceof Response) return verified;

    const resolved=await resolveLogin(c,verified);
    if(resolved instanceof Response) return resolved;
    const seenAt=new Date().toISOString();
    await c.env.DB.prepare(`UPDATE access_principals SET email_snapshot=COALESCE(?,email_snapshot),last_seen_at=?,updated_at=?
      WHERE issuer=? AND subject=? AND user_id=?`).bind(verified.email,seenAt,seenAt,verified.issuer,verified.subject,resolved).run();
    return issueUserToken(c,resolved,scopes);
  });

  // Cheap live authorization check for signed application sessions: no token issuance.
  app.post("/internal/v1/access/session-check",async c=>{
    const body=await c.req.json<AccessRequestBody>().catch(()=>({} as AccessRequestBody));
    const verified=await verifyForCurrentApplication(c,body.accessAssertion,options.accessFetch);
    if(verified instanceof Response) return verified;
    const resolved=await resolveLogin(c,verified);
    if(resolved instanceof Response) return resolved;
    c.header("cache-control","no-store");
    return c.json(ok({userId:resolved}));
  });

  app.post("/internal/v1/access/registrations", async (c) => {
    const body = await c.req.json<AccessRegistrationBody>().catch(() => ({} as AccessRegistrationBody));
    const name = normalizeDisplayName(body.displayName);
    if (!name) return c.json(fail("VALIDATION_ERROR", "displayName must contain 1-50 characters", c.get("requestId")), 422);
    const scopes = parseRequestedScopes(c, body.requestedScopes);
    if (scopes instanceof Response) return scopes;
    const verified = await verifyForCurrentApplication(c, body.accessAssertion, options.accessFetch);
    if (verified instanceof Response) return verified;
    if (!c.env.TOKEN_PRIVATE_KEY) {
      return c.json(fail("IDENTITY_NOT_CONFIGURED", "Token signing key is not configured", c.get("requestId")), 500);
    }

    const existing = await findPrincipal(c.env.DB, verified.issuer, verified.subject);
    if (existing) {
      return c.json(fail("ACCESS_PRINCIPAL_ALREADY_LINKED", "Access principal is already linked", c.get("requestId")), 409);
    }

    const declaredEmail=normalizeLoginEmail(verified.email);
    if(declaredEmail && await c.env.DB.prepare(`SELECT id FROM access_principals WHERE issuer=? AND pending_application_id=?
      AND lower(trim(email_snapshot))=? AND subject IS NULL AND status='active'`)
      .bind(verified.issuer,c.get("currentApplicationId"),declaredEmail).first())
      return c.json(fail("ACCESS_PRINCIPAL_ALREADY_LINKED","Complete the existing account link through normal login",c.get("requestId")),409);

    const userId = id("usr");
    const principalId = id("acp");
    const ts = new Date().toISOString();
    const tokenTtlSeconds = c.get("currentApplicationTokenTtlSeconds");
    const iat = Math.floor(Date.now() / 1000);
    const token = await sign({
      iss: TOKEN_ISSUER,
      aud: [...TOKEN_AUDIENCES],
      sub: userId,
      azp: c.get("currentApplicationId"),
      principal_type: "user",
      scope: scopes.join(" "),
      iat,
      exp: iat + tokenTtlSeconds,
      jti: id("tok"),
    }, c.env.TOKEN_PRIVATE_KEY, "RS256");

    try {
      await c.env.DB.batch([
        c.env.DB.prepare("INSERT INTO users(id,display_name,created_at,updated_at) VALUES(?,?,?,?)")
          .bind(userId, name, ts, ts),
        c.env.DB.prepare(`
          INSERT INTO access_principals(id,issuer,subject,user_id,email_snapshot,status,linked_at,last_seen_at,created_at,updated_at)
          VALUES(?,?,?,?,?,'active',?,?,?,?)
        `).bind(principalId, verified.issuer, verified.subject, userId, verified.email, ts, ts, ts, ts),
      ]);
    } catch {
      return c.json(fail("ACCESS_PRINCIPAL_ALREADY_LINKED", "Access principal became linked concurrently", c.get("requestId")), 409);
    }

    return c.json(ok({
      user: { id: userId, displayName: name },
      accessToken: token,
      tokenType: "Bearer",
      expiresIn: tokenTtlSeconds,
      scope: scopes.join(" "),
    }), 201);
  });

  app.post("/internal/v1/access/link-challenges", async (c) => {
    const body = await c.req.json<AccessRequestBody>().catch(() => ({} as AccessRequestBody));
    const verified = await verifyForCurrentApplication(c, body.accessAssertion, options.accessFetch);
    if (verified instanceof Response) return verified;
    const existing = await findPrincipal(c.env.DB, verified.issuer, verified.subject);
    if (existing) {
      return c.json(fail("ACCESS_PRINCIPAL_ALREADY_LINKED", "Access principal is already linked", c.get("requestId")), 409);
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + LINK_CHALLENGE_TTL_MS);
    const linkId = newChallengeId();
    await c.env.DB.prepare(`
      INSERT INTO access_link_challenges(id,application_id,issuer,subject,audience,email_snapshot,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).bind(
      linkId,
      c.get("currentApplicationId"),
      verified.issuer,
      verified.subject,
      verified.audience,
      verified.email,
      expiresAt.toISOString(),
      createdAt.toISOString(),
    ).run();
    return c.json(ok({ challengeId: linkId, expiresAt: expiresAt.toISOString() }), 201);
  });

  app.post("/api/v1/me/access-link-challenges/:challengeId/confirm", async (c) => {
    const now = new Date().toISOString();
    const linkId = c.req.param("challengeId");
    const challenge = await c.env.DB.prepare(`
      SELECT ch.id,ch.application_id,ch.issuer,ch.subject,ch.audience,ch.email_snapshot,ch.expires_at
      FROM access_link_challenges ch
      JOIN access_audiences a
        ON a.application_id=ch.application_id
       AND a.issuer=ch.issuer
       AND a.audience=ch.audience
       AND a.status='active'
      WHERE ch.id=? AND ch.consumed_at IS NULL AND ch.expires_at>?
    `).bind(linkId, now).first<AccessLinkChallengeRow>();
    if (!challenge) {
      return c.json(fail("ACCESS_LINK_CHALLENGE_INVALID", "Access link challenge is expired, consumed or unavailable", c.get("requestId")), 409);
    }

    const userId=c.get("principal").id,operationId=crypto.randomUUID();
    const challengeEmail=normalizeLoginEmail(challenge.email_snapshot);
    const owner=challengeEmail?await c.env.DB.prepare('SELECT user_id FROM user_login_emails WHERE email=?')
      .bind(challengeEmail).first<{user_id:string}>():null;
    if(owner&&owner.user_id!==userId)
      return c.json(fail('EMAIL_ALREADY_LINKED','Login email belongs to another LifeSpace user',c.get('requestId')),409);
    const version=await linkVersion(c.env.DB,userId);
    const pending=await currentAccessLink(c.env.DB,userId,challenge.application_id,challenge.issuer);
    try {
      const results=await c.env.DB.batch([
        claimLinkRevision(c.env.DB,userId,version,operationId),
        c.env.DB.prepare(`UPDATE access_link_challenges SET consumed_at=?,linked_user_id=?
          WHERE id=? AND consumed_at IS NULL AND expires_at>?
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND access_link_operation_id=?)`)
          .bind(now,userId,linkId,now,userId,operationId),
        completeAccessLink(c.env.DB,{id:id("acp"),pendingId:pending?.subject===null?pending.id:undefined,
          issuer:challenge.issuer,subject:challenge.subject,email:normalizeLoginEmail(challenge.email_snapshot),userId,operationId,now}),
        // Challenge-first binding owns the mailbox when the user has not
        // declared a different one. No duplicate ownership across applications.
        ...(challengeEmail?[c.env.DB.prepare(`INSERT INTO user_login_emails(user_id,email,created_at,updated_at)
          SELECT id,?,?,? FROM users WHERE id=? AND access_link_operation_id=?
          AND NOT EXISTS(SELECT 1 FROM user_login_emails WHERE user_id=?)`)
          .bind(challengeEmail,now,now,userId,operationId,userId)]:[]),
        linkAudit(c.env.DB,userId,challenge.application_id,operationId,c.get("requestId"),now),
      ]);
      if(results[0].meta.changes!==1 || results[1].meta.changes!==1 || results[2].meta.changes!==1)
        return c.json(fail("ACCESS_LINK_CHALLENGE_INVALID","Access link changed concurrently",c.get("requestId")),409);
    }catch(error){
      if(!/UNIQUE constraint/.test(String(error)))throw error;
      return c.json(fail("ACCESS_PRINCIPAL_ALREADY_LINKED","Access principal or mailbox became linked concurrently",c.get("requestId")),409);
    }
    return c.body(null, 204);
  });
}
