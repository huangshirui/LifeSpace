import type { Bindings, Principal } from "./env";
import { ApiError } from "./http";
import { oauthMcpServerId, currentMcpOAuthQueryPolicy } from "./mcp-oauth-server-policy";
import { expectedOrigin } from "./mcp-resource-ingress";
import { delegationChainStatement, groupDelegationChainRows, resolveAgentApiDelegatedPrincipal, validateStructuralDelegationChain, type DelegationChainRow } from "./delegation-chain";

// Explicit protocol exposure/enrollment configuration, not a Data Grant.
// These tuples never create a membership, authorize a record, or select a User.
export type McpDelegationContext = { spaceId:string; applicationId:string; agentId:string };
const SPACE=/^spc_[A-Za-z0-9_-]{1,128}$/u;
const APP=/^app_[A-Za-z0-9_-]{1,128}$/u;
const AGENT=/^agt_[A-Za-z0-9_-]{1,128}$/u;
const key=(row:McpDelegationContext)=>[row.spaceId,row.applicationId,row.agentId].join(":");

export function parseMcpDelegationContexts(raw:unknown):McpDelegationContext[]{
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>32)throw new ApiError("VALIDATION_ERROR","Invalid MCP delegation contexts",422);
  const seen=new Set<string>();
  return raw.map(value=>{
    if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).length!==3
      ||typeof value.spaceId!=="string"||!SPACE.test(value.spaceId)
      ||typeof value.applicationId!=="string"||!APP.test(value.applicationId)
      ||typeof value.agentId!=="string"||!AGENT.test(value.agentId))
      throw new ApiError("VALIDATION_ERROR","Invalid MCP delegation context",422);
    const row={spaceId:value.spaceId,applicationId:value.applicationId,agentId:value.agentId};
    const id=key(row);
    if(seen.has(id))throw new ApiError("VALIDATION_ERROR","Duplicate MCP delegation context",422);
    seen.add(id);
    return row;
  }).sort((a,b)=>key(a).localeCompare(key(b)));
}
export function includesMcpDelegationContext(rows:readonly McpDelegationContext[],target:McpDelegationContext):boolean{
  return rows.some(row=>key(row)===key(target));
}
export async function currentMcpDelegationContexts(env:Bindings,resource:string):Promise<McpDelegationContext[]>{
  const serverId=oauthMcpServerId(resource);
  if(!serverId||new URL(resource).origin!==expectedOrigin(env))
    throw new ApiError("OAUTH_SELECTION_DENIED","MCP Resource unavailable",403);
  const row=await env.DB.prepare("SELECT enabled,config_json FROM mcp_server_definitions WHERE id=?")
    .bind(serverId).first<{enabled:number;config_json:string}>();
  if(!row||row.enabled!==1)throw new ApiError("OAUTH_SELECTION_DENIED","MCP Server unavailable",403);
  try {
    const config=JSON.parse(row.config_json);
    if(!config||typeof config!=="object"||Array.isArray(config))throw Error("Invalid configuration");
    return parseMcpDelegationContexts(config.delegationContexts);
  }catch{
    throw new ApiError("OAUTH_SELECTION_DENIED","Invalid MCP Server configuration",403);
  }
}

// A trusted Agent credential alone is not a Server or Space selection.
// The exact tuple is revalidated for each discovery and canonical file call.
export async function requireTrustedMcpContext(env:Bindings,principal:Principal,spaceId:string,resource:string|undefined,selector:string|undefined){
  if(principal.type!=="agent"||principal.purpose!=="agent_api"||principal.actor
    ||!resource||(selector!==undefined&&!/^dlg_[A-Za-z0-9_-]{1,128}$/u.test(selector))
    ||!principal.scopes.includes("resources:read"))
    throw new ApiError("FORBIDDEN","Agent MCP requires authenticated Agent and valid explicit context",403);
  const configured=await currentMcpDelegationContexts(env,resource);
  if(!includesMcpDelegationContext(configured,{spaceId,applicationId:principal.clientId,agentId:principal.id}))
    throw new ApiError("FORBIDDEN","Trusted MCP context unavailable",403);
  if(selector!==undefined){
    const [result]=await env.DB.batch<Record<string,unknown>>([delegationChainStatement(env,[selector])]);
    const rows=groupDelegationChainRows((result?.results??[]) as DelegationChainRow[]).get(selector)??[];
    const represented=resolveAgentApiDelegatedPrincipal(principal,spaceId,selector,rows);
    validateStructuralDelegationChain(represented,spaceId,selector,rows);
  }
  return currentMcpOAuthQueryPolicy(env.DB,resource,"GET","/api/v1/spaces/"+spaceId+"/_discovery/operations");
}
