import { sql } from 'drizzle-orm';
import { one, num, type DbOrTx } from '../../db';
import type { PlanLimits } from '../../db/schema';
import { limitReached } from '../../core/errors';

const COUNTERS: Record<keyof PlanLimits, (tenantId: string) => ReturnType<typeof sql>> = {
  users: (id) => sql`SELECT COUNT(*) AS n FROM memberships WHERE tenant_id = ${id} AND status = 'active'`,
  warehouses: (id) => sql`SELECT COUNT(*) AS n FROM warehouses WHERE tenant_id = ${id}`,
  skus: (id) => sql`SELECT COUNT(*) AS n FROM products WHERE tenant_id = ${id}`,
  monthlyTransactions: (id) => sql`SELECT COUNT(*) AS n FROM inventory_transactions WHERE tenant_id = ${id} AND created_at >= date_trunc('month', now())`,
  monthlyAiRequests: (id) => sql`SELECT COUNT(*) AS n FROM ai_usage WHERE tenant_id = ${id} AND created_at >= date_trunc('month', now())`,
  storageMb: (id) => sql`SELECT COALESCE(SUM(size_bytes), 0) / 1048576.0 AS n FROM documents WHERE tenant_id = ${id}`,
  integrations: (id) => sql`SELECT COUNT(*) AS n FROM integrations WHERE tenant_id = ${id} AND status = 'connected'`,
};

const LABELS: Record<keyof PlanLimits, string> = {
  users: 'users', warehouses: 'warehouses', skus: 'products', monthlyTransactions: 'monthly inventory transactions',
  monthlyAiRequests: 'monthly AI requests', storageMb: 'MB of document storage', integrations: 'integrations',
};

export async function planLimits(dbx: DbOrTx, tenantId: string): Promise<PlanLimits | null> {
  const row = await one<{ limits: PlanLimits }>(dbx, sql`SELECT p.limits FROM tenants t JOIN plans p ON p.id = t.plan_id WHERE t.id = ${tenantId}`);
  return row?.limits ?? null;
}

export async function usage(dbx: DbOrTx, tenantId: string, key: keyof PlanLimits): Promise<number> {
  return num((await one<{ n: string }>(dbx, COUNTERS[key](tenantId)))?.n);
}

/** Throws PLAN_LIMIT_REACHED when adding `adding` more would exceed the plan. -1 = unlimited. */
export async function assertWithinLimit(dbx: DbOrTx, tenantId: string, key: keyof PlanLimits, adding = 1): Promise<void> {
  const limits = await planLimits(dbx, tenantId);
  const limit = limits?.[key];
  if (limit === undefined || limit < 0) return;
  const current = await usage(dbx, tenantId, key);
  if (current + adding > limit) {
    throw limitReached(`Your plan allows up to ${limit.toLocaleString()} ${LABELS[key]}. Upgrade your plan to add more.`);
  }
}

export async function usageSummary(dbx: DbOrTx, tenantId: string) {
  const limits = await planLimits(dbx, tenantId);
  const keys = Object.keys(COUNTERS) as (keyof PlanLimits)[];
  const values = await Promise.all(keys.map((k) => usage(dbx, tenantId, k)));
  return keys.map((k, i) => ({ key: k, label: LABELS[k], used: Math.round(values[i]! * 10) / 10, limit: limits?.[k] ?? -1 }));
}
