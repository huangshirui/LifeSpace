import type { Bindings } from "./env";
import { ApiError } from "./http";
import { chunkD1Values } from "./d1-batch";

export type RecordIcon = { type: "emoji"; value: string } | { type: "image"; fileId: string };
export type RecordPresentation = { icon: RecordIcon | null };
export const RECORD_ICON_FIELD = "__record_icon";
export const ICON_MAX_BYTES = 256 * 1024;
const FILE_ID = /^fil_[0-9a-f]{32}$/u;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export function parseRecordIcon(value: unknown): RecordIcon | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError("INVALID_RECORD_ICON", "Record icon must be an emoji, an image or null", 422);
  }
  const icon = value as Record<string, unknown>;
  if (icon.type === "emoji" && Object.keys(icon).sort().join(",") === "type,value") {
    const raw = icon.value;
    if (typeof raw !== "string" || !raw || raw.trim() !== raw
      || [...raw].length > 16
      || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u.test(raw)
      || /[\u0000-\u001F\u007F]/u.test(raw)) {
      throw new ApiError("INVALID_RECORD_ICON", "Icon must be a short Emoji sequence", 422);
    }
    return { type: "emoji", value: raw };
  }
  if (icon.type === "image" && Object.keys(icon).sort().join(",") === "fileId,type"
      && typeof icon.fileId === "string" && FILE_ID.test(icon.fileId)) {
    return { type: "image", fileId: icon.fileId };
  }
  throw new ApiError("INVALID_RECORD_ICON", "Only Emoji and LifeSpace image Files are supported", 422);
}

export function decodeStoredRecordIcon(raw: string | null): RecordIcon | null {
  if (raw === null) return null;
  try { return parseRecordIcon(JSON.parse(raw)); }
  catch { throw new ApiError("RESOURCE_STORAGE_CORRUPT", "Record icon metadata is invalid", 500); }
}

export async function loadRecordIcons(
  env: Bindings, spaceId: string, ids: readonly string[],
): Promise<Map<string, RecordIcon | null>> {
  const values = new Map<string, RecordIcon | null>();
  if (!ids.length) return values;
  // Exactly one batched metadata lookup per bounded result page. No per-row D1 I/O.
  for (const chunk of chunkD1Values([...new Set(ids)], 1)) {
    const rows = await env.DB.prepare(`SELECT id,icon_json FROM resource_records
      WHERE space_id=? AND id IN (${chunk.map(() => "?").join(",")})`)
      .bind(spaceId, ...chunk).all<{ id: string; icon_json: string | null }>();
    for (const row of rows.results) values.set(row.id, decodeStoredRecordIcon(row.icon_json));
  }
  return values;
}

/**
 * File upload cap applies to the actual object, not just declared size.
 * Only static PNG/JPEG/WebP; reject SVG, GIF, animated WebP and huge dimensions.
 */
export function validateRecordIconImage(bytes: Uint8Array, contentType: string): void {
  if (!IMAGE_TYPES.has(contentType)) throw new ApiError("INVALID_ICON_IMAGE", "Unsupported Icon image format", 415);
  if (!bytes.length || bytes.length > ICON_MAX_BYTES) throw new ApiError("FILE_TOO_LARGE", "Icon image exceeds 256 KiB", 413);
  const u16 = (offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
  const u24 = (offset: number) => (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
  const u32 = (offset: number) => (((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]);
  const ascii = (offset: number, len: number) => String.fromCharCode(...bytes.slice(offset, offset + len));
  let width = 0;
  let height = 0;
  if (contentType === "image/png" && bytes.length >= 33
    && [137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => bytes[i] === x)
    && ascii(12, 4) === "IHDR") {
    width = u32(16); height = u32(20);
    if (ascii(29, 4) === "acTL") throw new ApiError("INVALID_ICON_IMAGE", "Animated icons are not supported", 415);
    // Refuse APNG chunks anywhere in this small, bounded file.
    if (ascii(8, 4) === "acTL") throw new ApiError("INVALID_ICON_IMAGE", "Animated icons are not supported", 415);
    for (let i = 33; i + 8 <= bytes.length;) {
      const size = u32(i), tag = ascii(i + 4, 4);
      if (tag === "acTL" || tag === "fcTL" || tag === "fdAT") throw new ApiError("INVALID_ICON_IMAGE", "Animated icons are not supported", 415);
      if (tag === "IEND") break;
      if (size > bytes.length - i - 12) throw new ApiError("INVALID_ICON_IMAGE", "Corrupt PNG image", 415);
      i += size + 12;
    }
  } else if (contentType === "image/jpeg" && bytes.length > 6 && bytes[0] === 255 && bytes[1] === 216) {
    for (let i = 2; i < bytes.length - 4;) {
      if (bytes[i] !== 255) break;
      const marker = bytes[i + 1];
      if (marker === 217 || marker === 218) break;
      if (marker === 255 || marker === 0) { i++; continue; }
      const size = u16(i + 2);
      if (size < 2 || i + 2 + size > bytes.length) break;
      if ([192, 193, 194, 195, 198, 199, 201, 202].includes(marker) && size >= 7) {
        height = u16(i + 5); width = u16(i + 7); break;
      }
      i += 2 + size;
    }
  } else if (contentType === "image/webp" && bytes.length >= 30
    && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const mode = ascii(12, 4);
    if (mode === "VP8X") {
      if (bytes[20] & 2) throw new ApiError("INVALID_ICON_IMAGE", "Animated icons are not supported", 415);
      width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16));
      height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16));
    } else if (mode === "VP8 " && bytes.length >= 30 && bytes[23] === 157 && bytes[24] === 1 && bytes[25] === 42) {
      width = u16(26) & 0x3fff; height = u16(28) & 0x3fff;
    } else if (mode === "VP8L" && bytes.length >= 25 && bytes[20] === 47) {
      width = 1 + (((bytes[22] & 63) << 8) | bytes[21]);
      height = 1 + (((bytes[24] & 15) << 10) | (bytes[23] << 2) | (bytes[22] >> 6));
    }
    if (ascii(12, 4) === "ANIM") throw new ApiError("INVALID_ICON_IMAGE", "Animated icons are not supported", 415);
  }
  if (!width || !height || width > 512 || height > 512) {
    throw new ApiError("INVALID_ICON_IMAGE", "Icon must be a static image within 512 × 512 pixels", 415);
  }
}
