import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { db, num, t, type DbOrTx } from '../../db';
import { isoDate, type Router } from '../../core/http';
import type { Ctx } from '../../core/context';
import { redactFinance } from '../../core/finance-visibility';
import { delayedOrders, expiringStock, financialKpis, inventoryKpis, lowStock, movementTrend, operationsKpis, resolveRange, salesTrend, topDebtors, topProductsByValue, warehouseKpis } from '../analytics/metrics';

export interface AttentionItem {
  key: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  /** Primary next action: "What should I do next?" */
  action: { label: string; href: string };
  secondary?: { label: string; href: string };
}

/** Rule-based "what needs your attention today" — every KPI leads to an action. */
export async function attentionItems(dbx: DbOrTx, ctx: Ctx): Promise<AttentionItem[]> {
  const [inv, wh, ops] = await Promise.all([inventoryKpis(dbx, ctx.tenantId), warehouseKpis(dbx, ctx.tenantId), operationsKpis(dbx, ctx.tenantId, new Date().toISOString().slice(0, 10), new Date().toISOString().slice(0, 10))]);
  const items: AttentionItem[] = [];
  for (const w of wh.warehouses.filter((x) => x.utilizationPct >= 85).sort((a, b) => b.utilizationPct - a.utilizationPct)) {
    items.push({ key: `cap-${w.id}`, severity: w.utilizationPct >= 95 ? 'critical' : 'warning', title: `${w.name} is ${w.utilizationPct}% full`, detail: `${w.emptyLocations} empty locations remain.`, action: { label: 'View space plan', href: `/warehouses/${w.id}` }, secondary: { label: 'Space recommendations', href: '/ai?tab=space' } });
  }
  if (inv.outOfStockSkus > 0) items.push({ key: 'out', severity: 'critical', title: `${inv.outOfStockSkus} ${inv.outOfStockSkus === 1 ? 'SKU is' : 'SKUs are'} out of stock`, detail: 'Customers cannot be served for these items.', action: { label: 'View products', href: '/products?stock=out' }, secondary: { label: 'Smart reorder', href: '/ai?tab=reorder' } });
  if (inv.lowStockSkus > 0) items.push({ key: 'low', severity: 'warning', title: `${inv.lowStockSkus} ${inv.lowStockSkus === 1 ? 'SKU is' : 'SKUs are'} below reorder level`, detail: 'Reorder before they run out.', action: { label: 'Create purchase orders', href: '/ai?tab=reorder' }, secondary: { label: 'View products', href: '/products?stock=low' } });
  if (ops.delayedOrders > 0) items.push({ key: 'delayed', severity: 'warning', title: `${ops.delayedOrders} ${ops.delayedOrders === 1 ? 'order is' : 'orders are'} delayed`, detail: 'Past their required date or waiting more than 3 days.', action: { label: 'View delayed orders', href: '/orders?delayed=1' }, secondary: { label: 'Assign pick tasks', href: '/picking' } });
  if (inv.expiringBatches > 0) items.push({ key: 'expiry', severity: 'warning', title: `${inv.expiringBatches} ${inv.expiringBatches === 1 ? 'batch expires' : 'batches expire'} within ${inv.expiryAlertDays} days`, detail: 'Sell or move them first (FEFO).', action: { label: 'View expiring stock', href: '/reports/expiry' } });
  if (ops.pendingApprovals > 0 && ctx.permissions.has('approval.decide')) items.push({ key: 'approvals', severity: 'warning', title: `${ops.pendingApprovals} ${ops.pendingApprovals === 1 ? 'approval is' : 'approvals are'} waiting`, detail: 'Adjustments, purchase orders, counts or expenses need a decision.', action: { label: 'Review approvals', href: '/approvals' } });
  if (ops.pendingPutaway > 0) items.push({ key: 'putaway', severity: 'info', title: `${ops.pendingPutaway} putaway ${ops.pendingPutaway === 1 ? 'task' : 'tasks'} pending`, detail: 'Received stock is still at the dock and cannot be sold yet.', action: { label: 'Open putaway', href: '/putaway' } });
  if (ops.pendingDispatch > 0) items.push({ key: 'dispatch', severity: 'info', title: `${ops.pendingDispatch} packed ${ops.pendingDispatch === 1 ? 'order' : 'orders'} ready to dispatch`, detail: 'Book a vehicle or courier.', action: { label: 'Open dispatch', href: '/dispatch' } });
  if (ctx.permissions.has('finance.view')) {
    const debtors = (await topDebtors(dbx, ctx.tenantId, 0, 3)).filter((d) => num(d.overdue) > 0);
    for (const d of debtors) items.push({ key: `debt-${d.id}`, severity: num(d.maxDaysOverdue) > 60 ? 'critical' : 'warning', title: `${d.name} has ${Math.round(num(d.overdue)).toLocaleString()} overdue`, detail: `Oldest invoice ${num(d.maxDaysOverdue)} days past due.`, action: { label: 'View customer', href: `/customers/${d.id}` }, secondary: { label: 'Record payment', href: '/billing?tab=invoices' } });
    if (inv.deadStockValue > 0) items.push({ key: 'dead', severity: 'info', title: `${Math.round(inv.deadStockValue).toLocaleString()} tied up in dead stock`, detail: `${inv.deadStockSkus} SKUs have not moved in ${inv.deadStockDays} days.`, action: { label: 'View dead stock', href: '/reports/dead_stock' } });
  }
  const rank = { critical: 0, warning: 1, info: 2 };
  return items.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

export function registerDashboardRoutes(r: Router) {
  r.get('/', {
    summary: 'Business Command Center: inventory, warehouse, operations and financial KPIs with alerts and next actions',
    permission: 'dashboard.view',
    query: z.object({ range: z.enum(['today', 'yesterday', '7d', '30d', 'month', 'year', 'custom']).default('today'), from: isoDate().optional(), to: isoDate().optional(), warehouseId: z.string().uuid().optional() }),
  }, async ({ ctx, query }) => {
    const range = resolveRange(query.range, query.from, query.to);
    const finance = ctx.permissions.has('finance.view');
    const [inventory, warehouse, operations, financial, trend, sales, topValue, low, expiring, delayed, attention, alerts, briefing] = await Promise.all([
      inventoryKpis(db(), ctx.tenantId, query.warehouseId),
      warehouseKpis(db(), ctx.tenantId),
      operationsKpis(db(), ctx.tenantId, range.from, range.to, query.warehouseId),
      finance ? financialKpis(db(), ctx.tenantId, range.from, range.to) : Promise.resolve(null),
      movementTrend(db(), ctx.tenantId, range.from, range.to, query.warehouseId),
      finance ? salesTrend(db(), ctx.tenantId, 6) : Promise.resolve([]),
      topProductsByValue(db(), ctx.tenantId, 8),
      lowStock(db(), ctx.tenantId, 6),
      expiringStock(db(), ctx.tenantId, 30, 6),
      delayedOrders(db(), ctx.tenantId, 6),
      attentionItems(db(), ctx),
      db().select().from(t.notifications).where(and(eq(t.notifications.tenantId, ctx.tenantId))).orderBy(desc(t.notifications.createdAt)).limit(40),
      db().select().from(t.aiBriefings).where(eq(t.aiBriefings.tenantId, ctx.tenantId)).orderBy(desc(t.aiBriefings.briefingDate)).limit(1),
    ]);
    const visibleAlerts = alerts.filter((a) => !a.resolvedAt && ctx.permissions.has(a.permission)).slice(0, 8);
    return redactFinance(ctx, {
      range, generatedAt: new Date().toISOString(), inventory, warehouse, operations, financial, trend, salesTrend: sales,
      topProducts: topValue, lowStock: low, expiring, delayed, attention, alerts: visibleAlerts, briefing: briefing[0] ?? null,
      alertCounts: { critical: visibleAlerts.filter((a) => a.severity === 'critical').length, warning: visibleAlerts.filter((a) => a.severity === 'warning').length },
    });
  });
}
