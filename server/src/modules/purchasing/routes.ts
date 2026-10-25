import { z } from 'zod';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { db, num, one, rows, t, type DbOrTx, type Tx } from '../../db';
import { idParam, isoDate, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, invalidState, notFound } from '../../core/errors';
import { audit, diff } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { computeDocument } from '../finance/tax';
import { createApprovalRequest, findApplicableRule, registerApprovalHandler } from '../approvals/engine';
import { emitEvent } from '../integrations/events';
import { postMovement } from '../inventory/ledger';
import { camel } from '../../core/case';

const partyBody = z.object({
  code: z.string().trim().toUpperCase().max(20).optional(),
  name: z.string().trim().min(2).max(160),
  contactName: z.string().trim().max(120).default(''),
  phone: z.string().trim().max(40).default(''),
  email: z.string().trim().email().or(z.literal('')).default(''),
  address: z.string().trim().max(400).default(''),
  city: z.string().trim().max(80).default(''),
  country: z.string().trim().length(2).default('PK'),
  ntn: z.string().trim().max(40).default(''),
  strn: z.string().trim().max(40).default(''),
  paymentTermsDays: z.coerce.number().int().min(0).max(365).default(30),
  status: z.enum(['active', 'inactive', 'blocked']).default('active'),
  notes: z.string().trim().max(1000).default(''),
});
export const supplierBody = partyBody.extend({ leadTimeDays: z.coerce.number().min(0).max(365).default(7), currency: z.string().length(3).default('PKR') });

export async function createSupplier(tx: DbOrTx, ctx: Ctx, body: z.infer<typeof supplierBody>) {
  const code = body.code || (await nextNumber(tx, ctx.tenantId, 'SUP'));
  const [s] = await tx.insert(t.suppliers).values({ ...body, code, tenantId: ctx.tenantId }).returning();
  await audit(tx, ctx, { action: 'supplier.created', entityType: 'supplier', entityId: s!.id, newValue: { code, name: body.name } });
  return s!;
}

