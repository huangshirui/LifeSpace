import { describe, expect, it } from "vitest";
import { createApp } from "../src/app";

describe("LifeSpace Identity foundation",()=>{
  it("serves health without D1",async()=>{
    const response=await createApp().request("http://localhost/health",{},{} as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({data:{status:"ok"}});
  });
  it("does not expose bootstrap endpoints without the bootstrap secret",async()=>{
    const response=await createApp().request("http://localhost/internal/v1/users",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({displayName:"Test"})},{BOOTSTRAP_SECRET:"expected"} as any);
    expect(response.status).toBe(401);
    const body=await response.json() as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
  });
});
