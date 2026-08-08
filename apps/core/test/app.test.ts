import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("LifeSpace Core foundation",()=>{
  it("serves health without D1",async()=>{
    const response=await createApp().request("http://localhost/health",{},{} as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({data:{status:"ok"}});
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
  it("requires authentication for Space APIs",async()=>{
    const response=await createApp().request("http://localhost/api/v1/me/spaces",{},{} as any);
    expect(response.status).toBe(401);
    const body=await response.json() as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.requestId).toBeTruthy();
  });
});
