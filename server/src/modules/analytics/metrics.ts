import { eq, sql } from 'drizzle-orm';
import { num, one, rows, t, type DbOrTx } from '../../db';
import { warehouseCapacity } from '../warehouses/space';

export type RangePreset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'year' | 'custom';

export function resolveRange(preset: RangePreset = 'today', from?: string, to?: string): { from: string; to: string; label: string } {
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const today = new Date();
  const start = new Date(today);
  switch (preset) {
    case 'yesterday': start.setDate(today.getDate() - 1); return { from: d(start), to: d(start), label: 'Yesterday' };
    case '7d': start.setDate(today.getDate() - 6); return { from: d(start), to: d(today), label: 'Last 7 days' };
    case '30d': start.setDate(today.getDate() - 29); return { from: d(start), to: d(today), label: 'Last 30 days' };
    case 'month': return { from: d(new Date(today.getFullYear(), today.getMonth(), 1, 12)), to: d(today), label: 'This month' };
    case 'year': return { from: `${today.getFullYear()}-01-01`, to: d(today), label: 'This year' };
    case 'custom': return { from: from ?? d(today), to: to ?? d(today), label: `${from} → ${to}` };
    default: return { from: d(today), to: d(today), label: 'Today' };
  }
}

async function settings(dbx: DbOrTx, tenantId: string) {
  const [row] = await dbx.select({ settings: t.tenants.settings }).from(t.tenants).where(eq(t.tenants.id, tenantId)).limit(1);
  return { deadStockDays: row?.settings.inventory?.deadStockDays ?? 90, expiryAlertDays: row?.settings.inventory?.expiryAlertDays ?? 30 };
}

export async function inventoryKpis(dbx: DbOrTx, tenantId: string, warehouseId?: string | null) {
  const { deadStockDays, expiryAlertDays } = await settings(dbx, tenantId);
  const wf = warehouseId ? sql`AND b.warehouse_id = ${warehouseId}` : sql``;
  const row = await one<Record<string, string>>(dbx, sql`
    WITH bal AS (
      SELECT b.product_id, b.status, b.quantity, p.cost_price FROM inventory_balances b JOIN products p ON p.id = b.product_id
      WHERE b.tenant_id = ${tenantId} AND b.owner_customer_id IS NULL AND b.quantity > 0 ${wf}
    ), avail AS (SELECT product_id, SUM(quantity) FILTER (WHERE status = 'available') AS q FROM bal GROUP BY product_id),
    moved AS (SELECT DISTINCT product_id FROM inventory_transactions WHERE tenant_id = ${tenantId} AND transaction_type IN ('dispatch', 'pick') AND created_at >= now() - make_interval(days => ${deadStockDays}))
    SELECT
      (SELECT COUNT(*) FROM products WHERE tenant_id = ${tenantId} AND status = 'active') AS skus,
      (SELECT COUNT(DISTINCT product_id) FROM bal) AS skus_in_stock,
      COALESCE(SUM(quantity), 0) AS units, COALESCE(SUM(quantity * cost_price), 0) AS value,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'available'), 0) AS available,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'reserved'), 0) AS reserved,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'damaged'), 0) AS damaged,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'expired'), 0) AS expired,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'quarantine'), 0) AS quarantine,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'in_transit'), 0) AS in_transit,
      COALESCE(SUM(quantity) FILTER (WHERE status = 'blocked'), 0) AS blocked,
      COALESCE(SUM(quantity * cost_price) FILTER (WHERE status = 'available'), 0) AS available_value,
      COALESCE(SUM(quantity * cost_price) FILTER (WHERE status IN ('damaged', 'expired')), 0) AS impaired_value,
      COALESCE(SUM(quantity * cost_price) FILTER (WHERE product_id NOT IN (SELECT product_id FROM moved)), 0) AS dead_value,
      (SELECT COUNT(DISTINCT product_id) FROM bal WHERE product_id NOT IN (SELECT product_id FROM moved)) AS dead_skus,
      (SELECT COUNT(*) FROM products p LEFT JOIN avail a ON a.product_id = p.id WHERE p.tenant_id = ${tenantId} AND p.status = 'active' AND p.reorder_level > 0 AND COALESCE(a.q, 0) <= p.reorder_level) AS low_skus,
      (SELECT COUNT(*) FROM products p LEFT JOIN avail a ON a.product_id = p.id WHERE p.tenant_id = ${tenantId} AND p.status = 'active' AND COALESCE(a.q, 0) <= 0) AS out_skus,
      (SELECT COUNT(DISTINCT bt.id) FROM batches bt JOIN inventory_balances b ON b.batch_id = bt.id AND b.quantity > 0 AND b.status IN ('available', 'reserved') WHERE bt.tenant_id = ${tenantId} AND bt.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + ${expiryAlertDays}::int ${wf}) AS expiring_batches
    FROM bal`);
  const n = (k: string) => num(row?.[k]);
  return {
    totalSkus: n('skus'), skusInStock: n('skus_in_stock'), totalUnits: n('units'), inventoryValue: Math.round(n('value')), availableValue: Math.round(n('available_value')),
    available: n('available'), reserved: n('reserved'), damaged: n('damaged'), expired: n('expired'), quarantine: n('quarantine'), inTransit: n('in_transit'), blocked: n('blocked'),
    impairedValue: Math.round(n('impaired_value')), deadStockValue: Math.round(n('dead_value')), deadStockSkus: n('dead_skus'), lowStockSkus: n('low_skus'), outOfStockSkus: n('out_skus'),
    expiringBatches: n('expiring_batches'), deadStockDays, expiryAlertDays,
  };
}

