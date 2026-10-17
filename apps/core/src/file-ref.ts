import { isRfc3339Instant } from "./time-semantics";

export type FileRef = {
  name: string;
  url: string;
  expiresAt?: string;
};

export const MAX_FILE_REFS = 100;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validUrl(value: string): boolean {
  if (!value || value.length > 8192) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

export function parseFileRef(value: unknown): FileRef | null {
  if (!isObject(value)) return null;
  if (Object.keys(value).some((key) => !["name", "url", "expiresAt"].includes(key))) return null;
  if (typeof value.name !== "string" || !value.name.trim() || value.name.trim().length > 512) return null;
  if (typeof value.url !== "string" || !validUrl(value.url)) return null;
  if (value.expiresAt !== undefined && !isRfc3339Instant(value.expiresAt)) return null;
  return {
    name: value.name.trim(),
    url: value.url,
    ...(typeof value.expiresAt === "string" ? { expiresAt: value.expiresAt } : {}),
  };
}

export function parseFileRefList(value: unknown): FileRef[] | null {
  if (!Array.isArray(value) || value.length > MAX_FILE_REFS) return null;
  const refs: FileRef[] = [];
  for (const item of value) {
    const ref = parseFileRef(item);
    if (!ref) return null;
    refs.push(ref);
  }
  return refs;
}

export function fileRefListSchema(): Record<string, unknown> {
  return {
    type: "array",
    maxItems: MAX_FILE_REFS,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["name", "url"],
      properties: {
        name: { type: "string", minLength: 1, maxLength: 512 },
        url: { type: "string", format: "uri", maxLength: 8192 },
        expiresAt: { type: "string", format: "date-time" },
      },
    },
    "x-lifespace-type": "file_ref_list",
    "x-lifespace-storage": "references-only",
  };
}
