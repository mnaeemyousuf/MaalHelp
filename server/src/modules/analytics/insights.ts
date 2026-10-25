import { eq, sql } from 'drizzle-orm';
import { num, rows, t, type DbOrTx } from '../../db';
import { notify, resolveAlerts } from '../alerts/notify';
import { locationUsage } from '../warehouses/space';
import { delayedOrders, expiringStock, inventoryKpis, lowStock, topDebtors, warehouseKpis } from './metrics';

export interface DetectedAnomaly {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  entityType?: string;
  entityId?: string;
  metrics: Record<string, unknown>;
  dedupeKey: string;
}

/**
 * Statistical + rule-based anomaly detection. Language is deliberately neutral:
 * findings are "unusual activity" for human review, never accusations.
 */
export async function detectAnomalies(dbx: DbOrTx, tenantId: string): Promise<DetectedAnomaly[]> {
  const found: DetectedAnomaly[] = [];

  // 1. Adjustment value far above the tenant's normal range (mean + 3σ over 90 days).
  const adj = await rows<Record<string, string>>(dbx, sql`
    WITH a AS (SELECT id, reference_no, product_id, performed_by, created_at, ABS(quantity * unit_cost) AS v, quantity FROM inventory_transactions
      WHERE tenant_id = ${tenantId} AND transaction_type IN ('adjustment', 'write_off', 'damage') AND created_at >= now() - interval '90 days'),
    s AS (SELECT AVG(v) AS mean, COALESCE(STDDEV_POP(v), 0) AS sd FROM a)
    SELECT a.*, s.mean, s.sd, p.sku, u.name AS user_name FROM a CROSS JOIN s JOIN products p ON p.id = a.product_id LEFT JOIN users u ON u.id = a.performed_by
    WHERE a.created_at >= now() - interval '7 days' AND a.v > GREATEST(s.mean + 3 * s.sd, 50000) ORDER BY a.v DESC LIMIT 20`);
  for (const a of adj) {
    found.push({ type: 'unusual_adjustment', severity: 'warning', title: `Unusual stock adjustment: ${a.sku}`, description: `An adjustment of ${num(a.quantity)} units (value ${Math.round(num(a.v)).toLocaleString()}) is well above the usual range (average ${Math.round(num(a.mean)).toLocaleString()}). Please review the supporting reason${a.reference_no ? ` on ${a.reference_no}` : ''}.`, entityType: 'inventory_transaction', entityId: a.id, metrics: { value: num(a.v), mean: num(a.mean), sd: num(a.sd), user: a.user_name }, dedupeKey: `adj:${a.id}` });
  }

  // 2. Repeated negative adjustments by the same user.
  const rep = await rows<Record<string, string>>(dbx, sql`
    SELECT m.performed_by, u.name, COUNT(*) AS n, SUM(ABS(m.quantity * m.unit_cost)) AS v FROM inventory_transactions m LEFT JOIN users u ON u.id = m.performed_by
    WHERE m.tenant_id = ${tenantId} AND m.transaction_type IN ('adjustment', 'write_off') AND m.quantity < 0 AND m.created_at >= now() - interval '7 days' AND m.performed_by IS NOT NULL
    GROUP BY m.performed_by, u.name HAVING COUNT(*) >= 5`);
  for (const r of rep) {
    found.push({ type: 'repeated_adjustments', severity: 'warning', title: `Repeated stock reductions recorded by ${r.name}`, description: `${num(r.n)} negative adjustments (value ${Math.round(num(r.v)).toLocaleString()}) were recorded by the same user in 7 days. This may be legitimate (e.g. clearing damaged stock) — review the reasons.`, entityType: 'user', entityId: r.performed_by, metrics: { count: num(r.n), value: num(r.v) }, dedupeKey: `rep:${r.performed_by}:${new Date().toISOString().slice(0, 10)}` });
  }

  // 3. Unusual receiving quantity vs order.
  const rec = await rows<Record<string, string>>(dbx, sql`
    SELECT gl.id, g.number, p.sku, gl.received_qty, gl.expected_qty FROM goods_receipt_lines gl JOIN goods_receipts g ON g.id = gl.receipt_id JOIN products p ON p.id = gl.product_id
    WHERE gl.tenant_id = ${tenantId} AND g.received_at >= now() - interval '7 days' AND gl.expected_qty > 0 AND (gl.received_qty > gl.expected_qty * 1.2 OR gl.received_qty < gl.expected_qty * 0.5)`);
  for (const r of rec) {
    const over = num(r.received_qty) > num(r.expected_qty);
    found.push({ type: 'unusual_receiving', severity: 'info', title: `Unusual receiving quantity on ${r.number}`, description: `${r.sku}: received ${num(r.received_qty)} against ${num(r.expected_qty)} expected (${over ? 'over' : 'short'} delivery). Confirm with the supplier.`, entityType: 'goods_receipt_line', entityId: r.id, metrics: { received: num(r.received_qty), expected: num(r.expected_qty) }, dedupeKey: `rec:${r.id}` });
  }

  // 4. Repeated short picks at one location.
  const sp = await rows<Record<string, string>>(dbx, sql`
    SELECT pt.location_id, l.code, COUNT(*) AS n FROM pick_tasks pt JOIN locations l ON l.id = pt.location_id
    WHERE pt.tenant_id = ${tenantId} AND pt.status = 'short' AND pt.picked_at >= now() - interval '14 days' GROUP BY pt.location_id, l.code HAVING COUNT(*) >= 2`);
  for (const r of sp) {
    found.push({ type: 'picking_variance', severity: 'warning', title: `Repeated short picks at ${r.code}`, description: `${num(r.n)} picks at ${r.code} were short in 14 days. A cycle count of this location is recommended.`, entityType: 'location', entityId: r.location_id, metrics: { count: num(r.n) }, dedupeKey: `sp:${r.location_id}:${new Date().toISOString().slice(0, 7)}` });
  }

  // 5. Large single-day inventory decrease outside normal dispatch.
  const dec = await rows<Record<string, string>>(dbx, sql`
    WITH d AS (SELECT created_at::date AS day, SUM(ABS(quantity * unit_cost)) AS v FROM inventory_transactions WHERE tenant_id = ${tenantId} AND quantity < 0 AND transaction_type NOT IN ('dispatch', 'pick', 'putaway', 'transfer_out', 'reservation', 'status_change', 'reservation_release') AND created_at >= now() - interval '60 days' GROUP BY 1)
    SELECT day::text, v, (SELECT AVG(v) FROM d) AS mean FROM d WHERE day >= CURRENT_DATE - 2 AND v > GREATEST(3 * (SELECT AVG(v) FROM d), 100000)`);
  for (const r of dec) {
    found.push({ type: 'large_decrease', severity: 'critical', title: `Large inventory decrease on ${r.day}`, description: `Stock worth ${Math.round(num(r.v)).toLocaleString()} was removed outside normal dispatches (typical day: ${Math.round(num(r.mean)).toLocaleString()}). Review adjustments, write-offs and damage records for that day.`, metrics: { value: num(r.v), mean: num(r.mean) }, dedupeKey: `dec:${r.day}` });
  }

  // 6. Unexpected warehouse utilisation change vs 7 days ago (from daily snapshots).
  const util = await rows<Record<string, string>>(dbx, sql`
    SELECT w.id, w.code, SUM(s.quantity) FILTER (WHERE s.snapshot_date = CURRENT_DATE) AS today, SUM(s.quantity) FILTER (WHERE s.snapshot_date = CURRENT_DATE - 7) AS week_ago
    FROM inventory_snapshots s JOIN warehouses w ON w.id = s.warehouse_id WHERE s.tenant_id = ${tenantId} AND s.snapshot_date IN (CURRENT_DATE, CURRENT_DATE - 7) GROUP BY w.id`);
  for (const r of util) {
    const before = num(r.week_ago), now = num(r.today);
    if (before > 100 && Math.abs(now - before) / before > 0.35) {
      found.push({ type: 'utilization_change', severity: 'info', title: `Stock in ${r.code} changed ${Math.round(((now - before) / before) * 100)}% in a week`, description: `Units on hand moved from ${before} to ${now}. Check that large receipts or dispatches were expected.`, entityType: 'warehouse', entityId: r.id, metrics: { before, now }, dedupeKey: `util:${r.id}:${new Date().toISOString().slice(0, 10)}` });
    }
  }
  return found;
}