export async function warehouseKpis(dbx: DbOrTx, tenantId: string) {
  const list = await dbx.select().from(t.warehouses).where(eq(t.warehouses.tenantId, tenantId));
  const caps = await Promise.all(list.map(async (w) => ({ id: w.id, code: w.code, name: w.name, city: w.city, ...(await warehouseCapacity(dbx, tenantId, w)) })));
  const sum = (k: 'capacity' | 'used' | 'free' | 'occupiedLocations' | 'emptyLocations' | 'totalLocations' | 'stockValue') => caps.reduce((s, c) => s + (c[k] as number), 0);
  const capacity = sum('capacity');
  return {
    warehouses: caps,
    totalCapacity: capacity, usedCapacity: Math.round(sum('used') * 100) / 100, availableCapacity: Math.round(sum('free') * 100) / 100,
    capacityPct: capacity > 0 ? Math.round((sum('used') / capacity) * 1000) / 10 : 0,
    occupiedLocations: sum('occupiedLocations'), emptyLocations: sum('emptyLocations'), totalLocations: sum('totalLocations'),
    mixedUnits: new Set(caps.map((c) => c.capacityUnit)).size > 1,
  };
}

export async function operationsKpis(dbx: DbOrTx, tenantId: string, from: string, to: string, warehouseId?: string | null) {
  const wf = (col: string) => (warehouseId ? sql`AND ${sql.raw(col)} = ${warehouseId}` : sql``);
  const row = await one<Record<string, string>>(dbx, sql`SELECT
    (SELECT COUNT(*) FROM goods_receipts WHERE tenant_id = ${tenantId} AND received_at >= ${from}::date AND received_at < ${to}::date + 1 ${wf('warehouse_id')}) AS receipts,
    (SELECT COALESCE(SUM(quantity), 0) FROM inventory_transactions WHERE tenant_id = ${tenantId} AND transaction_type = 'receipt' AND created_at >= ${from}::date AND created_at < ${to}::date + 1 ${wf('warehouse_id')}) AS units_in,
    (SELECT COUNT(*) FROM shipments WHERE tenant_id = ${tenantId} AND dispatched_at >= ${from}::date AND dispatched_at < ${to}::date + 1 ${wf('warehouse_id')}) AS dispatches,
    (SELECT COALESCE(-SUM(quantity), 0) FROM inventory_transactions WHERE tenant_id = ${tenantId} AND transaction_type = 'dispatch' AND created_at >= ${from}::date AND created_at < ${to}::date + 1 ${wf('warehouse_id')}) AS units_out,
    (SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = ${tenantId} AND status IN ('approved', 'partially_received') ${wf('warehouse_id')}) AS pending_receipts,
    (SELECT COUNT(*) FROM purchase_orders WHERE tenant_id = ${tenantId} AND status IN ('approved', 'partially_received') AND expected_date < CURRENT_DATE ${wf('warehouse_id')}) AS overdue_receipts,
    (SELECT COUNT(*) FROM putaway_tasks WHERE tenant_id = ${tenantId} AND status = 'pending' ${wf('warehouse_id')}) AS pending_putaway,
    (SELECT COUNT(*) FROM sales_orders WHERE tenant_id = ${tenantId} AND status IN ('draft', 'confirmed', 'reserved', 'picking', 'packed') ${wf('warehouse_id')}) AS pending_orders,
    (SELECT COUNT(*) FROM sales_orders WHERE tenant_id = ${tenantId} AND status = 'confirmed' ${wf('warehouse_id')}) AS backordered,
    (SELECT COUNT(*) FROM pick_tasks WHERE tenant_id = ${tenantId} AND status IN ('pending', 'in_progress') ${wf('warehouse_id')}) AS pending_pick_tasks,
    (SELECT COUNT(DISTINCT sales_order_id) FROM pick_tasks WHERE tenant_id = ${tenantId} AND status IN ('pending', 'in_progress') ${wf('warehouse_id')}) AS pending_picking,
    (SELECT COUNT(*) FROM sales_orders so WHERE so.tenant_id = ${tenantId} AND so.status IN ('picking', 'reserved') ${wf('so.warehouse_id')} AND NOT EXISTS (SELECT 1 FROM pick_tasks pt WHERE pt.sales_order_id = so.id AND pt.status IN ('pending', 'in_progress')) AND EXISTS (SELECT 1 FROM sales_order_lines l WHERE l.sales_order_id = so.id AND l.picked_qty > 0)) AS pending_packing,
    (SELECT COUNT(*) FROM sales_orders WHERE tenant_id = ${tenantId} AND status = 'packed' ${wf('warehouse_id')}) AS pending_dispatch,
    (SELECT COUNT(*) FROM sales_orders WHERE tenant_id = ${tenantId} ${wf('warehouse_id')} AND ((required_date < CURRENT_DATE AND status IN ('confirmed', 'reserved', 'picking', 'packed')) OR (required_date IS NULL AND status IN ('confirmed', 'reserved', 'picking') AND confirmed_at < now() - interval '3 days'))) AS delayed_orders,
    (SELECT COUNT(*) FROM stock_transfers WHERE tenant_id = ${tenantId} AND status IN ('requested', 'approved', 'picking', 'in_transit')) AS open_transfers,
    (SELECT COUNT(*) FROM stock_counts WHERE tenant_id = ${tenantId} AND status IN ('draft', 'assigned', 'counting', 'review', 'pending_approval')) AS open_counts,
    (SELECT COUNT(*) FROM approval_requests WHERE tenant_id = ${tenantId} AND status = 'pending') AS pending_approvals`);
  const n = (k: string) => num(row?.[k]);
  return {
    receipts: n('receipts'), unitsReceived: n('units_in'), dispatches: n('dispatches'), unitsDispatched: n('units_out'),
    pendingReceipts: n('pending_receipts'), overdueReceipts: n('overdue_receipts'), pendingPutaway: n('pending_putaway'), pendingOrders: n('pending_orders'),
    backorderedOrders: n('backordered'), pendingPickTasks: n('pending_pick_tasks'), pendingPicking: n('pending_picking'), pendingPacking: n('pending_packing'),
    pendingDispatch: n('pending_dispatch'), delayedOrders: n('delayed_orders'), openTransfers: n('open_transfers'), openCounts: n('open_counts'), pendingApprovals: n('pending_approvals'),
  };
}

