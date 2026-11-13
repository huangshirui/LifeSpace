// Infrastructure regression executed inside the existing Cloudflare Workers pool.
import { describe, expect, it } from "vitest";
import { handleFileProbe, runFileSample, SIZES } from "../../../infra/performance-probe/file-worker.mjs";

const space = "spc_" + "a".repeat(32);
const upload = "upl_" + "b".repeat(32);
const file = "fil_" + "c".repeat(32);
const env = { PROBE_TOKEN: "x".repeat(32), USER_BEARER: "synthetic", SPACE_ID: space, MODEL_KEY: "smoke_file_bench_123_1" };
const root = "/api/v1/spaces/" + space;
const model = root + "/models/" + env.MODEL_KEY + "/records";
const signed = (key: string) => "https://" + "d".repeat(32) + ".r2.cloudflarestorage.com/lifespace-staging-assets/" + key + "?X-Amz-Signature=synthetic";

describe("Native File probe in workerd", () => {
  it("constructs the actual fixture discovery Request with manual redirects", async () => {
    let calls = 0;
    const response = await handleFileProbe(new Request("https://probe.example/ready", {headers: {"x-lifespace-probe-token": env.PROBE_TOKEN}}), env,
      async (url: string, init: RequestInit) => {
        // The real workerd Request constructor validates runtime-specific options.
        const req = new Request(url, init);
        calls++;
        expect(req.redirect).toBe("manual");
        expect(req.method).toBe("GET");
        return Response.json({data: {fields: [{key: "attachments", type: "file_list"}]}}, {headers: {"x-request-id": req.headers.get("x-request-id")!}});
      });
    expect(calls).toBe(1);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ok: true, stage: "core", correlationMatched: true});
  });

  it("constructs real workerd Requests throughout the synthetic lifecycle", async () => {
    let bytes: ArrayBuffer = new ArrayBuffer(0);
    let name = "";
    const methods: string[] = [];
    const result = await runFileSample(env, SIZES[0], async (url: string, init: RequestInit) => {
      const req = new Request(url, init);
      expect(req.redirect).toBe("manual");
      const path = new URL(req.url).pathname;
      methods.push(req.method);
      const json = (data: unknown, status = 200) => Response.json({data}, {status, headers: {"x-request-id": req.headers.get("x-request-id") ?? ""}});
      if (path === root + "/file-uploads") {
        name = (await req.json() as {name:string}).name;
        return json({id:upload, upload:{method:"PUT",headers:{"content-type":"application/octet-stream"},url:signed("uploads/native/"+space+"/"+upload)}}, 201);
      }
      if (req.method === "PUT") {
        bytes = await req.arrayBuffer();
        return new Response(null, {status: 200});
      }
      if (path.endsWith("/complete")) return json({id:file,size:SIZES[0],name,contentType:"application/octet-stream"});
      if (path === model && req.method === "POST") return json({id:"rec_synthetic",version:1,attachments:[file]},201);
      if (path === root + "/file-downloads") return json({id:file,size:SIZES[0],contentType:"application/octet-stream",url:signed("files/"+space+"/"+file)});
      if (req.method === "GET" && path.includes("/files/")) return new Response(bytes,{headers:{"content-type":"application/octet-stream"}});
      if (req.method === "DELETE") return new Response(null,{status:204});
      throw Error("unexpected synthetic request");
    });
    expect(result.ok).toBe(true);
    expect(result.completeRequestId).toBeTruthy();
    expect(methods).toEqual(["POST","PUT","POST","POST","POST","GET","DELETE","DELETE"]);
  });
});
