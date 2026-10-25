import { eq, sql } from 'drizzle-orm';
import { db, num, one, rows, t } from '../db';
import { delayedOrders, expiringStock, financialKpis, inventoryKpis, lowStock, operationsKpis, warehouseKpis, topDebtors } from '../modules/analytics/metrics';
import { detectAnomalies } from '../modules/analytics/insights';
import { mistral } from './mistral';

export interface BriefingItem { severity: 'critical' | 'warning' | 'info'; text: string; href: string }

const money = (n: number, c: string) => `${c} ${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : Math.round(n).toLocaleString()}`;

/** Gathers yesterday's facts and today's risks from the database. */
export async function briefingFacts(tenantId: string) {
  const y = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const [tenant] = await db().select({ name: t.tenants.name, currency: t.tenants.baseCurrency }).from(t.tenants).where(eq(t.tenants.id, tenantId));
  const [inv, wh, ops, fin, low, exp, delayed, debtors, anomalies, movementValue, bigMoves, lateSuppliers, pendingAdj] = await Promise.all([
    inventoryKpis(db(), tenantId), warehouseKpis(db(), tenantId), operationsKpis(db(), tenantId, y, y), financialKpis(db(), tenantId, y, y),
    lowStock(db(), tenantId, 10), expiringStock(db(), tenantId, 30, 10), delayedOrders(db(), tenantId, 10), topDebtors(db(), tenantId, 0, 5), detectAnomalies(db(), tenantId),
    one<{ v: string }>(db(), sql`SELECT COALESCE(SUM(ABS(quantity * unit_cost)), 0) AS v FROM inventory_transactions WHERE tenant_id = ${tenantId} AND created_at::date = ${y}::date AND transaction_type IN ('receipt', 'dispatch', 'transfer_in', 'adjustment', 'return', 'write_off')`),
    rows(db(), sql`SELECT m.transaction_type AS type, m.reference_no, p.sku, m.quantity::float AS quantity, ABS(m.quantity * m.unit_cost)::float AS value FROM inventory_transactions m JOIN products p ON p.id = m.product_id WHERE m.tenant_id = ${tenantId} AND m.created_at::date = ${y}::date AND m.transaction_type IN ('receipt', 'dispatch', 'adjustment', 'write_off') ORDER BY ABS(m.quantity * m.unit_cost) DESC LIMIT 3`),
    rows(db(), sql`SELECT po.number, s.name AS supplier, CURRENT_DATE - po.expected_date AS days_late FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.tenant_id = ${tenantId} AND po.status IN ('approved', 'partially_received') AND po.expected_date < CURRENT_DATE ORDER BY po.expected_date LIMIT 5`),
    one<{ n: string; v: string }>(db(), sql`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM stock_adjustments WHERE tenant_id = ${tenantId} AND status = 'pending_approval'`),
  ]);
  return { date: new Date().toISOString().slice(0, 10), yesterday: y, company: tenant?.name ?? '', currency: tenant?.currency ?? 'PKR', inventory: inv, warehouses: wh.warehouses.map((w) => ({ name: w.name, utilizationPct: w.utilizationPct, emptyLocations: w.emptyLocations })), operationsYesterday: ops, financialYesterday: fin, lowStock: low, expiring: exp, delayed, overdueCustomers: debtors.filter((d) => num(d.overdue) > 0), anomalies: anomalies.slice(0, 5), movementValueYesterday: num(movementValue?.v), largestMovements: bigMoves, lateSuppliers, pendingAdjustments: { count: num(pendingAdj?.n), value: num(pendingAdj?.v) } };
}