export async function financialKpis(dbx: DbOrTx, tenantId: string, from: string, to: string) {
  const row = await one<Record<string, string>>(dbx, sql`SELECT
    (SELECT COALESCE(SUM(subtotal), 0) FROM invoices WHERE tenant_id = ${tenantId} AND type IN ('sales', 'credit_note') AND status <> 'void' AND issue_date BETWEEN ${from} AND ${to}) AS sales,
    (SELECT COALESCE(SUM(subtotal), 0) FROM invoices WHERE tenant_id = ${tenantId} AND type = 'storage' AND status <> 'void' AND issue_date BETWEEN ${from} AND ${to}) AS storage_revenue,
    (SELECT COALESCE(SUM(subtotal), 0) FROM supplier_bills WHERE tenant_id = ${tenantId} AND status <> 'void' AND bill_date BETWEEN ${from} AND ${to}) AS purchases,
    (SELECT COALESCE(SUM(total), 0) FROM purchase_orders WHERE tenant_id = ${tenantId} AND status NOT IN ('draft', 'cancelled') AND order_date BETWEEN ${from} AND ${to}) AS purchase_orders_value,
    (SELECT COALESCE(SUM(total - amount_paid), 0) FROM invoices WHERE tenant_id = ${tenantId} AND status IN ('issued', 'partially_paid')) AS receivables,
    (SELECT COALESCE(SUM(total - amount_paid), 0) FROM invoices WHERE tenant_id = ${tenantId} AND status IN ('issued', 'partially_paid') AND due_date < CURRENT_DATE AND total > 0) AS overdue_receivables,
    (SELECT COALESCE(SUM(total - amount_paid), 0) FROM supplier_bills WHERE tenant_id = ${tenantId} AND status IN ('open', 'partially_paid')) AS payables,
    (SELECT COALESCE(SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)), 0) FROM sales_order_lines l JOIN sales_orders so ON so.id = l.sales_order_id WHERE so.tenant_id = ${tenantId} AND so.dispatched_at >= ${from}::date AND so.dispatched_at < ${to}::date + 1) AS shipped_revenue,
    (SELECT COALESCE(SUM(l.shipped_qty * l.unit_cost), 0) FROM sales_order_lines l JOIN sales_orders so ON so.id = l.sales_order_id WHERE so.tenant_id = ${tenantId} AND so.dispatched_at >= ${from}::date AND so.dispatched_at < ${to}::date + 1) AS shipped_cost,
    (SELECT COALESCE(SUM(amount), 0) FROM expenses WHERE tenant_id = ${tenantId} AND status = 'approved' AND expense_date BETWEEN ${from} AND ${to}) AS expenses,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE tenant_id = ${tenantId} AND direction = 'in' AND paid_at BETWEEN ${from} AND ${to}) AS cash_in,
    (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE tenant_id = ${tenantId} AND direction = 'out' AND paid_at BETWEEN ${from} AND ${to}) AS cash_out`);
  const n = (k: string) => Math.round(num(row?.[k]));
  const rev = num(row?.shipped_revenue), cost = num(row?.shipped_cost);
  return {
    sales: n('sales'), storageRevenue: n('storage_revenue'), purchases: n('purchases'), purchaseOrdersValue: n('purchase_orders_value'),
    receivables: n('receivables'), overdueReceivables: n('overdue_receivables'), payables: n('payables'), expenses: n('expenses'), cashIn: n('cash_in'), cashOut: n('cash_out'),
    grossMargin: Math.round(rev - cost), grossMarginPct: rev > 0 ? Math.round(((rev - cost) / rev) * 1000) / 10 : null,
  };
}

