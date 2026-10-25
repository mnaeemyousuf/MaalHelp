import type { Ctx } from './context';

/** Fields considered sensitive financial information (cost, value, margin). */
const FINANCIAL_FIELDS = new Set([
  'costPrice', 'cost_price', 'unitCost', 'unit_cost', 'value', 'stockValue', 'inventoryValue', 'margin', 'marginPct',
  'costTotal', 'cost_total', 'grossMargin', 'deadStockValue', 'varianceValue',
]);

/**
 * Removes cost and valuation fields for users without `finance.view`
 * (e.g. warehouse managers, per the RBAC brief).
 */
export function redactFinance<T>(ctx: Ctx, value: T): T {
  if (ctx.permissions.has('finance.view')) return value;
  return strip(value) as T;
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== 'object' || value instanceof Date) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!FINANCIAL_FIELDS.has(k)) out[k] = strip(v);
  }
  return out;
}
