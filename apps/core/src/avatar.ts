import type { Bindings } from "./env";
import { ApiError } from "./http";

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

type AvatarFile = {
  type: string;
  size: number;
  stream(): ReadableStream<Uint8Array>;
};

function isAvatarFile(value: unknown): value is File {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AvatarFile>;
  return typeof candidate.type === "string"
    && typeof candidate.size === "number"
    && typeof candidate.stream === "function";
}

export async function parseAvatarFile(request: Request): Promise<{ file: File; version: number }> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new ApiError("INVALID_AVATAR", "Request must be multipart/form-data", 400);
  }
  const value = form.get("file");
  if (!isAvatarFile(value)) throw new ApiError("INVALID_AVATAR", "Avatar file is required", 400);
  if (!CONTENT_TYPES[value.type]) throw new ApiError("UNSUPPORTED_AVATAR_TYPE", "Avatar must be JPEG, PNG, or WebP", 415);
  if (value.size <= 0 || value.size > MAX_AVATAR_BYTES) {
    throw new ApiError("AVATAR_TOO_LARGE", "Avatar must be no larger than 5 MB", 413);
  }
  const rawVersion = form.get("version");
  const parsed = typeof rawVersion === "string" ? Number(rawVersion) : NaN;
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new ApiError("VALIDATION_ERROR", "version must be a positive integer", 422);
  }
  return { file: value, version: parsed };
}

export function spaceAvatarObjectKey(spaceId: string, contentType: string): string {
  const extension = CONTENT_TYPES[contentType];
  if (!extension) throw new ApiError("UNSUPPORTED_AVATAR_TYPE", "Avatar must be JPEG, PNG, or WebP", 415);
  return `avatars/spaces/${spaceId}/${crypto.randomUUID()}.${extension}`;
}

export async function storeSpaceAvatar(env: Bindings, spaceId: string, file: File): Promise<string> {
  const key = spaceAvatarObjectKey(spaceId, file.type);
  await env.ASSETS.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { ownerType: "space", ownerId: spaceId },
  });
  return key;
}

export async function bestEffortDeleteSpaceAvatar(env: Bindings, spaceId: string, key: string | null | undefined): Promise<void> {
  if (!key || !key.startsWith(`avatars/spaces/${spaceId}/`)) return;
  try {
    await env.ASSETS.delete(key);
  } catch (error) {
    console.error("Space avatar cleanup failed", { spaceId, key, error });
  }
}