/** Deterministic briefing text built only from the facts. */
export function ruleBriefing(f: Awaited<ReturnType<typeof briefingFacts>>): { headline: string; content: string; items: BriefingItem[] } {
  const c = f.currency;
  const items: BriefingItem[] = [];
  for (const w of f.warehouses.filter((x) => x.utilizationPct >= 85)) items.push({ severity: w.utilizationPct >= 95 ? 'critical' : 'warning', text: `${w.name} is at ${w.utilizationPct}% capacity.`, href: '/warehouses' });
  if (f.inventory.lowStockSkus) items.push({ severity: 'warning', text: `${f.inventory.lowStockSkus} ${f.inventory.lowStockSkus === 1 ? 'SKU is' : 'SKUs are'} below reorder level${f.lowStock[0] ? ` (e.g. ${f.lowStock.slice(0, 3).map((p) => p.sku).join(', ')})` : ''}.`, href: '/ai?tab=reorder' });
  if (f.delayed.length) items.push({ severity: 'warning', text: `${f.delayed.length} order${f.delayed.length > 1 ? 's are' : ' is'} delayed.`, href: '/orders?delayed=1' });
  if (f.expiring.length) items.push({ severity: 'warning', text: `${f.expiring.length} ${f.expiring.length === 1 ? 'batch expires' : 'batches expire'} within 30 days.`, href: '/reports/expiry' });
  if (f.pendingAdjustments.count) items.push({ severity: 'warning', text: `Inventory adjustments worth ${money(f.pendingAdjustments.value, c)} require review.`, href: '/approvals' });
  for (const d of f.overdueCustomers.slice(0, 2)) items.push({ severity: 'warning', text: `${d.name} has ${money(num(d.overdue), c)} overdue.`, href: `/customers/${d.id}` });
  for (const s of f.lateSuppliers.slice(0, 2)) items.push({ severity: 'info', text: `${s.supplier} is ${s.days_late} days late on ${s.number}.`, href: '/purchasing' });
  for (const a of f.anomalies.slice(0, 2)) items.push({ severity: a.severity, text: `Unusual activity detected: ${a.title}.`, href: '/ai?tab=anomalies' });
  const o = f.operationsYesterday;
  const headline = `Good morning. Yesterday your warehouses processed ${money(f.movementValueYesterday, c)} of inventory movements.`;
  const content = [
    headline,
    `Receipts: ${o.receipts} (${o.unitsReceived.toLocaleString()} units in). Dispatches: ${o.dispatches} (${o.unitsDispatched.toLocaleString()} units out). Sales invoiced: ${money(f.financialYesterday.sales, c)}.`,
    f.largestMovements.length ? `Largest movements: ${f.largestMovements.map((m) => `${String(m.type).replace('_', ' ')} ${m.sku} ${Math.abs(num(m.quantity))} units (${money(num(m.value), c)})`).join('; ')}.` : '',
    `Stock on hand: ${f.inventory.totalUnits.toLocaleString()} units worth ${money(f.inventory.inventoryValue, c)}.`,
    items.length ? `${items.length} item${items.length > 1 ? 's need' : ' needs'} your attention today.` : 'Nothing needs urgent attention today.',
  ].filter(Boolean).join(' ');
  return { headline, content, items };
}

/** Generates (or regenerates) today's briefing. Mistral phrases it when configured; facts always come from the DB. */
export async function generateBriefing(tenantId: string, userId: string | null = null) {
  const facts = await briefingFacts(tenantId);
  const rule = ruleBriefing(facts);
  let content = rule.content;
  let generatedBy: 'mistral' | 'rules' = 'rules';
  if (mistral.configured) {
    try {
      const res = await mistral.chat([
        { role: 'system', content: 'You write a short morning "Warehouse Intelligence Brief" for a business owner. Use ONLY the JSON facts given. Do not invent numbers. 4–6 sentences, plain language, neutral tone for any unusual activity. Start with "Good morning."' },
        { role: 'user', content: JSON.stringify({ facts, attentionItems: rule.items }) },
      ], { tenantId, userId, feature: 'briefing', maxTokens: 400 });
      if (res.message.content) { content = String(res.message.content).trim(); generatedBy = 'mistral'; }
    } catch { /* keep rule-based text */ }
  }
  const [row] = await db().insert(t.aiBriefings).values({ tenantId, briefingDate: facts.date, headline: rule.headline, content, items: rule.items, facts: facts as never, generatedBy })
    .onConflictDoUpdate({ target: [t.aiBriefings.tenantId, t.aiBriefings.briefingDate], set: { headline: rule.headline, content, items: rule.items, facts: facts as never, generatedBy, createdAt: new Date() } }).returning();
  return row!;
}