export async function movementTrend(dbx: DbOrTx, tenantId: string, from: string, to: string, warehouseId?: string | null) {
  // At least a 14-day window so short presets still render a meaningful chart.
  const start = new Date(`${from}T00:00:00Z`);
  const minStart = new Date(`${to}T00:00:00Z`);
  minStart.setUTCDate(minStart.getUTCDate() - 13);
  const effectiveFrom = (start < minStart ? start : minStart).toISOString().slice(0, 10);
  const list = await rows<Record<string, string>>(dbx, sql`
    WITH days AS (SELECT generate_series(${effectiveFrom}::date, ${to}::date, interval '1 day')::date AS d)
    SELECT days.d::text AS day,
      COALESCE(SUM(m.quantity) FILTER (WHERE m.transaction_type = 'receipt'), 0) AS inbound,
      COALESCE(-SUM(m.quantity) FILTER (WHERE m.transaction_type = 'dispatch'), 0) AS outbound,
      COALESCE(SUM(ABS(m.quantity * m.unit_cost)) FILTER (WHERE m.transaction_type IN ('receipt', 'dispatch')), 0) AS value,
      COUNT(*) FILTER (WHERE m.transaction_type IN ('adjustment', 'stock_count', 'write_off', 'damage')) AS adjustments
    FROM days LEFT JOIN inventory_transactions m ON m.created_at::date = days.d AND m.tenant_id = ${tenantId} ${warehouseId ? sql`AND m.warehouse_id = ${warehouseId}` : sql``}
    GROUP BY days.d ORDER BY days.d`);
  return list.map((r) => ({ day: r.day, inbound: num(r.inbound), outbound: num(r.outbound), value: Math.round(num(r.value)), adjustments: num(r.adjustments) }));
}

