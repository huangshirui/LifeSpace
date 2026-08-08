import type { Hono } from "hono";
import type { Bindings, Variables } from "./env";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import { ApiError, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

export function registerSpaceRoutes(app: Hono<AppEnv>): void {
  app.get("/api/v1/me", requireScope("profile:read"), async (c) => c.json(success({ principal: c.get("principal") })));

  app.get("/api/v1/me/spaces", requireScope("spaces:read"), async (c) => {
    const p = c.get("principal");
    const result = p.type === "user"
      ? await c.env.DB.prepare(`SELECT s.id,s.kind,s.name,m.role,s.version FROM spaces s JOIN space_memberships m ON m.space_id=s.id WHERE m.user_id=? AND m.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY s.created_at`).bind(p.id).all()
      : { results: [] };
    return c.json(success(result.results));
  });

  app.post("/api/v1/spaces", requireScope("spaces:write"), async (c) => {
    const p = c.get("principal");
    if (p.type !== "user") throw new ApiError("FORBIDDEN", "Only users can create Spaces", 403);
    const body = await c.req.json<{ kind?: string; name?: string; ownerDisplayName?: string }>().catch(() => ({}));
    if (!body.kind || !["personal","family","team"].includes(body.kind) || !body.name?.trim() || !body.ownerDisplayName?.trim()) throw new ApiError("VALIDATION_ERROR", "kind, name and ownerDisplayName are required", 422);
    const spaceId=id("spc"), membershipId=id("mem"), personId=id("per"), timestamp=now();
    await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO spaces(id,kind,name,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(spaceId,body.kind,body.name.trim(),p.id,timestamp,timestamp),
      c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(membershipId,spaceId,p.id,"owner",timestamp,timestamp),
      c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(personId,spaceId,p.id,body.ownerDisplayName.trim(),timestamp,timestamp),
    ]);
    return c.json(success({ id:spaceId, kind:body.kind, name:body.name.trim(), role:"owner", ownerPersonId:personId, version:1 }),201);
  });

  app.get("/api/v1/spaces/:spaceId", requireScope("spaces:read"), async (c) => {
    const p=c.get("principal"), spaceId=c.req.param("spaceId");
    const access=await requireSpacePermission(c.env,p,spaceId,"read");
    const space=await c.env.DB.prepare(`SELECT id,kind,name,version FROM spaces WHERE id=? AND deleted_at IS NULL`).bind(spaceId).first();
    if (!space) throw new ApiError("NOT_FOUND","Space not found",404);
    return c.json(success({ ...space, access }));
  });

  app.get("/api/v1/spaces/:spaceId/members", requireScope("spaces:read"), async (c) => {
    const p=c.get("principal"), spaceId=c.req.param("spaceId");
    await requireSpacePermission(c.env,p,spaceId,"read");
    const rows=await c.env.DB.prepare(`SELECT id,user_id userId,role,created_at createdAt FROM space_memberships WHERE space_id=? AND deleted_at IS NULL ORDER BY created_at`).bind(spaceId).all();
    return c.json(success(rows.results));
  });

  app.post("/api/v1/spaces/:spaceId/members", requireScope("spaces:manage"), async (c) => {
    const p=c.get("principal"), spaceId=c.req.param("spaceId");
    await requireSpacePermission(c.env,p,spaceId,"manage");
    const body=await c.req.json<{userId?:string;role?:string;displayName?:string}>().catch(()=>({}));
    if(!body.userId || !body.role || !["admin","editor","viewer"].includes(body.role) || !body.displayName?.trim()) throw new ApiError("VALIDATION_ERROR","userId, role and displayName are required",422);
    const timestamp=now(), membershipId=id("mem"), personId=id("per");
    try {
      await c.env.DB.batch([
        c.env.DB.prepare(`INSERT INTO space_memberships(id,space_id,user_id,role,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(membershipId,spaceId,body.userId,body.role,timestamp,timestamp),
        c.env.DB.prepare(`INSERT INTO space_people(id,space_id,linked_user_id,display_name,created_at,updated_at) VALUES(?,?,?,?,?,?)`).bind(personId,spaceId,body.userId,body.displayName.trim(),timestamp,timestamp),
      ]);
    } catch { throw new ApiError("CONFLICT","User is already an active Space member",409); }
    return c.json(success({id:membershipId,userId:body.userId,role:body.role,personId}),201);
  });

  app.post("/api/v1/spaces/:spaceId/grants", requireScope("grants:manage"), async (c) => {
    const p=c.get("principal"), spaceId=c.req.param("spaceId");
    if(p.type!=="user") throw new ApiError("FORBIDDEN","Only users can manage Data Grants",403);
    await requireSpacePermission(c.env,p,spaceId,"manage");
    const body=await c.req.json<{granteeType?:string;granteeId?:string;permission?:string;expiresAt?:string|null}>().catch(()=>({}));
    if(!body.granteeType || !["user","space","service","device"].includes(body.granteeType) || !body.granteeId || !body.permission || !["free_busy","read","write","manage"].includes(body.permission)) throw new ApiError("VALIDATION_ERROR","Valid granteeType, granteeId and permission are required",422);
    const grantId=id("grt");
    await c.env.DB.prepare(`INSERT INTO data_grants(id,source_space_id,grantee_type,grantee_id,resource_type,resource_id,permission,created_by_user_id,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(grantId,spaceId,body.granteeType,body.granteeId,"space",null,body.permission,p.id,now(),body.expiresAt??null).run();
    return c.json(success({id:grantId,sourceSpaceId:spaceId,...body}),201);
  });
}
