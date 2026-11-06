import { describe,expect,it,vi } from "vitest";
import type { Bindings } from "../src/env";
import { readVerifiedUploadedObject,type UploadSessionRow } from "../src/file-routes";

const row = {
  object_key:"uploads/native/spc_synthetic/upl_"+"a".repeat(32),
  expected_size:18,
  content_type:"application/pdf",
} as UploadSessionRow;

function mockR2(value:object|null) {
  const head=vi.fn(async()=>{ throw new Error("duplicate R2 HEAD must not run"); });
  const get=vi.fn(async()=>value);
  const env={ASSETS:{get,head}} as unknown as Bindings;
  return {env,head,get};
}
describe("Native File staging read/verification",()=>{
  it("validates the same fetched R2 object that will be promoted, with one GET and zero HEADs",async()=>{
    const obj={size:18,httpMetadata:{contentType:"application/pdf"},body:new ReadableStream()};
    const r2=mockR2(obj);
    const result=await readVerifiedUploadedObject(r2.env,row);
    expect(result).toBe(obj);
    expect(r2.get).toHaveBeenCalledExactlyOnceWith(row.object_key);
    expect(r2.head).not.toHaveBeenCalled();
  });
  it("rejects missing/mismatched staging data without returning bytes for promotion",async()=>{
    for(const value of [
      null,
      {size:17,httpMetadata:{contentType:"application/pdf"}},
      {size:18,httpMetadata:{contentType:"image/png"}},
      {size:18,httpMetadata:{}},
    ]){
      const r2=mockR2(value);
      await expect(readVerifiedUploadedObject(r2.env,row)).rejects.toMatchObject({
        status:409,
      });
      expect(r2.get).toHaveBeenCalledTimes(1);
      expect(r2.head).not.toHaveBeenCalled();
    }
  });
});
