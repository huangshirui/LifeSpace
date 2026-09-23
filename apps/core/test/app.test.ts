import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";

describe("LifeSpace Core foundation",()=>{
  it("serves health without D1",async()=>{
    const response=await createApp().request("http://localhost/health",{},{} as any);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({data:{status:"ok"}});
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });
  it("emits structured performance timing in deployed environments and honors the kill switch", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const measured = await createApp().request("http://localhost/health", {}, { ENVIRONMENT: "production" } as any);
      expect(measured.status).toBe(200);
      const entries = log.mock.calls
        .map(([value]) => typeof value === "string" ? JSON.parse(value) : null)
        .filter((value) => value?.message === "LifeSpace performance timing");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ service: "core", method: "GET", path: "/health", status: 200, phases: {} });
      expect(typeof entries[0].totalMs).toBe("number");

      log.mockClear();
      await createApp().request(
        "http://localhost/health",
        {},
        { ENVIRONMENT: "production", PERFORMANCE_DIAGNOSTICS: "0" } as any,
      );
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("requires authentication for Space APIs",async()=>{
    const response=await createApp().request("http://localhost/api/v1/me/spaces",{},{} as any);
    expect(response.status).toBe(401);
    const body=await response.json() as any;
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.requestId).toBeTruthy();
  });
});
