import type { Bindings } from "./env";

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

export class AvatarError extends Error {
  constructor(
    public code: "INVALID_AVATAR" | "UNSUPPORTED_AVATAR_TYPE" | "AVATAR_TOO_LARGE",
    message: string,
    public status: 400 | 413 | 415,
  ) {
    super(message);
  }
}

function isAvatarFile(value: unknown): value is File {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AvatarFile>;
  return typeof candidate.type === "string"
    && typeof candidate.size === "number"
    && typeof candidate.stream === "function";
}

export async function parseAvatarFile(request: Request): Promise<File> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    throw new AvatarError("INVALID_AVATAR", "Request must be multipart/form-data", 400);
  }
  const value = form.get("file");
  if (!isAvatarFile(value)) throw new AvatarError("INVALID_AVATAR", "Avatar file is required", 400);
  if (!CONTENT_TYPES[value.type]) {
    throw new AvatarError("UNSUPPORTED_AVATAR_TYPE", "Avatar must be JPEG, PNG, or WebP", 415);
  }
  if (value.size <= 0 || value.size > MAX_AVATAR_BYTES) {
    throw new AvatarError("AVATAR_TOO_LARGE", "Avatar must be no larger than 5 MB", 413);
  }
  return value;
}

export function userAvatarObjectKey(userId: string, contentType: string): string {
  const extension = CONTENT_TYPES[contentType];
  if (!extension) throw new AvatarError("UNSUPPORTED_AVATAR_TYPE", "Avatar must be JPEG, PNG, or WebP", 415);
  return `avatars/users/${userId}/${crypto.randomUUID()}.${extension}`;
}

export async function storeUserAvatar(env: Bindings, userId: string, file: File): Promise<string> {
  const key = userAvatarObjectKey(userId, file.type);
  await env.ASSETS.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { ownerType: "user", ownerId: userId },
  });
  return key;
}

export async function bestEffortDeleteUserAvatar(env: Bindings, userId: string, key: string | null | undefined): Promise<void> {
  if (!key || !key.startsWith(`avatars/users/${userId}/`)) return;
  try {
    await env.ASSETS.delete(key);
  } catch (error) {
    console.error("User avatar cleanup failed", { userId, key, error });
  }
}
