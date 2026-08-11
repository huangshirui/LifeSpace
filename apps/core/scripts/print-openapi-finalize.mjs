import fs from "node:fs";

const output = fs.readFileSync(new URL("../openapi.yaml", import.meta.url), "utf8");
const encoded = Buffer.from(output, "utf8").toString("base64");
const size = 4000;
const count = Math.ceil(encoded.length / size);
console.log(`OPENAPI_CHUNK_COUNT=${count}`);
for (let index = 0; index < count; index += 1) {
  console.log(`OPENAPI_CHUNK_${String(index).padStart(3, "0")}=${encoded.slice(index * size, (index + 1) * size)}`);
}
