// Current authorized operation catalog for protocol-neutral consumers.
// Storage kind and source model are strictly Core-internal. The public DTO
// contains no origin, provider, Person Directory identifier or route binding.
import type { Context, Hono } from "hono";
import { requirePersonDirectoryPermission } from "./authorization";
import { getExternalModel, externalAuthorityModel } from "./external-model";
import { externalSemanticDetail } from "./external-runtime";
import { requireModelAccess } from "./model-authorization";
import { getRuntimeModel } from "./model-registry";
import { projectModelSemanticFacts } from "./model-semantic-projection";
import { getActiveModelContract } from "./model-contract-store";
import { getOrCreateActiveModelContract } from "./model-contract-service";
import { currentMcpOAuthQueryPolicy } from "./mcp-oauth-server-policy";
import type { Bindings, Principal, Variables } from "./env";
import { ApiError, success } from "./http";

type AppEnv={Bindings:Bindings;Variables:Variables};
type ContextApp=Context<AppEnv>;
type Access="read"|"write";
type Kind="native"|"external"|"person"|"action";
type Operation="query"|"get"|"create"|"update"|"delete"|`action:${string}`;
type Contract={ contractId?:string; modelKey:string; display:string; operation:Operation;
  operationRef:string; inputSchema:Record<string,unknown>; title:string; description:string; };
type Entry={dto:Contract;kind:Kind;target:string;actionKey?:string};
type JsonSchema=Record<string,unknown>;
const MODEL=/^[a-z][a-z0-9_]{1,62}$/u;
const ID=/^[A-Za-z0-9_-]{1,160}$/u;
const OP_REF=/^op_[a-f0-9]{64}$/u;
const MAX_OPERATIONS=128;
const denied=()=>new ApiError("NOT_FOUND","Operation unavailable",404);
const schemaString={type:"string",minLength:1,maxLength:160};
const version={type:"integer",minimum:1};
function operationSchema(spaceId:string,op:Operation,data?:JsonSchema,recordId?:JsonSchema):JsonSchema {
  const properties:JsonSchema={spaceId:{type:"string",enum:[spaceId]}};
  const required=["spaceId"];
  if(op==="get"||op==="update"||op==="delete"||op.startsWith("action:")) {
    properties.recordId=recordId??schemaString;
    required.push("recordId");
  }
  let definitions:Record<string,unknown>|undefined;
  if(op!=="get"){
    const wireData=structuredClone(data??{type:"object",additionalProperties:false});
    if(wireData.$defs && typeof wireData.$defs==="object"&&!Array.isArray(wireData.$defs)){
      definitions=wireData.$defs as Record<string,unknown>;
      delete wireData.$defs;
    }
    properties.data=wireData;
    if(op!=="query")required.push("data");
  }
  return {type:"object",additionalProperties:false,properties,required,
    ...(definitions?{$defs:definitions}:{})};
}
async function ref(key:string) {
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(key));
  return "op_"+Array.from(new Uint8Array(hash)).map(x=>x.toString(16).padStart(2,"0")).join("");
}
function names(value:unknown):string {
  return typeof value==="string"&&value.trim()?value:"Model";
}
function canonicalFieldSchema(field:Record<string,unknown>):JsonSchema {
  if(field.valueSchema && typeof field.valueSchema==="object"&&!Array.isArray(field.valueSchema))
    return structuredClone(field.valueSchema as JsonSchema);
  const type=field.type;
  if(type==="integer"||type==="number"||type==="boolean")return {type};
  if(type==="person_list"||type==="record_list"||type==="file_list")return {type:"array"};
  if(type==="date")return {type:"string",format:"date"};
  if(type==="instant")return {type:"string",format:"date-time"};
  if(type==="text"||type==="string"||type==="enum")return {type:"string"};
  // Unknown provider-specific syntax is never guessed. Core is the final
  // validator; permissive schema here is preferable to false semantics.
  return {};
}
function externalDataSchema(detail:ReturnType<typeof externalSemanticDetail>):JsonSchema {
  const fields=detail.fields.filter(f=>f.writable);
  const properties=Object.fromEntries(fields.map(f=>[f.key,canonicalFieldSchema(f as unknown as Record<string,unknown>)]));
  return {type:"object",additionalProperties:false,properties};
}
const personName={type:"string",minLength:1,maxLength:100};
const altNames={type:"array",maxItems:20,items:personName};
const personPatch={type:"object",additionalProperties:false,
  properties:{set:altNames,add:altNames,remove:altNames,
    rename:{type:"array",maxItems:20,items:{type:"object",additionalProperties:false,
      properties:{from:personName,to:personName},required:["from","to"]}}}};
