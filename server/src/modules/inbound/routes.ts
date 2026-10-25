import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, num, one, rows, t, type Tx } from '../../db';
import { idParam, isoDate, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, conflict, forbidden, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { redactFinance } from '../../core/finance-visibility';
import { moveStock, postMovement } from '../inventory/ledger';
import { ensureBatch } from '../products/routes';
import { notify } from '../alerts/notify';
import { emitEvent } from '../integrations/events';
import { suggestPutaway } from './putaway-engine';

const OVER_RECEIPT_TOLERANCE = 0.1; // 10% without explicit confirmation

const receiptLine = z.object({
  purchaseOrderLineId: z.string().uuid().nullish(),
  productId: z.string().uuid(),
  quantity: z.number().positive('Received quantity must be greater than zero.'),
  damagedQty: z.number().min(0).default(0),
  quarantineQty: z.number().min(0).default(0),
  locationId: z.string().uuid().nullish(),
  batchNo: z.string().trim().max(60).nullish(),
  expiryDate: isoDate().nullish(),
  mfgDate: isoDate().nullish(),
  serials: z.array(z.string().trim().min(1).max(120)).max(5000).default([]),
  unitCost: z.number().min(0).optional(),
  qcStatus: z.enum(['passed', 'failed', 'pending']).default('passed'),
  notes: z.string().trim().max(300).default(''),
});

export const receiptBody = z.object({
  purchaseOrderId: z.string().uuid().nullish(),
  supplierId: z.string().uuid().nullish(),
  warehouseId: z.string().uuid(),
  ownerCustomerId: z.string().uuid().nullish(),
  deliveryNoteNo: z.string().trim().max(60).default(''),
  vehicleNo: z.string().trim().max(30).default(''),
  notes: z.string().trim().max(1000).default(''),
  confirmOverReceipt: z.boolean().default(false),
  lines: z.array(receiptLine).min(1, 'Scan or add at least one product.').max(500),
});

export async function receiveGoods(tx: Tx, ctx: Ctx, body: z.infer<typeof receiptBody>) {
  const [warehouse] = await tx.select().from(t.warehouses).where(and(eq(t.warehouses.id, body.warehouseId), eq(t.warehouses.tenantId, ctx.tenantId))).limit(1);
  if (!warehouse) throw notFound('Warehouse');
  const [dock] = await tx.select().from(t.locations).where(and(eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, warehouse.id), eq(t.locations.isReceiving, true))).limit(1);
  if (!dock) throw invalidState('This warehouse has no receiving dock location.');

  let po: typeof t.purchaseOrders.$inferSelect | undefined;
  let poLines: (typeof t.purchaseOrderLines.$inferSelect)[] = [];
  if (body.purchaseOrderId) {
    [po] = await tx.select().from(t.purchaseOrders).where(and(eq(t.purchaseOrders.id, body.purchaseOrderId), eq(t.purchaseOrders.tenantId, ctx.tenantId))).for('update').limit(1);
    if (!po) throw notFound('Purchase order');
    if (!['approved', 'partially_received'].includes(po.status)) throw invalidState(`Purchase order ${po.number} is ${po.status.replace('_', ' ')}; it must be approved before receiving.`);
    if (po.warehouseId !== warehouse.id) throw badRequest(`Purchase order ${po.number} is for a different warehouse.`);
    poLines = await tx.select().from(t.purchaseOrderLines).where(eq(t.purchaseOrderLines.purchaseOrderId, po.id)).for('update');
  } else if (body.ownerCustomerId) {
    const [owner] = await tx.select({ id: t.customers.id }).from(t.customers).where(and(eq(t.customers.id, body.ownerCustomerId), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
    if (!owner) throw notFound('Stock owner (customer)');
  }

  const productIds = [...new Set(body.lines.map((l) => l.productId))];
  const products = await tx.select().from(t.products).where(and(eq(t.products.tenantId, ctx.tenantId), inArray(t.products.id, productIds)));
  if (products.length !== productIds.length) throw badRequest('One or more products do not belong to your company.');
  const locationIds = [...new Set(body.lines.map((l) => l.locationId).filter((x): x is string => !!x))];
  const locs = locationIds.length ? await tx.select().from(t.locations).where(and(eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, warehouse.id), inArray(t.locations.id, locationIds))) : [];
  if (locs.length !== locationIds.length) throw badRequest('A scanned location is not in this warehouse.');

  const number = await nextNumber(tx, ctx.tenantId, 'GRN');
  const supplierId = po?.supplierId ?? body.supplierId ?? null;
  const [grn] = await tx.insert(t.goodsReceipts).values({
    tenantId: ctx.tenantId, number, purchaseOrderId: po?.id ?? null, supplierId, warehouseId: warehouse.id, ownerCustomerId: po ? null : body.ownerCustomerId ?? null,
    deliveryNoteNo: body.deliveryNoteNo, vehicleNo: body.vehicleNo, notes: body.notes, receivedBy: ctx.userId || null,
  }).returning();

  const ownerCustomerId = grn!.ownerCustomerId;
  let totalValue = 0;
  let billSubtotal = 0;
  let billTax = 0;
  const putaways: string[] = [];
  const variances: string[] = [];

  for (const line of body.lines) {
    const product = products.find((p) => p.id === line.productId)!;
    if (line.damagedQty + line.quarantineQty > line.quantity) throw badRequest(`${product.sku}: damaged + quarantine cannot exceed the received quantity.`);
    if ((product.trackBatch || product.trackLot) && !line.batchNo) throw badRequest(`${product.sku} is batch-tracked. Scan or enter the batch number.`);
    if (product.trackExpiry && !line.expiryDate) throw badRequest(`${product.sku} tracks expiry. Enter the expiry date.`);
    if (product.trackSerial) {
      if (line.serials.length !== line.quantity) throw badRequest(`${product.sku} is serial-tracked: scan ${line.quantity} serial numbers (got ${line.serials.length}).`);
      if (new Set(line.serials).size !== line.serials.length) throw badRequest(`${product.sku}: duplicate serial numbers scanned.`);
      const dup = await one<{ serial: string }>(tx, sql`SELECT serial FROM serial_numbers WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product.id} AND serial IN (${sql.join(line.serials.map((s) => sql`${s}`), sql`, `)}) AND status <> 'dispatched' LIMIT 1`);
      if (dup) throw conflict('DUPLICATE_SERIAL', `Serial ${dup.serial} is already in stock.`);
    }

    let poLine: (typeof poLines)[number] | undefined;
    if (po) {
      poLine = line.purchaseOrderLineId ? poLines.find((l) => l.id === line.purchaseOrderLineId) : poLines.find((l) => l.productId === product.id && l.receivedQty < l.quantity) ?? poLines.find((l) => l.productId === product.id);
      if (!poLine) throw badRequest(`${product.sku} is not on purchase order ${po.number}.`);
      const after = poLine.receivedQty + line.quantity;
      if (after > poLine.quantity * (1 + OVER_RECEIPT_TOLERANCE) && !body.confirmOverReceipt) {
        throw conflict('OVER_RECEIPT', `${product.sku}: receiving ${after} against ${poLine.quantity} ordered is more than ${OVER_RECEIPT_TOLERANCE * 100}% over. Confirm over-receipt to continue.`, { productId: product.id, ordered: poLine.quantity, receiving: after });
      }
    }

    const batch = line.batchNo ? await ensureBatch(tx, ctx, { productId: product.id, batchNo: line.batchNo, expiryDate: line.expiryDate ?? null, mfgDate: line.mfgDate ?? null, supplierId }) : null;
    const location = line.locationId ? locs.find((l) => l.id === line.locationId)! : dock;
    const unitCost = line.unitCost ?? poLine?.unitCost ?? product.costPrice;
    const accepted = line.quantity - line.damagedQty - line.quarantineQty;
    const goodStatus = line.qcStatus === 'passed' ? 'available' : 'quarantine';
    const common = { warehouseId: warehouse.id, locationId: location.id, productId: product.id, batchId: batch?.id ?? null, ownerCustomerId, unitCost, referenceType: 'goods_receipt', referenceId: grn!.id, referenceNo: number };

    if (accepted > 0) {
      if (product.trackSerial) {
        for (const serial of line.serials.slice(0, accepted)) {
          const [sn] = await tx.insert(t.serialNumbers).values({ tenantId: ctx.tenantId, productId: product.id, serial, batchId: batch?.id ?? null, status: 'in_stock', warehouseId: warehouse.id, locationId: location.id, ownerCustomerId, referenceType: 'goods_receipt', referenceId: grn!.id })
            .onConflictDoUpdate({ target: [t.serialNumbers.tenantId, t.serialNumbers.productId, t.serialNumbers.serial], set: { status: 'in_stock', warehouseId: warehouse.id, locationId: location.id, updatedAt: new Date() } }).returning();
          await postMovement(tx, ctx, { ...common, status: goodStatus, quantity: 1, type: 'receipt', serialId: sn!.id, reason: line.notes });
        }
      } else {
        await postMovement(tx, ctx, { ...common, status: goodStatus, quantity: accepted, type: 'receipt', reason: line.notes });
      }
    }
    if (line.damagedQty > 0) await postMovement(tx, ctx, { ...common, status: 'damaged', quantity: line.damagedQty, type: 'receipt', reason: `Damaged on arrival${line.notes ? `: ${line.notes}` : ''}` });
    if (line.quarantineQty > 0) await postMovement(tx, ctx, { ...common, status: 'quarantine', quantity: line.quarantineQty, type: 'receipt', reason: 'Held for quality inspection' });

    const expected = poLine ? Math.max(poLine.quantity - poLine.receivedQty, 0) : 0;
    const varianceType = !poLine ? 'unplanned' : line.quantity < expected ? 'short' : line.quantity > expected ? 'over' : 'exact';
    if (varianceType === 'short' || varianceType === 'over') variances.push(`${product.sku} ${varianceType} (${line.quantity} of ${expected})`);
    const [grnLine] = await tx.insert(t.goodsReceiptLines).values({
      tenantId: ctx.tenantId, receiptId: grn!.id, purchaseOrderLineId: poLine?.id ?? null, productId: product.id, batchId: batch?.id ?? null, locationId: location.id,
      expectedQty: expected, receivedQty: line.quantity, acceptedQty: accepted, damagedQty: line.damagedQty, quarantineQty: line.quarantineQty, unitCost,
      varianceType, qcStatus: line.qcStatus, serials: line.serials, notes: line.notes,
    }).returning();

    if (poLine) {
      poLine.receivedQty += line.quantity;
      poLine.damagedQty += line.damagedQty;
      await tx.update(t.purchaseOrderLines).set({ receivedQty: poLine.receivedQty, damagedQty: poLine.damagedQty }).where(eq(t.purchaseOrderLines.id, poLine.id));
      const billable = line.quantity - line.damagedQty; // suppliers are not paid for goods damaged on arrival
      billSubtotal += billable * unitCost * (1 - poLine.discountPct / 100);
      billTax += billable * unitCost * (1 - poLine.discountPct / 100) * (poLine.taxRate / 100);
    }
    totalValue += line.quantity * unitCost;

    // Moving-average cost for company-owned stock.
    if (!ownerCustomerId && accepted > 0) {
      const onHand = await one<{ q: string }>(tx, sql`SELECT COALESCE(SUM(quantity), 0) AS q FROM inventory_balances WHERE tenant_id = ${ctx.tenantId} AND product_id = ${product.id} AND owner_customer_id IS NULL`);
      const total = num(onHand?.q);
      const prior = total - line.quantity;
      const avg = total > 0 ? (prior * product.costPrice + line.quantity * unitCost) / total : unitCost;
      await tx.update(t.products).set({ costPrice: Math.round(avg * 100) / 100, updatedAt: new Date() }).where(eq(t.products.id, product.id));
      product.costPrice = Math.round(avg * 100) / 100;
    }

    // Received into the dock → create a putaway task with a suggestion.
    if (location.isReceiving && accepted > 0 && goodStatus === 'available') {
      const suggestion = await suggestPutaway(tx, ctx.tenantId, warehouse.id, product.id, accepted, batch?.id ?? null, 1);
      const best = suggestion.candidates[0];
      const [task] = await tx.insert(t.putawayTasks).values({
        tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'PUT'), receiptId: grn!.id, receiptLineId: grnLine!.id, warehouseId: warehouse.id, productId: product.id,
        batchId: batch?.id ?? null, ownerCustomerId, fromLocationId: location.id, suggestedLocationId: best?.locationId ?? null, quantity: accepted,
        suggestionReason: best ? best.reasons.join('; ') : 'No location with enough free capacity — choose a location manually.',
      }).returning({ id: t.putawayTasks.id });
      putaways.push(task!.id);
    }
  }

  await tx.update(t.goodsReceipts).set({ totalValue: Math.round(totalValue * 100) / 100 }).where(eq(t.goodsReceipts.id, grn!.id));

  if (po) {
    const fully = poLines.every((l) => l.receivedQty >= l.quantity);
    await tx.update(t.purchaseOrders).set({ status: fully ? 'fully_received' : 'partially_received' }).where(eq(t.purchaseOrders.id, po.id));
    if (billSubtotal > 0) {
      const [supplier] = await tx.select({ terms: t.suppliers.paymentTermsDays }).from(t.suppliers).where(eq(t.suppliers.id, po.supplierId)).limit(1);
      const today = new Date();
      await tx.insert(t.supplierBills).values({
        tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'BILL'), supplierId: po.supplierId, purchaseOrderId: po.id, receiptId: grn!.id, warehouseId: warehouse.id,
        supplierInvoiceNo: body.deliveryNoteNo, billDate: today.toISOString().slice(0, 10), dueDate: new Date(today.getTime() + (supplier?.terms ?? 30) * 86400_000).toISOString().slice(0, 10),
        currency: po.currency, subtotal: round2(billSubtotal), taxTotal: round2(billTax), total: round2(billSubtotal + billTax), createdBy: ctx.userId || null,
      });
    }
  }

  await audit(tx, ctx, { action: 'goods.received', entityType: 'goods_receipt', entityId: grn!.id, newValue: { number, purchaseOrder: po?.number ?? null, lines: body.lines.length, totalValue: round2(totalValue), variances } });
  await notify(tx, ctx.tenantId, { severity: 'info', category: 'receipt', title: `${number} received${po ? ` for ${po.number}` : ''}`, body: variances.length ? `Variances: ${variances.join(', ')}` : `${body.lines.length} line(s) received.`, entityType: 'goods_receipt', entityId: grn!.id, actionUrl: `/receiving/${grn!.id}` });
  await emitEvent(tx, ctx.tenantId, 'goods.received', { receiptId: grn!.id, number, purchaseOrderId: po?.id ?? null });
  return { ...grn!, totalValue: round2(totalValue), putawayTaskIds: putaways, variances };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function registerReceivingRoutes(r: Router) {
  r.get('/', { summary: 'Goods receipts (GRNs)', permission: ['receiving.execute', 'purchase.view'], query: pageQuery.extend({ warehouseId: z.string().uuid().optional(), from: isoDate().optional(), to: isoDate().optional() }) }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT g.id, g.number, g.received_at AS "receivedAt", g.total_value::float AS "totalValue", g.delivery_note_no AS "deliveryNoteNo", g.status,
        po.number AS "poNumber", s.name AS "supplierName", c.name AS "ownerName", w.code AS "warehouseCode", u.name AS "receivedBy",
        (SELECT COUNT(*)::int FROM goods_receipt_lines l WHERE l.receipt_id = g.id) AS lines,
        (SELECT COALESCE(SUM(received_qty), 0)::float FROM goods_receipt_lines l WHERE l.receipt_id = g.id) AS units,
        (SELECT COUNT(*)::int FROM goods_receipt_lines l WHERE l.receipt_id = g.id AND l.variance_type IN ('short', 'over')) AS variances,
        COUNT(*) OVER() AS total_count
      FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id
      LEFT JOIN suppliers s ON s.id = g.supplier_id LEFT JOIN customers c ON c.id = g.owner_customer_id LEFT JOIN users u ON u.id = g.received_by
      WHERE g.tenant_id = ${ctx.tenantId}
      ${query.warehouseId ? sql`AND g.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.from ? sql`AND g.received_at >= ${query.from}::date` : sql``}
      ${query.to ? sql`AND g.received_at < ${query.to}::date + 1` : sql``}
      ${like ? sql`AND (lower(g.number) LIKE ${like} OR lower(COALESCE(po.number, '')) LIKE ${like} OR lower(COALESCE(s.name, '')) LIKE ${like})` : sql``}
      ORDER BY g.received_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(redactFinance(ctx, list.map(({ total_count: _t, ...x }) => x)), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'GRN detail (printable)', permission: ['receiving.execute', 'purchase.view'], params: idParam }, async ({ ctx, params }) => {
    const [g] = await rows<Record<string, unknown>>(db(), sql`
      SELECT g.*, po.number AS po_number, s.name AS supplier_name, c.name AS owner_name, w.name AS warehouse_name, w.code AS warehouse_code, u.name AS received_by_name
      FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id LEFT JOIN purchase_orders po ON po.id = g.purchase_order_id LEFT JOIN suppliers s ON s.id = g.supplier_id
      LEFT JOIN customers c ON c.id = g.owner_customer_id LEFT JOIN users u ON u.id = g.received_by WHERE g.id = ${params.id} AND g.tenant_id = ${ctx.tenantId}`);
    if (!g) throw notFound('Goods receipt');
    const lines = await rows(db(), sql`
      SELECT l.id, p.sku, p.name AS "productName", p.uom, l.expected_qty::float AS "expectedQty", l.received_qty::float AS "receivedQty", l.accepted_qty::float AS "acceptedQty",
        l.damaged_qty::float AS "damagedQty", l.quarantine_qty::float AS "quarantineQty", l.unit_cost::float AS "unitCost", l.variance_type AS "varianceType", l.qc_status AS "qcStatus",
        bt.batch_no AS "batchNo", bt.expiry_date AS "expiryDate", loc.code AS "locationCode", l.serials, l.notes
      FROM goods_receipt_lines l JOIN products p ON p.id = l.product_id JOIN locations loc ON loc.id = l.location_id LEFT JOIN batches bt ON bt.id = l.batch_id
      WHERE l.receipt_id = ${params.id} ORDER BY p.sku`);
    const tasks = await rows(db(), sql`SELECT pt.id, pt.number, pt.status, pt.quantity::float AS quantity, p.sku, sl.code AS "suggestedCode", al.code AS "actualCode" FROM putaway_tasks pt JOIN products p ON p.id = pt.product_id LEFT JOIN locations sl ON sl.id = pt.suggested_location_id LEFT JOIN locations al ON al.id = pt.actual_location_id WHERE pt.receipt_id = ${params.id}`);
    return redactFinance(ctx, { ...g, lines, putawayTasks: tasks });
  });

  r.post('/', {
    summary: 'Receive goods (against a PO, blind, or customer-owned stock). Generates the GRN automatically.',
    permission: 'receiving.execute',
    idempotent: true,
    body: receiptBody,
  }, async ({ ctx, body }) => db().transaction((tx) => receiveGoods(tx, ctx, body)));
}

export function registerPutawayRoutes(r: Router) {
  r.get('/suggest', {
    summary: 'Ranked putaway location suggestions with reasons',
    permission: ['putaway.execute', 'receiving.execute', 'warehouse.view'],
    query: z.object({ warehouseId: z.string().uuid(), productId: z.string().uuid(), quantity: z.coerce.number().positive().default(1), batchId: z.string().uuid().optional() }),
  }, async ({ ctx, query }) => suggestPutaway(db(), ctx.tenantId, query.warehouseId, query.productId, query.quantity, query.batchId ?? null, 5));

  r.get('/tasks', {
    summary: 'Putaway tasks',
    permission: ['putaway.execute', 'task.manage'],
    query: pageQuery.extend({ status: z.enum(['pending', 'completed', 'cancelled']).default('pending'), warehouseId: z.string().uuid().optional(), mine: z.coerce.boolean().optional() }),
  }, async ({ ctx, query }) => {
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT pt.id, pt.number, pt.status, pt.quantity::float AS quantity, pt.suggestion_reason AS "suggestionReason", pt.override_reason AS "overrideReason", pt.created_at AS "createdAt", pt.completed_at AS "completedAt",
        pt.warehouse_id AS "warehouseId", pt.product_id AS "productId", pt.batch_id AS "batchId", pt.owner_customer_id AS "ownerCustomerId",
        p.sku, p.name AS "productName", p.barcode, p.uom, bt.batch_no AS "batchNo", w.code AS "warehouseCode", fl.code AS "fromCode", fl.id AS "fromLocationId",
        sl.id AS "suggestedLocationId", sl.code AS "suggestedCode", sl.barcode AS "suggestedBarcode", al.code AS "actualCode", g.number AS "grnNumber", au.name AS "assignedTo", cu.name AS "completedBy",
        COUNT(*) OVER() AS total_count
      FROM putaway_tasks pt JOIN products p ON p.id = pt.product_id JOIN warehouses w ON w.id = pt.warehouse_id JOIN locations fl ON fl.id = pt.from_location_id
      LEFT JOIN locations sl ON sl.id = pt.suggested_location_id LEFT JOIN locations al ON al.id = pt.actual_location_id LEFT JOIN batches bt ON bt.id = pt.batch_id
      LEFT JOIN goods_receipts g ON g.id = pt.receipt_id LEFT JOIN users au ON au.id = pt.assigned_to LEFT JOIN users cu ON cu.id = pt.completed_by
      WHERE pt.tenant_id = ${ctx.tenantId} AND pt.status = ${query.status}
      ${query.warehouseId ? sql`AND pt.warehouse_id = ${query.warehouseId}` : sql``}
      ${query.mine ? sql`AND (pt.assigned_to = ${ctx.userId} OR pt.assigned_to IS NULL)` : sql``}
      ORDER BY pt.created_at ${sql.raw(query.status === 'pending' ? 'ASC' : 'DESC')} LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/tasks/:id/assign', { summary: 'Assign a putaway task', permission: 'task.manage', params: idParam, body: z.object({ userId: z.string().uuid().nullable() }) }, async ({ ctx, params, body }) => {
    const [task] = await db().update(t.putawayTasks).set({ assignedTo: body.userId }).where(and(eq(t.putawayTasks.id, params.id), eq(t.putawayTasks.tenantId, ctx.tenantId))).returning({ id: t.putawayTasks.id });
    if (!task) throw notFound('Putaway task');
    await audit(db(), ctx, { action: 'putaway.assigned', entityType: 'putaway_task', entityId: params.id, newValue: body });
    return { ok: true };
  });

  r.post('/tasks/:id/complete', {
    summary: 'Confirm putaway into the scanned location. Overrides of the suggestion need a reason.',
    permission: 'putaway.execute',
    idempotent: true,
    params: idParam,
    body: z.object({ locationId: z.string().uuid(), quantity: z.number().positive().optional(), overrideReason: z.string().trim().max(300).optional() }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const [task] = await tx.select().from(t.putawayTasks).where(and(eq(t.putawayTasks.id, params.id), eq(t.putawayTasks.tenantId, ctx.tenantId))).for('update').limit(1);
      if (!task) throw notFound('Putaway task');
      if (task.status !== 'pending') throw invalidState('This putaway task is already completed.');
      const [loc] = await tx.select().from(t.locations).where(and(eq(t.locations.id, body.locationId), eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, task.warehouseId))).limit(1);
      if (!loc) throw badRequest('That location is not in this warehouse.');
      if (loc.status !== 'active') throw badRequest(`Location ${loc.code} is blocked.`);
      const qty = body.quantity ?? task.quantity;
      if (qty > task.quantity + 1e-9) throw badRequest(`Only ${task.quantity} units are on this task.`);

      const isOverride = !!task.suggestedLocationId && loc.id !== task.suggestedLocationId;
      if (isOverride) {
        const alternatives = (await suggestPutaway(tx, ctx.tenantId, task.warehouseId, task.productId, qty, task.batchId, 5)).candidates.map((c) => c.locationId);
        const managerOverride = ctx.permissions.has('task.manage') || ctx.permissions.has('warehouse.manage');
        if (!alternatives.includes(loc.id) && !managerOverride) throw forbidden(`${loc.code} is not a recommended location. Use one of the suggested locations or ask a manager to override.`);
        if (!body.overrideReason || body.overrideReason.length < 3) throw badRequest('Enter a reason for using a different location than recommended.');
      }

      await moveStock(tx, ctx, {
        from: { warehouseId: task.warehouseId, locationId: task.fromLocationId, productId: task.productId, batchId: task.batchId, ownerCustomerId: task.ownerCustomerId, status: task.inventoryStatus as never },
        to: { warehouseId: task.warehouseId, locationId: loc.id, productId: task.productId, batchId: task.batchId, ownerCustomerId: task.ownerCustomerId, status: task.inventoryStatus as never },
        quantity: qty, outType: 'putaway', inType: 'putaway', referenceType: 'putaway_task', referenceId: task.id, referenceNo: task.number, reason: isOverride ? `Override: ${body.overrideReason}` : 'Putaway',
      });
      await tx.update(t.serialNumbers).set({ locationId: loc.id, updatedAt: new Date() })
        .where(and(eq(t.serialNumbers.tenantId, ctx.tenantId), eq(t.serialNumbers.productId, task.productId), eq(t.serialNumbers.locationId, task.fromLocationId), eq(t.serialNumbers.status, 'in_stock')));

      await tx.update(t.putawayTasks).set({ status: 'completed', actualLocationId: loc.id, quantity: qty, overrideReason: isOverride ? body.overrideReason ?? null : null, completedBy: ctx.userId, completedAt: new Date() }).where(eq(t.putawayTasks.id, task.id));
      if (qty < task.quantity) {
        await tx.insert(t.putawayTasks).values({ ...task, id: undefined, number: await nextNumber(tx, ctx.tenantId, 'PUT'), quantity: task.quantity - qty, status: 'pending', createdAt: new Date(), completedAt: null, completedBy: null, actualLocationId: null, overrideReason: null } as typeof t.putawayTasks.$inferInsert);
      }
      await audit(tx, ctx, { action: isOverride ? 'putaway.override' : 'putaway.completed', entityType: 'putaway_task', entityId: task.id, newValue: { location: loc.code, quantity: qty, overrideReason: body.overrideReason ?? null } });
      await emitEvent(tx, ctx.tenantId, 'putaway.completed', { taskId: task.id, locationId: loc.id, quantity: qty });
      return { ok: true, location: loc.code, override: isOverride, remaining: Math.max(0, task.quantity - qty) };
    });
  });
}