export function registerSupplierRoutes(r: Router) {
  r.get('/', { summary: 'List suppliers with payables and performance', permission: ['purchase.view', 'supplier.manage', 'billing.view'], query: pageQuery.extend({ status: z.string().optional() }) }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT s.*, COUNT(*) OVER() AS total_count,
        COALESCE((SELECT SUM(b.total - b.amount_paid) FROM supplier_bills b WHERE b.supplier_id = s.id AND b.status IN ('open', 'partially_paid')), 0)::float AS payable,
        COALESCE((SELECT SUM(po.total) FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status NOT IN ('draft', 'cancelled')), 0)::float AS purchased,
        (SELECT COUNT(*)::int FROM purchase_orders po WHERE po.supplier_id = s.id AND po.status IN ('approved', 'partially_received')) AS open_pos
      FROM suppliers s WHERE s.tenant_id = ${ctx.tenantId}
      ${like ? sql`AND (lower(s.name) LIKE ${like} OR lower(s.code) LIKE ${like} OR s.phone LIKE ${like})` : sql``}
      ${query.status ? sql`AND s.status = ${query.status}` : sql``}
      ORDER BY ${sql.raw(({ name: 's.name', payable: 'payable', purchased: 'purchased' } as Record<string, string>)[query.sort ?? ''] ?? 's.name')} ${sql.raw(query.sort ? (query.dir === 'asc' ? 'ASC' : 'DESC') : 'ASC')}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => camel(x)), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/', { summary: 'Create a supplier', permission: 'supplier.manage', body: supplierBody }, async ({ ctx, body }) => db().transaction((tx) => createSupplier(tx, ctx, body)));

  r.patch('/:id', { summary: 'Update a supplier', permission: 'supplier.manage', params: idParam, body: supplierBody.partial() }, async ({ ctx, params, body }) => {
    const [before] = await db().select().from(t.suppliers).where(and(eq(t.suppliers.id, params.id), eq(t.suppliers.tenantId, ctx.tenantId))).limit(1);
    if (!before) throw notFound('Supplier');
    const [s] = await db().update(t.suppliers).set(body).where(eq(t.suppliers.id, params.id)).returning();
    await audit(db(), ctx, { action: 'supplier.updated', entityType: 'supplier', entityId: params.id, ...diff(before as Record<string, unknown>, body) });
    return s;
  });

  r.get('/:id', { summary: 'Supplier 360: POs, receipts, returns, payments, outstanding, products, performance', permission: ['purchase.view', 'supplier.manage'], params: idParam }, async ({ ctx, params }) => {
    const [s] = await db().select().from(t.suppliers).where(and(eq(t.suppliers.id, params.id), eq(t.suppliers.tenantId, ctx.tenantId))).limit(1);
    if (!s) throw notFound('Supplier');
    const [pos, receipts, returns, payments, bills, products, performance] = await Promise.all([
      rows(db(), sql`SELECT id, number, status, order_date AS "orderDate", expected_date AS "expectedDate", total::float AS total FROM purchase_orders WHERE tenant_id = ${ctx.tenantId} AND supplier_id = ${s.id} ORDER BY created_at DESC LIMIT 50`),
      rows(db(), sql`SELECT g.id, g.number, g.received_at AS "receivedAt", g.total_value::float AS "totalValue", po.number AS "poNumber" FROM goods_receipts g LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id WHERE g.tenant_id = ${ctx.tenantId} AND g.supplier_id = ${s.id} ORDER BY g.received_at DESC LIMIT 50`),
      rows(db(), sql`SELECT id, number, reason, total::float AS total, created_at AS "createdAt" FROM purchase_returns WHERE tenant_id = ${ctx.tenantId} AND supplier_id = ${s.id} ORDER BY created_at DESC LIMIT 50`),
      rows(db(), sql`SELECT id, number, amount::float AS amount, method, reference, paid_at AS "paidAt" FROM payments WHERE tenant_id = ${ctx.tenantId} AND supplier_id = ${s.id} ORDER BY paid_at DESC LIMIT 50`),
      rows(db(), sql`SELECT id, number, bill_date AS "billDate", due_date AS "dueDate", total::float AS total, amount_paid::float AS "amountPaid", status FROM supplier_bills WHERE tenant_id = ${ctx.tenantId} AND supplier_id = ${s.id} ORDER BY bill_date DESC LIMIT 50`),
      rows(db(), sql`SELECT p.id, p.sku, p.name, MAX(l.unit_cost)::float AS "lastCost", SUM(l.quantity)::float AS "orderedQty" FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id JOIN products p ON p.id = l.product_id WHERE po.tenant_id = ${ctx.tenantId} AND po.supplier_id = ${s.id} GROUP BY p.id ORDER BY "orderedQty" DESC LIMIT 50`),
      supplierPerformance(db(), ctx.tenantId, s.id),
    ]);
    const outstanding = bills.reduce((sum, b) => sum + (['open', 'partially_paid'].includes(String(b.status)) ? num(b.total) - num(b.amountPaid) : 0), 0);
    return { ...s, purchaseOrders: pos, receipts, returns, payments, bills, products, performance, outstanding };
  });
}

export async function supplierPerformance(dbx: DbOrTx, tenantId: string, supplierId: string) {
  const row = await one<Record<string, string | null>>(dbx, sql`
    WITH rec AS (
      SELECT g.id, g.received_at, po.expected_date, po.order_date FROM goods_receipts g JOIN purchase_orders po ON po.id = g.purchase_order_id
      WHERE g.tenant_id = ${tenantId} AND g.supplier_id = ${supplierId}
    ), lines AS (
      SELECT gl.* FROM goods_receipt_lines gl JOIN rec ON rec.id = gl.receipt_id
    )
    SELECT
      (SELECT COUNT(*) FROM rec) AS receipts,
      (SELECT COUNT(*) FILTER (WHERE expected_date IS NOT NULL AND received_at::date <= expected_date) * 100.0 / NULLIF(COUNT(*) FILTER (WHERE expected_date IS NOT NULL), 0) FROM rec) AS on_time_pct,
      (SELECT AVG(received_at::date - order_date) FROM rec) AS avg_lead_days,
      (SELECT COUNT(*) FILTER (WHERE variance_type = 'short') * 100.0 / NULLIF(COUNT(*), 0) FROM lines) AS short_pct,
      (SELECT SUM(damaged_qty) * 100.0 / NULLIF(SUM(received_qty), 0) FROM lines) AS damaged_pct,
      (SELECT COUNT(*) FROM (
        SELECT l.product_id FROM purchase_order_lines l JOIN purchase_orders po ON po.id = l.purchase_order_id
        WHERE po.tenant_id = ${tenantId} AND po.supplier_id = ${supplierId} AND po.created_at >= now() - interval '180 days'
        GROUP BY l.product_id HAVING COUNT(DISTINCT l.unit_cost) > 1) x) AS price_changes`);
  const r1 = (v: string | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 10) / 10);
  const onTime = r1(row?.on_time_pct);
  const damaged = r1(row?.damaged_pct) ?? 0;
  const short = r1(row?.short_pct) ?? 0;
  // Simple weighted score out of 100
  const score = num(row?.receipts) ? Math.max(0, Math.round((onTime ?? 80) * 0.5 + (100 - short) * 0.3 + (100 - damaged * 5) * 0.2)) : null;
  return { receipts: num(row?.receipts), onTimePct: onTime, avgLeadTimeDays: r1(row?.avg_lead_days), shortDeliveryPct: short, damagedPct: damaged, priceChanges180d: num(row?.price_changes), score };
}

