import { validateCapabilities, type CapabilityDefinitions } from "./capability-definition";
import { validateModelPolicies, type ModelPoliciesDefinition } from "./policy-definition";
import { validateWorkflowActions, type WorkflowActionsDefinition } from "./workflow-definition";

export const MODEL_DEFINITION_VERSION = 1 as const;
export const FIELD_TYPES = ["string","text","integer","number","boolean","date","datetime","timezone","enum","person","person_list","record","record_list"] as const;
export type FieldType = typeof FIELD_TYPES[number];
export type ModelAccess = "read" | "write" | "manage";
export type ModelDefaultValue = string | number | boolean | null | string[];

export type FieldDefinition = {
  type: FieldType; description?: string; required?: boolean; nullable?: boolean; immutable?: boolean; readOnly?: boolean;
  minLength?: number; maxLength?: number; minimum?: number; maximum?: number; values?: string[]; targetModel?: string;
};
export type QueryDefinition = { searchable?: string[]; filterable?: string[]; sortable?: string[] };
export type ModelDefinition = {
  definitionVersion: typeof MODEL_DEFINITION_VERSION; key: string; route: string; description?: string;
  display: { singular: string; plural: string }; fields: Record<string, FieldDefinition>;
  defaults?: Record<string, ModelDefaultValue>; query?: QueryDefinition; access: ModelAccess[];
  lifecycle?: { optimisticConcurrency?: boolean; softDelete?: boolean }; capabilities?: CapabilityDefinitions;
  policies?: ModelPoliciesDefinition; actions?: WorkflowActionsDefinition;
};
export type ModelValidationIssue = { path: string; code: string; message: string };
export type ModelValidationResult = { valid: true; definition: ModelDefinition; hashInput: string } | { valid: false; issues: ModelValidationIssue[] };

const MODEL_KEY=/^[a-z][a-z0-9_]{1,62}$/; const ROUTE_SEGMENT=/^[a-z][a-z0-9-]{1,62}$/; const FIELD_KEY=/^[a-z][A-Za-z0-9]{0,62}$/;
const RESERVED_ROUTES=new Set(["health","status","me","spaces","space-invites","grants","creation-drafts","models","model-admin"]);
const RESERVED_FIELDS=new Set(["id","spaceId","modelKey","modelVersion","version","createdAt","updatedAt","deletedAt","createdBy","updatedBy"]);
const FIELD_TYPE_SET=new Set<string>(FIELD_TYPES); const ACCESS_SET=new Set<string>(["read","write","manage"]);
function isObject(value:unknown): value is Record<string,unknown>{return Boolean(value)&&typeof value==="object"&&!Array.isArray(value);}
function issue(issues:ModelValidationIssue[],path:string,code:string,message:string){issues.push({path,code,message});}
function boundedText(issues:ModelValidationIssue[],value:unknown,path:string,max:number,required=false){if(value===undefined){if(required)issue(issues,path,"TEXT_REQUIRED",`${path} is required`);return undefined;}if(typeof value!=="string"||!value.trim()||value.trim().length>max){issue(issues,path,"INVALID_TEXT",`${path} must contain 1-${max} characters`);return undefined;}return value.trim();}
function integerConstraint(issues:ModelValidationIssue[],value:unknown,path:string,minimum:number){if(value===undefined)return undefined;if(!Number.isInteger(value)||Number(value)<minimum){issue(issues,path,"INVALID_CONSTRAINT",`${path} must be an integer >= ${minimum}`);return undefined;}return Number(value);}
function stringArray(issues:ModelValidationIssue[],value:unknown,path:string){if(value===undefined)return undefined;if(!Array.isArray(value)||value.some((entry)=>typeof entry!=="string"||!entry)){issue(issues,path,"INVALID_LIST",`${path} must be an array of non-empty strings`);return undefined;}if(new Set(value).size!==value.length)issue(issues,path,"DUPLICATE_VALUE",`${path} must not contain duplicates`);return [...value] as string[];}
function canonicalize(value:unknown):unknown{if(Array.isArray(value))return value.map(canonicalize);if(!isObject(value))return value;return Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonicalize(value[key])]));}
export function canonicalModelDefinition(definition:ModelDefinition){return JSON.stringify(canonicalize(definition));}
function validDate(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;const [y,m,d]=value.split("-").map(Number);const parsed=new Date(Date.UTC(y,m-1,d));return parsed.getUTCFullYear()===y&&parsed.getUTCMonth()+1===m&&parsed.getUTCDate()===d;}
function validTimezone(value:string){try{new Intl.DateTimeFormat("en-US",{timeZone:value}).format(new Date(0));return true;}catch{return false;}}
function validDefault(field:FieldDefinition,value:unknown):boolean{
  if(value===null)return field.nullable===true;
  if(field.type==="person"||field.type==="record")return false;
  if(field.type==="person_list"||field.type==="record_list")return Array.isArray(value)&&value.length===0;
  if(field.type==="string"||field.type==="text")return typeof value==="string"&&(field.minLength===undefined||value.length>=field.minLength)&&(field.maxLength===undefined||value.length<=field.maxLength);
  if(field.type==="integer"||field.type==="number")return typeof value==="number"&&Number.isFinite(value)&&(field.type!=="integer"||Number.isInteger(value))&&(field.minimum===undefined||value>=field.minimum)&&(field.maximum===undefined||value<=field.maximum);
  if(field.type==="boolean")return typeof value==="boolean";
  if(field.type==="date")return typeof value==="string"&&validDate(value);
  if(field.type==="datetime")return typeof value==="string"&&/T/.test(value)&&!Number.isNaN(Date.parse(value));
  if(field.type==="timezone")return typeof value==="string"&&validTimezone(value);
  if(field.type==="enum")return typeof value==="string"&&Boolean(field.values?.includes(value));
  return false;
}