export async function salesTrend(dbx: DbOrTx, tenantId: string, months = 6) {
  const list = await rows<Record<string, string>>(dbx, sql`
    WITH m AS (SELECT generate_series(date_trunc('month', now()) - make_interval(months => ${months - 1}), date_trunc('month', now()), interval '1 month')::date AS month)
    SELECT to_char(m.month, 'Mon YY') AS label,
      COALESCE((SELECT SUM(subtotal) FROM invoices i WHERE i.tenant_id = ${tenantId} AND i.type IN ('sales', 'credit_note') AND i.status <> 'void' AND date_trunc('month', i.issue_date) = m.month), 0) AS sales,
      COALESCE((SELECT SUM(subtotal) FROM supplier_bills b WHERE b.tenant_id = ${tenantId} AND b.status <> 'void' AND date_trunc('month', b.bill_date) = m.month), 0) AS purchases,
      COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.tenant_id = ${tenantId} AND e.status = 'approved' AND date_trunc('month', e.expense_date) = m.month), 0) AS expenses
    FROM m ORDER BY m.month`);
  return list.map((r) => ({ label: r.label, sales: Math.round(num(r.sales)), purchases: Math.round(num(r.purchases)), expenses: Math.round(num(r.expenses)) }));
}

export async function lowStock(dbx: DbOrTx, tenantId: string, limit = 50) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT p.id, p.sku, p.name, p.reorder_level::float AS "reorderLevel", p.reorder_qty::float AS "reorderQty", p.min_stock::float AS "minStock", s.name AS "supplierName", p.default_supplier_id AS "supplierId",
      COALESCE(a.q, 0)::float AS available,
      COALESCE((SELECT SUM(l.quantity - l.received_qty) FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id WHERE l.product_id = p.id AND po.status IN ('draft', 'submitted', 'approved', 'partially_received')), 0)::float AS incoming
    FROM products p
    LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_balances WHERE tenant_id = ${tenantId} AND status = 'available' AND owner_customer_id IS NULL GROUP BY product_id) a ON a.product_id = p.id
    LEFT JOIN suppliers s ON s.id = p.default_supplier_id
    WHERE p.tenant_id = ${tenantId} AND p.status = 'active' AND p.reorder_level > 0 AND COALESCE(a.q, 0) <= p.reorder_level
    ORDER BY COALESCE(a.q, 0) / NULLIF(p.reorder_level, 0) ASC, p.sku LIMIT ${limit}`);
}

export async function expiringStock(dbx: DbOrTx, tenantId: string, days = 30, limit = 50) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT bt.id AS "batchId", bt.batch_no AS "batchNo", bt.expiry_date AS "expiryDate", (bt.expiry_date - CURRENT_DATE) AS "daysLeft", p.id AS "productId", p.sku, p.name,
      SUM(b.quantity)::float AS quantity, SUM(b.quantity * p.cost_price)::float AS value, string_agg(DISTINCT w.code, ', ') AS warehouses
    FROM batches bt JOIN products p ON p.id = bt.product_id JOIN inventory_balances b ON b.batch_id = bt.id AND b.quantity > 0 AND b.status IN ('available', 'reserved', 'quarantine')
    JOIN warehouses w ON w.id = b.warehouse_id
    WHERE bt.tenant_id = ${tenantId} AND bt.expiry_date IS NOT NULL AND bt.expiry_date <= CURRENT_DATE + ${days}::int
    GROUP BY bt.id, p.id ORDER BY bt.expiry_date LIMIT ${limit}`);
}

