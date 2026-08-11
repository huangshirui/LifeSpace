import type { Hono } from "hono";
import { requireScope } from "./auth";
import { requireSpacePermission } from "./authorization";
import { bestEffortDeleteSpaceAvatar, parseAvatarFile, storeSpaceAvatar } from "./avatar";
import type { Bindings, Variables } from "./env";
import { ApiError, failure, success } from "./http";

type AppEnv = { Bindings: Bindings; Variables: Variables };
type App = Hono<AppEnv>;

type SpaceAvatarRow = {
  id: string;
  avatar_key: string | null;
  version: number;
};

function publicAvatarUrl(requestUrl: string, spaceId: string): string {
  return new URL(`/assets/spaces/${encodeURIComponent(spaceId)}/avatar`, requestUrl).toString();
}

export function registerSpaceAvatarRoutes(app: App): void {
  app.get("/assets/spaces/:spaceId/avatar", async (c) => {
    const spaceId = c.req.param("spaceId");
    const row = await c.env.DB.prepare("SELECT avatar_key avatarKey FROM spaces WHERE id=? AND deleted_at IS NULL")
      .bind(spaceId).first<{ avatarKey: string | null }>();
    if (!row?.avatarKey || !row.avatarKey.startsWith(`avatars/spaces/${spaceId}/`)) {
      return c.json(failure("AVATAR_NOT_FOUND", "Avatar not found", c.get("requestId")), 404);
    }
    const object = await c.env.ASSETS.get(row.avatarKey);
    if (!object) return c.json(failure("AVATAR_NOT_FOUND", "Avatar not found", c.get("requestId")), 404);
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set("cache-control", "public, max-age=300, must-revalidate");
    headers.set("x-content-type-options", "nosniff");
    return new Response(object.body, { headers });
  });

  app.put("/api/v1/spaces/:spaceId/avatar", requireScope("spaces:manage"), async (c) => {
    const spaceId = c.req.param("spaceId");
    await requireSpacePermission(c.env, c.get("principal"), spaceId, "manage");
    const previous = await c.env.DB.prepare("SELECT id,avatar_key,version FROM spaces WHERE id=? AND deleted_at IS NULL")
      .bind(spaceId).first<SpaceAvatarRow>();
    if (!previous) throw new ApiError("SPACE_NOT_FOUND", "Space not found", 404);

    const { file, version } = await parseAvatarFile(c.req.raw);
    if (version !== previous.version) throw new ApiError("SPACE_VERSION_CONFLICT", "Space version conflict", 409);

    const newKey = await storeSpaceAvatar(c.env, spaceId, file);
    try {
      const updatedAt = new Date().toISOString();
      const result = await c.env.DB.prepare(`UPDATE spaces SET avatar_key=?,updated_at=?,version=version+1
        WHERE id=? AND deleted_at IS NULL AND version=?`)
        .bind(newKey, updatedAt, spaceId, version).run();
      if (!result.meta.changes) throw new ApiError("SPACE_VERSION_CONFLICT", "Space version conflict", 409);
    } catch (error) {
      await bestEffortDeleteSpaceAvatar(c.env, spaceId, newKey);
      throw error;
    }

    await bestEffortDeleteSpaceAvatar(c.env, spaceId, previous.avatar_key);
    return c.json(success({ avatarUrl: publicAvatarUrl(c.req.url, spaceId), version: version + 1 }));
  });
}