function personData(op:Operation):JsonSchema {
  if(op==="query")return {type:"object",additionalProperties:false,properties:{
    search:{type:"string",minLength:1,maxLength:100},limit:{type:"integer",minimum:1,maximum:100},
    cursor:{type:"string",minLength:1,maxLength:2048}}};
  if(op==="create")return {type:"object",additionalProperties:false,
    properties:{displayName:personName,alternateNames:altNames},required:["displayName"]};
  if(op==="update")return {type:"object",additionalProperties:false,
    properties:{version,displayName:personName,alternateNames:personPatch},required:["version"]};
  if(op==="delete")return {type:"object",additionalProperties:false,properties:{version},required:["version"]};
  return {type:"object",additionalProperties:false};
}
async function may(env:Bindings,p:Principal,spaceId:string,model:Parameters<typeof requireModelAccess>[3],access:Access) {
  if(!p.scopes.includes("resources:"+access))return false;
  try {await requireModelAccess(env,p,spaceId,model,access);return true;}
  catch(e){if(e instanceof ApiError&&[403,404,405].includes(e.status))return false;throw e;}
}
async function personMay(env:Bindings,p:Principal,spaceId:string,access:Access) {
  if(!p.scopes.includes("resources:"+access))return false;
  try {await requirePersonDirectoryPermission(env,p,spaceId,access);return true;}
  catch(e){if(e instanceof ApiError&&[403,404].includes(e.status))return false;throw e;}
}
async function manifest(c:ContextApp):Promise<Entry[]>{
  const principal=c.get("principal"),execution=principal.oauthExecution;
  const spaceId=c.req.param("spaceId");
  if(principal.purpose!=="oauth_agent_execution"||!execution||execution.spaceId!==spaceId
    ||principal.actor)throw denied();
  const policy=await currentMcpOAuthQueryPolicy(c.env.DB,execution.resource,
    "GET","/api/v1/me/_discovery/inventory");
  const out:Entry[]=[];
  const push=async(kind:Kind,modelKey:string,display:string,operation:Operation,data?:JsonSchema,actionKey?:string)=>{
    if(out.length>=MAX_OPERATIONS)throw new ApiError("OPERATION_LIMIT","Too many configured MCP operations",413);
    const opRef=await ref([policy.serverId,spaceId,modelKey,operation,kind].join(":"));
    const dataSchema=operationSchema(spaceId,operation,data);
    const toolOp=operation.startsWith("action:")?"action":operation;
    out.push({kind,target:modelKey,actionKey,
      dto:{modelKey,display,operation,operationRef:opRef,
        inputSchema:dataSchema,title:toolOp+" "+display,
        description:"LifeSpace "+toolOp+". Current Core Resource, Space, Model, Policy and Delegation are revalidated at execution."}});
  };
  for(const [key, configured]of Object.entries(policy.modelOperations)){
    if(!MODEL.test(key)||!Array.isArray(configured)||!configured.length)throw denied();
    const model=await getRuntimeModel(c.env,key);
    if(!model)continue;
    if(model.definition.origin==="external"){
      const bound=await getExternalModel(c.env,spaceId,key);
      if(!bound)continue;
      const decision=externalAuthorityModel(bound);
      const [read,write]=await Promise.all([may(c.env,principal,spaceId,decision,"read"),may(c.env,principal,spaceId,decision,"write")]);
      const detail=externalSemanticDetail(bound,[...(read?["read"]:[]),...(write?["write"]:[])]);
      for(const op of configured){
        if(!["query","get","create","update","delete"].includes(op))continue;
        if(!(op==="get"||op==="query"?read:write)
          ||detail.runtimeCapabilities[op as keyof typeof detail.runtimeCapabilities]!==true)continue;
        const input=op==="query"?{type:"object",description:"Canonical Query. Core validates current provider fields, filters, sorting and cursor."}
          :op==="create"||op==="update"?externalDataSchema(detail):{type:"object",additionalProperties:false};
        await push("external",key,names(detail.display.singular),op as Operation,input);
      }
      continue;
    }
    const [read,write]=await Promise.all([may(c.env,principal,spaceId,model,"read"),may(c.env,principal,spaceId,model,"write")]);
    const semantic=projectModelSemanticFacts(model);
    for(const op of configured){
      if(["query","get","create","update","delete"].includes(op)){
        if(!(op==="query"||op==="get"?read:write))continue;
        let schema:JsonSchema={type:"object",description:"LifeSpace canonical operation input, validated against the current Model Contract."};
        if(op==="delete")schema={type:"object",additionalProperties:false,properties:{version},required:["version"]};
        else if(op==="create"||op==="update"){
          // The immutable generated Model Contract is the source of the
          // writable shape, not an Adapter-maintained field-type table.
          const contract=await getActiveModelContract(c.env)??await getOrCreateActiveModelContract(c.env);
          const metadata=(contract.jsonSchema["x-lifespace-models"] as Record<string,Record<string,unknown>>)?.[key];
          const inputRef=metadata?.[op==="create"?"createSchema":"updateSchema"];
          if(typeof inputRef!=="string")continue;
          const defs=contract.jsonSchema.$defs as Record<string,JsonSchema>;
          if(!defs||!inputRef.startsWith("#/$defs/")||!defs[inputRef.slice(8)]
            ||metadata?.schemaHash!==model.schemaHash||metadata?.version!==model.version)continue;
          const selected:Record<string,JsonSchema>={};
          const include=(source:string):void=>{
            if(!source.startsWith("#/$defs/"))throw denied();
            const key=source.slice(8);
            if(selected[key])return;
            if(!defs[key]||Object.keys(selected).length>64)throw denied();
            selected[key]=structuredClone(defs[key]);
            for(const m of JSON.stringify(defs[key]).matchAll(/"\\$ref":"([^"]+)"/gu))include(m[1]);
          };
          include(inputRef);
          schema={$ref:inputRef,$defs:selected};
        }
        await push("native",key,names(semantic.display.singular),op as Operation,schema);
      }else if(op.startsWith("action:")){
        const actionKey=op.slice(7);
        const action=semantic.actions.find(a=>a.key===actionKey);
        if(!action||!(action.access==="read"?read:write))continue;
        await push("action",key,names(semantic.display.singular),op as Operation,
          action.kind==="workflow"
            ?{type:"object",additionalProperties:false,properties:{version},required:["version"]}
            :{type:"object",description:"Published Capability action input, validated by Core."},actionKey);
      }
    }
  }
  const choices=policy.personOperations??[];
  if(choices.length){
    const [read,write]=await Promise.all([personMay(c.env,principal,spaceId,"read"),personMay(c.env,principal,spaceId,"write")]);
    for(const op of choices){
      const normalized=op==="list"?"query":op;
      if(!["query","get","create","update","delete"].includes(normalized))continue;
      const available=["query","get"].includes(normalized)?read:op==="update"
        ?read&&principal.scopes.includes("resources:write"):write;
      if(available)await push("person","person","Person",normalized as Operation,personData(normalized as Operation));
    }
  }
  return out;
}
function targetRequest(c:ContextApp,item:Entry,args:Record<string,unknown>) {
  const spaceId=c.req.param("spaceId");
  if(typeof spaceId!=="string"||!/^spc_[A-Za-z0-9_-]+$/u.test(spaceId))throw denied();
  if(Object.keys(args).some(k=>!["spaceId","recordId","data"].includes(k))
    ||args.spaceId!==spaceId)throw denied();
  const op=item.dto.operation;
  const refId=args.recordId;
  if(["get","update","delete"].includes(op)||op.startsWith("action:")){
    if(typeof refId!=="string"||!ID.test(refId))throw denied();
  }else if(refId!==undefined)throw denied();
  // Empty Query has the same meaning on all Core-owned model families.
  const data=op==="query"&&args.data===undefined?{}:args.data;
  if(op!=="get"&&(data===undefined||typeof data!=="object"||data===null||Array.isArray(data)))
    throw new ApiError("INVALID_REQUEST","Operation requires an object payload",400);
  const base="/api/v1/spaces/"+encodeURIComponent(spaceId);
  let method="GET",path="";
  let body:unknown=undefined;
  if(item.kind==="person"){
    const personBase=base+"/people";
    if(op==="query"){
      const query=data as Record<string,unknown>;
      if(Object.keys(query).some(k=>!["search","limit","cursor"].includes(k)))throw denied();
      const params=new URLSearchParams();
      if(typeof query.search==="string")params.set("q",query.search);
      if(Number.isInteger(query.limit))params.set("limit",String(query.limit as number));
      if(typeof query.cursor==="string")params.set("cursor",query.cursor);
      path=personBase+(params.size?"?"+params:"");
    }else{
      method=op==="get"?"GET":op==="create"?"POST":op==="update"?"PATCH":"DELETE";
      path=personBase+(op==="create"?"":"/"+encodeURIComponent(refId as string));
      body=data;
    }
  }else{
    const modelBase=base+"/models/"+encodeURIComponent(item.target)+"/records";
    if(op==="query"){method="POST";path=modelBase+"/query";body=data;}
    else if(op==="get"){path=modelBase+"/"+encodeURIComponent(refId as string);}
    else if(op.startsWith("action:")){method="POST";path=modelBase+"/"+encodeURIComponent(refId as string)
      +"/actions/"+encodeURIComponent(item.actionKey!);body=data;}
    else{method=op==="create"?"POST":op==="update"?"PATCH":"DELETE";
      path=modelBase+(op==="create"?"":"/"+encodeURIComponent(refId as string));body=data;}
  }
  return {method,path,body};
}
export function registerMcpGenericOperationRoutes(app:Hono<AppEnv>):void {
  app.get("/api/v1/spaces/:spaceId/_discovery/operations",async c=>{
    const all=await manifest(c);
    return c.json(success({operations:all.map(e=>e.dto)}),200,{"cache-control":"no-store"});
  });
  app.post("/api/v1/spaces/:spaceId/_operations/:operationRef/invoke",async c=>{
    if(!OP_REF.test(c.req.param("operationRef")))throw denied();
    const raw=await c.req.text();
    if(raw.length>65536)throw new ApiError("REQUEST_TOO_LARGE","Operation payload too large",413);
    let input:unknown;
    try{input=JSON.parse(raw);}catch{throw new ApiError("INVALID_REQUEST","JSON required",400);}
    if(!input||typeof input!=="object"||Array.isArray(input)
      ||Object.keys(input).length!==1||!("arguments" in input))throw denied();
    const args=(input as {arguments:unknown}).arguments;
    if(!args||typeof args!=="object"||Array.isArray(args))throw denied();
    const item=(await manifest(c)).find(op=>op.dto.operationRef===c.req.param("operationRef"));
    if(!item)throw denied();
    const {method,path,body}=targetRequest(c,item,args as Record<string,unknown>);
    const headers=new Headers({authorization:c.req.header("authorization")||"",
      accept:"application/json",...(body===undefined?{}:{"content-type":"application/json"})});
    const selector=c.req.header("x-lifespace-delegation-id");
    if(selector)headers.set("x-lifespace-delegation-id",selector);
    // Call the same Core Worker app, never a remote Provider/Adapter directly.
    // The inner canonical route independently rechecks full current authority.
    const response=await app.fetch(new Request("https://core.internal"+path,{
      method,headers,...(body===undefined?{}:{body:JSON.stringify(body)}),
    }),c.env);
    const resultHeaders=new Headers(response.headers);
    resultHeaders.set("cache-control","no-store");
    return new Response(response.body,{status:response.status,headers:resultHeaders});
  });
}
