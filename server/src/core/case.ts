const NUMERIC_KEY = /(qty|quantity|total|amount|limit|days|price|cost|value|balance|rate|payable|receivable|purchased|sold|units|count|pct)/i;

/** Converts snake_case row keys to camelCase and numeric-string money/qty columns to numbers. */
export function camel<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
      typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v) && NUMERIC_KEY.test(k) ? Number(v) : v,
    ]),
  ) as T;
}
