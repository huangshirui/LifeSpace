import { describe, expect, it } from "vitest";
import { decodeStoredRecordIcon, parseRecordIcon, validateRecordIconImage, ICON_MAX_BYTES } from "../src/record-icon";

function png(width: number, height: number): Uint8Array {
  const data = new Uint8Array(57);
  data.set([137,80,78,71,13,10,26,10], 0);
  data[8] = 0; data[9] = 0; data[10] = 0; data[11] = 13;
  data.set([73,72,68,82],12);
  const put = (pos: number, value: number) => {
    data[pos] = (value >>> 24) & 255;
    data[pos + 1] = (value >>> 16) & 255;
    data[pos + 2] = (value >>> 8) & 255;
    data[pos + 3] = value & 255;
  };
  put(16, width); put(20, height);
  data[33] = 0; data[34] = 0; data[35] = 0; data[36] = 0;
  data.set([73,69,78,68],37);
  return data;
}

describe("shared Record Icon", () => {
  it("accepts Emoji, flags and managed image identities", () => {
    expect(parseRecordIcon({ type: "emoji", value: "🏳️‍🌈" })).toEqual({ type: "emoji", value: "🏳️‍🌈" });
    expect(parseRecordIcon({ type: "emoji", value: "🇨🇳" })).toEqual({ type: "emoji", value: "🇨🇳" });
    expect(parseRecordIcon({ type: "image", fileId: `fil_${"a".repeat(32)}` })).toEqual({ type: "image", fileId: `fil_${"a".repeat(32)}` });
    expect(parseRecordIcon(null)).toBeNull();
    expect(decodeStoredRecordIcon(JSON.stringify({ type: "emoji", value: "🎂" }))).toEqual({ type: "emoji", value: "🎂" });
  });
  it("rejects arbitrary URLs, text and undeclared keys", () => {
    for (const value of [
      "🎂", { type: "url", value: "https://example.org/logo.png" },
      { type: "emoji", value: "hello" }, { type: "emoji", value: "🎂", url: "https://example.com" },
      { type: "image", fileId: "other.png" }, { type: "image", fileId: `fil_${"A".repeat(32)}` },
    ]) {
      expect(() => parseRecordIcon(value)).toThrow();
    }
  });
  it("enforces image pixel size and actual MIME bytes", () => {
    expect(() => validateRecordIconImage(png(512, 512), "image/png")).not.toThrow();
    expect(() => validateRecordIconImage(png(513, 512), "image/png")).toThrow();
    expect(() => validateRecordIconImage(png(32, 32), "image/svg+xml")).toThrow();
    expect(() => validateRecordIconImage(new Uint8Array(ICON_MAX_BYTES + 1), "image/png")).toThrow();
    expect(() => validateRecordIconImage(new Uint8Array([1,2,3]), "image/png")).toThrow();
  });
  it("rejects animated PNGs", () => {
    const animated = png(64,64);
    animated[37] = 97; animated[38] = 99; animated[39] = 84; animated[40] = 76; // acTL
    expect(() => validateRecordIconImage(animated, "image/png")).toThrow();
  });
});
