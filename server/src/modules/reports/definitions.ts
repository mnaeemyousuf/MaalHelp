import { sql, type SQL } from 'drizzle-orm';
import type { Permission } from '@shared/permissions';

export type ColumnType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'percent' | 'status';
export interface ReportColumn { key: string; label: string; type: ColumnType }
export type FilterKey = 'warehouseId' | 'from' | 'to' | 'categoryId' | 'customerId' | 'supplierId' | 'productId' | 'days';

export interface ReportFilters {
  tenantId: string;
  warehouseId?: string;
  from: string;
  to: string;
  categoryId?: string;
  customerId?: string;
  supplierId?: string;
  productId?: string;
  days: number;
}

export interface ReportDefinition {
  key: string;
  name: string;
  category: 'Inventory' | 'Warehouse' | 'Sales' | 'Purchasing' | 'Financial';
  description: string;
  permission: Permission;
  filters: FilterKey[];
  columns: ReportColumn[];
  defaultSort: string;
  /** Summed in the report footer. */
  totals?: string[];
  query: (f: ReportFilters) => SQL;
}

const wh = (f: ReportFilters, col = 'warehouse_id') => (f.warehouseId ? sql`AND ${sql.raw(col)} = ${f.warehouseId}` : sql``);
const cat = (f: ReportFilters, col = 'p.category_id') => (f.categoryId ? sql`AND ${sql.raw(col)} = ${f.categoryId}` : sql``);
const range = (f: ReportFilters, col: string) => sql`AND ${sql.raw(col)} >= ${f.from}::date AND ${sql.raw(col)} < ${f.to}::date + 1`;
const C = (key: string, label: string, type: ColumnType = 'text'): ReportColumn => ({ key, label, type });

