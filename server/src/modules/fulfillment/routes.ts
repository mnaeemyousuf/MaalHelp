import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { PRIORITIES } from '@shared/domain';
import { db, num, one, rows, t, type Tx } from '../../db';
import { idParam, pageQuery, paged, type Router } from '../../core/http';
import { AppError, badRequest, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { moveStock, postMovement } from '../inventory/ledger';
import { lookupProduct } from '../products/routes';
import { getOrder } from '../sales/routes';
import { reserveOrder } from '../sales/reservation';
import { createInvoice } from '../finance/invoicing';
import { notify } from '../alerts/notify';
import { emitEvent } from '../integrations/events';
import { shippingAdapter } from '../integrations/adapters';

const PRIORITY_ORDER = sql.raw(`array_position(ARRAY['urgent','high','normal','low'], pt.priority)`);

async function dispatchDock(tx: Tx, tenantId: string, warehouseId: string) {
  const [dock] = await tx.select().from(t.locations).where(and(eq(t.locations.tenantId, tenantId), eq(t.locations.warehouseId, warehouseId), eq(t.locations.isDispatch, true))).limit(1);
  if (!dock) throw invalidState('This warehouse has no dispatch dock location.');
  return dock;
}

async function refreshOrderPickState(tx: Tx, orderId: string) {
  const [state] = await rows<{ open: number; done: number }>(tx, sql`SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress'))::int AS open, COUNT(*) FILTER (WHERE status IN ('completed', 'short'))::int AS done FROM pick_tasks WHERE sales_order_id = ${orderId}`);
  if ((state?.done ?? 0) > 0) await tx.execute(sql`UPDATE sales_orders SET status = 'picking' WHERE id = ${orderId} AND status IN ('reserved', 'confirmed')`);
  return state;
}

export function registerPickingRoutes(r: Router) {
  r.get('/tasks', {
    summary: 'Pick tasks (priority first). Supports single-order, batch (wave), zone and "my tasks" views.',
    permission: ['picking.execute', 'task.manage'],
    query: pageQuery.extend({
      status: z.string().default('pending,in_progress'),
      warehouseId: z.string().uuid().optional(),
      zoneId: z.string().uuid().optional(),
      waveId: z.string().uuid().optional(),
      salesOrderId: z.string().uuid().optional(),
      mine: z.coerce.boolean().optional(),
      priority: z.enum(PRIORITIES).optional(),
    }),
  }, async ({ ctx, query }) => {
    const statuses = query.status.split(',').filter(Boolean);
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT pt.id, pt.number, pt.status, pt.priority, pt.quantity::float AS quantity, pt.picked_qty::float AS "pickedQty", pt.created_at AS "createdAt",
        so.id AS "salesOrderId", so.number AS "orderNumber", c.name AS "customerName", p.id AS "productId", p.sku, p.name AS "productName", p.barcode, p.uom, p.track_serial AS "trackSerial",
        l.id AS "locationId", l.code AS "locationCode", l.barcode AS "locationBarcode", z.code AS "zoneCode", pt.zone_id AS "zoneId", bt.batch_no AS "batchNo", bt.expiry_date AS "expiryDate",
        w.code AS "warehouseCode", pt.warehouse_id AS "warehouseId", u.name AS "assignedTo", pt.assigned_to AS "assignedToId", wv.number AS "waveNumber", pt.wave_id AS "waveId",
        COUNT(*) OVER() AS total_count
      FROM pick_tasks pt JOIN sales_orders so ON so.id = pt.sales_order_id JOIN customers c ON c.id = so.customer_id JOIN products p ON p.id = pt.product_id
      JOIN locations l ON l.id = pt.location_id JOIN warehouses w ON w.id = pt.warehouse_id LEFT JOIN locations z ON z.id = pt.zone_id
      LEFT JOIN batches bt ON bt.id = pt.batch_id LEFT JOIN users u ON u.id = pt.assigned_to LEFT JOIN pick_waves wv ON wv.id = pt.wave_id
      WHERE pt.tenant_id = ${ctx.tenantId} AND pt.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})
      ${query.warehouseId ? sql`AND pt.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.zoneId ? sql`AND pt.zone_id = ${query.zoneId}` : sql``}
      ${query.waveId ? sql`AND pt.wave_id = ${query.waveId}` : sql``}
      ${query.salesOrderId ? sql`AND pt.sales_order_id = ${query.salesOrderId}` : sql``}
      ${query.priority ? sql`AND pt.priority = ${query.priority}` : sql``}
      ${query.mine ? sql`AND (pt.assigned_to = ${ctx.userId} OR pt.assigned_to IS NULL)` : sql``}
      ORDER BY ${PRIORITY_ORDER}, so.required_date NULLS LAST, so.created_at, l.pick_priority, l.code
      LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/waves', {
    summary: 'Group pick tasks into a batch or zone wave and optionally assign a picker',
    permission: 'task.manage',
    body: z.object({ warehouseId: z.string().uuid(), type: z.enum(['batch', 'zone']).default('batch'), taskIds: z.array(z.string().uuid()).optional(), salesOrderIds: z.array(z.string().uuid()).optional(), zoneId: z.string().uuid().optional(), assignedTo: z.string().uuid().nullish() }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const conds = [eq(t.pickTasks.tenantId, ctx.tenantId), eq(t.pickTasks.warehouseId, body.warehouseId), eq(t.pickTasks.status, 'pending')];
      if (body.taskIds?.length) conds.push(inArray(t.pickTasks.id, body.taskIds));
      if (body.salesOrderIds?.length) conds.push(inArray(t.pickTasks.salesOrderId, body.salesOrderIds));
      if (body.zoneId) conds.push(eq(t.pickTasks.zoneId, body.zoneId));
      const tasks = await tx.select({ id: t.pickTasks.id }).from(t.pickTasks).where(and(...conds));
      if (!tasks.length) throw badRequest('No pending pick tasks match.');
      const [wave] = await tx.insert(t.pickWaves).values({ tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'WAVE'), warehouseId: body.warehouseId, type: body.type, assignedTo: body.assignedTo ?? null, createdBy: ctx.userId }).returning();
      await tx.update(t.pickTasks).set({ waveId: wave!.id, assignedTo: body.assignedTo ?? undefined }).where(inArray(t.pickTasks.id, tasks.map((x) => x.id)));
      await audit(tx, ctx, { action: 'pick_wave.created', entityType: 'pick_wave', entityId: wave!.id, newValue: { tasks: tasks.length, type: body.type } });
      return { ...wave!, tasks: tasks.length };
    });
  });

  r.get('/waves', { summary: 'Open pick waves', permission: ['picking.execute', 'task.manage'] }, async ({ ctx }) =>
    rows(db(), sql`SELECT wv.id, wv.number, wv.type, wv.status, wv.created_at AS "createdAt", u.name AS "assignedTo", w.code AS "warehouseCode",
      COUNT(pt.id)::int AS tasks, COUNT(pt.id) FILTER (WHERE pt.status IN ('completed', 'short'))::int AS done, COUNT(DISTINCT pt.sales_order_id)::int AS orders
      FROM pick_waves wv JOIN warehouses w ON w.id = wv.warehouse_id LEFT JOIN users u ON u.id = wv.assigned_to LEFT JOIN pick_tasks pt ON pt.wave_id = wv.id
      WHERE wv.tenant_id = ${ctx.tenantId} AND wv.status = 'open' GROUP BY wv.id, u.name, w.code ORDER BY wv.created_at DESC`));

  r.post('/tasks/assign', { summary: 'Assign pick tasks to a picker', permission: 'task.manage', body: z.object({ taskIds: z.array(z.string().uuid()).min(1), userId: z.string().uuid().nullable() }) }, async ({ ctx, body }) => {
    await db().update(t.pickTasks).set({ assignedTo: body.userId }).where(and(eq(t.pickTasks.tenantId, ctx.tenantId), inArray(t.pickTasks.id, body.taskIds)));
    await audit(db(), ctx, { action: 'pick_tasks.assigned', entityType: 'pick_task', entityId: body.taskIds.join(',').slice(0, 200), newValue: body });
    return { ok: true };
  });

  r.post('/tasks/:id/confirm', {
    summary: 'Confirm a pick: scanned location and product must match; quantity cannot exceed the task',
    permission: 'picking.execute',
    idempotent: true,
    params: idParam,
    body: z.object({ locationCode: z.string().trim().min(1).max(120), productCode: z.string().trim().min(1).max(120), quantity: z.number().positive(), serials: z.array(z.string().trim().min(1)).max(1000).default([]) }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const [task] = await tx.select().from(t.pickTasks).where(and(eq(t.pickTasks.id, params.id), eq(t.pickTasks.tenantId, ctx.tenantId))).for('update').limit(1);
      if (!task) throw notFound('Pick task');
      if (!['pending', 'in_progress'].includes(task.status)) throw invalidState('This pick task is already finished.');
      const [loc] = await tx.select().from(t.locations).where(eq(t.locations.id, task.locationId)).limit(1);
      const scanned = body.locationCode.toUpperCase();
      if (![loc!.barcode.toUpperCase(), loc!.code.toUpperCase()].includes(scanned)) {
        throw new AppError(422, 'WRONG_LOCATION', `Wrong location. Go to ${loc!.code} (you scanned ${body.locationCode}).`, { expected: loc!.code });
      }
      const product = await lookupProduct(tx, ctx.tenantId, body.productCode);
      if (!product || product.id !== task.productId) {
        const [expected] = await tx.select({ sku: t.products.sku, name: t.products.name }).from(t.products).where(eq(t.products.id, task.productId));
        throw new AppError(422, 'WRONG_PRODUCT', `Wrong product. This task needs ${expected?.sku} — ${expected?.name}.`, { expected: expected?.sku, scanned: product?.sku ?? body.productCode });
      }
      const remaining = task.quantity - task.pickedQty;
      if (body.quantity > remaining + 1e-9) {
        throw new AppError(422, 'EXCESS_QUANTITY', `Too many. Pick only ${remaining} (you entered ${body.quantity}).`, { remaining });
      }
      const [prod] = await tx.select({ trackSerial: t.products.trackSerial }).from(t.products).where(eq(t.products.id, task.productId));
      if (prod?.trackSerial && body.serials.length !== body.quantity) throw badRequest(`Scan ${body.quantity} serial number(s) for this serial-tracked product.`);

      const [order] = await tx.select().from(t.salesOrders).where(eq(t.salesOrders.id, task.salesOrderId)).limit(1);
      const dock = await dispatchDock(tx, ctx.tenantId, task.warehouseId);
      const key = { warehouseId: task.warehouseId, productId: task.productId, batchId: task.batchId };
      await moveStock(tx, ctx, {
        from: { ...key, locationId: task.locationId, status: 'reserved' }, to: { ...key, locationId: dock.id, status: 'reserved' }, quantity: body.quantity,
        outType: 'pick', inType: 'pick', referenceType: 'sales_order', referenceId: task.salesOrderId, referenceNo: order?.number, reason: `Picked ${task.number}`,
      });
      if (body.serials.length) {
        const updated = await tx.update(t.serialNumbers).set({ status: 'reserved', locationId: dock.id, referenceType: 'sales_order', referenceId: task.salesOrderId, updatedAt: new Date() })
          .where(and(eq(t.serialNumbers.tenantId, ctx.tenantId), eq(t.serialNumbers.productId, task.productId), inArray(t.serialNumbers.serial, body.serials), eq(t.serialNumbers.status, 'in_stock'), eq(t.serialNumbers.locationId, task.locationId))).returning({ id: t.serialNumbers.id });
        if (updated.length !== body.serials.length) throw badRequest('One or more serial numbers are not in stock at this location.');
      }
      const picked = task.pickedQty + body.quantity;
      const done = picked >= task.quantity - 1e-9;
      await tx.update(t.pickTasks).set({ pickedQty: picked, status: done ? 'completed' : 'in_progress', pickedBy: ctx.userId, pickedAt: new Date(), assignedTo: task.assignedTo ?? ctx.userId }).where(eq(t.pickTasks.id, task.id));
      if (task.reservationId) await tx.execute(sql`UPDATE stock_reservations SET picked_qty = picked_qty + ${body.quantity}, status = CASE WHEN picked_qty + ${body.quantity} >= quantity THEN 'picked' ELSE status END WHERE id = ${task.reservationId}`);
      await tx.execute(sql`UPDATE sales_order_lines SET picked_qty = picked_qty + ${body.quantity} WHERE id = ${task.salesOrderLineId}`);
      const state = await refreshOrderPickState(tx, task.salesOrderId);
      await audit(tx, ctx, { action: 'order.picked', entityType: 'pick_task', entityId: task.id, newValue: { order: order?.number, location: loc!.code, sku: product.sku, quantity: body.quantity } });
      if (state && state.open === 0) await emitEvent(tx, ctx.tenantId, 'order.picked', { salesOrderId: task.salesOrderId, number: order?.number });
      return { ok: true, taskStatus: done ? 'completed' : 'in_progress', remaining: Math.max(0, task.quantity - picked), orderReadyToPack: state?.open === 0 };
    });
  });

  r.post('/tasks/:id/short', {
    summary: 'Report a short pick: the unpicked remainder is blocked pending a count and re-reserved elsewhere',
    permission: 'picking.execute',
    params: idParam,
    body: z.object({ reason: z.string().trim().min(3).max(300) }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const [task] = await tx.select().from(t.pickTasks).where(and(eq(t.pickTasks.id, params.id), eq(t.pickTasks.tenantId, ctx.tenantId))).for('update').limit(1);
      if (!task) throw notFound('Pick task');
      if (!['pending', 'in_progress'].includes(task.status)) throw invalidState('This pick task is already finished.');
      const missing = task.quantity - task.pickedQty;
      const key = { warehouseId: task.warehouseId, locationId: task.locationId, productId: task.productId, batchId: task.batchId };
      if (missing > 0) {
        await moveStock(tx, ctx, { from: { ...key, status: 'reserved' }, to: { ...key, status: 'blocked' }, quantity: missing, outType: 'status_change', inType: 'status_change', referenceType: 'pick_task', referenceId: task.id, referenceNo: task.number, reason: `Short pick: ${body.reason}` });
        await tx.execute(sql`UPDATE sales_order_lines SET reserved_qty = GREATEST(reserved_qty - ${missing}, 0) WHERE id = ${task.salesOrderLineId}`);
        if (task.reservationId) await tx.execute(sql`UPDATE stock_reservations SET quantity = picked_qty, status = CASE WHEN picked_qty > 0 THEN 'picked' ELSE 'released' END WHERE id = ${task.reservationId}`);
      }
      await tx.update(t.pickTasks).set({ status: 'short', pickedBy: ctx.userId, pickedAt: new Date() }).where(eq(t.pickTasks.id, task.id));
      const reservation = await reserveOrder(tx, ctx, task.salesOrderId); // try other locations
      const [loc] = await tx.select({ code: t.locations.code }).from(t.locations).where(eq(t.locations.id, task.locationId));
      await notify(tx, ctx.tenantId, { severity: 'warning', category: 'stock_discrepancy', title: `Short pick at ${loc?.code}`, body: `${missing} unit(s) not found (${body.reason}). Stock blocked pending a cycle count.`, entityType: 'location', entityId: task.locationId, actionUrl: '/stock-counts', permission: 'inventory.count', dedupeKey: `short-pick:${task.id}` });
      await audit(tx, ctx, { action: 'order.short_picked', entityType: 'pick_task', entityId: task.id, newValue: { missing, reason: body.reason, rereserved: reservation.reservedUnits } });
      await refreshOrderPickState(tx, task.salesOrderId);
      return { ok: true, missing, rereserved: reservation.reservedUnits };
    });
  });
}

export function registerPackingRoutes(r: Router) {
  r.get('/queue', { summary: 'Orders ready to pack (all picks finished)', permission: ['packing.execute', 'task.manage'], query: z.object({ warehouseId: z.string().uuid().optional() }) }, async ({ ctx, query }) =>
    rows(db(), sql`
      SELECT so.id, so.number, so.priority, so.required_date AS "requiredDate", c.name AS "customerName", w.code AS "warehouseCode",
        SUM(l.picked_qty)::float AS "pickedQty", SUM(l.packed_qty)::float AS "packedQty", COUNT(l.id)::int AS lines
      FROM sales_orders so JOIN customers c ON c.id = so.customer_id JOIN warehouses w ON w.id = so.warehouse_id JOIN sales_order_lines l ON l.sales_order_id = so.id
      WHERE so.tenant_id = ${ctx.tenantId} AND so.status IN ('picking', 'reserved')
        ${query.warehouseId ? sql`AND so.warehouse_id = ${query.warehouseId}` : sql``}
        AND NOT EXISTS (SELECT 1 FROM pick_tasks pt WHERE pt.sales_order_id = so.id AND pt.status IN ('pending', 'in_progress'))
      GROUP BY so.id, c.name, w.code HAVING SUM(l.picked_qty) > 0
      ORDER BY array_position(ARRAY['urgent','high','normal','low'], so.priority), so.created_at`));

  r.post('/:id/scan', {
    summary: 'Packing verification scan: ✓ correct product / ✗ wrong product / ✗ excess quantity',
    permission: 'packing.execute',
    params: idParam,
    body: z.object({ code: z.string().trim().min(1).max(120), quantity: z.number().positive().optional() }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id, true);
      if (!['picking', 'reserved'].includes(order.status)) throw invalidState(`Order ${order.number} is ${order.status}; it cannot be packed.`);
      const product = await lookupProduct(tx, ctx.tenantId, body.code);
      if (!product) return { result: 'wrong_product', message: `✗ Unknown barcode ${body.code}` };
      const lines = await tx.select().from(t.salesOrderLines).where(and(eq(t.salesOrderLines.salesOrderId, order.id), eq(t.salesOrderLines.productId, product.id)));
      const line = lines.find((l) => l.packedQty < l.pickedQty) ?? lines[0];
      if (!line) return { result: 'wrong_product', message: `✗ Wrong product: ${product.sku} is not on ${order.number}` };
      const qty = body.quantity ?? product.unitQty;
      if (line.packedQty + qty > line.pickedQty + 1e-9) return { result: 'excess', message: `✗ Too many ${product.sku}: picked ${line.pickedQty}, already packed ${line.packedQty}` };
      await tx.update(t.salesOrderLines).set({ packedQty: line.packedQty + qty }).where(eq(t.salesOrderLines.id, line.id));
      const remaining = await one<{ left: string }>(tx, sql`SELECT COALESCE(SUM(picked_qty - packed_qty), 0) AS left FROM sales_order_lines WHERE sales_order_id = ${order.id}`);
      return { result: 'ok', message: `✓ ${product.sku} × ${qty}`, sku: product.sku, packedQty: line.packedQty + qty, pickedQty: line.pickedQty, orderRemaining: num(remaining?.left) };
    });
  });

  r.post('/:id/reset', { summary: 'Restart packing verification for an order', permission: 'packing.execute', params: idParam }, async ({ ctx, params }) => {
    const order = await getOrder(db(), ctx.tenantId, params.id);
    if (!['picking', 'reserved'].includes(order.status)) throw invalidState('Only orders being packed can be reset.');
    await db().update(t.salesOrderLines).set({ packedQty: 0 }).where(eq(t.salesOrderLines.salesOrderId, order.id));
    return { ok: true };
  });

  r.post('/:id/complete', {
    summary: 'Complete packing: creates packages (with barcodes) and a shipment ready for dispatch',
    permission: 'packing.execute',
    idempotent: true,
    params: idParam,
    body: z.object({ packages: z.array(z.object({ weightKg: z.number().min(0).default(0), lengthCm: z.number().min(0).default(0), widthCm: z.number().min(0).default(0), heightCm: z.number().min(0).default(0) })).min(1).max(200), skipVerification: z.boolean().default(false) }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id, true);
      if (!['picking', 'reserved'].includes(order.status)) throw invalidState(`Order ${order.number} is ${order.status}.`);
      const open = await one<{ n: number }>(tx, sql`SELECT COUNT(*)::int AS n FROM pick_tasks WHERE sales_order_id = ${order.id} AND status IN ('pending', 'in_progress')`);
      if ((open?.n ?? 0) > 0) throw invalidState('Finish or short-pick all pick tasks before packing.');
      const lines = await tx.select().from(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, order.id));
      if (!lines.some((l) => l.pickedQty > 0)) throw invalidState('Nothing has been picked for this order.');
      if (body.skipVerification) {
        if (!ctx.permissions.has('task.manage')) throw badRequest('Scan every item to verify, or ask a manager to skip verification.');
        for (const l of lines) await tx.update(t.salesOrderLines).set({ packedQty: l.pickedQty }).where(eq(t.salesOrderLines.id, l.id));
      } else {
        const unverified = lines.filter((l) => l.packedQty + 1e-9 < l.pickedQty);
        if (unverified.length) throw new AppError(422, 'PACKING_NOT_VERIFIED', `${unverified.length} line(s) not fully scanned. Verify every picked item before closing the carton.`);
      }
      const [w] = await tx.select({ code: t.warehouses.code }).from(t.warehouses).where(eq(t.warehouses.id, order.warehouseId));
      const totalWeight = body.packages.reduce((s, p) => s + p.weightKg, 0);
      const [shipment] = await tx.insert(t.shipments).values({ tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'SHP'), salesOrderId: order.id, warehouseId: order.warehouseId, destination: order.shippingAddress, packageCount: body.packages.length, totalWeightKg: totalWeight, status: 'ready', createdBy: ctx.userId }).returning();
      for (let i = 0; i < body.packages.length; i++) {
        const p = body.packages[i]!;
        await tx.insert(t.packages).values({ tenantId: ctx.tenantId, salesOrderId: order.id, shipmentId: shipment!.id, packageNo: i + 1, barcode: `${await nextNumber(tx, ctx.tenantId, 'PKG')}-${w?.code ?? ''}`, ...p, items: i === 0 ? lines.map((l) => ({ productId: l.productId, quantity: l.pickedQty })) : [], packedBy: ctx.userId });
      }
      await tx.insert(t.shipmentEvents).values({ tenantId: ctx.tenantId, shipmentId: shipment!.id, status: 'ready', note: `${body.packages.length} package(s) packed`, createdBy: ctx.userId });
      await tx.update(t.salesOrders).set({ status: 'packed', packedAt: new Date(), packageCount: body.packages.length, totalWeightKg: totalWeight }).where(eq(t.salesOrders.id, order.id));
      await audit(tx, ctx, { action: 'order.packed', entityType: 'sales_order', entityId: order.id, newValue: { packages: body.packages.length, weightKg: totalWeight, skippedVerification: body.skipVerification } });
      await emitEvent(tx, ctx.tenantId, 'order.packed', { salesOrderId: order.id, number: order.number, shipmentId: shipment!.id });
      return { status: 'packed', shipmentId: shipment!.id, shipmentNumber: shipment!.number };
    });
  });
}

const DISPATCH_FLOW: Record<string, string[]> = {
  ready: ['dispatched'],
  dispatched: ['in_transit', 'delivered', 'failed'],
  in_transit: ['delivered', 'failed', 'returned'],
  failed: ['in_transit', 'returned'],
  delivered: [],
  returned: [],
};

export function registerDispatchRoutes(r: Router) {
  r.post('/:id', {
    summary: 'Dispatch a packed order: consumes stock, ships packed quantities, creates the sales invoice',
    permission: 'dispatch.execute',
    idempotent: true,
    params: idParam,
    body: z.object({
      carrier: z.string().trim().max(80).default('Own vehicle'),
      service: z.string().trim().max(80).default(''),
      trackingNumber: z.string().trim().max(80).default(''),
      vehicleNo: z.string().trim().max(30).default(''),
      driverName: z.string().trim().max(80).default(''),
      driverPhone: z.string().trim().max(40).default(''),
      destination: z.string().trim().max(400).optional(),
      freightCost: z.number().min(0).default(0),
      bookWithCarrier: z.string().max(40).optional(),
    }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const order = await getOrder(tx, ctx.tenantId, params.id, true);
      if (order.status !== 'packed') throw invalidState(`Pack and verify order ${order.number} before dispatch (it is ${order.status}).`);
      const dock = await dispatchDock(tx, ctx.tenantId, order.warehouseId);
      const lines = await tx.select().from(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, order.id));
      const reservations = await tx.select().from(t.stockReservations).where(and(eq(t.stockReservations.salesOrderId, order.id), inArray(t.stockReservations.status, ['picked', 'active'])));
      let costTotal = 0;
      for (const line of lines) {
        const qty = line.packedQty;
        if (qty <= 0) continue;
        const [p] = await tx.select({ cost: t.products.costPrice, sku: t.products.sku, name: t.products.name }).from(t.products).where(eq(t.products.id, line.productId));
        // Consume from the dispatch dock per batch, as picked.
        let left = qty;
        const byBatch = reservations.filter((r0) => r0.salesOrderLineId === line.id && r0.pickedQty > 0);
        for (const res of byBatch) {
          if (left <= 1e-9) break;
          const take = Math.min(left, res.pickedQty);
          await postMovement(tx, ctx, { warehouseId: order.warehouseId, locationId: dock.id, productId: line.productId, batchId: res.batchId, status: 'reserved', quantity: -take, type: 'dispatch', unitCost: p?.cost, referenceType: 'sales_order', referenceId: order.id, referenceNo: order.number, reason: 'Dispatched' });
          left -= take;
        }
        if (left > 1e-9) {
          await postMovement(tx, ctx, { warehouseId: order.warehouseId, locationId: dock.id, productId: line.productId, status: 'reserved', quantity: -left, type: 'dispatch', unitCost: p?.cost, referenceType: 'sales_order', referenceId: order.id, referenceNo: order.number, reason: 'Dispatched' });
        }
        costTotal += qty * (p?.cost ?? 0);
        await tx.update(t.salesOrderLines).set({ shippedQty: line.shippedQty + qty, unitCost: p?.cost ?? 0 }).where(eq(t.salesOrderLines.id, line.id));
      }
      await tx.update(t.stockReservations).set({ status: 'released' }).where(eq(t.stockReservations.salesOrderId, order.id));
      await tx.update(t.serialNumbers).set({ status: 'dispatched', locationId: null, updatedAt: new Date() }).where(and(eq(t.serialNumbers.tenantId, ctx.tenantId), eq(t.serialNumbers.referenceId, order.id), eq(t.serialNumbers.status, 'reserved')));

      let trackingNumber = body.trackingNumber;
      let service = body.service;
      if (body.bookWithCarrier) {
        const booked = await shippingAdapter(body.bookWithCarrier).createShipment({ reference: order.number, destination: body.destination ?? order.shippingAddress, packageCount: order.packageCount || 1, weightKg: order.totalWeightKg });
        trackingNumber = booked.trackingNumber;
        service = booked.service;
      }
      const now = new Date();
      let [shipment] = await tx.select().from(t.shipments).where(and(eq(t.shipments.salesOrderId, order.id), eq(t.shipments.status, 'ready'))).limit(1);
      const shipmentValues = { carrier: body.carrier, service, trackingNumber, vehicleNo: body.vehicleNo, driverName: body.driverName, driverPhone: body.driverPhone, destination: body.destination ?? order.shippingAddress, freightCost: body.freightCost, status: 'dispatched', dispatchedAt: now };
      if (shipment) [shipment] = await tx.update(t.shipments).set(shipmentValues).where(eq(t.shipments.id, shipment.id)).returning();
      else [shipment] = await tx.insert(t.shipments).values({ tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'SHP'), salesOrderId: order.id, warehouseId: order.warehouseId, packageCount: order.packageCount || 1, totalWeightKg: order.totalWeightKg, createdBy: ctx.userId, ...shipmentValues }).returning();
      await tx.insert(t.shipmentEvents).values({ tenantId: ctx.tenantId, shipmentId: shipment!.id, status: 'dispatched', note: `${body.carrier}${trackingNumber ? ` · ${trackingNumber}` : ''}${body.vehicleNo ? ` · vehicle ${body.vehicleNo}` : ''}`, createdBy: ctx.userId });

      // Invoice the shipped quantities.
      const shippedLines = lines.filter((l) => l.packedQty > 0);
      const products = await tx.select({ id: t.products.id, sku: t.products.sku, name: t.products.name }).from(t.products).where(inArray(t.products.id, shippedLines.map((l) => l.productId)));
      const invoice = await createInvoice(tx, ctx, {
        type: 'sales', customerId: order.customerId, salesOrderId: order.id, warehouseId: order.warehouseId, currency: order.currency,
        lines: shippedLines.map((l) => {
          const ratio = l.quantity > 0 ? l.packedQty / l.quantity : 0;
          const p = products.find((x) => x.id === l.productId);
          return { productId: l.productId, description: `${p?.sku} — ${p?.name}`, quantity: l.packedQty, unitPrice: l.unitPrice, taxRate: l.taxRate, taxAmount: Math.round(l.taxAmount * ratio * 100) / 100, lineTotal: Math.round(l.lineTotal * ratio * 100) / 100 };
        }),
      });
      await tx.update(t.salesOrders).set({ status: 'dispatched', dispatchedAt: now, costTotal: Math.round(costTotal * 100) / 100 }).where(eq(t.salesOrders.id, order.id));
      await tx.execute(sql`UPDATE sales_order_lines SET packed_qty = 0 WHERE sales_order_id = ${order.id}`);
      await audit(tx, ctx, { action: 'shipment.dispatched', entityType: 'sales_order', entityId: order.id, newValue: { shipment: shipment!.number, carrier: body.carrier, trackingNumber, invoice: invoice.number } });
      await notify(tx, ctx.tenantId, { severity: 'info', category: 'dispatch', title: `${order.number} dispatched`, body: `${shipment!.number} via ${body.carrier}`, entityType: 'shipment', entityId: shipment!.id, actionUrl: `/dispatch` });
      await emitEvent(tx, ctx.tenantId, 'shipment.dispatched', { salesOrderId: order.id, shipmentId: shipment!.id, trackingNumber, invoiceId: invoice.id });
      return { shipment, invoice: { id: invoice.id, number: invoice.number, total: invoice.total } };
    });
  });
}

export function registerShipmentRoutes(r: Router) {
  r.get('/', { summary: 'Shipments', permission: ['dispatch.execute', 'sales.view'], query: pageQuery.extend({ status: z.string().optional(), warehouseId: z.string().uuid().optional() }) }, async ({ ctx, query }) => {
    const statuses = query.status?.split(',').filter(Boolean);
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT s.id, s.number, s.status, s.carrier, s.service, s.tracking_number AS "trackingNumber", s.vehicle_no AS "vehicleNo", s.driver_name AS "driverName", s.driver_phone AS "driverPhone",
        s.destination, s.package_count AS "packageCount", s.total_weight_kg::float AS "totalWeightKg", s.dispatched_at AS "dispatchedAt", s.delivered_at AS "deliveredAt", s.created_at AS "createdAt",
        so.id AS "salesOrderId", so.number AS "orderNumber", c.name AS "customerName", w.code AS "warehouseCode", COUNT(*) OVER() AS total_count
      FROM shipments s JOIN sales_orders so ON so.id = s.sales_order_id JOIN customers c ON c.id = so.customer_id JOIN warehouses w ON w.id = s.warehouse_id
      WHERE s.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND s.status IN (${sql.join(statuses.map((x) => sql`${x}`), sql`, `)})` : sql``}
      ${query.warehouseId ? sql`AND s.warehouse_id = ${query.warehouseId}` : sql``}
      ${like ? sql`AND (lower(s.number) LIKE ${like} OR lower(s.tracking_number) LIKE ${like} OR lower(so.number) LIKE ${like} OR lower(c.name) LIKE ${like})` : sql``}
      ORDER BY s.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'Shipment with packages and status history', permission: ['dispatch.execute', 'sales.view'], params: idParam }, async ({ ctx, params }) => {
    const [s] = await db().select().from(t.shipments).where(and(eq(t.shipments.id, params.id), eq(t.shipments.tenantId, ctx.tenantId))).limit(1);
    if (!s) throw notFound('Shipment');
    const [events, pkgs, order] = await Promise.all([
      rows(db(), sql`SELECT e.status, e.note, e.location, e.created_at AS "createdAt", u.name AS "by" FROM shipment_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.shipment_id = ${s.id} ORDER BY e.created_at`),
      db().select().from(t.packages).where(eq(t.packages.shipmentId, s.id)),
      rows(db(), sql`SELECT so.number, c.name AS customer, c.phone, so.shipping_address AS address FROM sales_orders so JOIN customers c ON c.id = so.customer_id WHERE so.id = ${s.salesOrderId}`),
    ]);
    return { ...s, events, packages: pkgs, order: order[0] };
  });

  r.post('/:id/status', {
    summary: 'Update delivery status (Dispatched → In transit → Delivered / Failed / Returned)',
    permission: 'dispatch.execute',
    params: idParam,
    body: z.object({ status: z.enum(['in_transit', 'delivered', 'failed', 'returned', 'dispatched']), note: z.string().trim().max(300).default(''), location: z.string().trim().max(120).default('') }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const [s] = await tx.select().from(t.shipments).where(and(eq(t.shipments.id, params.id), eq(t.shipments.tenantId, ctx.tenantId))).for('update').limit(1);
      if (!s) throw notFound('Shipment');
      if (!DISPATCH_FLOW[s.status]?.includes(body.status)) throw invalidState(`A ${s.status.replace('_', ' ')} shipment cannot move to ${body.status.replace('_', ' ')}.`);
      const now = new Date();
      await tx.update(t.shipments).set({ status: body.status, deliveredAt: body.status === 'delivered' ? now : s.deliveredAt }).where(eq(t.shipments.id, s.id));
      await tx.insert(t.shipmentEvents).values({ tenantId: ctx.tenantId, shipmentId: s.id, status: body.status, note: body.note, location: body.location, createdBy: ctx.userId });
      if (body.status === 'delivered') {
        await tx.update(t.salesOrders).set({ status: 'delivered', deliveredAt: now }).where(and(eq(t.salesOrders.id, s.salesOrderId), eq(t.salesOrders.status, 'dispatched')));
        await emitEvent(tx, ctx.tenantId, 'shipment.delivered', { shipmentId: s.id, salesOrderId: s.salesOrderId });
      }
      if (body.status === 'failed' || body.status === 'returned') {
        await notify(tx, ctx.tenantId, { severity: 'warning', category: 'delivery', title: `Shipment ${s.number} ${body.status}`, body: body.note || 'Follow up with the carrier and customer.', entityType: 'shipment', entityId: s.id, actionUrl: body.status === 'returned' ? '/returns' : '/dispatch', dedupeKey: `shipment:${s.id}:${body.status}` });
      }
      await audit(tx, ctx, { action: 'shipment.status_changed', entityType: 'shipment', entityId: s.id, oldValue: { status: s.status }, newValue: body });
      await emitEvent(tx, ctx.tenantId, 'shipment.status_changed', { shipmentId: s.id, status: body.status });
      return { status: body.status };
    });
  });
}