export async function deadStock(dbx: DbOrTx, tenantId: string, days = 90, limit = 100) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT p.id, p.sku, p.name, c.name AS category, SUM(b.quantity)::float AS quantity, SUM(b.quantity * p.cost_price)::float AS value,
      (SELECT MAX(created_at) FROM inventory_transactions m WHERE m.product_id = p.id AND m.transaction_type IN ('dispatch', 'pick')) AS "lastMovedAt",
      (SELECT MIN(created_at) FROM inventory_transactions m WHERE m.product_id = p.id AND m.transaction_type IN ('receipt', 'opening_balance')) AS "firstReceivedAt"
    FROM products p JOIN inventory_balances b ON b.product_id = p.id AND b.quantity > 0 AND b.owner_customer_id IS NULL LEFT JOIN product_categories c ON c.id = p.category_id
    WHERE p.tenant_id = ${tenantId}
      AND NOT EXISTS (SELECT 1 FROM inventory_transactions m WHERE m.tenant_id = p.tenant_id AND m.product_id = p.id AND m.transaction_type IN ('dispatch', 'pick') AND m.created_at >= now() - make_interval(days => ${days}))
    GROUP BY p.id, c.name ORDER BY value DESC LIMIT ${limit}`);
}

export async function topProductsByValue(dbx: DbOrTx, tenantId: string, limit = 10) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT p.id, p.sku, p.name, SUM(b.quantity)::float AS quantity, SUM(b.quantity * p.cost_price)::float AS value
    FROM inventory_balances b JOIN products p ON p.id = b.product_id WHERE b.tenant_id = ${tenantId} AND b.owner_customer_id IS NULL AND b.quantity > 0
    GROUP BY p.id ORDER BY value DESC LIMIT ${limit}`);
}

export async function topDebtors(dbx: DbOrTx, tenantId: string, minAmount = 0, limit = 10) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT c.id, c.name, c.phone, SUM(i.total - i.amount_paid)::float AS outstanding,
      SUM(i.total - i.amount_paid) FILTER (WHERE i.due_date < CURRENT_DATE)::float AS overdue, MAX(CURRENT_DATE - i.due_date) FILTER (WHERE i.due_date < CURRENT_DATE) AS "maxDaysOverdue", c.credit_limit::float AS "creditLimit"
    FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ${tenantId} AND i.status IN ('issued', 'partially_paid')
    GROUP BY c.id HAVING SUM(i.total - i.amount_paid) > ${minAmount} ORDER BY outstanding DESC LIMIT ${limit}`);
}

export async function supplierBalances(dbx: DbOrTx, tenantId: string, limit = 10) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT s.id, s.name, SUM(b.total - b.amount_paid)::float AS payable, SUM(b.total - b.amount_paid) FILTER (WHERE b.due_date < CURRENT_DATE)::float AS overdue
    FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id WHERE b.tenant_id = ${tenantId} AND b.status IN ('open', 'partially_paid')
    GROUP BY s.id ORDER BY payable DESC LIMIT ${limit}`);
}

export async function delayedOrders(dbx: DbOrTx, tenantId: string, limit = 50) {
  return rows<Record<string, unknown>>(dbx, sql`
    SELECT so.id, so.number, so.status, so.priority, so.required_date AS "requiredDate", so.confirmed_at AS "confirmedAt", so.total::float AS total, c.name AS "customerName",
      GREATEST(CURRENT_DATE - so.required_date, (CURRENT_DATE - so.confirmed_at::date) - 3) AS "daysLate"
    FROM sales_orders so JOIN customers c ON c.id = so.customer_id
    WHERE so.tenant_id = ${tenantId} AND ((so.required_date < CURRENT_DATE AND so.status IN ('confirmed', 'reserved', 'picking', 'packed')) OR (so.required_date IS NULL AND so.status IN ('confirmed', 'reserved', 'picking') AND so.confirmed_at < now() - interval '3 days'))
    ORDER BY "daysLate" DESC NULLS LAST LIMIT ${limit}`);
}

