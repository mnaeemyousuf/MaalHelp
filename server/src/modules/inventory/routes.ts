import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { ADJUSTMENT_REASONS, INVENTORY_STATUSES, TRANSACTION_TYPES } from '@shared/domain';
import { db, num, one, rows, t, type DbOrTx, type Tx } from '../../db';
import { isoDate, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { redactFinance } from '../../core/finance-visibility';
import { moveStock, postMovement } from './ledger';
import { createApprovalRequest, findApplicableRule, registerApprovalHandler } from '../approvals/engine';
import { emitEvent } from '../integrations/events';

const statusEnum = z.enum(INVENTORY_STATUSES);
const owner = z.string().uuid().nullish().transform((v) => v ?? null);

export function registerInventoryRoutes(r: Router) {
  r.get('/', {
    summary: 'Stock balances by warehouse / location / product / batch / owner / status',
    permission: 'inventory.view',
    query: pageQuery.extend({
      warehouseId: z.string().uuid().optional(),
      locationId: z.string().uuid().optional(),
      productId: z.string().uuid().optional(),
      status: statusEnum.optional(),
      owner: z.enum(['company', 'customer', 'all']).default('all'),
      ownerCustomerId: z.string().uuid().optional(),
    }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT b.id, b.status, b.quantity::float AS quantity, b.updated_at AS "updatedAt",
        p.id AS "productId", p.sku, p.name AS "productName", p.uom, p.cost_price::float AS "unitCost", (b.quantity * p.cost_price)::float AS value,
        w.id AS "warehouseId", w.code AS "warehouseCode", w.name AS "warehouseName", l.id AS "locationId", l.code AS "locationCode", l.type AS "locationType",
        bt.id AS "batchId", bt.batch_no AS "batchNo", bt.expiry_date AS "expiryDate", c.id AS "ownerCustomerId", c.name AS "ownerName",
        COUNT(*) OVER() AS total_count
      FROM inventory_balances b
      JOIN products p ON p.id = b.product_id JOIN warehouses w ON w.id = b.warehouse_id JOIN locations l ON l.id = b.location_id
      LEFT JOIN batches bt ON bt.id = b.batch_id LEFT JOIN customers c ON c.id = b.owner_customer_id
      WHERE b.tenant_id = ${ctx.tenantId} AND b.quantity > 0
      ${query.warehouseId ? sql`AND b.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.locationId ? sql`AND b.location_id = ${query.locationId}` : sql``}
      ${query.productId ? sql`AND b.product_id = ${query.productId}` : sql``}
      ${query.status ? sql`AND b.status = ${query.status}` : sql``}
      ${query.owner === 'company' ? sql`AND b.owner_customer_id IS NULL` : query.owner === 'customer' ? sql`AND b.owner_customer_id IS NOT NULL` : sql``}
      ${query.ownerCustomerId ? sql`AND b.owner_customer_id = ${query.ownerCustomerId}` : sql``}
      ${like ? sql`AND (lower(p.sku) LIKE ${like} OR lower(p.name) LIKE ${like} OR lower(l.code) LIKE ${like} OR lower(COALESCE(bt.batch_no, '')) LIKE ${like})` : sql``}
      ORDER BY ${sql.raw(({ sku: 'p.sku', location: 'l.code', quantity: 'b.quantity', value: 'value', expiry: 'bt.expiry_date', updated: 'b.updated_at' } as Record<string, string>)[query.sort ?? ''] ?? 'b.updated_at')} ${sql.raw(query.dir === 'asc' ? 'ASC' : 'DESC')} NULLS LAST, p.sku
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(redactFinance(ctx, list.map(({ total_count: _t, ...x }) => x)), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/summary', { summary: 'Totals by status and by warehouse', permission: 'inventory.view', query: z.object({ warehouseId: z.string().uuid().optional() }) }, async ({ ctx, query }) => {
    const filter = query.warehouseId ? sql`AND b.warehouse_id = ${query.warehouseId}` : sql``;
    const [byStatus, byWarehouse, byOwner] = await Promise.all([
      rows(db(), sql`SELECT b.status, SUM(b.quantity)::float AS units, SUM(b.quantity * p.cost_price)::float AS value, COUNT(DISTINCT b.product_id)::int AS skus FROM inventory_balances b JOIN products p ON p.id = b.product_id WHERE b.tenant_id = ${ctx.tenantId} AND b.quantity > 0 AND b.owner_customer_id IS NULL ${filter} GROUP BY b.status`),
      rows(db(), sql`SELECT w.id, w.code, w.name, COALESCE(SUM(b.quantity), 0)::float AS units, COALESCE(SUM(b.quantity * p.cost_price), 0)::float AS value, COUNT(DISTINCT b.product_id)::int AS skus FROM warehouses w LEFT JOIN inventory_balances b ON b.warehouse_id = w.id AND b.quantity > 0 AND b.owner_customer_id IS NULL LEFT JOIN products p ON p.id = b.product_id WHERE w.tenant_id = ${ctx.tenantId} GROUP BY w.id ORDER BY value DESC`),
      rows(db(), sql`SELECT c.id, c.name, SUM(b.quantity)::float AS units, COUNT(DISTINCT b.product_id)::int AS skus FROM inventory_balances b JOIN customers c ON c.id = b.owner_customer_id WHERE b.tenant_id = ${ctx.tenantId} AND b.quantity > 0 ${filter} GROUP BY c.id ORDER BY units DESC`),
    ]);
    return redactFinance(ctx, { byStatus, byWarehouse, customerOwned: byOwner });
  });

  r.get('/ledger', {
    summary: 'Immutable inventory transaction ledger',
    permission: ['inventory.view', 'audit.view'],
    query: pageQuery.extend({
      productId: z.string().uuid().optional(),
      warehouseId: z.string().uuid().optional(),
      locationId: z.string().uuid().optional(),
      type: z.enum(TRANSACTION_TYPES).optional(),
      from: isoDate().optional(),
      to: isoDate().optional(),
      referenceId: z.string().uuid().optional(),
    }),
  }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT m.id, m.transaction_type AS type, m.status, m.quantity::float AS quantity, m.unit_cost::float AS "unitCost", (m.quantity * m.unit_cost)::float AS value,
        m.balance_after::float AS "balanceAfter", m.reference_type AS "referenceType", m.reference_id AS "referenceId", m.reference_no AS "referenceNo", m.reason,
        m.correlation_id AS "correlationId", m.created_at AS "createdAt", p.id AS "productId", p.sku, p.name AS "productName",
        w.code AS "warehouseCode", l.code AS "locationCode", bt.batch_no AS "batchNo", sn.serial, c.name AS "ownerName", u.name AS "performedBy",
        COUNT(*) OVER() AS total_count
      FROM inventory_transactions m
      JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id JOIN locations l ON l.id = m.location_id
      LEFT JOIN batches bt ON bt.id = m.batch_id LEFT JOIN serial_numbers sn ON sn.id = m.serial_id LEFT JOIN customers c ON c.id = m.owner_customer_id LEFT JOIN users u ON u.id = m.performed_by
      WHERE m.tenant_id = ${ctx.tenantId}
      ${query.productId ? sql`AND m.product_id = ${query.productId}` : sql``}
      ${query.warehouseId ? sql`AND m.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.locationId ? sql`AND m.location_id = ${query.locationId}` : sql``}
      ${query.type ? sql`AND m.transaction_type = ${query.type}` : sql``}
      ${query.referenceId ? sql`AND m.reference_id = ${query.referenceId}` : sql``}
      ${query.from ? sql`AND m.created_at >= ${query.from}::date` : sql``}
      ${query.to ? sql`AND m.created_at < ${query.to}::date + 1` : sql``}
      ${like ? sql`AND (lower(p.sku) LIKE ${like} OR lower(p.name) LIKE ${like} OR lower(COALESCE(m.reference_no, '')) LIKE ${like} OR lower(l.code) LIKE ${like})` : sql``}
      ORDER BY m.created_at ${sql.raw(query.dir === 'asc' ? 'ASC' : 'DESC')}, m.id
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(redactFinance(ctx, list.map(({ total_count: _t, ...x }) => x)), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/adjustments', { summary: 'Stock adjustments', permission: ['inventory.view', 'inventory.adjust'], query: pageQuery.extend({ status: z.string().optional() }) }, async ({ ctx, query }) => {
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT a.id, a.number, a.status, a.inventory_status AS "inventoryStatus", a.quantity_delta::float AS "quantityDelta", a.value::float AS value, a.reason_code AS "reasonCode", a.notes,
        a.created_at AS "createdAt", a.posted_at AS "postedAt", p.sku, p.name AS "productName", w.code AS "warehouseCode", l.code AS "locationCode",
        ru.name AS "requestedBy", au.name AS "approvedBy", COUNT(*) OVER() AS total_count
      FROM stock_adjustments a JOIN products p ON p.id = a.product_id JOIN warehouses w ON w.id = a.warehouse_id JOIN locations l ON l.id = a.location_id
      LEFT JOIN users ru ON ru.id = a.requested_by LEFT JOIN users au ON au.id = a.approved_by
      WHERE a.tenant_id = ${ctx.tenantId} ${query.status ? sql`AND a.status = ${query.status}` : sql``}
      ORDER BY a.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(redactFinance(ctx, list.map(({ total_count: _t, ...x }) => x)), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/adjustments', {
    summary: 'Request a stock adjustment (routed for approval above the configured value threshold)',
    permission: 'inventory.adjust',
    idempotent: true,
    body: z.object({
      warehouseId: z.string().uuid(),
      locationId: z.string().uuid(),
      productId: z.string().uuid(),
      batchId: owner,
      ownerCustomerId: owner,
      status: statusEnum.default('available'),
      quantityDelta: z.number().refine((n) => n !== 0, 'Quantity change cannot be zero.'),
      reasonCode: z.enum(ADJUSTMENT_REASONS),
      notes: z.string().trim().max(500).default(''),
    }),
  }, async ({ ctx, body }) => db().transaction((tx) => requestAdjustment(tx, ctx, body)));

  r.post('/status-change', {
    summary: 'Move stock between statuses (e.g. available → damaged / quarantine / blocked, or release quarantine)',
    permission: 'inventory.adjust',
    idempotent: true,
    body: z.object({
      warehouseId: z.string().uuid(),
      locationId: z.string().uuid(),
      productId: z.string().uuid(),
      batchId: owner,
      ownerCustomerId: owner,
      fromStatus: statusEnum,
      toStatus: statusEnum,
      quantity: z.number().positive(),
      reason: z.string().trim().min(3, 'Give a reason for the status change.').max(300),
    }),
  }, async ({ ctx, body }) => {
    if (body.fromStatus === body.toStatus) throw badRequest('Choose a different target status.');
    if (body.toStatus === 'reserved' || body.fromStatus === 'reserved') throw badRequest('Reservations are managed by sales orders.');
    if (body.toStatus === 'in_transit' || body.fromStatus === 'in_transit') throw badRequest('In-transit stock is managed by transfers.');
    return db().transaction(async (tx) => {
      const key = { warehouseId: body.warehouseId, locationId: body.locationId, productId: body.productId, batchId: body.batchId, ownerCustomerId: body.ownerCustomerId };
      await moveStock(tx, ctx, { from: { ...key, status: body.fromStatus }, to: { ...key, status: body.toStatus }, quantity: body.quantity, outType: 'status_change', inType: body.toStatus === 'damaged' ? 'damage' : 'status_change', referenceType: 'status_change', reason: body.reason });
      await audit(tx, ctx, { action: 'inventory.status_changed', entityType: 'product', entityId: body.productId, newValue: body });
      return { ok: true };
    });
  });

  r.post('/relocate', {
    summary: 'Move stock from one location to another within a warehouse (mobile transfer)',
    permission: ['transfer.execute', 'putaway.execute', 'inventory.adjust'],
    idempotent: true,
    body: z.object({
      warehouseId: z.string().uuid(),
      fromLocationId: z.string().uuid(),
      toLocationId: z.string().uuid(),
      productId: z.string().uuid(),
      batchId: owner,
      ownerCustomerId: owner,
      status: statusEnum.default('available'),
      quantity: z.number().positive(),
      reason: z.string().trim().max(300).default('Internal relocation'),
    }),
  }, async ({ ctx, body }) => {
    if (body.fromLocationId === body.toLocationId) throw badRequest('Source and destination locations are the same.');
    if (body.status === 'reserved') throw badRequest('Reserved stock is moved by picking tasks.');
    return db().transaction(async (tx) => {
      const key = { warehouseId: body.warehouseId, productId: body.productId, batchId: body.batchId, ownerCustomerId: body.ownerCustomerId, status: body.status };
      const { correlationId } = await moveStock(tx, ctx, { from: { ...key, locationId: body.fromLocationId }, to: { ...key, locationId: body.toLocationId }, quantity: body.quantity, outType: 'transfer_out', inType: 'transfer_in', referenceType: 'relocation', reason: body.reason });
      await audit(tx, ctx, { action: 'stock.relocated', entityType: 'product', entityId: body.productId, newValue: { ...body, correlationId } });
      return { correlationId };
    });
  });

  r.post('/release-to-owner', {
    summary: 'Release customer-owned (consignment / 3PL) stock back to its owner — counted as outbound handling for billing',
    permission: ['dispatch.execute', 'inventory.adjust'],
    idempotent: true,
    body: z.object({
      ownerCustomerId: z.string().uuid(),
      warehouseId: z.string().uuid(),
      reference: z.string().trim().max(60).default(''),
      lines: z.array(z.object({ productId: z.string().uuid(), locationId: z.string().uuid(), batchId: owner, quantity: z.number().positive() })).min(1).max(200),
    }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const [cust] = await tx.select({ id: t.customers.id, name: t.customers.name }).from(t.customers).where(and(eq(t.customers.id, body.ownerCustomerId), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
      if (!cust) throw notFound('Customer');
      const number = await nextNumber(tx, ctx.tenantId, 'SHP');
      for (const l of body.lines) {
        await postMovement(tx, ctx, { warehouseId: body.warehouseId, locationId: l.locationId, productId: l.productId, batchId: l.batchId, ownerCustomerId: cust.id, status: 'available', quantity: -l.quantity, type: 'dispatch', referenceType: 'owner_release', referenceNo: number, reason: `Released to owner ${cust.name}${body.reference ? ` (${body.reference})` : ''}` });
      }
      await audit(tx, ctx, { action: 'stock.released_to_owner', entityType: 'customer', entityId: cust.id, newValue: { number, lines: body.lines } });
      return { number, lines: body.lines.length };
    });
  });

  r.post('/expire-batches', { summary: 'Move stock of expired batches to the "expired" status', permission: 'inventory.adjust' }, async ({ ctx }) =>
    db().transaction((tx) => expireBatches(tx, ctx)));
}

export interface AdjustmentInput {
  warehouseId: string; locationId: string; productId: string; batchId: string | null; ownerCustomerId: string | null;
  status: (typeof INVENTORY_STATUSES)[number]; quantityDelta: number; reasonCode: (typeof ADJUSTMENT_REASONS)[number]; notes: string;
}

/** Creates an adjustment. Below the approval threshold it posts immediately; above, it waits for approval. */
export async function requestAdjustment(tx: Tx, ctx: Ctx, body: AdjustmentInput) {
  const [product] = await tx.select({ id: t.products.id, cost: t.products.costPrice, sku: t.products.sku }).from(t.products).where(and(eq(t.products.id, body.productId), eq(t.products.tenantId, ctx.tenantId))).limit(1);
  if (!product) throw notFound('Product');
  const value = Math.round(Math.abs(body.quantityDelta) * product.cost * 100) / 100;
  const number = await nextNumber(tx, ctx.tenantId, 'ADJ');
  const rule = await findApplicableRule(tx, ctx.tenantId, 'stock_adjustment', value);
  const [adj] = await tx.insert(t.stockAdjustments).values({
    tenantId: ctx.tenantId, number, warehouseId: body.warehouseId, locationId: body.locationId, productId: body.productId, batchId: body.batchId, ownerCustomerId: body.ownerCustomerId,
    inventoryStatus: body.status, quantityDelta: body.quantityDelta, unitCost: product.cost, value, reasonCode: body.reasonCode, notes: body.notes,
    status: rule ? 'pending_approval' : 'posted', requestedBy: ctx.userId || null,
  }).returning();
  if (rule) {
    // Validate now that a removal would currently be possible, so approvers aren't asked to approve the impossible.
    if (body.quantityDelta < 0) {
      const bal = await one<{ q: string }>(tx, sql`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_balances WHERE tenant_id = ${ctx.tenantId} AND location_id = ${body.locationId} AND product_id = ${body.productId} AND status = ${body.status} AND batch_id IS NOT DISTINCT FROM ${body.batchId}::uuid AND owner_customer_id IS NOT DISTINCT FROM ${body.ownerCustomerId}::uuid`);
      if (num(bal?.q) + body.quantityDelta < 0) throw badRequest(`Only ${num(bal?.q)} units are at this location.`);
    }
    const requestId = await createApprovalRequest(tx, ctx, { entityType: 'stock_adjustment', entityId: adj!.id, entityNumber: number, amount: value, rule, summary: `${product.sku}: ${body.quantityDelta > 0 ? '+' : ''}${body.quantityDelta} units (${body.reasonCode.replace('_', ' ')}), value ${value.toLocaleString()}` });
    await tx.update(t.stockAdjustments).set({ approvalRequestId: requestId }).where(eq(t.stockAdjustments.id, adj!.id));
    await audit(tx, ctx, { action: 'inventory.adjustment_requested', entityType: 'stock_adjustment', entityId: adj!.id, newValue: { number, ...body, value } });
    return { ...adj!, status: 'pending_approval', approvalRequestId: requestId };
  }
  await postAdjustment(tx, ctx, adj!);
  return { ...adj!, status: 'posted' };
}

async function postAdjustment(tx: DbOrTx, ctx: Ctx, adj: typeof t.stockAdjustments.$inferSelect): Promise<void> {
  const type = adj.reasonCode === 'damage' ? 'damage' : adj.reasonCode === 'write_off' || adj.reasonCode === 'expired' ? 'write_off' : adj.reasonCode === 'consumption' ? 'consumption' : 'adjustment';
  await postMovement(tx, ctx, {
    warehouseId: adj.warehouseId, locationId: adj.locationId, productId: adj.productId, batchId: adj.batchId, ownerCustomerId: adj.ownerCustomerId, status: adj.inventoryStatus as never,
    quantity: adj.quantityDelta, type, unitCost: adj.unitCost, referenceType: 'stock_adjustment', referenceId: adj.id, referenceNo: adj.number, reason: `${adj.reasonCode}${adj.notes ? `: ${adj.notes}` : ''}`,
  });
  await tx.update(t.stockAdjustments).set({ status: 'posted', postedAt: new Date(), approvedBy: adj.status === 'pending_approval' ? ctx.userId : null }).where(eq(t.stockAdjustments.id, adj.id));
  await audit(tx, ctx, { action: 'inventory.adjusted', entityType: 'stock_adjustment', entityId: adj.id, newValue: { number: adj.number, quantityDelta: adj.quantityDelta, reason: adj.reasonCode, value: adj.value } });
  await emitEvent(tx, ctx.tenantId, 'inventory.adjusted', { number: adj.number, productId: adj.productId, quantityDelta: adj.quantityDelta });
}

registerApprovalHandler('stock_adjustment', {
  approve: async (tx, ctx, id) => {
    const [adj] = await tx.select().from(t.stockAdjustments).where(and(eq(t.stockAdjustments.id, id), eq(t.stockAdjustments.tenantId, ctx.tenantId))).limit(1);
    if (!adj || adj.status !== 'pending_approval') throw invalidState('Adjustment is not awaiting approval.');
    await postAdjustment(tx, ctx, adj);
  },
  reject: async (tx, ctx, id) => {
    await tx.update(t.stockAdjustments).set({ status: 'rejected', approvedBy: ctx.userId }).where(and(eq(t.stockAdjustments.id, id), eq(t.stockAdjustments.tenantId, ctx.tenantId)));
  },
});

/** Moves available stock of expired batches into the expired status. */
export async function expireBatches(tx: DbOrTx, ctx: Ctx): Promise<{ moved: number }> {
  const due = await rows<{ warehouse_id: string; location_id: string; product_id: string; batch_id: string; owner_customer_id: string | null; quantity: string; batch_no: string }>(tx, sql`
    SELECT b.warehouse_id, b.location_id, b.product_id, b.batch_id, b.owner_customer_id, b.quantity, bt.batch_no
    FROM inventory_balances b JOIN batches bt ON bt.id = b.batch_id
    WHERE b.tenant_id = ${ctx.tenantId} AND b.status = 'available' AND b.quantity > 0 AND bt.expiry_date < CURRENT_DATE`);
  for (const d of due) {
    const key = { warehouseId: d.warehouse_id, locationId: d.location_id, productId: d.product_id, batchId: d.batch_id, ownerCustomerId: d.owner_customer_id };
    await moveStock(tx, ctx, { from: { ...key, status: 'available' }, to: { ...key, status: 'expired' }, quantity: num(d.quantity), outType: 'status_change', inType: 'status_change', referenceType: 'batch_expiry', reason: `Batch ${d.batch_no} expired` });
  }
  if (due.length) await tx.execute(sql`UPDATE batches SET status = 'expired' WHERE tenant_id = ${ctx.tenantId} AND expiry_date < CURRENT_DATE AND status = 'active'`);
  return { moved: due.length };
}
