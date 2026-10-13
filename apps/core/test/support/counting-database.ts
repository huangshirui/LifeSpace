export type DatabaseCost = { roundTrips: number; rowsRead: number; sql: string[] };

/** Counts transport calls, not the number of SQL statements inside D1.batch. */
export function countingDatabase(database: D1Database, cost: DatabaseCost,
  beforeBatch?: (sql: readonly string[]) => Promise<void>): D1Database {
  const raw = new WeakMap<object, D1PreparedStatement>();
  const sqlByStatement = new WeakMap<object, string>();
  const record = (result: unknown) => {
    const values = Array.isArray(result) ? result : [result];
    for (const value of values) cost.rowsRead += Number((value as D1Result | undefined)?.meta?.rows_read ?? 0);
    return result;
  };
  const statement = (target: D1PreparedStatement, sql: string): D1PreparedStatement => {
    const wrapped = new Proxy(target, { get(_target, key) {
      if (key === "bind") return (...args: unknown[]) => statement(target.bind(...args), sql);
      if (["all", "first", "run", "raw"].includes(String(key))) return async (...args: unknown[]) => {
        cost.roundTrips += 1;
        const method = Reflect.get(target, key, target) as (...args: unknown[]) => Promise<unknown>;
        return record(await method.apply(target, args));
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    raw.set(wrapped, target); sqlByStatement.set(wrapped, sql);
    return wrapped;
  };
  return new Proxy(database, { get(_target, key) {
    if (key === "prepare") return (sql: string) => { cost.sql.push(sql); return statement(database.prepare(sql), sql); };
    if (key === "batch") return async (statements: D1PreparedStatement[]) => {
      await beforeBatch?.(statements.map(statement => sqlByStatement.get(statement) ?? ""));
      cost.roundTrips += 1;
      return record(await database.batch(statements.map(statement => raw.get(statement) ?? statement)));
    };
    const value = Reflect.get(database, key, database);
    return typeof value === "function" ? value.bind(database) : value;
  } }) as D1Database;
}