/** Per-product demand and cover — basis of stock intelligence and smart reorder. */
export async function productVelocity(dbx: DbOrTx, tenantId: string, productId?: string) {
  return rows<Record<string, unknown>>(dbx, sql`
    WITH demand AS (
      SELECT product_id,
        -SUM(quantity) FILTER (WHERE created_at >= now() - interval '30 days') AS d30,
        -SUM(quantity) FILTER (WHERE created_at >= now() - interval '90 days') AS d90,
        -SUM(quantity) FILTER (WHERE created_at >= now() - interval '180 days' AND created_at < now() - interval '90 days') AS prev90,
        MAX(created_at) AS last_out
      FROM inventory_transactions WHERE tenant_id = ${tenantId} AND transaction_type = 'dispatch' AND owner_customer_id IS NULL GROUP BY product_id
    ), stock AS (
      SELECT product_id, SUM(quantity) FILTER (WHERE status = 'available') AS available, SUM(quantity) FILTER (WHERE status = 'reserved') AS reserved, SUM(quantity) AS on_hand
      FROM inventory_balances WHERE tenant_id = ${tenantId} AND owner_customer_id IS NULL GROUP BY product_id
    ), incoming AS (
      SELECT l.product_id, SUM(GREATEST(l.quantity - l.received_qty, 0)) AS q FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
      WHERE po.tenant_id = ${tenantId} AND po.status IN ('submitted', 'approved', 'partially_received') GROUP BY l.product_id
    ), backlog AS (
      SELECT l.product_id, SUM(GREATEST(l.quantity - l.reserved_qty, 0)) AS q FROM sales_order_lines l JOIN sales_orders so ON so.id = l.sales_order_id
      WHERE so.tenant_id = ${tenantId} AND so.status IN ('confirmed', 'reserved', 'picking') GROUP BY l.product_id
    )
    SELECT p.id, p.sku, p.name, p.cost_price::float AS "unitCost", p.reorder_level::float AS "reorderLevel", p.reorder_qty::float AS "reorderQty", p.max_stock::float AS "maxStock", p.min_stock::float AS "minStock",
      COALESCE(s.available, 0)::float AS available, COALESCE(s.reserved, 0)::float AS reserved, COALESCE(s.on_hand, 0)::float AS "onHand", COALESCE(i.q, 0)::float AS incoming, COALESCE(bk.q, 0)::float AS backlog,
      COALESCE(d.d30, 0)::float AS "demand30d", COALESCE(d.d90, 0)::float AS "demand90d", COALESCE(d.prev90, 0)::float AS "demandPrev90d", d.last_out AS "lastDispatchAt",
      COALESCE(sp.lead_time_days, 7)::float AS "leadTimeDays", sp.id AS "supplierId", sp.name AS "supplierName", p.created_at AS "createdAt"
    FROM products p LEFT JOIN demand d ON d.product_id = p.id LEFT JOIN stock s ON s.product_id = p.id LEFT JOIN incoming i ON i.product_id = p.id
    LEFT JOIN backlog bk ON bk.product_id = p.id LEFT JOIN suppliers sp ON sp.id = p.default_supplier_id
    WHERE p.tenant_id = ${tenantId} AND p.status = 'active' ${productId ? sql`AND p.id = ${productId}` : sql``}`);
}

export interface StockInsight {
  productId: string; sku: string; name: string; onHand: number; available: number; avgDailyDemand: number; monthlyDemand: number;
  daysOfCover: number | null; monthsOfCover: number | null; classification: 'fast' | 'slow' | 'dead' | 'overstock' | 'understock' | 'normal' | 'new'; trend: 'rising' | 'falling' | 'stable' | 'none';
  seasonal: boolean; stockoutRisk: boolean; value: number; message: string;
}

export function classifyStock(v: Record<string, unknown>, deadDays = 90): StockInsight {
  const onHand = num(v.onHand), available = num(v.available), d90 = num(v.demand90d), prev = num(v.demandPrev90d), d30 = num(v.demand30d);
  const daily = d90 / 90;
  const monthly = Math.round(daily * 30 * 10) / 10;
  const cover = daily > 0 ? available / daily : null;
  const created = v.createdAt ? new Date(String(v.createdAt)) : new Date();
  const ageDays = (Date.now() - created.getTime()) / 86400_000;
  const lead = num(v.leadTimeDays) || 7;
  let classification: StockInsight['classification'] = 'normal';
  if (ageDays < 30 && d90 === 0) classification = 'new';
  else if (onHand > 0 && d90 === 0 && (!v.lastDispatchAt || (Date.now() - new Date(String(v.lastDispatchAt)).getTime()) / 86400_000 > deadDays)) classification = 'dead';
  else if (num(v.maxStock) > 0 && onHand > num(v.maxStock)) classification = 'overstock';
  else if (cover !== null && cover < lead) classification = 'understock';
  else if (cover !== null && cover > 180) classification = 'overstock';
  else if (d30 > 0 && daily > 0 && d30 / 30 >= daily * 1.0 && d90 >= 90) classification = 'fast';
  else if (d90 > 0 && cover !== null && cover > 90) classification = 'slow';
  const trend: StockInsight['trend'] = d90 === 0 && prev === 0 ? 'none' : prev === 0 ? 'rising' : d90 > prev * 1.25 ? 'rising' : d90 < prev * 0.75 ? 'falling' : 'stable';
  const seasonal = prev > 0 && (d90 > prev * 2 || d90 < prev * 0.4);
  const stockoutRisk = cover !== null && cover <= 30;
  const months = cover === null ? null : Math.round((cover / 30) * 10) / 10;
  const message = daily > 0
    ? `${v.sku} has ${onHand} units (${available} available). Average monthly demand is ${monthly} units. At the current rate, about ${months} month(s) of available stock remain.`
    : onHand > 0 ? `${v.sku} has ${onHand} units with no dispatches in the last 90 days.` : `${v.sku} has no stock and no recent demand.`;
  return { productId: String(v.id), sku: String(v.sku), name: String(v.name), onHand, available, avgDailyDemand: Math.round(daily * 100) / 100, monthlyDemand: monthly, daysOfCover: cover === null ? null : Math.round(cover), monthsOfCover: months, classification, trend, seasonal, stockoutRisk, value: Math.round(onHand * num(v.unitCost)), message };
}