const poLine = z.object({ productId: z.string().uuid(), quantity: z.number().positive(), unitCost: z.number().min(0), discountPct: z.number().min(0).max(100).default(0), taxRate: z.number().min(0).max(100).optional() });
export const poBody = z.object({
  supplierId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  orderDate: isoDate().optional(),
  expectedDate: isoDate().nullish(),
  currency: z.string().length(3).optional(),
  notes: z.string().trim().max(1000).default(''),
  source: z.enum(['manual', 'ai_reorder', 'document', 'import']).default('manual'),
  lines: z.array(poLine).min(1, 'Add at least one product.').max(300),
});

async function buildPoLines(tx: DbOrTx, ctx: Ctx, lines: z.infer<typeof poLine>[]) {
  const ids = [...new Set(lines.map((l) => l.productId))];
  const products = await tx.select({ id: t.products.id, taxRateId: t.products.taxRateId }).from(t.products).where(and(eq(t.products.tenantId, ctx.tenantId), inArray(t.products.id, ids)));
  if (products.length !== ids.length) throw badRequest('One or more products do not belong to your company.');
  const taxes = await tx.select().from(t.taxRates).where(eq(t.taxRates.tenantId, ctx.tenantId));
  const defaultTax = taxes.find((x) => x.isDefault && x.appliesTo !== 'sales');
  const [tenant] = await tx.select({ inclusive: t.tenants.taxInclusivePricing }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId)).limit(1);
  const withRates = lines.map((l) => {
    const p = products.find((x) => x.id === l.productId)!;
    const rate = l.taxRate ?? taxes.find((x) => x.id === p.taxRateId)?.rate ?? defaultTax?.rate ?? 0;
    return { ...l, taxRate: rate };
  });
  const doc = computeDocument(withRates.map((l) => ({ quantity: l.quantity, unitPrice: l.unitCost, discountPct: l.discountPct, taxRate: l.taxRate })), tenant?.inclusive ?? false);
  return { lines: withRates.map((l, i) => ({ ...l, taxAmount: doc.lines[i]!.tax, lineTotal: doc.lines[i]!.total })), totals: doc.totals };
}

