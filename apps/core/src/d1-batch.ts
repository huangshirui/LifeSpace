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
): Promise<T[]> {
  if (!statements.length) return [];
  const results = statements.length === 1
    ? [await statements[0].all<T>()]
    : await database.batch<T>([...statements]);
  return results.flatMap((result) => result.results ?? []);
}
