import type { Context } from "hono";
import type { AuthorityD1Timing, Bindings, Variables } from "./env";

type AppEnv = { Bindings: Bindings; Variables: Variables };

function rounded(milliseconds: number): number {
  return Math.round(milliseconds * 10) / 10;
}

export function startPerformanceTiming(context: Context<AppEnv>): void {
  if (context.env.PERFORMANCE_DIAGNOSTICS === "0") return;
  if (
    context.env.PERFORMANCE_DIAGNOSTICS !== "1"
    && context.env.ENVIRONMENT !== "staging"
    && context.env.ENVIRONMENT !== "production"
  ) return;
  context.set("performanceTiming", {
    startedAt: performance.now(),
    phases: {},
  });
}

export async function measurePerformancePhase<T>(
  context: Context<AppEnv>,
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const timing = context.get("performanceTiming");
  if (!timing) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    timing.phases[name] = rounded((timing.phases[name] ?? 0) + performance.now() - startedAt);
  }
}

// This observer is never a credential or authorization input. Only existing
// request diagnostics opt in, with a fixed cap and no extra D1 calls.
export function authorityD1Observer(context: Context<AppEnv>): ((sample: AuthorityD1Timing) => void) | undefined {
  const timing = context.get("performanceTiming");
  if (!timing) return undefined;
  return sample => {
    const list = timing.authorityD1 ??= [];
    if (list.length < 8) list.push(sample);
  };
}

export function logPerformanceTiming(context: Context<AppEnv>): void {
  const timing = context.get("performanceTiming");
  if (!timing) return;
  console.log(JSON.stringify({
    message: "LifeSpace performance timing",
    service: "core",
    requestId: context.get("requestId"),
    method: context.req.method,
    path: context.req.path,
    status: context.res.status,
    totalMs: rounded(performance.now() - timing.startedAt),
    cfPlacement: context.req.header("cf-placement") ?? undefined,
    phases: timing.phases,
    ...(timing.authorityD1?.length ? { authorityD1: timing.authorityD1 } : {}),
  }));
}