export async function persistAnomalies(dbx: DbOrTx, tenantId: string, list: DetectedAnomaly[]): Promise<number> {
  let created = 0;
  for (const a of list) {
    const res = await dbx.insert(t.anomalies).values({ tenantId, type: a.type, severity: a.severity, title: a.title, description: a.description, entityType: a.entityType ?? null, entityId: a.entityId ?? null, metrics: a.metrics, dedupeKey: a.dedupeKey }).onConflictDoNothing().returning({ id: t.anomalies.id });
    if (res.length) {
      created++;
      await notify(dbx, tenantId, { severity: a.severity, category: 'anomaly', title: `Unusual activity detected: ${a.title}`, body: a.description, entityType: 'anomaly', entityId: res[0]!.id, actionUrl: '/ai/anomalies', permission: 'inventory.approve', dedupeKey: `anomaly:${a.dedupeKey}` });
    }
  }
  return created;
}

export interface SpaceRecommendation { type: string; priority: 'high' | 'medium' | 'low'; title: string; detail: string; productId?: string; locationId?: string; warehouseId: string }

/** Rule-based slotting recommendations (ML can replace this later). */
export async function spaceRecommendations(dbx: DbOrTx, tenantId: string): Promise<SpaceRecommendation[]> {
  const recs: SpaceRecommendation[] = [];
  const whs = await dbx.select().from(t.warehouses).where(eq(t.warehouses.tenantId, tenantId));
  for (const w of whs) {
    const vol = await rows<Record<string, string>>(dbx, sql`
      WITH picks AS (SELECT product_id, -SUM(quantity) AS q FROM inventory_transactions WHERE tenant_id = ${tenantId} AND warehouse_id = ${w.id} AND transaction_type = 'dispatch' AND created_at >= now() - interval '30 days' GROUP BY product_id),
      total AS (SELECT NULLIF(SUM(q), 0) AS t FROM picks)
      SELECT p.id, p.sku, picks.q, picks.q / total.t AS share, l.id AS location_id, l.code, l.pick_priority, l.level
      FROM picks CROSS JOIN total JOIN products p ON p.id = picks.product_id
      JOIN inventory_balances b ON b.product_id = p.id AND b.warehouse_id = ${w.id} AND b.quantity > 0 AND b.status IN ('available', 'reserved')
      JOIN locations l ON l.id = b.location_id AND l.is_pickable
      ORDER BY share DESC`);
    const seen = new Set<string>();
    for (const v of vol) {
      if (num(v.share) >= 0.08 && (num(v.pick_priority) > 40 || num(v.level) >= 3) && !seen.has(String(v.id))) {
        seen.add(String(v.id));
        recs.push({ type: 'move_closer', priority: 'high', warehouseId: w.id, productId: String(v.id), locationId: String(v.location_id), title: `Move ${v.sku} closer to dispatch`, detail: `${v.sku} represents ${Math.round(num(v.share) * 100)}% of ${w.code}'s 30-day picking volume but sits at ${v.code} (priority ${num(v.pick_priority)}, level ${num(v.level)}). Moving it to a low-level slot near the dispatch dock reduces walking time.` });
      }
    }
    const slowPrime = await rows<Record<string, string>>(dbx, sql`
      SELECT p.id, p.sku, l.id AS location_id, l.code FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN locations l ON l.id = b.location_id
      WHERE b.tenant_id = ${tenantId} AND b.warehouse_id = ${w.id} AND b.quantity > 0 AND l.is_pickable AND l.pick_priority <= 25 AND l.level <= 2
        AND NOT EXISTS (SELECT 1 FROM inventory_transactions m WHERE m.product_id = p.id AND m.transaction_type = 'dispatch' AND m.created_at >= now() - interval '60 days')
      LIMIT 10`);
    for (const s of slowPrime) recs.push({ type: 'move_higher', priority: 'medium', warehouseId: w.id, productId: String(s.id), locationId: String(s.location_id), title: `Move slow-moving ${s.sku} to a higher rack`, detail: `${s.sku} has not shipped in 60 days but occupies prime slot ${s.code}. Relocate it to an upper level to free space for fast movers.` });

    const usage = await locationUsage(dbx, tenantId, w.id);
    for (const z of usage.filter((l) => l.type === 'zone')) {
      if (z.binCount >= 4 && z.utilization < 0.2) recs.push({ type: 'underutilized_zone', priority: 'low', warehouseId: w.id, locationId: z.id, title: `${z.name} in ${w.code} is underutilized`, detail: `${z.name} is ${Math.round(z.utilization * 100)}% used (${z.occupiedBins} of ${z.binCount} bins occupied). Consider consolidating stock or renting the space.` });
      if (z.utilization > 0.95) recs.push({ type: 'zone_full', priority: 'high', warehouseId: w.id, locationId: z.id, title: `${z.name} in ${w.code} is nearly full`, detail: `${z.name} is ${Math.round(z.utilization * 100)}% used. Move slow movers out or expand capacity before receiving more stock.` });
    }
    for (const l of usage.filter((x) => !usage.some((c) => c.parentId === x.id) && x.utilization > 1)) {
      recs.push({ type: 'overloaded_location', priority: 'high', warehouseId: w.id, locationId: l.id, title: `${l.code} is over capacity`, detail: `${l.code} holds ${Math.round(l.utilization * 100)}% of its configured capacity. Move part of the stock to a free location.` });
    }
    const scattered = await rows<Record<string, string>>(dbx, sql`SELECT p.id, p.sku, COUNT(DISTINCT b.location_id) AS n FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN locations l ON l.id = b.location_id WHERE b.tenant_id = ${tenantId} AND b.warehouse_id = ${w.id} AND b.quantity > 0 AND b.status = 'available' AND l.is_pickable GROUP BY p.id HAVING COUNT(DISTINCT b.location_id) >= 4 LIMIT 10`);
    for (const s of scattered) recs.push({ type: 'consolidate', priority: 'low', warehouseId: w.id, productId: String(s.id), title: `Consolidate ${s.sku}`, detail: `${s.sku} is spread across ${num(s.n)} locations in ${w.code}. Consolidating frees bins and speeds picking.` });
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Scans conditions and raises / resolves alerts (runs on a schedule and on demand). */
export async function scanAlerts(dbx: DbOrTx, tenantId: string): Promise<{ raised: number }> {
  let raised = 0;
  const keep = async (key: string, fn: () => Promise<unknown>) => { await fn(); raised++; return key; };

  const low = await lowStock(dbx, tenantId, 200);
  const lowKeys = new Set<string>();
  for (const p of low) {
    lowKeys.add(await keep(`low:${p.id}`, () => notify(dbx, tenantId, { severity: num(p.available) <= 0 ? 'critical' : 'warning', category: 'low_stock', title: `${p.sku} ${num(p.available) <= 0 ? 'is out of stock' : 'is below reorder level'}`, body: `${num(p.available)} available, reorder level ${num(p.reorderLevel)}${num(p.incoming) ? `, ${num(p.incoming)} on order` : ''}.`, entityType: 'product', entityId: String(p.id), actionUrl: `/products/${p.id}`, permission: 'inventory.view', dedupeKey: `low:${p.id}` })));
  }
  const openLow = await rows<{ dedupe_key: string }>(dbx, sql`SELECT dedupe_key FROM notifications WHERE tenant_id = ${tenantId} AND resolved_at IS NULL AND dedupe_key LIKE 'low:%'`);
  await resolveAlerts(dbx, tenantId, openLow.map((r) => r.dedupe_key).filter((k) => !lowKeys.has(k)));

  for (const b of await expiringStock(dbx, tenantId, (await inventoryKpis(dbx, tenantId)).expiryAlertDays, 100)) {
    const days = num(b.daysLeft);
    await keep('', () => notify(dbx, tenantId, { severity: days < 0 ? 'critical' : days <= 7 ? 'warning' : 'info', category: 'expiry', title: days < 0 ? `Batch ${b.batchNo} of ${b.sku} has expired` : `Batch ${b.batchNo} of ${b.sku} expires in ${days} days`, body: `${num(b.quantity)} units in ${b.warehouses}. Prioritise dispatch (FEFO) or move to expired status.`, entityType: 'batch', entityId: String(b.batchId), actionUrl: '/inventory?tab=batches', permission: 'inventory.view', dedupeKey: `expiry:${b.batchId}:${days < 0 ? 'expired' : days <= 7 ? 'week' : 'month'}` }));
  }

  const wk = await warehouseKpis(dbx, tenantId);
  for (const w of wk.warehouses) {
    if (w.utilizationPct >= 90) await keep('', () => notify(dbx, tenantId, { severity: w.utilizationPct > 100 ? 'critical' : 'warning', category: 'capacity', title: `${w.name} is ${w.utilizationPct}% full`, body: `${w.emptyLocations} empty locations left. Review space recommendations.`, entityType: 'warehouse', entityId: w.id, actionUrl: `/warehouses/${w.id}`, permission: 'warehouse.view', dedupeKey: `capacity:${w.id}` }));
    else await resolveAlerts(dbx, tenantId, [`capacity:${w.id}`]);
  }

  const delayed = await delayedOrders(dbx, tenantId, 100);
  if (delayed.length) await keep('', () => notify(dbx, tenantId, { severity: 'warning', category: 'order_delay', title: `${delayed.length} order${delayed.length > 1 ? 's are' : ' is'} delayed`, body: delayed.slice(0, 5).map((o) => `${o.number} (${o.customerName}, ${o.status})`).join(', '), actionUrl: '/orders?delayed=1', permission: 'sales.view', dedupeKey: 'orders:delayed' }));
  else await resolveAlerts(dbx, tenantId, ['orders:delayed']);

  for (const c of await topDebtors(dbx, tenantId, 0, 50)) {
    if (num(c.overdue) > 0) await keep('', () => notify(dbx, tenantId, { severity: num(c.maxDaysOverdue) > 60 ? 'critical' : 'warning', category: 'payment_overdue', title: `${c.name} has an overdue balance`, body: `${Math.round(num(c.overdue)).toLocaleString()} overdue (up to ${num(c.maxDaysOverdue)} days).`, entityType: 'customer', entityId: String(c.id), actionUrl: `/customers/${c.id}`, permission: 'finance.view', dedupeKey: `overdue:${c.id}` }));
  }

  const pendingAdj = await rows<{ n: string; v: string }>(dbx, sql`SELECT COUNT(*) AS n, COALESCE(SUM(value), 0) AS v FROM stock_adjustments WHERE tenant_id = ${tenantId} AND status = 'pending_approval'`);
  if (num(pendingAdj[0]?.n) > 0) await keep('', () => notify(dbx, tenantId, { severity: 'warning', category: 'approval', title: `${num(pendingAdj[0]?.n)} stock adjustment(s) worth ${Math.round(num(pendingAdj[0]?.v)).toLocaleString()} need review`, actionUrl: '/approvals', permission: 'approval.decide', dedupeKey: 'adjustments:pending' }));
  else await resolveAlerts(dbx, tenantId, ['adjustments:pending']);

  const kpi = await inventoryKpis(dbx, tenantId);
  if (kpi.expired > 0) await keep('', () => notify(dbx, tenantId, { severity: 'critical', category: 'expired_stock', title: `${kpi.expired} units of expired stock on hand`, body: 'Write off or return expired stock to keep valuation accurate.', actionUrl: '/inventory?status=expired', permission: 'inventory.view', dedupeKey: 'expired:summary' }));
  else await resolveAlerts(dbx, tenantId, ['expired:summary']);

  await persistAnomalies(dbx, tenantId, await detectAnomalies(dbx, tenantId));
  return { raised };
}