export const REPORTS: ReportDefinition[] = [
  // ───── Inventory ─────
  {
    key: 'current_inventory', name: 'Current inventory', category: 'Inventory', permission: 'inventory.view', description: 'Stock on hand by product, warehouse and status.',
    filters: ['warehouseId', 'categoryId'], defaultSort: 'sku', totals: ['available', 'reserved', 'other', 'on_hand'],
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('category', 'Category'), C('warehouse', 'Warehouse'), C('available', 'Available', 'number'), C('reserved', 'Reserved', 'number'), C('other', 'Damaged / other', 'number'), C('on_hand', 'On hand', 'number'), C('uom', 'UoM')],
    query: (f) => sql`SELECT p.sku, p.name, c.name AS category, w.code AS warehouse,
      SUM(b.quantity) FILTER (WHERE b.status = 'available') AS available, SUM(b.quantity) FILTER (WHERE b.status = 'reserved') AS reserved,
      SUM(b.quantity) FILTER (WHERE b.status NOT IN ('available', 'reserved')) AS other, SUM(b.quantity) AS on_hand, p.uom
      FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 AND b.owner_customer_id IS NULL ${wh(f, 'b.warehouse_id')} ${cat(f)} GROUP BY p.id, c.name, w.code`,
  },
  {
    key: 'inventory_valuation', name: 'Inventory valuation', category: 'Inventory', permission: 'report.financial', description: 'Quantity × moving-average cost for company-owned stock.',
    filters: ['warehouseId', 'categoryId'], defaultSort: 'value', totals: ['quantity', 'value', 'retail_value'],
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('category', 'Category'), C('quantity', 'Quantity', 'number'), C('unit_cost', 'Avg cost', 'money'), C('value', 'Cost value', 'money'), C('retail_value', 'Retail value', 'money'), C('share_pct', '% of total', 'percent')],
    query: (f) => sql`SELECT p.sku, p.name, c.name AS category, SUM(b.quantity) AS quantity, p.cost_price AS unit_cost, SUM(b.quantity * p.cost_price) AS value, SUM(b.quantity * p.selling_price) AS retail_value,
      100.0 * SUM(b.quantity * p.cost_price) / NULLIF(SUM(SUM(b.quantity * p.cost_price)) OVER (), 0) AS share_pct
      FROM inventory_balances b JOIN products p ON p.id = b.product_id LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 AND b.owner_customer_id IS NULL ${wh(f, 'b.warehouse_id')} ${cat(f)} GROUP BY p.id, c.name`,
  },
  {
    key: 'stock_movement', name: 'Stock movement', category: 'Inventory', permission: 'inventory.view', description: 'Every ledger transaction in the period.',
    filters: ['warehouseId', 'from', 'to', 'productId'], defaultSort: 'created_at',
    columns: [C('created_at', 'Date', 'datetime'), C('type', 'Type', 'status'), C('reference', 'Reference'), C('sku', 'SKU'), C('name', 'Product'), C('warehouse', 'Warehouse'), C('location', 'Location'), C('status', 'Stock status', 'status'), C('quantity', 'Qty', 'number'), C('balance_after', 'Balance after', 'number'), C('user_name', 'By'), C('reason', 'Reason')],
    query: (f) => sql`SELECT m.created_at, m.transaction_type AS type, m.reference_no AS reference, p.sku, p.name, w.code AS warehouse, l.code AS location, m.status, m.quantity, m.balance_after, u.name AS user_name, m.reason
      FROM inventory_transactions m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id JOIN locations l ON l.id = m.location_id LEFT JOIN users u ON u.id = m.performed_by
      WHERE m.tenant_id = ${f.tenantId} ${range(f, 'm.created_at')} ${wh(f, 'm.warehouse_id')} ${f.productId ? sql`AND m.product_id = ${f.productId}` : sql``}`,
  },
  {
    key: 'stock_aging', name: 'Stock aging', category: 'Inventory', permission: 'inventory.view', description: 'On-hand quantity by age since receipt (FIFO approximation).',
    filters: ['warehouseId', 'categoryId'], defaultSort: 'over_180',
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('on_hand', 'On hand', 'number'), C('d0_30', '0–30 days', 'number'), C('d31_90', '31–90 days', 'number'), C('d91_180', '91–180 days', 'number'), C('over_180', '180+ days', 'number'), C('oldest_receipt', 'Oldest receipt', 'date')],
    totals: ['on_hand', 'd0_30', 'd31_90', 'd91_180', 'over_180'],
    query: (f) => sql`WITH oh AS (SELECT product_id, SUM(quantity) AS q FROM inventory_balances WHERE tenant_id = ${f.tenantId} AND owner_customer_id IS NULL ${wh(f)} GROUP BY product_id HAVING SUM(quantity) > 0),
      rc AS (SELECT product_id, created_at, quantity, SUM(quantity) OVER (PARTITION BY product_id ORDER BY created_at DESC ROWS UNBOUNDED PRECEDING) AS cum FROM inventory_transactions WHERE tenant_id = ${f.tenantId} AND transaction_type IN ('receipt', 'opening_balance', 'return') AND quantity > 0 ${wh(f)}),
      alloc AS (SELECT rc.product_id, rc.created_at, GREATEST(LEAST(rc.quantity, oh.q - (rc.cum - rc.quantity)), 0) AS q FROM rc JOIN oh ON oh.product_id = rc.product_id WHERE rc.cum - rc.quantity < oh.q)
      SELECT p.sku, p.name, oh.q AS on_hand,
        COALESCE(SUM(a.q) FILTER (WHERE a.created_at >= now() - interval '30 days'), 0) AS d0_30,
        COALESCE(SUM(a.q) FILTER (WHERE a.created_at < now() - interval '30 days' AND a.created_at >= now() - interval '90 days'), 0) AS d31_90,
        COALESCE(SUM(a.q) FILTER (WHERE a.created_at < now() - interval '90 days' AND a.created_at >= now() - interval '180 days'), 0) AS d91_180,
        COALESCE(SUM(a.q) FILTER (WHERE a.created_at < now() - interval '180 days'), 0) AS over_180, MIN(a.created_at) AS oldest_receipt
      FROM oh JOIN products p ON p.id = oh.product_id LEFT JOIN alloc a ON a.product_id = oh.product_id WHERE true ${cat(f)} GROUP BY p.id, oh.q`,
  },
  {
    key: 'dead_stock', name: 'Dead stock', category: 'Inventory', permission: 'inventory.view', description: 'Stock with no picks or dispatches in the selected number of days (default 90).',
    filters: ['warehouseId', 'categoryId', 'days'], defaultSort: 'value', totals: ['quantity', 'value'],
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('category', 'Category'), C('quantity', 'Quantity', 'number'), C('value', 'Value', 'money'), C('last_moved', 'Last dispatched', 'date'), C('days_idle', 'Days idle', 'number')],
    query: (f) => sql`SELECT p.sku, p.name, c.name AS category, SUM(b.quantity) AS quantity, SUM(b.quantity * p.cost_price) AS value,
      (SELECT MAX(created_at) FROM inventory_transactions m WHERE m.product_id = p.id AND m.transaction_type = 'dispatch') AS last_moved,
      CURRENT_DATE - COALESCE((SELECT MAX(created_at) FROM inventory_transactions m WHERE m.product_id = p.id AND m.transaction_type = 'dispatch'), (SELECT MIN(created_at) FROM inventory_transactions m WHERE m.product_id = p.id))::date AS days_idle
      FROM inventory_balances b JOIN products p ON p.id = b.product_id LEFT JOIN product_categories c ON c.id = p.category_id
      WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 AND b.owner_customer_id IS NULL ${wh(f, 'b.warehouse_id')} ${cat(f)}
        AND NOT EXISTS (SELECT 1 FROM inventory_transactions m WHERE m.product_id = p.id AND m.transaction_type IN ('dispatch', 'pick') AND m.created_at >= now() - make_interval(days => ${f.days}))
      GROUP BY p.id, c.name`,
  },
  {
    key: 'slow_moving', name: 'Slow-moving stock', category: 'Inventory', permission: 'inventory.view', description: 'Items with more than 90 days of cover at the last-90-day rate.',
    filters: ['warehouseId', 'categoryId'], defaultSort: 'days_cover',
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('on_hand', 'On hand', 'number'), C('sold_90d', 'Dispatched 90d', 'number'), C('days_cover', 'Days of cover', 'number'), C('value', 'Value', 'money')],
    query: (f) => sql`SELECT * FROM (SELECT p.sku, p.name, SUM(b.quantity) AS on_hand, d.q AS sold_90d, ROUND(SUM(b.quantity) / NULLIF(d.q / 90.0, 0)) AS days_cover, SUM(b.quantity * p.cost_price) AS value
      FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN (SELECT product_id, -SUM(quantity) AS q FROM inventory_transactions WHERE tenant_id = ${f.tenantId} AND transaction_type = 'dispatch' AND created_at >= now() - interval '90 days' GROUP BY product_id) d ON d.product_id = p.id
      WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 AND b.owner_customer_id IS NULL ${wh(f, 'b.warehouse_id')} ${cat(f)} GROUP BY p.id, d.q) x WHERE days_cover > 90`,
  },
  {
    key: 'fast_moving', name: 'Fast-moving stock', category: 'Inventory', permission: 'inventory.view', description: 'Top movers by units dispatched in the period.',
    filters: ['warehouseId', 'from', 'to', 'categoryId'], defaultSort: 'dispatched', totals: ['dispatched'],
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('dispatched', 'Units dispatched', 'number'), C('orders', 'Orders', 'number'), C('share_pct', 'Share of volume', 'percent'), C('available', 'Available now', 'number')],
    query: (f) => sql`SELECT p.sku, p.name, -SUM(m.quantity) AS dispatched, COUNT(DISTINCT m.reference_id) AS orders, 100.0 * -SUM(m.quantity) / NULLIF(SUM(-SUM(m.quantity)) OVER (), 0) AS share_pct,
      (SELECT COALESCE(SUM(quantity), 0) FROM inventory_balances b WHERE b.product_id = p.id AND b.status = 'available') AS available
      FROM inventory_transactions m JOIN products p ON p.id = m.product_id WHERE m.tenant_id = ${f.tenantId} AND m.transaction_type = 'dispatch' ${range(f, 'm.created_at')} ${wh(f, 'm.warehouse_id')} ${cat(f)} GROUP BY p.id`,
  },
  {
    key: 'low_stock', name: 'Low stock', category: 'Inventory', permission: 'inventory.view', description: 'Products at or below reorder level, with incoming PO quantity.',
    filters: ['categoryId'], defaultSort: 'available',
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('available', 'Available', 'number'), C('reorder_level', 'Reorder level', 'number'), C('reorder_qty', 'Reorder qty', 'number'), C('incoming', 'On order', 'number'), C('supplier', 'Supplier')],
    query: (f) => sql`SELECT p.sku, p.name, COALESCE(a.q, 0) AS available, p.reorder_level, p.reorder_qty,
      COALESCE((SELECT SUM(l.quantity - l.received_qty) FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id WHERE l.product_id = p.id AND po.status IN ('submitted', 'approved', 'partially_received')), 0) AS incoming, s.name AS supplier
      FROM products p LEFT JOIN (SELECT product_id, SUM(quantity) AS q FROM inventory_balances WHERE tenant_id = ${f.tenantId} AND status = 'available' AND owner_customer_id IS NULL GROUP BY product_id) a ON a.product_id = p.id
      LEFT JOIN suppliers s ON s.id = p.default_supplier_id WHERE p.tenant_id = ${f.tenantId} AND p.status = 'active' AND p.reorder_level > 0 AND COALESCE(a.q, 0) <= p.reorder_level ${cat(f)}`,
  },
  {
    key: 'expiry', name: 'Expiry report', category: 'Inventory', permission: 'inventory.view', description: 'Batches expiring within the selected number of days (default 90), including expired.',
    filters: ['warehouseId', 'days'], defaultSort: 'expiry_date',
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('batch_no', 'Batch'), C('expiry_date', 'Expiry', 'date'), C('days_left', 'Days left', 'number'), C('quantity', 'Quantity', 'number'), C('value', 'Value', 'money'), C('locations', 'Locations')],
    query: (f) => sql`SELECT p.sku, p.name, bt.batch_no, bt.expiry_date, bt.expiry_date - CURRENT_DATE AS days_left, SUM(b.quantity) AS quantity, SUM(b.quantity * p.cost_price) AS value, string_agg(DISTINCT l.code, ', ') AS locations
      FROM batches bt JOIN products p ON p.id = bt.product_id JOIN inventory_balances b ON b.batch_id = bt.id AND b.quantity > 0 JOIN locations l ON l.id = b.location_id
      WHERE bt.tenant_id = ${f.tenantId} AND bt.expiry_date <= CURRENT_DATE + ${f.days}::int ${wh(f, 'b.warehouse_id')} GROUP BY bt.id, p.id`,
  },
  {
    key: 'batch', name: 'Batch / lot report', category: 'Inventory', permission: 'inventory.view', description: 'All batches with supplier, dates and stock.',
    filters: ['productId'], defaultSort: 'created_at',
    columns: [C('batch_no', 'Batch'), C('lot_no', 'Lot'), C('sku', 'SKU'), C('name', 'Product'), C('supplier', 'Supplier'), C('mfg_date', 'Mfg', 'date'), C('expiry_date', 'Expiry', 'date'), C('on_hand', 'On hand', 'number'), C('status', 'Status', 'status'), C('created_at', 'Received', 'date')],
    query: (f) => sql`SELECT bt.batch_no, bt.lot_no, p.sku, p.name, s.name AS supplier, bt.mfg_date, bt.expiry_date, COALESCE((SELECT SUM(quantity) FROM inventory_balances b WHERE b.batch_id = bt.id), 0) AS on_hand, bt.status, bt.created_at
      FROM batches bt JOIN products p ON p.id = bt.product_id LEFT JOIN suppliers s ON s.id = bt.supplier_id WHERE bt.tenant_id = ${f.tenantId} ${f.productId ? sql`AND bt.product_id = ${f.productId}` : sql``}`,
  },
  {
    key: 'serial', name: 'Serial number report', category: 'Inventory', permission: 'inventory.view', description: 'Serial numbers with status and current location.',
    filters: ['productId', 'warehouseId'], defaultSort: 'updated_at',
    columns: [C('serial', 'Serial'), C('sku', 'SKU'), C('name', 'Product'), C('status', 'Status', 'status'), C('warehouse', 'Warehouse'), C('location', 'Location'), C('updated_at', 'Last change', 'datetime')],
    query: (f) => sql`SELECT s.serial, p.sku, p.name, s.status, w.code AS warehouse, l.code AS location, s.updated_at FROM serial_numbers s JOIN products p ON p.id = s.product_id LEFT JOIN warehouses w ON w.id = s.warehouse_id LEFT JOIN locations l ON l.id = s.location_id
      WHERE s.tenant_id = ${f.tenantId} ${f.productId ? sql`AND s.product_id = ${f.productId}` : sql``} ${wh(f, 's.warehouse_id')}`,
  },
  {
    key: 'damaged_stock', name: 'Damaged, quarantined & blocked stock', category: 'Inventory', permission: 'inventory.view', description: 'Stock that cannot be sold.',
    filters: ['warehouseId'], defaultSort: 'value', totals: ['quantity', 'value'],
    columns: [C('status', 'Status', 'status'), C('sku', 'SKU'), C('name', 'Product'), C('warehouse', 'Warehouse'), C('location', 'Location'), C('batch_no', 'Batch'), C('quantity', 'Quantity', 'number'), C('value', 'Value', 'money')],
    query: (f) => sql`SELECT b.status, p.sku, p.name, w.code AS warehouse, l.code AS location, bt.batch_no, b.quantity, b.quantity * p.cost_price AS value
      FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id JOIN locations l ON l.id = b.location_id LEFT JOIN batches bt ON bt.id = b.batch_id
      WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 AND b.status IN ('damaged', 'quarantine', 'blocked', 'expired') ${wh(f, 'b.warehouse_id')}`,
  },
  {
    key: 'adjustments', name: 'Adjustment report', category: 'Inventory', permission: 'inventory.view', description: 'Stock adjustments with reason, value and approver.',
    filters: ['warehouseId', 'from', 'to'], defaultSort: 'created_at', totals: ['quantity_delta', 'value'],
    columns: [C('created_at', 'Date', 'datetime'), C('number', 'Number'), C('status', 'Status', 'status'), C('sku', 'SKU'), C('location', 'Location'), C('reason_code', 'Reason', 'status'), C('quantity_delta', 'Qty change', 'number'), C('value', 'Value', 'money'), C('requested_by', 'Requested by'), C('approved_by', 'Approved by'), C('notes', 'Notes')],
    query: (f) => sql`SELECT a.created_at, a.number, a.status, p.sku, l.code AS location, a.reason_code, a.quantity_delta, a.value, ru.name AS requested_by, au.name AS approved_by, a.notes
      FROM stock_adjustments a JOIN products p ON p.id = a.product_id JOIN locations l ON l.id = a.location_id LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users au ON au.id = a.approved_by
      WHERE a.tenant_id = ${f.tenantId} ${range(f, 'a.created_at')} ${wh(f, 'a.warehouse_id')}`,
  },
  {
    key: 'customer_owned_stock', name: 'Customer-owned (consignment) stock', category: 'Inventory', permission: 'inventory.view', description: 'Stock held on behalf of storage clients, by owner.',
    filters: ['warehouseId', 'customerId'], defaultSort: 'owner',
    columns: [C('owner', 'Owner'), C('sku', 'SKU'), C('name', 'Product'), C('warehouse', 'Warehouse'), C('location', 'Location'), C('quantity', 'Quantity', 'number'), C('volume_m3', 'Volume m³', 'number')],
    query: (f) => sql`SELECT c.name AS owner, p.sku, p.name, w.code AS warehouse, l.code AS location, b.quantity, b.quantity * p.volume_m3 AS volume_m3
      FROM inventory_balances b JOIN customers c ON c.id = b.owner_customer_id JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id JOIN locations l ON l.id = b.location_id
      WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 ${wh(f, 'b.warehouse_id')} ${f.customerId ? sql`AND b.owner_customer_id = ${f.customerId}` : sql``}`,
  },
  // ───── Warehouse ─────
  {
    key: 'location_utilization', name: 'Location utilisation', category: 'Warehouse', permission: 'warehouse.view', description: 'Every storage location with occupancy against capacity.',
    filters: ['warehouseId'], defaultSort: 'utilization_pct',
    columns: [C('warehouse', 'Warehouse'), C('code', 'Location'), C('type', 'Type', 'status'), C('units', 'Units', 'number'), C('capacity_units', 'Unit capacity', 'number'), C('volume', 'Volume m³', 'number'), C('capacity_volume_m3', 'Volume capacity', 'number'), C('utilization_pct', 'Utilisation', 'percent'), C('skus', 'SKUs', 'number')],
    query: (f) => sql`SELECT w.code AS warehouse, l.code, l.type, COALESCE(SUM(b.quantity), 0) AS units, l.capacity_units, COALESCE(SUM(b.quantity * p.volume_m3), 0) AS volume, l.capacity_volume_m3,
      100.0 * GREATEST(COALESCE(SUM(b.quantity), 0) / NULLIF(l.capacity_units, 0), COALESCE(SUM(b.quantity * p.volume_m3), 0) / NULLIF(l.capacity_volume_m3, 0)) AS utilization_pct, COUNT(DISTINCT b.product_id) AS skus
      FROM locations l JOIN warehouses w ON w.id = l.warehouse_id LEFT JOIN inventory_balances b ON b.location_id = l.id AND b.quantity > 0 LEFT JOIN products p ON p.id = b.product_id
      WHERE l.tenant_id = ${f.tenantId} AND NOT EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id) ${wh(f, 'l.warehouse_id')} GROUP BY l.id, w.code`,
  },
  {
    key: 'warehouse_utilization', name: 'Warehouse utilisation', category: 'Warehouse', permission: 'warehouse.view', description: 'Occupied vs empty storage locations and cubic utilisation per warehouse.',
    filters: [], defaultSort: 'occupied_pct',
    columns: [C('warehouse', 'Warehouse'), C('capacity', 'Capacity'), C('locations', 'Storage locations', 'number'), C('occupied', 'Occupied', 'number'), C('empty', 'Empty', 'number'), C('occupied_pct', 'Locations used', 'percent'), C('volume_used', 'Volume used m³', 'number'), C('volume_capacity', 'Volume capacity m³', 'number'), C('cubic_pct', 'Cubic utilisation', 'percent')],
    query: (f) => sql`WITH leaf AS (SELECT l.* FROM locations l WHERE l.tenant_id = ${f.tenantId} AND l.type NOT IN ('dock', 'staging') AND NOT EXISTS (SELECT 1 FROM locations c WHERE c.parent_id = l.id)),
      used AS (SELECT b.location_id, SUM(b.quantity) AS q, SUM(b.quantity * p.volume_m3) AS v FROM inventory_balances b JOIN products p ON p.id = b.product_id WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 GROUP BY b.location_id)
      SELECT w.code || ' · ' || w.name AS warehouse, w.capacity || ' ' || w.capacity_unit AS capacity, COUNT(leaf.id) AS locations, COUNT(used.location_id) AS occupied, COUNT(leaf.id) - COUNT(used.location_id) AS empty,
        100.0 * COUNT(used.location_id) / NULLIF(COUNT(leaf.id), 0) AS occupied_pct, COALESCE(SUM(used.v), 0) AS volume_used, SUM(leaf.capacity_volume_m3) AS volume_capacity, 100.0 * COALESCE(SUM(used.v), 0) / NULLIF(SUM(leaf.capacity_volume_m3), 0) AS cubic_pct
      FROM warehouses w LEFT JOIN leaf ON leaf.warehouse_id = w.id LEFT JOIN used ON used.location_id = leaf.id WHERE w.tenant_id = ${f.tenantId} GROUP BY w.id`,
  },
  {
    key: 'receiving_performance', name: 'Receiving performance', category: 'Warehouse', permission: 'report.view', description: 'GRNs with on-time status, variances and putaway lead time.',
    filters: ['warehouseId', 'from', 'to', 'supplierId'], defaultSort: 'received_at',
    columns: [C('received_at', 'Received', 'datetime'), C('number', 'GRN'), C('po', 'PO'), C('supplier', 'Supplier'), C('lines', 'Lines', 'number'), C('units', 'Units', 'number'), C('variance_lines', 'Variance lines', 'number'), C('on_time', 'On time', 'status'), C('putaway_hours', 'Hours to putaway', 'number'), C('received_by', 'Received by')],
    query: (f) => sql`SELECT g.received_at, g.number, po.number AS po, s.name AS supplier, COUNT(gl.id) AS lines, SUM(gl.received_qty) AS units, COUNT(gl.id) FILTER (WHERE gl.variance_type IN ('short', 'over')) AS variance_lines,
      CASE WHEN po.expected_date IS NULL THEN 'n/a' WHEN g.received_at::date <= po.expected_date THEN 'yes' ELSE 'late' END AS on_time,
      ROUND(EXTRACT(EPOCH FROM (SELECT MAX(completed_at) FROM putaway_tasks pt WHERE pt.receipt_id = g.id) - g.received_at) / 3600.0, 1) AS putaway_hours, u.name AS received_by
      FROM goods_receipts g JOIN goods_receipt_lines gl ON gl.receipt_id = g.id LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN users u ON u.id = g.received_by
      WHERE g.tenant_id = ${f.tenantId} ${range(f, 'g.received_at')} ${wh(f, 'g.warehouse_id')} ${f.supplierId ? sql`AND g.supplier_id = ${f.supplierId}` : sql``} GROUP BY g.id, po.number, po.expected_date, s.name, u.name`,
  },
  {
    key: 'picking_performance', name: 'Picking performance', category: 'Warehouse', permission: 'report.view', description: 'Picks per picker with short-pick rate.',
    filters: ['warehouseId', 'from', 'to'], defaultSort: 'units',
    columns: [C('picker', 'Picker'), C('tasks', 'Tasks', 'number'), C('units', 'Units picked', 'number'), C('orders', 'Orders', 'number'), C('short_tasks', 'Short picks', 'number'), C('accuracy_pct', 'Accuracy', 'percent')],
    query: (f) => sql`SELECT COALESCE(u.name, 'Unassigned') AS picker, COUNT(*) AS tasks, SUM(pt.picked_qty) AS units, COUNT(DISTINCT pt.sales_order_id) AS orders, COUNT(*) FILTER (WHERE pt.status = 'short') AS short_tasks,
      100.0 - 100.0 * COUNT(*) FILTER (WHERE pt.status = 'short') / NULLIF(COUNT(*), 0) AS accuracy_pct
      FROM pick_tasks pt LEFT JOIN users u ON u.id = pt.picked_by WHERE pt.tenant_id = ${f.tenantId} AND pt.status IN ('completed', 'short') ${range(f, 'pt.picked_at')} ${wh(f, 'pt.warehouse_id')} GROUP BY u.name`,
  },
  {
    key: 'dispatch_performance', name: 'Dispatch performance', category: 'Warehouse', permission: 'report.view', description: 'Order-to-dispatch time and delivery outcome by carrier.',
    filters: ['warehouseId', 'from', 'to'], defaultSort: 'shipments',
    columns: [C('carrier', 'Carrier'), C('shipments', 'Shipments', 'number'), C('delivered', 'Delivered', 'number'), C('failed', 'Failed / returned', 'number'), C('avg_hours_to_dispatch', 'Avg hours order→dispatch', 'number'), C('on_time_pct', 'Dispatched by required date', 'percent')],
    query: (f) => sql`SELECT COALESCE(NULLIF(s.carrier, ''), 'Unspecified') AS carrier, COUNT(*) AS shipments, COUNT(*) FILTER (WHERE s.status = 'delivered') AS delivered, COUNT(*) FILTER (WHERE s.status IN ('failed', 'returned')) AS failed,
      ROUND(AVG(EXTRACT(EPOCH FROM s.dispatched_at - so.confirmed_at) / 3600.0)::numeric, 1) AS avg_hours_to_dispatch,
      100.0 * COUNT(*) FILTER (WHERE so.required_date IS NULL OR s.dispatched_at::date <= so.required_date) / NULLIF(COUNT(*), 0) AS on_time_pct
      FROM shipments s JOIN sales_orders so ON so.id = s.sales_order_id WHERE s.tenant_id = ${f.tenantId} AND s.dispatched_at IS NOT NULL ${range(f, 's.dispatched_at')} ${wh(f, 's.warehouse_id')} GROUP BY 1`,
  },
  {
    key: 'inventory_accuracy', name: 'Inventory accuracy', category: 'Warehouse', permission: 'report.view', description: 'Posted counts: lines counted, lines with variance and accuracy %.',
    filters: ['warehouseId', 'from', 'to'], defaultSort: 'posted_at',
    columns: [C('posted_at', 'Posted', 'datetime'), C('number', 'Count'), C('type', 'Type', 'status'), C('lines', 'Lines', 'number'), C('variance_lines', 'Lines with variance', 'number'), C('accuracy_pct', 'Accuracy', 'percent'), C('variance_value', 'Abs. variance value', 'money')],
    query: (f) => sql`SELECT c.posted_at, c.number, c.type, COUNT(l.id) AS lines, COUNT(l.id) FILTER (WHERE l.variance_qty <> 0) AS variance_lines, 100.0 - 100.0 * COUNT(l.id) FILTER (WHERE l.variance_qty <> 0) / NULLIF(COUNT(l.id), 0) AS accuracy_pct, c.variance_value
      FROM stock_counts c JOIN stock_count_lines l ON l.count_id = c.id WHERE c.tenant_id = ${f.tenantId} AND c.status = 'posted' ${range(f, 'c.posted_at')} ${wh(f, 'c.warehouse_id')} GROUP BY c.id`,
  },
  {
    key: 'stock_variance', name: 'Stock variance', category: 'Warehouse', permission: 'report.view', description: 'Count lines with differences between expected and counted.',
    filters: ['warehouseId', 'from', 'to'], defaultSort: 'variance_value', totals: ['variance_qty', 'variance_value'],
    columns: [C('number', 'Count'), C('location', 'Location'), C('sku', 'SKU'), C('expected_qty', 'Expected', 'number'), C('counted_qty', 'Counted', 'number'), C('variance_qty', 'Variance', 'number'), C('variance_value', 'Value', 'money'), C('counted_by', 'Counted by')],
    query: (f) => sql`SELECT c.number, loc.code AS location, p.sku, l.expected_qty, l.counted_qty, l.variance_qty, l.variance_value, u.name AS counted_by
      FROM stock_count_lines l JOIN stock_counts c ON c.id = l.count_id JOIN locations loc ON loc.id = l.location_id JOIN products p ON p.id = l.product_id LEFT JOIN users u ON u.id = l.counted_by
      WHERE l.tenant_id = ${f.tenantId} AND l.variance_qty <> 0 ${range(f, 'l.counted_at')} ${wh(f, 'c.warehouse_id')}`,
  },
  // ───── Sales ─────
  {
    key: 'sales_by_customer', name: 'Sales by customer', category: 'Sales', permission: 'report.view', description: 'Invoiced sales net of tax by customer.',
    filters: ['from', 'to', 'warehouseId'], defaultSort: 'net_sales', totals: ['invoices', 'net_sales', 'tax', 'gross'],
    columns: [C('customer', 'Customer'), C('invoices', 'Invoices', 'number'), C('net_sales', 'Net sales', 'money'), C('tax', 'Tax', 'money'), C('gross', 'Gross', 'money'), C('outstanding', 'Outstanding', 'money')],
    query: (f) => sql`SELECT c.name AS customer, COUNT(*) AS invoices, SUM(i.subtotal) AS net_sales, SUM(i.tax_total) AS tax, SUM(i.total) AS gross, SUM(i.total - i.amount_paid) FILTER (WHERE i.status IN ('issued', 'partially_paid')) AS outstanding
      FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ${f.tenantId} AND i.type IN ('sales', 'credit_note') AND i.status <> 'void' AND i.issue_date BETWEEN ${f.from} AND ${f.to} ${wh(f, 'i.warehouse_id')} GROUP BY c.id`,
  },
  {
    key: 'sales_by_product', name: 'Sales by product', category: 'Sales', permission: 'report.view', description: 'Shipped quantity, revenue and margin by product.',
    filters: ['from', 'to', 'warehouseId', 'categoryId', 'customerId'], defaultSort: 'revenue', totals: ['quantity', 'revenue', 'cost', 'margin'],
    columns: [C('sku', 'SKU'), C('name', 'Product'), C('quantity', 'Qty shipped', 'number'), C('revenue', 'Revenue', 'money'), C('cost', 'Cost', 'money'), C('margin', 'Margin', 'money'), C('margin_pct', 'Margin %', 'percent')],
    query: (f) => sql`SELECT p.sku, p.name, SUM(l.shipped_qty) AS quantity, SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)) AS revenue, SUM(l.shipped_qty * l.unit_cost) AS cost,
      SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)) - SUM(l.shipped_qty * l.unit_cost) AS margin,
      100.0 * (SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)) - SUM(l.shipped_qty * l.unit_cost)) / NULLIF(SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)), 0) AS margin_pct
      FROM sales_order_lines l JOIN sales_orders so ON so.id = l.sales_order_id JOIN products p ON p.id = l.product_id
      WHERE so.tenant_id = ${f.tenantId} AND l.shipped_qty > 0 ${range(f, 'so.dispatched_at')} ${wh(f, 'so.warehouse_id')} ${cat(f)} ${f.customerId ? sql`AND so.customer_id = ${f.customerId}` : sql``} GROUP BY p.id`,
  },
  {
    key: 'sales_by_warehouse', name: 'Sales by warehouse', category: 'Sales', permission: 'report.view', description: 'Orders, units and revenue shipped from each warehouse.',
    filters: ['from', 'to'], defaultSort: 'revenue', totals: ['orders', 'units', 'revenue'],
    columns: [C('warehouse', 'Warehouse'), C('orders', 'Orders', 'number'), C('units', 'Units', 'number'), C('revenue', 'Revenue', 'money')],
    query: (f) => sql`SELECT w.code || ' · ' || w.name AS warehouse, COUNT(DISTINCT so.id) AS orders, SUM(l.shipped_qty) AS units, SUM(l.shipped_qty * l.unit_price * (1 - l.discount_pct / 100)) AS revenue
      FROM sales_orders so JOIN sales_order_lines l ON l.sales_order_id = so.id JOIN warehouses w ON w.id = so.warehouse_id WHERE so.tenant_id = ${f.tenantId} AND l.shipped_qty > 0 ${range(f, 'so.dispatched_at')} GROUP BY w.id`,
  },
  {
    key: 'sales_by_date', name: 'Sales by date', category: 'Sales', permission: 'report.view', description: 'Daily orders and invoiced sales.',
    filters: ['from', 'to', 'warehouseId'], defaultSort: 'day', totals: ['orders', 'net_sales'],
    columns: [C('day', 'Date', 'date'), C('orders', 'Orders created', 'number'), C('invoices', 'Invoices', 'number'), C('net_sales', 'Net sales', 'money')],
    query: (f) => sql`WITH d AS (SELECT generate_series(${f.from}::date, ${f.to}::date, interval '1 day')::date AS day)
      SELECT d.day, (SELECT COUNT(*) FROM sales_orders so WHERE so.tenant_id = ${f.tenantId} AND so.order_date = d.day ${wh(f, 'so.warehouse_id')}) AS orders,
        (SELECT COUNT(*) FROM invoices i WHERE i.tenant_id = ${f.tenantId} AND i.type = 'sales' AND i.issue_date = d.day ${wh(f, 'i.warehouse_id')}) AS invoices,
        (SELECT COALESCE(SUM(subtotal), 0) FROM invoices i WHERE i.tenant_id = ${f.tenantId} AND i.type IN ('sales', 'credit_note') AND i.status <> 'void' AND i.issue_date = d.day ${wh(f, 'i.warehouse_id')}) AS net_sales FROM d`,
  },
  {
    key: 'receivables', name: 'Outstanding receivables', category: 'Sales', permission: 'billing.view', description: 'Unpaid customer invoices with days overdue.',
    filters: ['customerId'], defaultSort: 'days_overdue', totals: ['total', 'paid', 'balance'],
    columns: [C('number', 'Invoice'), C('customer', 'Customer'), C('type', 'Type', 'status'), C('issue_date', 'Issued', 'date'), C('due_date', 'Due', 'date'), C('days_overdue', 'Days overdue', 'number'), C('total', 'Total', 'money'), C('paid', 'Paid', 'money'), C('balance', 'Balance', 'money')],
    query: (f) => sql`SELECT i.number, c.name AS customer, i.type, i.issue_date, i.due_date, GREATEST(CURRENT_DATE - i.due_date, 0) AS days_overdue, i.total, i.amount_paid AS paid, i.total - i.amount_paid AS balance
      FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.tenant_id = ${f.tenantId} AND i.status IN ('issued', 'partially_paid') ${f.customerId ? sql`AND i.customer_id = ${f.customerId}` : sql``}`,
  },
  // ───── Purchasing ─────
  {
    key: 'purchases_by_supplier', name: 'Purchases by supplier', category: 'Purchasing', permission: 'report.view', description: 'Purchase order value and received value by supplier.',
    filters: ['from', 'to', 'warehouseId'], defaultSort: 'ordered_value', totals: ['orders', 'ordered_value', 'received_value'],
    columns: [C('supplier', 'Supplier'), C('orders', 'POs', 'number'), C('ordered_value', 'Ordered value', 'money'), C('received_value', 'Received value', 'money'), C('fill_rate_pct', 'Fill rate', 'percent')],
    query: (f) => sql`SELECT s.name AS supplier, COUNT(DISTINCT po.id) AS orders, SUM(l.quantity * l.unit_cost) AS ordered_value, SUM(l.received_qty * l.unit_cost) AS received_value, 100.0 * SUM(l.received_qty) / NULLIF(SUM(l.quantity), 0) AS fill_rate_pct
      FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id = po.id JOIN suppliers s ON s.id = po.supplier_id
      WHERE po.tenant_id = ${f.tenantId} AND po.status NOT IN ('draft', 'cancelled') AND po.order_date BETWEEN ${f.from} AND ${f.to} ${wh(f, 'po.warehouse_id')} GROUP BY s.id`,
  },
  {
    key: 'purchase_trends', name: 'Purchase trends', category: 'Purchasing', permission: 'report.view', description: 'Monthly purchase value and average unit cost changes.',
    filters: ['from', 'to', 'productId'], defaultSort: 'month',
    columns: [C('month', 'Month'), C('orders', 'POs', 'number'), C('units', 'Units', 'number'), C('value', 'Value', 'money'), C('avg_unit_cost', 'Avg unit cost', 'money')],
    query: (f) => sql`SELECT to_char(date_trunc('month', po.order_date), 'YYYY-MM') AS month, COUNT(DISTINCT po.id) AS orders, SUM(l.quantity) AS units, SUM(l.quantity * l.unit_cost) AS value, SUM(l.quantity * l.unit_cost) / NULLIF(SUM(l.quantity), 0) AS avg_unit_cost
      FROM purchase_orders po JOIN purchase_order_lines l ON l.purchase_order_id = po.id WHERE po.tenant_id = ${f.tenantId} AND po.status NOT IN ('draft', 'cancelled') AND po.order_date BETWEEN ${f.from} AND ${f.to} ${f.productId ? sql`AND l.product_id = ${f.productId}` : sql``} GROUP BY 1`,
  },
  {
    key: 'supplier_performance', name: 'Supplier performance', category: 'Purchasing', permission: 'report.view', description: 'On-time delivery, short and damaged deliveries, lead time.',
    filters: ['from', 'to'], defaultSort: 'receipts',
    columns: [C('supplier', 'Supplier'), C('receipts', 'Receipts', 'number'), C('on_time_pct', 'On time', 'percent'), C('short_pct', 'Short lines', 'percent'), C('damaged_pct', 'Damaged units', 'percent'), C('avg_lead_days', 'Avg lead time (days)', 'number')],
    query: (f) => sql`SELECT s.name AS supplier, COUNT(DISTINCT g.id) AS receipts,
      100.0 * COUNT(DISTINCT g.id) FILTER (WHERE po.expected_date IS NOT NULL AND g.received_at::date <= po.expected_date) / NULLIF(COUNT(DISTINCT g.id) FILTER (WHERE po.expected_date IS NOT NULL), 0) AS on_time_pct,
      100.0 * COUNT(gl.id) FILTER (WHERE gl.variance_type = 'short') / NULLIF(COUNT(gl.id), 0) AS short_pct, 100.0 * SUM(gl.damaged_qty) / NULLIF(SUM(gl.received_qty), 0) AS damaged_pct,
      ROUND(AVG(g.received_at::date - po.order_date)::numeric, 1) AS avg_lead_days
      FROM goods_receipts g JOIN goods_receipt_lines gl ON gl.receipt_id = g.id JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
      WHERE g.tenant_id = ${f.tenantId} ${range(f, 'g.received_at')} GROUP BY s.id`,
  },
  {
    key: 'payables', name: 'Outstanding payables', category: 'Purchasing', permission: 'billing.view', description: 'Unpaid supplier bills.',
    filters: ['supplierId'], defaultSort: 'due_date', totals: ['total', 'paid', 'balance'],
    columns: [C('number', 'Bill'), C('supplier', 'Supplier'), C('po', 'PO'), C('bill_date', 'Bill date', 'date'), C('due_date', 'Due', 'date'), C('days_overdue', 'Days overdue', 'number'), C('total', 'Total', 'money'), C('paid', 'Paid', 'money'), C('balance', 'Balance', 'money')],
    query: (f) => sql`SELECT b.number, s.name AS supplier, po.number AS po, b.bill_date, b.due_date, GREATEST(CURRENT_DATE - b.due_date, 0) AS days_overdue, b.total, b.amount_paid AS paid, b.total - b.amount_paid AS balance
      FROM supplier_bills b JOIN suppliers s ON s.id = b.supplier_id LEFT JOIN purchase_orders po ON po.id = b.purchase_order_id WHERE b.tenant_id = ${f.tenantId} AND b.status IN ('open', 'partially_paid') ${f.supplierId ? sql`AND b.supplier_id = ${f.supplierId}` : sql``}`,
  },
  // ───── Financial ─────
  {
    key: 'revenue', name: 'Revenue', category: 'Financial', permission: 'report.financial', description: 'Invoiced revenue by type and month (sales, storage, credit notes).',
    filters: ['from', 'to', 'warehouseId'], defaultSort: 'month', totals: ['sales', 'storage', 'credit_notes', 'net'],
    columns: [C('month', 'Month'), C('sales', 'Sales', 'money'), C('storage', 'Storage & handling', 'money'), C('credit_notes', 'Credit notes', 'money'), C('net', 'Net revenue', 'money'), C('tax', 'Tax collected', 'money')],
    query: (f) => sql`SELECT to_char(date_trunc('month', issue_date), 'YYYY-MM') AS month, SUM(subtotal) FILTER (WHERE type = 'sales') AS sales, SUM(subtotal) FILTER (WHERE type = 'storage') AS storage, SUM(subtotal) FILTER (WHERE type = 'credit_note') AS credit_notes, SUM(subtotal) AS net, SUM(tax_total) AS tax
      FROM invoices WHERE tenant_id = ${f.tenantId} AND status <> 'void' AND issue_date BETWEEN ${f.from} AND ${f.to} ${wh(f)} GROUP BY 1`,
  },
  {
    key: 'expenses', name: 'Expenses', category: 'Financial', permission: 'report.financial', description: 'Approved expenses by category, warehouse and cost center.',
    filters: ['from', 'to', 'warehouseId'], defaultSort: 'amount', totals: ['entries', 'amount'],
    columns: [C('category', 'Category', 'status'), C('warehouse', 'Warehouse'), C('cost_center', 'Cost center'), C('entries', 'Entries', 'number'), C('amount', 'Amount', 'money')],
    query: (f) => sql`SELECT e.category, COALESCE(w.code, 'Company') AS warehouse, NULLIF(e.cost_center, '') AS cost_center, COUNT(*) AS entries, SUM(e.amount) AS amount
      FROM expenses e LEFT JOIN warehouses w ON w.id = e.warehouse_id WHERE e.tenant_id = ${f.tenantId} AND e.status = 'approved' AND e.expense_date BETWEEN ${f.from} AND ${f.to} ${wh(f, 'e.warehouse_id')} GROUP BY e.category, w.code, e.cost_center`,
  },
  {
    key: 'warehouse_profitability', name: 'Warehouse profitability', category: 'Financial', permission: 'report.financial', description: 'Estimated revenue, cost of goods, expenses and net by warehouse.',
    filters: ['from', 'to'], defaultSort: 'net_profit', totals: ['revenue', 'cogs', 'expenses', 'net_profit'],
    columns: [C('warehouse', 'Warehouse'), C('revenue', 'Revenue', 'money'), C('cogs', 'Cost of goods', 'money'), C('expenses', 'Expenses + freight', 'money'), C('net_profit', 'Est. net profit', 'money'), C('margin_pct', 'Margin', 'percent')],
    query: (f) => sql`SELECT * , 100.0 * net_profit / NULLIF(revenue, 0) AS margin_pct FROM (SELECT w.code || ' · ' || w.name AS warehouse,
      COALESCE((SELECT SUM(subtotal) FROM invoices i WHERE i.warehouse_id = w.id AND i.status <> 'void' AND i.issue_date BETWEEN ${f.from} AND ${f.to}), 0) AS revenue,
      COALESCE((SELECT -SUM(quantity * unit_cost) FROM inventory_transactions m WHERE m.warehouse_id = w.id AND m.transaction_type = 'dispatch' AND m.owner_customer_id IS NULL AND m.created_at >= ${f.from}::date AND m.created_at < ${f.to}::date + 1), 0) AS cogs,
      COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.warehouse_id = w.id AND e.status = 'approved' AND e.expense_date BETWEEN ${f.from} AND ${f.to}), 0) + COALESCE((SELECT SUM(freight_cost) FROM shipments s WHERE s.warehouse_id = w.id AND s.dispatched_at >= ${f.from}::date AND s.dispatched_at < ${f.to}::date + 1), 0) AS expenses,
      COALESCE((SELECT SUM(subtotal) FROM invoices i WHERE i.warehouse_id = w.id AND i.status <> 'void' AND i.issue_date BETWEEN ${f.from} AND ${f.to}), 0)
        - COALESCE((SELECT -SUM(quantity * unit_cost) FROM inventory_transactions m WHERE m.warehouse_id = w.id AND m.transaction_type = 'dispatch' AND m.owner_customer_id IS NULL AND m.created_at >= ${f.from}::date AND m.created_at < ${f.to}::date + 1), 0)
        - COALESCE((SELECT SUM(amount) FROM expenses e WHERE e.warehouse_id = w.id AND e.status = 'approved' AND e.expense_date BETWEEN ${f.from} AND ${f.to}), 0)
        - COALESCE((SELECT SUM(freight_cost) FROM shipments s WHERE s.warehouse_id = w.id AND s.dispatched_at >= ${f.from}::date AND s.dispatched_at < ${f.to}::date + 1), 0) AS net_profit
      FROM warehouses w WHERE w.tenant_id = ${f.tenantId}) x`,
  },
  {
    key: 'inventory_value_by_warehouse', name: 'Inventory value by warehouse', category: 'Financial', permission: 'report.financial', description: 'Stock value held in each warehouse and status.',
    filters: [], defaultSort: 'value', totals: ['units', 'value', 'available_value'],
    columns: [C('warehouse', 'Warehouse'), C('skus', 'SKUs', 'number'), C('units', 'Units', 'number'), C('value', 'Total value', 'money'), C('available_value', 'Available value', 'money'), C('impaired_value', 'Damaged/expired value', 'money')],
    query: (f) => sql`SELECT w.code || ' · ' || w.name AS warehouse, COUNT(DISTINCT b.product_id) AS skus, SUM(b.quantity) AS units, SUM(b.quantity * p.cost_price) AS value,
      SUM(b.quantity * p.cost_price) FILTER (WHERE b.status = 'available') AS available_value, SUM(b.quantity * p.cost_price) FILTER (WHERE b.status IN ('damaged', 'expired')) AS impaired_value
      FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id WHERE b.tenant_id = ${f.tenantId} AND b.quantity > 0 AND b.owner_customer_id IS NULL GROUP BY w.id`,
  },
  {
    key: 'storage_billing', name: 'Storage billing', category: 'Financial', permission: 'billing.view', description: 'Storage and handling charges invoiced to storage clients.',
    filters: ['from', 'to', 'customerId'], defaultSort: 'period_start', totals: ['amount'],
    columns: [C('customer', 'Customer'), C('period_start', 'From', 'date'), C('period_end', 'To', 'date'), C('charge_type', 'Charge', 'status'), C('basis', 'Basis', 'status'), C('quantity', 'Quantity', 'number'), C('rate', 'Rate', 'money'), C('amount', 'Amount', 'money'), C('invoice', 'Invoice')],
    query: (f) => sql`SELECT c.name AS customer, ch.period_start, ch.period_end, ch.charge_type, ch.basis, ch.quantity, ch.rate, ch.amount, i.number AS invoice
      FROM storage_charges ch JOIN customers c ON c.id = ch.customer_id LEFT JOIN invoices i ON i.id = ch.invoice_id
      WHERE ch.tenant_id = ${f.tenantId} AND ch.period_start <= ${f.to}::date AND ch.period_end >= ${f.from}::date ${f.customerId ? sql`AND ch.customer_id = ${f.customerId}` : sql``}`,
  },
];

export function reportByKey(key: string): ReportDefinition | undefined {
  return REPORTS.find((r) => r.key === key);
}
