import type { Context,Hono } from "hono";
import type { Bindings,Variables } from "./env";
import { requireScope } from "./auth";
import { requirePlatformAdminContext } from "./platform-admin-auth";
import { ApiError,success } from "./http";
import { changeModelAccessCeiling,getModelAccessCeilingConfiguration,type CeilingManager } from "./model-access-ceiling-governance";
import type { ModelAccessCeiling } from "./model-access-ceiling";

type AppEnv={Bindings:Bindings;Variables:Variables};
type AppContext=Context<AppEnv>;
const scope="spaces:manage";
function target(c:AppContext) {
  const spaceId=c.req.param("spaceId")??"",userId=c.req.param("userId")??"";
  if(!/^spc_[A-Za-z0-9_-]+$/u.test(spaceId)||!/^usr_[A-Za-z0-9_-]+$/u.test(userId)
    ||spaceId.length>128||userId.length>128) throw new ApiError("VALIDATION_ERROR","Invalid Space or User identifier",422);
  return {spaceId,userId};
}
function key(c:AppContext) {
  const value=c.req.param("modelKey")??"";
  if(!/^[a-z][a-z0-9_]{1,62}$/u.test(value)) throw new ApiError("VALIDATION_ERROR","Invalid model key",422);
  return value;
}
async function maxAccess(c:AppContext):Promise<ModelAccessCeiling> {
  const input=await c.req.json<unknown>().catch(()=>null);
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).length!==1
    ||!Object.hasOwn(input,"maxAccess")) throw new ApiError("INVALID_REQUEST","Expected only maxAccess",400);
  const value=(input as Record<string,unknown>).maxAccess;
  if(typeof value!=="string"||!["none","read","write","manage"].includes(value)) throw new ApiError("VALIDATION_ERROR","Invalid maxAccess",422);
  return value as ModelAccessCeiling;
}
async function manager(c:AppContext,platform:boolean):Promise<CeilingManager>{
  return platform?{kind:"platform",admin:await requirePlatformAdminContext(c,scope)}
    :{kind:"space",principal:c.get("principal")};
}

/** Same service and representation for both governance surfaces.
 * Register only on the full candidate; the Draft PR is not a deployable slice. */
export function registerModelAccessCeilingRoutes(app:Hono<AppEnv>):void {
  for(const platform of [false,true]){
    const base=platform?"/api/v1/platform-admin/spaces/:spaceId/members/:userId/model-access"
      :"/api/v1/spaces/:spaceId/members/:userId/model-access";
    const middleware=platform?[]:[requireScope(scope)];
    app.get(base,...middleware,async c=>c.json(success(await getModelAccessCeilingConfiguration(c.env,await manager(c,platform),target(c)))));
    app.put(base+"/:modelKey",...middleware,async c=>{
      const authority=await manager(c,platform);
      await changeModelAccessCeiling(c.env,authority,target(c),key(c),await maxAccess(c),c.get("requestId"));
      return c.body(null,204);
    });
    app.delete(base+"/:modelKey",...middleware,async c=>{
      await changeModelAccessCeiling(c.env,await manager(c,platform),target(c),key(c),null,c.get("requestId"));
      return c.body(null,204);
    });
  }
}
