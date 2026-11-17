// Only fixed route templates, validated UUIDs, placement metadata and
// known transport codes are retained. Never serialize arbitrary payloads.
export const safePlacement = value => typeof value === "string" && /^(?:local|remote)-[A-Z]{3}$/u.test(value) ? value : null;
export const safeColo = value => typeof value === "string" && /^[A-Z]{3}$/u.test(value) ? value : null;
export const safeUuid = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) ? value : null;
export const safeRay = value => typeof value === "string" && /^[a-f0-9]{16,32}(?:-[A-Z]{3})?$/iu.test(value) ? value : null;
export const safeMs = value => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const codes=new Set(["ECONNRESET","ECONNREFUSED","ETIMEDOUT","EPIPE","ENOTFOUND","EAI_AGAIN","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT","UND_ERR_SOCKET","AbortError","TimeoutError","TypeError"]);
export function safeTransportCode(error) {
  const code=error?.cause?.code??error?.code??error?.name;
  return codes.has(code)?code:"unknown";
}
export function safeRoute(path, method) {
  let url;
  try {url=new URL(path,"https://core-staging.aisr.online");} catch {return "unknown";}
  if(url.origin!=="https://core-staging.aisr.online"||!["GET","POST","PATCH","DELETE"].includes(method))return "unknown";
  const p=url.pathname.replace(/^\/api\/v1\/spaces\/spc_[A-Za-z0-9_-]+(?=\/)/u,"/api/v1/spaces/spc_*").replace(/\/rec_[A-Za-z0-9_-]+(?=\/|$)/gu,"/rec_*");
  return /^\/api\/v1\/spaces\/spc_\*\/(?:_discovery|models\/(?:task|event|day_record|wish)\/records(?:\/query|\/rec_\*(?:\/actions\/(?:complete|reopen))?)?)$/u.test(p)?method+" "+p:"unknown";
}
