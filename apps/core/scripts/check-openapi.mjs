import fs from "node:fs";
import YAML from "yaml";
const doc=YAML.parse(fs.readFileSync(new URL("../openapi.yaml",import.meta.url),"utf8"));
if(doc.openapi!=="3.1.0"||doc.info?.version!=="0.1.0")throw new Error("Core OpenAPI version metadata is invalid");
for(const path of ["/health","/api/v1/status","/api/v1/me","/api/v1/me/spaces","/api/v1/spaces","/api/v1/spaces/{spaceId}","/api/v1/spaces/{spaceId}/members","/api/v1/spaces/{spaceId}/grants"]){if(!doc.paths?.[path])throw new Error(`Core OpenAPI missing ${path}`);}
console.log("Core OpenAPI contract sanity check passed");