export interface ReorderRecommendation {
  productId: string; sku: string; name: string; supplierId: string | null; supplierName: string | null; available: number; incoming: number; backlog: number;
  forecastDemand: number; safetyStock: number; projected: number; reorderLevel: number; suggestedQty: number; openPoQty: number;
  action: 'order_now' | 'wait' | 'reduce_order' | 'increase_order'; reasoning: string; unitCost: number; estimatedCost: number;
}

/**
 * Smart reorder: projected = available + incoming − backlog − forecast demand over
 * (lead time + review period). Recommends Order now / Wait / Reduce / Increase.
 * Never places orders itself — the UI turns a recommendation into a draft PO only
 * when the user confirms.
 */
export function reorderRecommendation(v: Record<string, unknown>, reviewDays = 14): ReorderRecommendation {
  const available = num(v.available), incoming = num(v.incoming), backlog = num(v.backlog), daily = num(v.demand90d) / 90;
  const lead = num(v.leadTimeDays) || 7;
  const horizon = lead + reviewDays;
  const forecast = Math.ceil(daily * horizon);
  const safety = Math.ceil(daily * Math.max(7, lead * 0.5));
  const reorderLevel = num(v.reorderLevel);
  const projected = available + incoming - backlog - forecast;
  const target = Math.max(forecast + safety, reorderLevel + num(v.reorderQty) * 0.5, num(v.minStock));
  const gap = Math.ceil(target - (available + incoming - backlog));
  const base = num(v.reorderQty) > 0 ? num(v.reorderQty) : Math.max(gap, 0);
  const maxStock = num(v.maxStock);
  let action: ReorderRecommendation['action'];
  let suggested = 0;
  let reasoning: string;
  const facts = `Available ${available}, incoming ${incoming}, unreserved backlog ${backlog}, forecast demand ${forecast} over ${horizon} days (lead time ${lead}d + ${reviewDays}d review, ${Math.round(daily * 100) / 100}/day from the last 90 days), safety stock ${safety}.`;
  if (gap <= 0 && available > reorderLevel) {
    action = incoming > 0 && available + incoming - backlog > target * 1.5 + num(v.reorderQty) ? 'reduce_order' : 'wait';
    reasoning = action === 'reduce_order' ? `Open purchase orders bring stock well above need. Consider reducing incoming orders. ${facts}` : `Stock covers expected demand through the next replenishment cycle. ${facts}`;
  } else if (incoming > 0 && gap > 0) {
    action = 'increase_order'; suggested = gap;
    reasoning = `Incoming purchase orders are not enough to cover demand plus safety stock; add about ${gap} units. ${facts}`;
  } else {
    action = 'order_now'; suggested = Math.max(base, gap, 1);
    reasoning = `Projected stock (${Math.round(projected)}) will fall below safety stock before the next delivery. ${facts}`;
  }
  if (maxStock > 0 && suggested + available + incoming > maxStock) suggested = Math.max(0, Math.floor(maxStock - available - incoming));
  return {
    productId: String(v.id), sku: String(v.sku), name: String(v.name), supplierId: (v.supplierId as string) ?? null, supplierName: (v.supplierName as string) ?? null,
    available, incoming, backlog, forecastDemand: forecast, safetyStock: safety, projected: Math.round(projected), reorderLevel, suggestedQty: suggested, openPoQty: incoming,
    action, reasoning, unitCost: num(v.unitCost), estimatedCost: Math.round(suggested * num(v.unitCost)),
  };
}