export async function createPurchaseOrder(tx: Tx, ctx: Ctx, body: z.infer<typeof poBody>) {
  const [supplier] = await tx.select().from(t.suppliers).where(and(eq(t.suppliers.id, body.supplierId), eq(t.suppliers.tenantId, ctx.tenantId))).limit(1);
  if (!supplier) throw notFound('Supplier');
  if (supplier.status === 'blocked') throw badRequest('This supplier is blocked.');
  const [w] = await tx.select({ id: t.warehouses.id }).from(t.warehouses).where(and(eq(t.warehouses.id, body.warehouseId), eq(t.warehouses.tenantId, ctx.tenantId))).limit(1);
  if (!w) throw notFound('Warehouse');
  const { lines, totals } = await buildPoLines(tx, ctx, body.lines);
  const number = await nextNumber(tx, ctx.tenantId, 'PO');
  const today = new Date().toISOString().slice(0, 10);
  const [po] = await tx.insert(t.purchaseOrders).values({
    tenantId: ctx.tenantId, number, supplierId: supplier.id, warehouseId: w.id, orderDate: body.orderDate ?? today,
    expectedDate: body.expectedDate ?? new Date(Date.now() + supplier.leadTimeDays * 86400_000).toISOString().slice(0, 10),
    currency: body.currency ?? supplier.currency, notes: body.notes, source: body.source, createdBy: ctx.userId || null, ...totals,
  }).returning();
  await tx.insert(t.purchaseOrderLines).values(lines.map((l) => ({ tenantId: ctx.tenantId, purchaseOrderId: po!.id, productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, discountPct: l.discountPct, taxRate: l.taxRate, taxAmount: l.taxAmount, lineTotal: l.lineTotal })));
  await audit(tx, ctx, { action: 'purchase_order.created', entityType: 'purchase_order', entityId: po!.id, newValue: { number, supplier: supplier.name, total: totals.total, lines: lines.length, source: body.source } });
  return po!;
}

export async function getPurchaseOrder(dbx: DbOrTx, tenantId: string, id: string) {
  const [po] = await dbx.select().from(t.purchaseOrders).where(and(eq(t.purchaseOrders.id, id), eq(t.purchaseOrders.tenantId, tenantId))).limit(1);
  if (!po) throw notFound('Purchase order');
  return po;
}

async function approvePo(tx: DbOrTx, ctx: Ctx, poId: string) {
  await tx.update(t.purchaseOrders).set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() }).where(eq(t.purchaseOrders.id, poId));
  await audit(tx, ctx, { action: 'purchase_order.approved', entityType: 'purchase_order', entityId: poId });
  await emitEvent(tx, ctx.tenantId, 'purchase_order.approved', { purchaseOrderId: poId });
}

registerApprovalHandler('purchase_order', {
  approve: async (tx, ctx, id) => {
    const po = await getPurchaseOrder(tx, ctx.tenantId, id);
    if (po.status !== 'submitted') throw invalidState('Purchase order is not awaiting approval.');
    await approvePo(tx, ctx, id);
  },
  reject: async (tx, ctx, id, comment) => {
    await tx.update(t.purchaseOrders).set({ status: 'draft', notes: sql`${t.purchaseOrders.notes} || ${`\n[Rejected] ${comment}`}` }).where(and(eq(t.purchaseOrders.id, id), eq(t.purchaseOrders.tenantId, ctx.tenantId)));
    await audit(tx, ctx, { action: 'purchase_order.rejected', entityType: 'purchase_order', entityId: id, newValue: { comment } });
  },
});

