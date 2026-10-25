import { z, type ZodType } from 'zod';
import { sql } from 'drizzle-orm';
import type { Permission } from '@shared/permissions';
import { db, num, rows } from '../db';
import type { Ctx } from '../core/context';
import { redactFinance } from '../core/finance-visibility';
import {
  classifyStock, deadStock, delayedOrders, expiringStock, financialKpis, inventoryKpis, lowStock, operationsKpis, productVelocity,
  reorderRecommendation, resolveRange, supplierBalances, topDebtors, topProductsByValue, warehouseKpis,
} from '../modules/analytics/metrics';
import { detectAnomalies, spaceRecommendations } from '../modules/analytics/insights';
import { profitability } from '../modules/finance/routes';
import type { ToolSpec } from './mistral';

export interface AiTool<A extends ZodType = ZodType> {
  name: string;
  description: string;
  permission: Permission;
  args: A;
  run: (ctx: Ctx, args: z.output<A>) => Promise<unknown>;
}

/** Typed helper so each tool's run() receives its parsed arguments. */
function tool<A extends ZodType>(def: AiTool<A>): AiTool { return def as unknown as AiTool; }

const empty = z.object({});
const rangeArgs = z.object({ range: z.enum(['today', 'yesterday', '7d', '30d', 'month', 'year']).default('30d').describe('Reporting window') });

async function findProduct(ctx: Ctx, query: string) {
  const like = `%${query.toLowerCase()}%`;
  return rows<{ id: string; sku: string; name: string }>(db(), sql`SELECT id, sku, name FROM products WHERE tenant_id = ${ctx.tenantId} AND (lower(sku) = lower(${query}) OR lower(sku) LIKE ${like} OR lower(name) LIKE ${like} OR barcode = ${query}) ORDER BY (lower(sku) = lower(${query})) DESC LIMIT 5`);
}

