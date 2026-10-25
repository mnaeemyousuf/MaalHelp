import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, num, one, rows, t, type DbOrTx, type Tx } from '../../db';
import { idParam, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, forbidden, insufficientStock, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { moveStock, postMovement } from '../inventory/ledger';
import { notify } from '../alerts/notify';
import { emitEvent } from '../integrations/events';

const lineBody = z.object({
  productId: z.string().uuid(),
  sourceLocationId: z.string().uuid(),
  destLocationId: z.string().uuid().nullish(),
  batchId: z.string().uuid().nullish(),
  ownerCustomerId: z.string().uuid().nullish(),
  quantity: z.number().positive(),
});

export const transferBody = z.object({
  type: z.enum(['warehouse', 'location']).default('warehouse'),
  sourceWarehouseId: z.string().uuid(),
  destWarehouseId: z.string().uuid().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  notes: z.string().trim().max(500).default(''),
  submit: z.boolean().default(true),
  lines: z.array(lineBody).min(1).max(200),
});

async function load(dbx: DbOrTx, tenantId: string, id: string, lock = false) {
  const q = dbx.select().from(t.stockTransfers).where(and(eq(t.stockTransfers.id, id), eq(t.stockTransfers.tenantId, tenantId))).limit(1);
  const [tr] = lock ? await q.for('update') : await q;
  if (!tr) throw notFound('Transfer');
  const lines = await dbx.select().from(t.stockTransferLines).where(eq(t.stockTransferLines.transferId, tr.id));
  return { tr, lines };
}

async function availableAt(dbx: DbOrTx, tenantId: string, l: z.infer<typeof lineBody>) {
  const row = await one<{ q: string }>(dbx, sql`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_balances WHERE tenant_id = ${tenantId} AND location_id = ${l.sourceLocationId} AND product_id = ${l.productId} AND status = 'available' AND batch_id IS NOT DISTINCT FROM ${l.batchId ?? null}::uuid AND owner_customer_id IS NOT DISTINCT FROM ${l.ownerCustomerId ?? null}::uuid`);
  return num(row?.q);
}

export async function createTransfer(tx: Tx, ctx: Ctx, body: z.infer<typeof transferBody>) {
  const destWarehouseId = body.type === 'location' ? body.sourceWarehouseId : body.destWarehouseId;
  if (!destWarehouseId) throw badRequest('Choose a destination warehouse.');
  if (body.type === 'warehouse' && destWarehouseId === body.sourceWarehouseId) throw badRequest('Source and destination warehouses must differ. Use a location transfer to move stock inside a warehouse.');
  const whs = await tx.select({ id: t.warehouses.id }).from(t.warehouses).where(and(eq(t.warehouses.tenantId, ctx.tenantId), inArray(t.warehouses.id, [body.sourceWarehouseId, destWarehouseId])));
  if (whs.length !== new Set([body.sourceWarehouseId, destWarehouseId]).size) throw notFound('Warehouse');
  for (const l of body.lines) {
    const [src] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.id, l.sourceLocationId), eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, body.sourceWarehouseId))).limit(1);
    if (!src) throw badRequest('A source location is not in the source warehouse.');
    if (l.destLocationId) {
      const [dst] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.id, l.destLocationId), eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, destWarehouseId))).limit(1);
      if (!dst) throw badRequest('A destination location is not in the destination warehouse.');
    } else if (body.type === 'location') throw badRequest('Location transfers need a destination location for each line.');
    if (body.type === 'location' && l.destLocationId === l.sourceLocationId) throw badRequest('Source and destination locations are the same.');
    const available = await availableAt(tx, ctx.tenantId, l);
    if (available < l.quantity) throw insufficientStock(`Only ${available} available at the source location.`, { productId: l.productId, available });
  }
  const number = await nextNumber(tx, ctx.tenantId, 'TRF');
  const now = new Date();
  const [tr] = await tx.insert(t.stockTransfers).values({
    tenantId: ctx.tenantId, number, type: body.type, sourceWarehouseId: body.sourceWarehouseId, destWarehouseId, priority: body.priority, notes: body.notes,
    status: body.submit ? 'requested' : 'draft', requestedBy: body.submit ? ctx.userId : null, requestedAt: body.submit ? now : null, createdBy: ctx.userId,
  }).returning();
  await tx.insert(t.stockTransferLines).values(body.lines.map((l) => ({ tenantId: ctx.tenantId, transferId: tr!.id, productId: l.productId, sourceLocationId: l.sourceLocationId, destLocationId: l.destLocationId ?? null, batchId: l.batchId ?? null, ownerCustomerId: l.ownerCustomerId ?? null, quantity: l.quantity })));
  await audit(tx, ctx, { action: 'transfer.created', entityType: 'transfer', entityId: tr!.id, newValue: { number, type: body.type, lines: body.lines.length, status: tr!.status } });
  if (body.submit) await notify(tx, ctx.tenantId, { severity: 'info', category: 'transfer', title: `Transfer ${number} needs approval`, entityType: 'transfer', entityId: tr!.id, actionUrl: `/transfers/${tr!.id}`, permission: 'transfer.approve', dedupeKey: `transfer-approval:${tr!.id}` });
  return tr!;
}

