import type { Hono } from "hono";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";
import { projectDelegationEligibleOperations, type DelegationEligibilityCandidate } from "./authority-capability-discovery";

type App = Hono<{ Bindings: Bindings; Variables: Variables }>;
const SPACE = /^spc_[A-Za-z0-9_-]+$/u;
const MODEL = /^[a-z][a-z0-9_]{1,62}$/u;
const OPERATION = /^(query|get|create|update|delete|file_read|file_upload|action:[a-z][a-z0-9_-]{0,62})$/u;

function requester(principal: Principal, spaceId: string): {
  user: Principal;
  candidates: DelegationEligibilityCandidate[] | null;
} {
  if (!principal.scopes.includes("resources:read")) {
    throw new ApiError("FORBIDDEN", "Delegation eligibility requires read Scope", 403);
  }
  if (principal.type === "user" && !principal.actor && !principal.purpose) {
    return { user: principal, candidates: null };
  }
  // Core authentication already verified the *current* OAuth authorization,
  // signed identity and enabled Resource/Server operation ceiling. Never
  // trust an Agent-provided userId, Resource or candidate Model list.
  const execution = principal.oauthExecution;
  if (principal.type !== "agent" || principal.actor
    || principal.purpose !== "oauth_agent_execution"
    || !execution || !execution.allowUserAuthorization || execution.spaceId !== spaceId
    || !execution.userId || !execution.modelOperations || !execution.personOperations) {
    throw new ApiError("FORBIDDEN", "Delegation eligibility requires a current verified User context", 403);
  }
  const candidates: DelegationEligibilityCandidate[] = [];
  for (const [modelKey, operations] of Object.entries(execution.modelOperations)) {
    if (!MODEL.test(modelKey) || !Array.isArray(operations) || operations.length > 32) {
      throw new ApiError("FORBIDDEN", "Invalid authorized operation ceiling", 403);
    }
    for (const operation of operations) {
      if (typeof operation === "string" && OPERATION.test(operation)) candidates.push({modelKey,operation});
    }
  }
  for (const operation of execution.personOperations) {
    if (typeof operation === "string" && ["list","get","create","update","delete"].includes(operation)) {
      candidates.push({modelKey:"person",operation:operation==="list"?"query":operation});
    }
  }
  if (candidates.length > 128) throw new ApiError("FORBIDDEN", "Too many configured operations", 403);
  return {
    user: {
      type:"user",id:execution.userId,clientId:principal.clientId,
      tokenId:principal.tokenId,scopes:[...principal.scopes],
    },
    candidates,
  };
}

export function registerAuthorityEligibilityRoutes(app: App): void {
  // The Core Authority contract is independent of the caller's protocol.
  // For direct User calls, ask about one specific operation. For an Agent
  // with an Identity-bound User consent, project the current preapproved
  // operation ceiling from the verified transport context without allowing
  // the Agent to provide/expand it.
  app.get("/api/v1/spaces/:spaceId/_authority/delegation-eligibility", async c => {
    const spaceId=c.req.param("spaceId");
    if (!SPACE.test(spaceId)) throw new ApiError("INVALID_REQUEST","Invalid Space",400);
    const params=new URL(c.req.url).searchParams;
    const modelKey=params.get("modelKey"), operation=params.get("operation");
    if ([...params.keys()].some(k=>k!=="modelKey"&&k!=="operation")
      || params.getAll("modelKey").length>1 || params.getAll("operation").length>1
      || (operation!==null && modelKey===null)
      || (modelKey!==null && !MODEL.test(modelKey))
      || (operation!==null && !OPERATION.test(operation))) {
      throw new ApiError("INVALID_REQUEST","Invalid eligibility filter",400);
    }
    const {user,candidates}=requester(c.get("principal"),spaceId);
    if (candidates===null && (!modelKey || !operation)) {
      throw new ApiError("INVALID_REQUEST","Direct User requires an exact modelKey and operation",400);
    }
    const selected=(candidates??[{modelKey:modelKey!,operation:operation!}])
      .filter(item=>(!modelKey||item.modelKey===modelKey)&&(!operation||item.operation===operation));
    const result=await projectDelegationEligibleOperations(c.env,user,spaceId,selected);
    c.header("Cache-Control","no-store");
    return c.json(success({eligibleOperations:result}));
  });
}