/** Monthly warehouse performance report: structured sections + optional AI narrative. */
export async function monthlyReport(tenantId: string, month: string, userId: string | null) {
  const from = `${month}-01`;
  const end = new Date(`${from}T00:00:00Z`);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  const to = end.toISOString().slice(0, 10);
  const { profitability } = await import('../modules/finance/routes');
  const [tenant] = await db().select({ name: t.tenants.name, currency: t.tenants.baseCurrency }).from(t.tenants).where(eq(t.tenants.id, tenantId));
  const [inv, wh, ops, fin, profit, low, accuracy, topSkus] = await Promise.all([
    inventoryKpis(db(), tenantId), warehouseKpis(db(), tenantId), operationsKpis(db(), tenantId, from, to), financialKpis(db(), tenantId, from, to), profitability(db(), tenantId, from, to),
    lowStock(db(), tenantId, 10),
    one<{ lines: string; variance_lines: string }>(db(), sql`SELECT COUNT(l.id) AS lines, COUNT(l.id) FILTER (WHERE l.variance_qty <> 0) AS variance_lines FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id WHERE c.tenant_id = ${tenantId} AND c.status = 'posted' AND c.posted_at BETWEEN ${from}::date AND ${to}::date + 1`),
    rows(db(), sql`SELECT p.sku, p.name, -SUM(m.quantity)::float AS units FROM inventory_transactions m JOIN products p ON p.id = m.product_id WHERE m.tenant_id = ${tenantId} AND m.transaction_type = 'dispatch' AND m.created_at >= ${from}::date AND m.created_at < ${to}::date + 1 GROUP BY p.id ORDER BY units DESC LIMIT 5`),
  ]);
  const accuracyPct = num(accuracy?.lines) ? Math.round((1 - num(accuracy?.variance_lines) / num(accuracy?.lines)) * 1000) / 10 : null;
  const currency = tenant?.currency ?? 'PKR';
  const issues: string[] = [];
  if (inv.lowStockSkus) issues.push(`${inv.lowStockSkus} SKUs below reorder level at month end.`);
  if (ops.delayedOrders) issues.push(`${ops.delayedOrders} orders delayed.`);
  for (const w of wh.warehouses.filter((x) => x.utilizationPct >= 85)) issues.push(`${w.name} at ${w.utilizationPct}% capacity.`);
  if (inv.deadStockValue) issues.push(`${money(inv.deadStockValue, currency)} in dead stock (${inv.deadStockSkus} SKUs).`);
  const recommendations: string[] = [];
  if (inv.lowStockSkus) recommendations.push('Use Smart Reorder to raise purchase orders for low-stock SKUs before they run out.');
  if (inv.deadStockValue) recommendations.push('Run a clearance plan for dead stock (discounts, bundles or supplier returns) to free cash and space.');
  if (wh.warehouses.some((w) => w.utilizationPct >= 85)) recommendations.push('Review space recommendations: relocate slow movers and consolidate partially filled bins.');
  if (accuracyPct !== null && accuracyPct < 98) recommendations.push('Increase cycle-count frequency on high-value locations to raise inventory accuracy above 98%.');
  if (fin.overdueReceivables) recommendations.push(`Follow up ${money(fin.overdueReceivables, currency)} of overdue receivables.`);
  if (!recommendations.length) recommendations.push('Operations are within normal ranges. Maintain the current cycle-count and reorder routines.');

  const sections = {
    title: `Monthly warehouse performance report — ${new Date(`${from}T00:00:00Z`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`,
    company: tenant?.name ?? '', period: { from, to }, currency,
    kpis: [
      { label: 'Goods receipts', value: ops.receipts }, { label: 'Units received', value: ops.unitsReceived }, { label: 'Dispatches', value: ops.dispatches }, { label: 'Units dispatched', value: ops.unitsDispatched },
      { label: 'Inventory value (now)', value: money(inv.inventoryValue, currency) }, { label: 'Warehouse capacity used', value: `${wh.capacityPct}%` }, { label: 'Inventory accuracy', value: accuracyPct === null ? 'No counts posted' : `${accuracyPct}%` },
      { label: 'Sales (net)', value: money(fin.sales, currency) }, { label: 'Estimated net profit', value: money(profit.netProfit, currency) },
    ],
    issues, inventoryAnalysis: { totals: inv, lowStock: low.slice(0, 5), topMovers: topSkus },
    operations: ops, financial: { ...fin, profitability: profit }, recommendations, executiveSummary: '', generatedBy: 'rules' as 'rules' | 'mistral',
  };
  sections.executiveSummary = `${sections.company} received ${ops.receipts} shipments (${ops.unitsReceived.toLocaleString()} units) and dispatched ${ops.dispatches} orders (${ops.unitsDispatched.toLocaleString()} units) between ${from} and ${to}. Net sales were ${money(fin.sales, currency)} with an estimated net profit of ${money(profit.netProfit, currency)}. ${issues.length ? `Key issues: ${issues.join(' ')}` : 'No major issues were recorded.'}`;
  if (mistral.configured) {
    try {
      const res = await mistral.chat([
        { role: 'system', content: 'Write a 120-word executive summary of a monthly warehouse performance report using ONLY the JSON data. No invented numbers. Professional, plain English.' },
        { role: 'user', content: JSON.stringify({ kpis: sections.kpis, issues, financial: { sales: fin.sales, netProfit: profit.netProfit }, operations: ops }) },
      ], { tenantId, userId, feature: 'report', maxTokens: 350 });
      if (res.message.content) { sections.executiveSummary = String(res.message.content).trim(); sections.generatedBy = 'mistral'; }
    } catch { /* keep rule-based summary */ }
  }
  return sections;
}