export const TOOLS: AiTool[] = [
  tool({
    name: 'get_inventory', description: 'Company-wide inventory totals: SKUs, units, value, available/reserved/damaged/expired/quarantine/in-transit, low stock and dead stock counts.', permission: 'inventory.view', args: z.object({ warehouseCode: z.string().optional() }),
    run: async (ctx, a) => {
      const wh = a.warehouseCode ? (await rows<{ id: string }>(db(), sql`SELECT id FROM warehouses WHERE tenant_id = ${ctx.tenantId} AND upper(code) = upper(${a.warehouseCode})`))[0]?.id : undefined;
      return inventoryKpis(db(), ctx.tenantId, wh);
    },
  }),
  tool({
    name: 'get_inventory_by_product', description: 'Stock of one product by warehouse, location, batch and status. Accepts SKU, barcode or part of the name.', permission: 'inventory.view', args: z.object({ product: z.string().min(1) }),
    run: async (ctx, a) => {
      const matches = await findProduct(ctx, a.product);
      if (!matches.length) return { found: false, message: `No product matches "${a.product}".` };
      const p = matches[0]!;
      const stock = await rows(db(), sql`SELECT w.code AS warehouse, l.code AS location, b.status, b.quantity::float AS quantity, bt.batch_no AS batch, bt.expiry_date AS expiry FROM inventory_balances b JOIN warehouses w ON w.id = b.warehouse_id JOIN locations l ON l.id = b.location_id LEFT JOIN batches bt ON bt.id = b.batch_id WHERE b.tenant_id = ${ctx.tenantId} AND b.product_id = ${p.id} AND b.quantity > 0 ORDER BY w.code, l.code`);
      const [v] = await productVelocity(db(), ctx.tenantId, p.id);
      return { product: p, otherMatches: matches.slice(1), stock, insight: v ? classifyStock(v) : null };
    },
  }),
  tool({
    name: 'get_inventory_by_warehouse', description: 'Units and stock value per warehouse, plus capacity utilisation.', permission: 'inventory.view', args: empty,
    run: async (ctx) => {
      const [byWh, kpi] = await Promise.all([
        rows(db(), sql`SELECT w.code, w.name, w.city, COALESCE(SUM(b.quantity), 0)::float AS units, COALESCE(SUM(b.quantity * p.cost_price), 0)::float AS value, COUNT(DISTINCT b.product_id)::int AS skus FROM warehouses w LEFT JOIN inventory_balances b ON b.warehouse_id = w.id AND b.quantity > 0 AND b.owner_customer_id IS NULL LEFT JOIN products p ON p.id = b.product_id WHERE w.tenant_id = ${ctx.tenantId} GROUP BY w.id ORDER BY value DESC`),
        warehouseKpis(db(), ctx.tenantId),
      ]);
      return byWh.map((w) => ({ ...w, utilizationPct: kpi.warehouses.find((k) => k.code === w.code)?.utilizationPct ?? null }));
    },
  }),
  tool({ name: 'get_low_stock', description: 'Products at or below their reorder level, with available and on-order quantities.', permission: 'inventory.view', args: z.object({ limit: z.number().int().min(1).max(100).default(25) }), run: async (ctx, a) => lowStock(db(), ctx.tenantId, a.limit) }),
  tool({ name: 'get_expiring_stock', description: 'Batches expiring within N days (default 30), including already expired.', permission: 'inventory.view', args: z.object({ days: z.number().int().min(1).max(365).default(30) }), run: async (ctx, a) => expiringStock(db(), ctx.tenantId, a.days, 50) }),
  tool({ name: 'get_dead_stock', description: 'Products with stock but no dispatches for N days (default 90).', permission: 'inventory.view', args: z.object({ days: z.number().int().min(15).max(730).default(90) }), run: async (ctx, a) => deadStock(db(), ctx.tenantId, a.days, 50) }),
  tool({ name: 'get_top_products_by_value', description: 'Top N products by stock value at cost.', permission: 'inventory.view', args: z.object({ limit: z.number().int().min(1).max(50).default(10) }), run: async (ctx, a) => topProductsByValue(db(), ctx.tenantId, a.limit) }),
  tool({
    name: 'get_sales_summary', description: 'Sales, gross margin, receivables and top customers for a period.', permission: 'finance.view', args: rangeArgs,
    run: async (ctx, a) => {
      const r = resolveRange(a.range);
      const top = await rows(db(), sql`SELECT c.name, SUM(i.subtotal)::float AS sales FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ${ctx.tenantId} AND i.type IN ('sales', 'credit_note') AND i.status <> 'void' AND i.issue_date BETWEEN ${r.from} AND ${r.to} GROUP BY c.id ORDER BY 2 DESC LIMIT 5`);
      return { period: r, ...(await financialKpis(db(), ctx.tenantId, r.from, r.to)), topCustomers: top };
    },
  }),
  tool({
    name: 'get_purchase_summary', description: 'Purchases and open purchase orders for a period, by supplier.', permission: 'purchase.view', args: rangeArgs,
    run: async (ctx, a) => {
      const r = resolveRange(a.range);
      const [bySupplier, open] = await Promise.all([
        rows(db(), sql`SELECT s.name, COUNT(*)::int AS orders, SUM(po.total)::float AS value FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = ${ctx.tenantId} AND po.status NOT IN ('draft', 'cancelled') AND po.order_date BETWEEN ${r.from} AND ${r.to} GROUP BY s.id ORDER BY value DESC LIMIT 10`),
        rows(db(), sql`SELECT po.number, s.name AS supplier, po.status, po.expected_date, po.total::float AS total, (po.expected_date < CURRENT_DATE) AS overdue FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = ${ctx.tenantId} AND po.status IN ('submitted', 'approved', 'partially_received') ORDER BY po.expected_date LIMIT 20`),
      ]);
      return { period: r, bySupplier, openPurchaseOrders: open };
    },
  }),
  tool({ name: 'get_customer_balance', description: 'Customers who owe money: outstanding and overdue balances, optionally above a minimum amount.', permission: 'finance.view', args: z.object({ minAmount: z.number().min(0).default(0), limit: z.number().int().min(1).max(50).default(10) }), run: async (ctx, a) => topDebtors(db(), ctx.tenantId, a.minAmount, a.limit) }),
  tool({ name: 'get_supplier_balance', description: 'Amounts owed to suppliers (payables), with overdue amounts.', permission: 'finance.view', args: z.object({ limit: z.number().int().min(1).max(50).default(10) }), run: async (ctx, a) => supplierBalances(db(), ctx.tenantId, a.limit) }),
  tool({ name: 'get_warehouse_utilization', description: 'Capacity, used and free space, occupied/empty locations per warehouse.', permission: 'warehouse.view', args: empty, run: async (ctx) => warehouseKpis(db(), ctx.tenantId) }),
  tool({
    name: 'get_order_status', description: 'Status of a sales or purchase order by number, or a summary of open orders and delayed orders.', permission: 'sales.view', args: z.object({ orderNumber: z.string().optional() }),
    run: async (ctx, a) => {
      if (a.orderNumber) {
        const so = await rows(db(), sql`SELECT so.number, so.status, so.priority, so.order_date, so.required_date, so.total::float AS total, c.name AS customer, (SELECT string_agg(s.carrier || ' ' || s.tracking_number || ' (' || s.status || ')', '; ') FROM shipments s WHERE s.sales_order_id = so.id) AS shipments FROM sales_orders so JOIN customers c ON c.id = so.customer_id WHERE so.tenant_id = ${ctx.tenantId} AND upper(so.number) = upper(${a.orderNumber})`);
        if (so.length) return { type: 'sales_order', ...so[0] };
        const po = await rows(db(), sql`SELECT po.number, po.status, po.expected_date, po.total::float AS total, s.name AS supplier FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = ${ctx.tenantId} AND upper(po.number) = upper(${a.orderNumber})`);
        if (po.length) return { type: 'purchase_order', ...po[0] };
        return { found: false, message: `No order numbered ${a.orderNumber}.` };
      }
      const byStatus = await rows(db(), sql`SELECT status, COUNT(*)::int AS orders, SUM(total)::float AS value FROM sales_orders WHERE tenant_id = ${ctx.tenantId} AND status NOT IN ('completed', 'cancelled') GROUP BY status`);
      return { openOrdersByStatus: byStatus, delayed: await delayedOrders(db(), ctx.tenantId, 20) };
    },
  }),
  tool({
    name: 'get_stock_movements', description: 'Inventory movements in a period grouped by transaction type (explains why stock went up or down), plus the largest movements.', permission: 'inventory.view', args: rangeArgs,
    run: async (ctx, a) => {
      const r = resolveRange(a.range);
      const [byType, largest] = await Promise.all([
        rows(db(), sql`SELECT transaction_type AS type, COUNT(*)::int AS transactions, SUM(quantity)::float AS net_units, SUM(quantity * unit_cost)::float AS net_value FROM inventory_transactions WHERE tenant_id = ${ctx.tenantId} AND created_at >= ${r.from}::date AND created_at < ${r.to}::date + 1 AND transaction_type NOT IN ('reservation', 'reservation_release', 'putaway', 'pick') GROUP BY 1 ORDER BY ABS(SUM(quantity * unit_cost)) DESC`),
        rows(db(), sql`SELECT m.created_at, m.transaction_type AS type, m.reference_no, p.sku, m.quantity::float AS quantity, (m.quantity * m.unit_cost)::float AS value FROM inventory_transactions m JOIN products p ON p.id = m.product_id WHERE m.tenant_id = ${ctx.tenantId} AND m.created_at >= ${r.from}::date AND m.created_at < ${r.to}::date + 1 AND m.transaction_type IN ('receipt', 'dispatch', 'adjustment', 'write_off', 'damage', 'stock_count', 'return', 'purchase_return') ORDER BY ABS(m.quantity * m.unit_cost) DESC LIMIT 10`),
      ]);
      const net = byType.reduce((s, x) => s + num(x.net_value), 0);
      return { period: r, netValueChange: Math.round(net), byType, largestMovements: largest, note: 'Transfers, putaway, picking and reservations move stock between locations/statuses and do not change total company stock; status changes are excluded from totals only when paired.' };
    },
  }),
  tool({
    name: 'get_inventory_variances', description: 'Recent stock count variances, pending and posted adjustments, short picks.', permission: 'inventory.view', args: empty,
    run: async (ctx) => {
      const [counts, adjustments, shortPicks] = await Promise.all([
        rows(db(), sql`SELECT number, status, variance_qty::float AS variance_qty, variance_value::float AS variance_value, submitted_at FROM stock_counts WHERE tenant_id = ${ctx.tenantId} AND submitted_at >= now() - interval '30 days' ORDER BY submitted_at DESC LIMIT 10`),
        rows(db(), sql`SELECT a.number, a.status, p.sku, a.quantity_delta::float AS qty, a.value::float AS value, a.reason_code FROM stock_adjustments a JOIN products p ON p.id = a.product_id WHERE a.tenant_id = ${ctx.tenantId} AND a.created_at >= now() - interval '30 days' ORDER BY a.value DESC LIMIT 10`),
        rows(db(), sql`SELECT pt.number, p.sku, l.code AS location, (pt.quantity - pt.picked_qty)::float AS missing, pt.picked_at FROM pick_tasks pt JOIN products p ON p.id = pt.product_id JOIN locations l ON l.id = pt.location_id WHERE pt.tenant_id = ${ctx.tenantId} AND pt.status = 'short' AND pt.picked_at >= now() - interval '30 days' LIMIT 10`),
      ]);
      return { counts, adjustments, shortPicks };
    },
  }),
  tool({ name: 'get_profitability', description: 'Estimated revenue, cost of goods, expenses and net profit for a period, per warehouse.', permission: 'report.financial', args: rangeArgs, run: async (ctx, a) => { const r = resolveRange(a.range); return profitability(db(), ctx.tenantId, r.from, r.to); } }),
  tool({
    name: 'get_operations_summary', description: "Today's (or a period's) receipts, dispatches, pending putaway/picking/packing/dispatch, delayed orders, approvals.", permission: 'dashboard.view', args: z.object({ range: z.enum(['today', 'yesterday', '7d']).default('today') }),
    run: async (ctx, a) => { const r = resolveRange(a.range); return { period: r, ...(await operationsKpis(db(), ctx.tenantId, r.from, r.to)) }; },
  }),
  tool({
    name: 'get_stock_intelligence', description: 'Classifies products as fast, slow, dead, overstock or understock with months of cover and stockout risk.', permission: 'inventory.view', args: z.object({ classification: z.enum(['fast', 'slow', 'dead', 'overstock', 'understock', 'stockout_risk', 'all']).default('all'), limit: z.number().int().min(1).max(100).default(20) }),
    run: async (ctx, a) => {
      const all = (await productVelocity(db(), ctx.tenantId)).map((v) => classifyStock(v));
      const filtered = a.classification === 'all' ? all : a.classification === 'stockout_risk' ? all.filter((x) => x.stockoutRisk) : all.filter((x) => x.classification === a.classification);
      const counts = all.reduce<Record<string, number>>((m, x) => ({ ...m, [x.classification]: (m[x.classification] ?? 0) + 1 }), {});
      return { counts, items: filtered.sort((x, y) => (x.daysOfCover ?? 1e9) - (y.daysOfCover ?? 1e9)).slice(0, a.limit) };
    },
  }),
  tool({
    name: 'get_reorder_recommendations', description: 'Smart reorder: Order now / Increase order / Wait / Reduce order per product, with suggested quantity and reasoning. Recommendations only — never places orders.', permission: 'purchase.view', args: z.object({ limit: z.number().int().min(1).max(100).default(20) }),
    run: async (ctx, a) => {
      const recs = (await productVelocity(db(), ctx.tenantId)).map((v) => reorderRecommendation(v)).filter((r) => r.action !== 'wait');
      return recs.sort((x, y) => (x.action === 'order_now' ? -1 : 1) - (y.action === 'order_now' ? -1 : 1) || y.estimatedCost - x.estimatedCost).slice(0, a.limit);
    },
  }),
  tool({ name: 'get_anomalies', description: 'Unusual activity detected in inventory (for human review; never an accusation).', permission: 'inventory.view', args: empty, run: async (ctx) => detectAnomalies(db(), ctx.tenantId) }),
  tool({ name: 'get_space_recommendations', description: 'Rule-based slotting and space recommendations (move fast movers closer to dispatch, underutilised zones, overloaded bins).', permission: 'warehouse.view', args: empty, run: async (ctx) => (await spaceRecommendations(db(), ctx.tenantId)).slice(0, 15) }),
];

export function toolsFor(ctx: Ctx): AiTool[] {
  return TOOLS.filter((tool) => ctx.permissions.has(tool.permission));
}

export function toolSpecs(tools: AiTool[]): ToolSpec[] {
  return tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: z.toJSONSchema(tool.args, { io: 'input' }) } }));
}

/** Executes a tool after re-checking permission and validating arguments. Output is redacted for non-finance users. */
export async function runTool(ctx: Ctx, name: string, rawArgs: unknown): Promise<{ ok: boolean; data: unknown }> {
  const tool = TOOLS.find((x) => x.name === name);
  if (!tool) return { ok: false, data: { error: `Unknown tool ${name}` } };
  if (!ctx.permissions.has(tool.permission)) return { ok: false, data: { error: 'You do not have permission to view this information.' } };
  const parsed = tool.args.safeParse(rawArgs ?? {});
  if (!parsed.success) return { ok: false, data: { error: 'Invalid arguments', issues: parsed.error.issues.map((i) => i.message) } };
  return { ok: true, data: redactFinance(ctx, await tool.run(ctx, parsed.data)) };
}