export function validateModelDefinition(input:unknown):ModelValidationResult{
  const issues:ModelValidationIssue[]=[];
  if(!isObject(input))return{valid:false,issues:[{path:"$",code:"INVALID_DEFINITION",message:"Model definition must be an object"}]};
  const allowedTopLevel=new Set(["definitionVersion","key","route","description","display","fields","defaults","query","access","lifecycle","capabilities","policies","actions"]);
  for(const key of Object.keys(input))if(!allowedTopLevel.has(key))issue(issues,key,"UNKNOWN_PROPERTY",`Unsupported model property ${key}`);
  if(input.definitionVersion!==MODEL_DEFINITION_VERSION)issue(issues,"definitionVersion","UNSUPPORTED_DEFINITION_VERSION",`definitionVersion must be ${MODEL_DEFINITION_VERSION}`);
  const key=typeof input.key==="string"?input.key:"";if(!MODEL_KEY.test(key))issue(issues,"key","INVALID_MODEL_KEY","key must match /^[a-z][a-z0-9_]{1,62}$/");
  const route=typeof input.route==="string"?input.route:"";if(!ROUTE_SEGMENT.test(route))issue(issues,"route","INVALID_ROUTE","route must be one lowercase URL segment");if(RESERVED_ROUTES.has(route))issue(issues,"route","RESERVED_ROUTE",`${route} is reserved by the LifeSpace Kernel`);
  const description=boundedText(issues,input.description,"description",500);
  const display=isObject(input.display)?input.display:{};for(const property of Object.keys(display))if(property!=="singular"&&property!=="plural")issue(issues,`display.${property}`,"UNKNOWN_PROPERTY",`Unsupported display property ${property}`);
  const singular=typeof display.singular==="string"?display.singular.trim():"",plural=typeof display.plural==="string"?display.plural.trim():"";if(!singular||singular.length>80)issue(issues,"display.singular","INVALID_DISPLAY_NAME","display.singular must contain 1-80 characters");if(!plural||plural.length>80)issue(issues,"display.plural","INVALID_DISPLAY_NAME","display.plural must contain 1-80 characters");
  const fieldsInput=isObject(input.fields)?input.fields:null;if(!fieldsInput||Object.keys(fieldsInput).length===0)issue(issues,"fields","FIELDS_REQUIRED","At least one field is required");
  const fields:Record<string,FieldDefinition>={};
  if(fieldsInput){if(Object.keys(fieldsInput).length>100)issue(issues,"fields","TOO_MANY_FIELDS","A model may define at most 100 fields");for(const [fieldKey,raw] of Object.entries(fieldsInput)){
    const path=`fields.${fieldKey}`;if(!FIELD_KEY.test(fieldKey))issue(issues,path,"INVALID_FIELD_KEY",`${fieldKey} is not a valid field key`);if(RESERVED_FIELDS.has(fieldKey))issue(issues,path,"RESERVED_FIELD",`${fieldKey} is managed by the Generic Runtime`);if(!isObject(raw)){issue(issues,path,"INVALID_FIELD",`${path} must be an object`);continue;}
    const allowed=new Set(["type","description","required","nullable","immutable","readOnly","minLength","maxLength","minimum","maximum","values","targetModel"]);for(const property of Object.keys(raw))if(!allowed.has(property))issue(issues,`${path}.${property}`,"UNKNOWN_PROPERTY",`Unsupported field property ${property}`);
    const type=typeof raw.type==="string"?raw.type:"";if(!FIELD_TYPE_SET.has(type)){issue(issues,`${path}.type","UNSUPPORTED_FIELD_TYPE",`Unsupported field type ${type||"<missing>"}`);continue;}
    const fieldDescription=boundedText(issues,raw.description,`${path}.description`,300);const required=raw.required===undefined?undefined:raw.required===true,nullable=raw.nullable===undefined?undefined:raw.nullable===true,immutable=raw.immutable===undefined?undefined:raw.immutable===true,readOnly=raw.readOnly===undefined?undefined:raw.readOnly===true;
    for(const [name,value] of [["required",raw.required],["nullable",raw.nullable],["immutable",raw.immutable],["readOnly",raw.readOnly]] as const)if(value!==undefined&&typeof value!=="boolean")issue(issues,`${path}.${name}`,"INVALID_BOOLEAN",`${path}.${name} must be boolean`);if(required&&nullable)issue(issues,path,"CONTRADICTORY_NULLABILITY","A required field cannot also be nullable in Model Definition v1");
    const minLength=integerConstraint(issues,raw.minLength,`${path}.minLength`,0),maxLength=integerConstraint(issues,raw.maxLength,`${path}.maxLength`,1);if(minLength!==undefined&&maxLength!==undefined&&minLength>maxLength)issue(issues,path,"INVALID_RANGE","minLength cannot exceed maxLength");if((minLength!==undefined||maxLength!==undefined)&&type!=="string"&&type!=="text")issue(issues,path,"INVALID_CONSTRAINT","Length constraints apply only to string/text fields");
    const minimum=typeof raw.minimum==="number"&&Number.isFinite(raw.minimum)?raw.minimum:undefined,maximum=typeof raw.maximum==="number"&&Number.isFinite(raw.maximum)?raw.maximum:undefined;if(raw.minimum!==undefined&&minimum===undefined)issue(issues,`${path}.minimum`,`INVALID_CONSTRAINT`,`minimum must be a finite number`);if(raw.maximum!==undefined&&maximum===undefined)issue(issues,`${path}.maximum`,`INVALID_CONSTRAINT`,`maximum must be a finite number`);if(minimum!==undefined&&maximum!==undefined&&minimum>maximum)issue(issues,path,"INVALID_RANGE","minimum cannot exceed maximum");if((minimum!==undefined||maximum!==undefined)&&type!=="integer"&&type!=="number")issue(issues,path,"INVALID_CONSTRAINT","Numeric constraints apply only to integer/number fields");
    const values=stringArray(issues,raw.values,`${path}.values`);if(type==="enum"){if(!values?.length)issue(issues,`${path}.values","ENUM_VALUES_REQUIRED","enum fields require values");if(values&&values.length>50)issue(issues,`${path}.values","TOO_MANY_ENUM_VALUES","enum fields may contain at most 50 values");}else if(values!==undefined)issue(issues,`${path}.values","INVALID_CONSTRAINT","values is only valid for enum fields");
    const targetModel=typeof raw.targetModel==="string"?raw.targetModel:undefined;const recordRelation=type==="record"||type==="record_list";if(recordRelation&&(!targetModel||!MODEL_KEY.test(targetModel)))issue(issues,`${path}.targetModel","TARGET_MODEL_REQUIRED","record relations require a valid targetModel key");if(!recordRelation&&raw.targetModel!==undefined)issue(issues,`${path}.targetModel","INVALID_CONSTRAINT","targetModel is only valid for record relations");
    fields[fieldKey]={type:type as FieldType,...(fieldDescription?{description:fieldDescription}:{}),...(required===undefined?{}:{required}),...(nullable===undefined?{}:{nullable}),...(immutable===undefined?{}:{immutable}),...(readOnly===undefined?{}:{readOnly}),...(minLength===undefined?{}:{minLength}),...(maxLength===undefined?{}:{maxLength}),...(minimum===undefined?{}:{minimum}),...(maximum===undefined?{}:{maximum}),...(values===undefined?{}:{values}),...(targetModel===undefined?{}:{targetModel})};
  }}
  const defaultsInput=input.defaults===undefined?undefined:isObject(input.defaults)?input.defaults:null;if(input.defaults!==undefined&&!defaultsInput)issue(issues,"defaults","INVALID_DEFAULTS","defaults must be an object");const defaults:Record<string,ModelDefaultValue>={};if(defaultsInput){for(const [fieldKey,value] of Object.entries(defaultsInput)){const field=fields[fieldKey];if(!field){issue(issues,`defaults.${fieldKey}`,"UNKNOWN_DEFAULT_FIELD",`${fieldKey} is not a declared field`);continue;}if(!validDefault(field,value)){issue(issues,`defaults.${fieldKey}`,"INVALID_DEFAULT",`Default for ${fieldKey} does not satisfy the declared field type/constraints`);continue;}defaults[fieldKey]=structuredClone(value) as ModelDefaultValue;}}
  const accessInput=stringArray(issues,input.access,"access")??[];if(accessInput.length===0)issue(issues,"access","ACCESS_REQUIRED","At least one access capability is required");for(const value of accessInput)if(!ACCESS_SET.has(value))issue(issues,"access","UNSUPPORTED_ACCESS",`Unsupported access capability ${value}`);if(accessInput.includes("write")&&!accessInput.includes("read"))issue(issues,"access","INVALID_ACCESS","write requires read");if(accessInput.includes("manage")&&!accessInput.includes("write"))issue(issues,"access","INVALID_ACCESS","manage requires write");
  const queryInput=input.query===undefined?undefined:isObject(input.query)?input.query:null;if(input.query!==undefined&&!queryInput)issue(issues,"query","INVALID_QUERY","query must be an object");const query:QueryDefinition|undefined=queryInput?{searchable:stringArray(issues,queryInput.searchable,"query.searchable"),filterable:stringArray(issues,queryInput.filterable,"query.filterable"),sortable:stringArray(issues,queryInput.sortable,"query.sortable")}:undefined;if(query)for(const [kind,fieldKeys] of Object.entries(query))for(const fieldKey of fieldKeys??[])if(!fields[fieldKey])issue(issues,`query.${kind}`,"UNKNOWN_QUERY_FIELD",`${fieldKey} is not a declared field`);
  const lifecycleInput=input.lifecycle===undefined?undefined:isObject(input.lifecycle)?input.lifecycle:null;if(input.lifecycle!==undefined&&!lifecycleInput)issue(issues,"lifecycle","INVALID_LIFECYCLE","lifecycle must be an object");const lifecycle=lifecycleInput?{optimisticConcurrency:lifecycleInput.optimisticConcurrency===true,softDelete:lifecycleInput.softDelete===true}:undefined;if(lifecycleInput){for(const property of Object.keys(lifecycleInput))if(property!=="optimisticConcurrency"&&property!=="softDelete")issue(issues,`lifecycle.${property}`,"UNKNOWN_PROPERTY",`Unsupported lifecycle property ${property}`);for(const property of ["optimisticConcurrency","softDelete"] as const)if(lifecycleInput[property]!==undefined&&typeof lifecycleInput[property]!=="boolean")issue(issues,`lifecycle.${property}`,"INVALID_BOOLEAN",`${property} must be boolean`);}
  const capabilityResult=validateCapabilities(input.capabilities,fields);issues.push(...capabilityResult.issues);const modelPolicies=validateModelPolicies(input.policies,fields);issues.push(...modelPolicies.issues);const workflow=validateWorkflowActions(input.actions,fields);issues.push(...workflow.issues);if(workflow.actions)for(const [actionKey,action] of Object.entries(workflow.actions))if(!accessInput.includes(action.access))issue(issues,`actions.${actionKey}.access","ACTION_ACCESS_NOT_EXPOSED",`Action access ${action.access} is not exposed by model ${key}`);if(capabilityResult.capabilities?.temporal?.occurrences===true&&workflow.actions?.["record-occurrence"])issue(issues,"actions.record-occurrence","CAPABILITY_ACTION_COLLISION","record-occurrence is owned by the Temporal capability");
  if(issues.length)return{valid:false,issues};
  const definition:ModelDefinition={definitionVersion:MODEL_DEFINITION_VERSION,key,route,...(description?{description}:{}),display:{singular,plural},fields,...(Object.keys(defaults).length?{defaults}:{}),...(query?{query}:{}),access:accessInput as ModelAccess[],...(lifecycle?{lifecycle}:{}),...(capabilityResult.capabilities?{capabilities:capabilityResult.capabilities}:{}),...(modelPolicies.policies?{policies:modelPolicies.policies}:{}),...(workflow.actions?{actions:workflow.actions}:{})};
  return{valid:true,definition,hashInput:canonicalModelDefinition(definition)};
}
