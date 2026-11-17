import type { AuthorityD1Timing } from "./env";

type D1ReadResult = D1Result<unknown> | D1Result<unknown>[];

// Observe the actual existing binding call, never execute a diagnostic query.
// SQL time is not Worker-to-D1 wall time. Missing metadata stays unknown.
export function measureD1Results<T extends D1ReadResult>(
  statementCount: number,
  operation: () => Promise<T>,
  observe?: (sample: AuthorityD1Timing) => void,
): Promise<T> {
  if (!observe) return operation();
  return (async () => {
    const start = performance.now();
    let results: D1Result<unknown>[] | null = null;
    try {
      const result = await operation();
      results = Array.isArray(result) ? result : [result];
      return result;
    } finally {
      const wallMs = Math.round((performance.now() - start) * 10) / 10;
      const metadata = (results ?? []).map(result => result.meta as unknown as {
        duration?: number; timings?: { sql_duration_ms?: number }; rows_read?: number;
        served_by_region?: string; served_by_colo?: string;
      } | undefined);
      const sum = (values: (number | undefined)[]) =>
        values.length === statementCount && values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)
          ? Math.round(values.reduce<number>((total, value) => total + (value ?? 0), 0) * 10) / 10
          : null;
      const labels = (values: (string | undefined)[]) => [...new Set(values.filter(
        (value): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,40}$/u.test(value),
      ))].slice(0, 8);
      observe({
        wallMs, statements: statementCount, success: results !== null && results.length === statementCount && results.every(result => result.success),
        sqlDurationMs: sum(metadata.map(value => value?.timings?.sql_duration_ms)),
        reportedDurationMs: sum(metadata.map(value => value?.duration)),
        rowsRead: sum(metadata.map(value => value?.rows_read)),
        regions: labels(metadata.map(value => value?.served_by_region)),
        colos: labels(metadata.map(value => value?.served_by_colo)),
      });
    }
  })();
}

export const D1_MAX_BOUND_PARAMETERS = 100;

export function chunkD1Values<T>(values: readonly T[], fixedBindings = 0): T[][] {
  const chunkSize = D1_MAX_BOUND_PARAMETERS - fixedBindings;
  if (!Number.isInteger(fixedBindings) || fixedBindings < 0 || chunkSize < 1) {
    throw new Error(`Invalid D1 fixed binding budget: ${fixedBindings}`);
  }
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

/**
 * Execute one or more bounded SELECT statements without turning chunking into
 * multiple Worker->D1 network round trips. A single statement uses all();
 * multiple statements are sent together with D1 batch().
 */
export async function allD1Batched<T>(
  database: D1Database,
  statements: readonly D1PreparedStatement[],
  observe?: (sample: AuthorityD1Timing) => void,
): Promise<T[]> {
  if (!statements.length) return [];
  const results = statements.length === 1
    ? [await measureD1Results(1, () => statements[0].all<T>(), observe)]
    : await measureD1Results(statements.length, () => database.batch<T>([...statements]), observe);
  return results.flatMap((result) => result.results ?? []);
}
