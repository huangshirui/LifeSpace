import fs from "node:fs";
import YAML from "yaml";
const doc=YAML.parse(fs.readFileSync(new URL("../openapi.yaml",import.meta.url),"utf8"));
if(doc.openapi!=="3.1.0"||doc.info?.version!=="0.1.0")throw new Error("Identity OpenAPI version metadata is invalid");
for(const path of ["/health","/api/v1/status","/internal/v1/users","/internal/v1/applications","/internal/v1/tokens"]){if(!doc.paths?.[path])throw new Error(`Identity OpenAPI missing ${path}`);}
console.log("Identity OpenAPI contract sanity check passed");