export function registerPurchaseOrderRoutes(r: Router) {
  r.get('/', {
    summary: 'List purchase orders',
    permission: ['purchase.view', 'receiving.execute', 'billing.view'],
    query: pageQuery.extend({ status: z.string().optional(), supplierId: z.string().uuid().optional(), warehouseId: z.string().uuid().optional(), from: isoDate().optional(), to: isoDate().optional(), receivable: z.coerce.boolean().optional() }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const statuses = query.status?.split(',').filter(Boolean);
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT po.id, po.number, po.status, po.order_date AS "orderDate", po.expected_date AS "expectedDate", po.total::float AS total, po.currency, po.source,
        po.created_at AS "createdAt", s.id AS "supplierId", s.name AS "supplierName", w.id AS "warehouseId", w.code AS "warehouseCode", w.name AS "warehouseName",
        (SELECT COALESCE(SUM(quantity), 0) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id)::float AS "orderedQty",
        (SELECT COALESCE(SUM(received_qty), 0) FROM purchase_order_lines l WHERE l.purchase_order_id = po.id)::float AS "receivedQty",
        (po.expected_date < CURRENT_DATE AND po.status IN ('approved', 'partially_received')) AS overdue,
        COUNT(*) OVER() AS total_count
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id JOIN warehouses w ON w.id = po.warehouse_id
      WHERE po.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND po.status IN (${sql.join(statuses.map((x) => sql`${x}`), sql`, `)})` : sql``}
      ${query.receivable ? sql`AND po.status IN ('approved', 'partially_received')` : sql``}
      ${query.supplierId ? sql`AND po.supplier_id = ${query.supplierId}` : sql``}
      ${query.warehouseId ? sql`AND po.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.from ? sql`AND po.order_date >= ${query.from}` : sql``}
      ${query.to ? sql`AND po.order_date <= ${query.to}` : sql``}
      ${like ? sql`AND (lower(po.number) LIKE ${like} OR lower(s.name) LIKE ${like})` : sql``}
      ORDER BY ${sql.raw(({ number: 'po.number', total: 'po.total', expected: 'po.expected_date', supplier: 's.name' } as Record<string, string>)[query.sort ?? ''] ?? 'po.created_at')} ${sql.raw(query.dir === 'asc' ? 'ASC' : 'DESC')}
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'Purchase order with lines and receipts', permission: ['purchase.view', 'receiving.execute', 'billing.view'], params: idParam }, async ({ ctx, params }) => {
    const po = await getPurchaseOrder(db(), ctx.tenantId, params.id);
    const [lines, receipts, supplier, warehouse, approval] = await Promise.all([
      rows(db(), sql`SELECT l.id, l.product_id AS "productId", p.sku, p.name AS "productName", p.barcode, p.uom, p.track_batch AS "trackBatch", p.track_expiry AS "trackExpiry", p.track_serial AS "trackSerial",
        l.quantity::float AS quantity, l.unit_cost::float AS "unitCost", l.discount_pct::float AS "discountPct", l.tax_rate::float AS "taxRate", l.tax_amount::float AS "taxAmount", l.line_total::float AS "lineTotal",
        l.received_qty::float AS "receivedQty", l.damaged_qty::float AS "damagedQty", GREATEST(l.quantity - l.received_qty, 0)::float AS "remainingQty"
        FROM purchase_order_lines l JOIN products p ON p.id = l.product_id WHERE l.purchase_order_id = ${po.id} ORDER BY p.sku`),
      rows(db(), sql`SELECT g.id, g.number, g.received_at AS "receivedAt", g.total_value::float AS "totalValue", u.name AS "receivedBy" FROM goods_receipts g LEFT JOIN users u ON u.id = g.received_by WHERE g.purchase_order_id = ${po.id} ORDER BY g.received_at`),
      db().select({ id: t.suppliers.id, name: t.suppliers.name, phone: t.suppliers.phone, email: t.suppliers.email, address: t.suppliers.address, ntn: t.suppliers.ntn, strn: t.suppliers.strn }).from(t.suppliers).where(eq(t.suppliers.id, po.supplierId)),
      db().select({ id: t.warehouses.id, name: t.warehouses.name, code: t.warehouses.code, address: t.warehouses.address }).from(t.warehouses).where(eq(t.warehouses.id, po.warehouseId)),
      po.approvalRequestId ? db().select().from(t.approvalRequests).where(eq(t.approvalRequests.id, po.approvalRequestId)) : Promise.resolve([]),
    ]);
    return { ...po, lines, receipts, supplier: supplier[0], warehouse: warehouse[0], approval: approval[0] ?? null };
  });

  r.post('/', { summary: 'Create a draft purchase order', permission: 'purchase.manage', body: poBody }, async ({ ctx, body }) => db().transaction((tx) => createPurchaseOrder(tx, ctx, body)));

  r.put('/:id', { summary: 'Replace lines/header of a draft purchase order', permission: 'purchase.manage', params: idParam, body: poBody }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const po = await getPurchaseOrder(tx, ctx.tenantId, params.id);
      if (po.status !== 'draft') throw invalidState('Only draft purchase orders can be edited.');
      const { lines, totals } = await buildPoLines(tx, ctx, body.lines);
      await tx.delete(t.purchaseOrderLines).where(eq(t.purchaseOrderLines.purchaseOrderId, po.id));
      await tx.insert(t.purchaseOrderLines).values(lines.map((l) => ({ tenantId: ctx.tenantId, purchaseOrderId: po.id, productId: l.productId, quantity: l.quantity, unitCost: l.unitCost, discountPct: l.discountPct, taxRate: l.taxRate, taxAmount: l.taxAmount, lineTotal: l.lineTotal })));
      const [updated] = await tx.update(t.purchaseOrders).set({ supplierId: body.supplierId, warehouseId: body.warehouseId, expectedDate: body.expectedDate ?? po.expectedDate, notes: body.notes, ...totals }).where(eq(t.purchaseOrders.id, po.id)).returning();
      await audit(tx, ctx, { action: 'purchase_order.updated', entityType: 'purchase_order', entityId: po.id, oldValue: { total: po.total }, newValue: { total: totals.total, lines: lines.length } });
      return updated;
    });
  });

  r.post('/:id/submit', { summary: 'Submit for approval (auto-approves below the threshold)', permission: 'purchase.manage', params: idParam }, async ({ ctx, params }) => {
    return db().transaction(async (tx) => {
      const po = await getPurchaseOrder(tx, ctx.tenantId, params.id);
      if (po.status !== 'draft') throw invalidState('Only draft purchase orders can be submitted.');
      await tx.update(t.purchaseOrders).set({ status: 'submitted', submittedAt: new Date() }).where(eq(t.purchaseOrders.id, po.id));
      await audit(tx, ctx, { action: 'purchase_order.submitted', entityType: 'purchase_order', entityId: po.id, newValue: { total: po.total } });
      const rule = await findApplicableRule(tx, ctx.tenantId, 'purchase_order', po.total);
      if (rule) {
        const requestId = await createApprovalRequest(tx, ctx, { entityType: 'purchase_order', entityId: po.id, entityNumber: po.number, amount: po.total, rule, summary: `${po.number} for ${po.currency} ${po.total.toLocaleString()}` });
        await tx.update(t.purchaseOrders).set({ approvalRequestId: requestId }).where(eq(t.purchaseOrders.id, po.id));
        return { status: 'submitted', approvalRequired: true, approverRole: rule.approverRoleKey };
      }
      if (ctx.permissions.has('purchase.approve')) {
        await approvePo(tx, ctx, po.id);
        return { status: 'approved', approvalRequired: false };
      }
      return { status: 'submitted', approvalRequired: false };
    });
  });

  r.post('/:id/approve', { summary: 'Approve a submitted purchase order (below approval-rule threshold)', permission: 'purchase.approve', params: idParam }, async ({ ctx, params }) => {
    return db().transaction(async (tx) => {
      const po = await getPurchaseOrder(tx, ctx.tenantId, params.id);
      if (po.status !== 'submitted') throw invalidState('Only submitted purchase orders can be approved.');
      if (po.approvalRequestId) throw invalidState('This order needs a decision in Approvals because it exceeds an approval threshold.');
      await approvePo(tx, ctx, po.id);
      return { status: 'approved' };
    });
  });

  r.post('/:id/cancel', { summary: 'Cancel a purchase order with nothing received', permission: 'purchase.manage', params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const po = await getPurchaseOrder(tx, ctx.tenantId, params.id);
      if (!['draft', 'submitted', 'approved'].includes(po.status)) throw invalidState('Received or closed purchase orders cannot be cancelled. Close it instead.');
      await tx.update(t.purchaseOrders).set({ status: 'cancelled', notes: `${po.notes}\n[Cancelled] ${body.reason}`.trim() }).where(eq(t.purchaseOrders.id, po.id));
      if (po.approvalRequestId) await tx.update(t.approvalRequests).set({ status: 'cancelled' }).where(and(eq(t.approvalRequests.id, po.approvalRequestId), eq(t.approvalRequests.status, 'pending')));
      await audit(tx, ctx, { action: 'purchase_order.cancelled', entityType: 'purchase_order', entityId: po.id, newValue: { reason: body.reason } });
      return { status: 'cancelled' };
    });
  });

  r.post('/:id/close', { summary: 'Close a (partially) received purchase order — remaining quantity will not be received', permission: 'purchase.manage', params: idParam }, async ({ ctx, params }) => {
    const po = await getPurchaseOrder(db(), ctx.tenantId, params.id);
    if (!['partially_received', 'fully_received', 'approved'].includes(po.status)) throw invalidState('Only approved or received purchase orders can be closed.');
    await db().update(t.purchaseOrders).set({ status: 'closed', closedAt: new Date() }).where(eq(t.purchaseOrders.id, po.id));
    await audit(db(), ctx, { action: 'purchase_order.closed', entityType: 'purchase_order', entityId: po.id });
    return { status: 'closed' };
  });
}