export function registerTransferRoutes(r: Router) {
  r.get('/', { summary: 'Stock transfers', permission: ['transfer.request', 'transfer.execute', 'transfer.approve', 'inventory.view'], query: pageQuery.extend({ status: z.string().optional(), warehouseId: z.string().uuid().optional() }) }, async ({ ctx, query }) => {
    const statuses = query.status?.split(',').filter(Boolean);
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT tr.id, tr.number, tr.type, tr.status, tr.priority, tr.notes, tr.created_at AS "createdAt", tr.requested_at AS "requestedAt", tr.received_at AS "receivedAt",
        sw.code AS "sourceCode", sw.name AS "sourceName", dw.code AS "destCode", dw.name AS "destName", ru.name AS "requestedBy", au.name AS "approvedBy",
        (SELECT COUNT(*)::int FROM stock_transfer_lines l WHERE l.transfer_id = tr.id) AS lines,
        (SELECT COALESCE(SUM(quantity), 0)::float FROM stock_transfer_lines l WHERE l.transfer_id = tr.id) AS units,
        COUNT(*) OVER() AS total_count
      FROM stock_transfers tr JOIN warehouses sw ON sw.id = tr.source_warehouse_id JOIN warehouses dw ON dw.id = tr.dest_warehouse_id
      LEFT JOIN users ru ON ru.id = tr.requested_by LEFT JOIN users au ON au.id = tr.approved_by
      WHERE tr.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND tr.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ${query.warehouseId ? sql`AND (tr.source_warehouse_id = ${query.warehouseId} OR tr.dest_warehouse_id = ${query.warehouseId})` : sql``}
      ${like ? sql`AND lower(tr.number) LIKE ${like}` : sql``}
      ORDER BY tr.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'Transfer detail with lines and people', permission: ['transfer.request', 'transfer.execute', 'transfer.approve', 'inventory.view'], params: idParam }, async ({ ctx, params }) => {
    const { tr } = await load(db(), ctx.tenantId, params.id);
    const lines = await rows(db(), sql`
      SELECT l.id, l.quantity::float AS quantity, l.picked_qty::float AS "pickedQty", l.received_qty::float AS "receivedQty", p.id AS "productId", p.sku, p.name AS "productName", p.barcode,
        sl.id AS "sourceLocationId", sl.code AS "sourceCode", dl.id AS "destLocationId", dl.code AS "destCode", bt.batch_no AS "batchNo", l.batch_id AS "batchId", c.name AS "ownerName"
      FROM stock_transfer_lines l JOIN products p ON p.id = l.product_id JOIN locations sl ON sl.id = l.source_location_id LEFT JOIN locations dl ON dl.id = l.dest_location_id
      LEFT JOIN batches bt ON bt.id = l.batch_id LEFT JOIN customers c ON c.id = l.owner_customer_id WHERE l.transfer_id = ${tr.id} ORDER BY p.sku`);
    const people = await rows<{ id: string; name: string }>(db(), sql`SELECT id, name FROM users WHERE id IN (${sql.join([tr.requestedBy, tr.approvedBy, tr.pickedBy, tr.receivedBy, tr.createdBy].filter(Boolean).map((x) => sql`${x}`).concat([sql`NULL`]), sql`, `)})`);
    const name = (id: string | null) => people.find((p) => p.id === id)?.name ?? null;
    const [sw] = await db().select({ code: t.warehouses.code, name: t.warehouses.name }).from(t.warehouses).where(eq(t.warehouses.id, tr.sourceWarehouseId));
    const [dw] = await db().select({ code: t.warehouses.code, name: t.warehouses.name }).from(t.warehouses).where(eq(t.warehouses.id, tr.destWarehouseId));
    return { ...tr, source: sw, dest: dw, lines, requestedByName: name(tr.requestedBy), approvedByName: name(tr.approvedBy), pickedByName: name(tr.pickedBy), receivedByName: name(tr.receivedBy) };
  });

  r.post('/', { summary: 'Create a transfer (draft or submitted as requested)', permission: 'transfer.request', idempotent: true, body: transferBody }, async ({ ctx, body }) =>
    db().transaction((tx) => createTransfer(tx, ctx, body)));

  r.post('/:id/request', { summary: 'Submit a draft transfer for approval', permission: 'transfer.request', params: idParam }, async ({ ctx, params }) => step(ctx, params.id, ['draft'], async (tx, tr) => {
    await tx.update(t.stockTransfers).set({ status: 'requested', requestedBy: ctx.userId, requestedAt: new Date() }).where(eq(t.stockTransfers.id, tr.id));
    return 'transfer.requested';
  }));

  r.post('/:id/approve', { summary: 'Approve a requested transfer', permission: 'transfer.approve', params: idParam }, async ({ ctx, params }) => step(ctx, params.id, ['requested'], async (tx, tr) => {
    if (tr.requestedBy === ctx.userId && ctx.roleKey !== 'owner') throw forbidden('You cannot approve a transfer you requested.');
    await tx.update(t.stockTransfers).set({ status: 'approved', approvedBy: ctx.userId, approvedAt: new Date() }).where(eq(t.stockTransfers.id, tr.id));
    await tx.update(t.notifications).set({ resolvedAt: new Date() }).where(and(eq(t.notifications.tenantId, ctx.tenantId), eq(t.notifications.dedupeKey, `transfer-approval:${tr.id}`)));
    return 'transfer.approved';
  }));

  r.post('/:id/start-picking', { summary: 'Start picking an approved transfer', permission: 'transfer.execute', params: idParam }, async ({ ctx, params }) => step(ctx, params.id, ['approved'], async (tx, tr) => {
    await tx.update(t.stockTransfers).set({ status: 'picking', pickedBy: ctx.userId }).where(eq(t.stockTransfers.id, tr.id));
    return 'transfer.picking_started';
  }));

  r.post('/:id/dispatch', {
    summary: 'Confirm picked quantities and dispatch (stock becomes in transit). Location transfers complete immediately.',
    permission: 'transfer.execute',
    idempotent: true,
    params: idParam,
    body: z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().min(0) })).optional() }),
  }, async ({ ctx, params, body }) => step(ctx, params.id, ['approved', 'picking'], async (tx, tr, lines) => {
    for (const l of lines) {
      const qty = body.lines?.find((x) => x.lineId === l.id)?.quantity ?? l.quantity;
      if (qty > l.quantity) throw badRequest('Picked quantity cannot exceed the requested quantity.');
      if (qty <= 0) continue;
      const key = { warehouseId: tr.sourceWarehouseId, locationId: l.sourceLocationId, productId: l.productId, batchId: l.batchId, ownerCustomerId: l.ownerCustomerId };
      if (tr.type === 'location') {
        await moveStock(tx, ctx, { from: { ...key, status: 'available' }, to: { ...key, locationId: l.destLocationId!, status: 'available' }, quantity: qty, outType: 'transfer_out', inType: 'transfer_in', referenceType: 'transfer', referenceId: tr.id, referenceNo: tr.number });
        await tx.update(t.stockTransferLines).set({ pickedQty: qty, receivedQty: qty }).where(eq(t.stockTransferLines.id, l.id));
      } else {
        await moveStock(tx, ctx, { from: { ...key, status: 'available' }, to: { ...key, status: 'in_transit' }, quantity: qty, outType: 'transfer_out', inType: 'status_change', referenceType: 'transfer', referenceId: tr.id, referenceNo: tr.number, reason: 'Dispatched on transfer' });
        await tx.update(t.stockTransferLines).set({ pickedQty: qty }).where(eq(t.stockTransferLines.id, l.id));
      }
    }
    const now = new Date();
    if (tr.type === 'location') {
      await tx.update(t.stockTransfers).set({ status: 'completed', pickedBy: tr.pickedBy ?? ctx.userId, pickedAt: now, dispatchedAt: now, receivedAt: now, receivedBy: ctx.userId, completedAt: now }).where(eq(t.stockTransfers.id, tr.id));
      await emitEvent(tx, ctx.tenantId, 'transfer.completed', { transferId: tr.id, number: tr.number });
      return 'transfer.completed';
    }
    await tx.update(t.stockTransfers).set({ status: 'in_transit', pickedBy: tr.pickedBy ?? ctx.userId, pickedAt: now, dispatchedAt: now }).where(eq(t.stockTransfers.id, tr.id));
    return 'transfer.dispatched';
  }));

  r.post('/:id/receive', {
    summary: 'Receive an in-transit transfer at the destination warehouse',
    permission: 'transfer.execute',
    idempotent: true,
    params: idParam,
    body: z.object({ lines: z.array(z.object({ lineId: z.string().uuid(), quantity: z.number().min(0), destLocationId: z.string().uuid().optional() })).optional() }),
  }, async ({ ctx, params, body }) => step(ctx, params.id, ['in_transit'], async (tx, tr, lines) => {
    const [dock] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, tr.destWarehouseId), eq(t.locations.isReceiving, true))).limit(1);
    let short = false;
    for (const l of lines) {
      const input = body.lines?.find((x) => x.lineId === l.id);
      const qty = input?.quantity ?? l.pickedQty;
      if (qty > l.pickedQty + 1e-9) throw badRequest('Received quantity cannot exceed the dispatched quantity.');
      const destLocationId = input?.destLocationId ?? l.destLocationId ?? dock?.id;
      if (!destLocationId) throw badRequest('Choose a destination location.');
      const [dst] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.id, destLocationId), eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, tr.destWarehouseId))).limit(1);
      if (!dst) throw badRequest('Destination location is not in the destination warehouse.');
      if (qty > 0) {
        await moveStock(tx, ctx, {
          from: { warehouseId: tr.sourceWarehouseId, locationId: l.sourceLocationId, productId: l.productId, batchId: l.batchId, ownerCustomerId: l.ownerCustomerId, status: 'in_transit' },
          to: { warehouseId: tr.destWarehouseId, locationId: dst.id, productId: l.productId, batchId: l.batchId, ownerCustomerId: l.ownerCustomerId, status: 'available' },
          quantity: qty, outType: 'status_change', inType: 'transfer_in', referenceType: 'transfer', referenceId: tr.id, referenceNo: tr.number, reason: 'Transfer received',
        });
      }
      if (qty < l.pickedQty) short = true;
      await tx.update(t.stockTransferLines).set({ receivedQty: qty, destLocationId: dst.id }).where(eq(t.stockTransferLines.id, l.id));
    }
    const now = new Date();
    if (short) {
      await tx.update(t.stockTransfers).set({ status: 'received', receivedBy: ctx.userId, receivedAt: now }).where(eq(t.stockTransfers.id, tr.id));
      await notify(tx, ctx.tenantId, { severity: 'warning', category: 'transfer', title: `Transfer ${tr.number} received short`, body: 'Review the shortage and complete the transfer to write it off.', entityType: 'transfer', entityId: tr.id, actionUrl: `/transfers/${tr.id}`, permission: 'transfer.approve', dedupeKey: `transfer-short:${tr.id}` });
      return 'transfer.received_short';
    }
    await tx.update(t.stockTransfers).set({ status: 'completed', receivedBy: ctx.userId, receivedAt: now, completedAt: now }).where(eq(t.stockTransfers.id, tr.id));
    await emitEvent(tx, ctx.tenantId, 'transfer.completed', { transferId: tr.id, number: tr.number });
    return 'transfer.received';
  }));

  r.post('/:id/complete', { summary: 'Complete a short-received transfer: writes off the in-transit shortage', permission: 'transfer.approve', params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => step(ctx, params.id, ['received'], async (tx, tr, lines) => {
    for (const l of lines) {
      const shortage = l.pickedQty - l.receivedQty;
      if (shortage > 1e-9) {
        await postMovement(tx, ctx, { warehouseId: tr.sourceWarehouseId, locationId: l.sourceLocationId, productId: l.productId, batchId: l.batchId, ownerCustomerId: l.ownerCustomerId, status: 'in_transit', quantity: -shortage, type: 'write_off', referenceType: 'transfer', referenceId: tr.id, referenceNo: tr.number, reason: `Transit shortage: ${body.reason}` });
      }
    }
    await tx.update(t.stockTransfers).set({ status: 'completed', completedAt: new Date() }).where(eq(t.stockTransfers.id, tr.id));
    await emitEvent(tx, ctx.tenantId, 'transfer.completed', { transferId: tr.id, number: tr.number, shortage: true });
    return 'transfer.completed_with_shortage';
  }));

  r.post('/:id/cancel', { summary: 'Cancel a transfer that has not been dispatched', permission: ['transfer.request', 'transfer.approve'], params: idParam, body: z.object({ reason: z.string().trim().min(3).max(300) }) }, async ({ ctx, params, body }) => step(ctx, params.id, ['draft', 'requested', 'approved', 'picking'], async (tx, tr) => {
    await tx.update(t.stockTransfers).set({ status: 'cancelled', notes: `${tr.notes}\n[Cancelled] ${body.reason}`.trim() }).where(eq(t.stockTransfers.id, tr.id));
    return 'transfer.cancelled';
  }));
}

/** Runs a workflow step with state checking, locking and auditing. */
async function step(ctx: Ctx, id: string, from: string[], fn: (tx: Tx, tr: typeof t.stockTransfers.$inferSelect, lines: (typeof t.stockTransferLines.$inferSelect)[]) => Promise<string>) {
  return db().transaction(async (tx) => {
    const { tr, lines } = await load(tx, ctx.tenantId, id, true);
    if (!from.includes(tr.status)) throw invalidState(`Transfer ${tr.number} is ${tr.status.replace('_', ' ')}; this action needs it to be ${from.join(' or ')}.`);
    const action = await fn(tx, tr, lines);
    await audit(tx, ctx, { action, entityType: 'transfer', entityId: tr.id, oldValue: { status: tr.status } });
    const [after] = await tx.select().from(t.stockTransfers).where(eq(t.stockTransfers.id, tr.id));
    return after;
  });
}
