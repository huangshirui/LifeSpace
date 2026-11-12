// Vercel Node runtime (portable Web Request/Response handler).
// This is NOT a general-purpose proxy. It accepts exactly one CIMD document ID
// from the authenticated Identity service, and returns only bounded JSON.
import { timingSafeEqual } from "node:crypto";
import { fetchPublicCimd, parseClientUrl } from "../lib/public-https.mjs";

const MAX_REQUEST = 1024;
const headers = {"cache-control":"no-store", "content-type":"application/json; charset=utf-8"};
function error(status) { return Response.json({error:"cimd_unavailable"}, {status, headers}); }
function authorized(request, secret) {
  if (!/^[a-f0-9]{64}$/u.test(secret || "")) return false;
  const expected = Buffer.from("Bearer " + secret);
  const received = Buffer.from(request.headers.get("authorization") || "");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
async function readRequest(request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_REQUEST
    || !/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") || "")) throw Error("INVALID_REQUEST");
  const reader = request.body?.getReader();
  if (!reader) throw Error("INVALID_REQUEST");
  const parts = [];
  let total = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST) throw Error("INVALID_REQUEST");
      parts.push(Buffer.from(value));
    }
    return JSON.parse(new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(parts,total)));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function createHandler({secret, load = fetchPublicCimd} = {}) {
  return async request => {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/api/cimd") return error(404);
    if (!/^[a-f0-9]{64}$/u.test(secret || "")) return error(503);
    if (!authorized(request, secret)) return error(401);
    try {
      const value = await readRequest(request);
      if (!value || typeof value !== "object" || Array.isArray(value)
        || Object.keys(value).length !== 1 || !parseClientUrl(value.client_id)) return error(400);
      const document = await load(value.client_id);
      return new Response(document, {status:200, headers});
    } catch { return error(400); }
  };
}

export default {
  fetch(request) {
    return createHandler({secret:process.env.CIMD_EGRESS_SHARED_SECRET})(request);
  },
};