export function registerPurchaseReturnRoutes(r: Router) {
  r.get('/', { summary: 'Purchase returns to suppliers', permission: ['purchase.view', 'purchase.manage'], query: pageQuery }, async ({ ctx, query }) => {
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT pr.id, pr.number, pr.reason, pr.total::float AS total, pr.status, pr.created_at AS "createdAt", s.name AS "supplierName", po.number AS "poNumber", w.code AS "warehouseCode", COUNT(*) OVER() AS total_count
      FROM purchase_returns pr JOIN suppliers s ON s.id = pr.supplier_id JOIN warehouses w ON w.id = pr.warehouse_id LEFT JOIN purchase_orders po ON po.id = pr.purchase_order_id
      WHERE pr.tenant_id = ${ctx.tenantId} ORDER BY pr.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/', {
    summary: 'Return goods to a supplier (removes stock and reduces the payable)',
    permission: 'purchase.manage',
    idempotent: true,
    body: z.object({
      supplierId: z.string().uuid(),
      purchaseOrderId: z.string().uuid().nullish(),
      warehouseId: z.string().uuid(),
      reason: z.string().trim().min(3).max(300),
      lines: z.array(z.object({ productId: z.string().uuid(), locationId: z.string().uuid(), batchId: z.string().uuid().nullish(), quantity: z.number().positive(), unitCost: z.number().min(0).optional(), fromStatus: z.enum(['available', 'damaged', 'quarantine', 'expired', 'blocked']).default('available') })).min(1),
    }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const [s] = await tx.select({ id: t.suppliers.id }).from(t.suppliers).where(and(eq(t.suppliers.id, body.supplierId), eq(t.suppliers.tenantId, ctx.tenantId))).limit(1);
      if (!s) throw notFound('Supplier');
      const number = await nextNumber(tx, ctx.tenantId, 'PRT');
      const products = await tx.select({ id: t.products.id, cost: t.products.costPrice }).from(t.products).where(and(eq(t.products.tenantId, ctx.tenantId), inArray(t.products.id, body.lines.map((l) => l.productId))));
      const lines = body.lines.map((l) => ({ ...l, unitCost: l.unitCost ?? products.find((p) => p.id === l.productId)?.cost ?? 0 }));
      const total = Math.round(lines.reduce((sum, l) => sum + l.quantity * l.unitCost, 0) * 100) / 100;
      const [pr] = await tx.insert(t.purchaseReturns).values({ tenantId: ctx.tenantId, number, supplierId: s.id, purchaseOrderId: body.purchaseOrderId ?? null, warehouseId: body.warehouseId, reason: body.reason, total, createdBy: ctx.userId }).returning();
      for (const l of lines) {
        await postMovement(tx, ctx, { warehouseId: body.warehouseId, locationId: l.locationId, productId: l.productId, batchId: l.batchId ?? null, status: l.fromStatus, quantity: -l.quantity, type: 'purchase_return', unitCost: l.unitCost, referenceType: 'purchase_return', referenceId: pr!.id, referenceNo: number, reason: body.reason });
        await tx.insert(t.purchaseReturnLines).values({ tenantId: ctx.tenantId, purchaseReturnId: pr!.id, productId: l.productId, batchId: l.batchId ?? null, locationId: l.locationId, quantity: l.quantity, unitCost: l.unitCost });
      }
      // Debit note: reduce the open bill for this PO if there is one.
      if (body.purchaseOrderId) {
        await tx.execute(sql`UPDATE supplier_bills SET total = GREATEST(total - ${total}, amount_paid),
          status = CASE WHEN GREATEST(total - ${total}, amount_paid) <= amount_paid THEN 'paid' ELSE status END
          WHERE tenant_id = ${ctx.tenantId} AND purchase_order_id = ${body.purchaseOrderId} AND status IN ('open', 'partially_paid')`);
      }
      await audit(tx, ctx, { action: 'purchase_return.created', entityType: 'purchase_return', entityId: pr!.id, newValue: { number, total, reason: body.reason } });
      return pr;
    });
  });
}

