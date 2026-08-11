import type { Bindings } from "./env";

export async function cleanupExpiredCreationDraftJobs(
  env: Pick<Bindings, "DB">,
  now: Date = new Date(),
): Promise<{ deleted: number; cutoff: string }> {
  const cutoff = now.toISOString();
  const result = await env.DB.prepare("DELETE FROM creation_draft_jobs WHERE expires_at <= ?").bind(cutoff).run();
  return { deleted: result.meta.changes ?? 0, cutoff };
}
