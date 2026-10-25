import { and, eq, inArray, sql } from 'drizzle-orm';
import { num, one, t, type Tx } from '../../db';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { availableLocations, moveStock } from '../inventory/ledger';

export interface ReserveResult {
  reservedUnits: number;
  shortUnits: number;
  pickTasks: number;
}

/** Zone (top-level ancestor) of a location, for zone picking. */
async function zoneOf(tx: Tx, locationId: string): Promise<string | null> {
  const row = await one<{ id: string }>(tx, sql`
    WITH RECURSIVE anc AS (SELECT id, parent_id, type FROM locations WHERE id = ${locationId}
      UNION ALL SELECT l.id, l.parent_id, l.type FROM locations l JOIN anc ON anc.parent_id = l.id)
    SELECT id FROM anc WHERE type = 'zone' LIMIT 1`);
  return row?.id ?? null;
}

/**
 * Allocates available stock to the order's unreserved quantities (FEFO, then
 * pick priority), moving each allocation available → reserved at its location
 * and creating one pick task per allocation. Balance rows are locked
 * (FOR UPDATE) so two orders can never reserve the same units.
 */
export async function reserveOrder(tx: Tx, ctx: Ctx, orderId: string): Promise<ReserveResult> {
  const [order] = await tx.select().from(t.salesOrders).where(and(eq(t.salesOrders.id, orderId), eq(t.salesOrders.tenantId, ctx.tenantId))).limit(1);
  if (!order) return { reservedUnits: 0, shortUnits: 0, pickTasks: 0 };
  const lines = await tx.select().from(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, orderId)).for('update');
  let reservedUnits = 0;
  let shortUnits = 0;
  let pickTasks = 0;

  for (const line of lines) {
    let need = line.quantity - line.reservedQty;
    if (need <= 1e-9) continue;
    const slots = await availableLocations(tx, ctx.tenantId, line.productId, order.warehouseId, null, true);
    for (const slot of slots) {
      if (need <= 1e-9) break;
      const take = Math.min(need, slot.quantity);
      const key = { warehouseId: order.warehouseId, locationId: slot.locationId, productId: line.productId, batchId: slot.batchId };
      await moveStock(tx, ctx, {
        from: { ...key, status: 'available' }, to: { ...key, status: 'reserved' }, quantity: take,
        outType: 'reservation', inType: 'reservation', referenceType: 'sales_order', referenceId: order.id, referenceNo: order.number, reason: `Reserved for ${order.number}`,
      });
      const [res] = await tx.insert(t.stockReservations).values({
        tenantId: ctx.tenantId, salesOrderId: order.id, salesOrderLineId: line.id, productId: line.productId, warehouseId: order.warehouseId,
        locationId: slot.locationId, batchId: slot.batchId, quantity: take,
      }).returning({ id: t.stockReservations.id });
      await tx.insert(t.pickTasks).values({
        tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'PICK'), salesOrderId: order.id, salesOrderLineId: line.id, reservationId: res!.id,
        warehouseId: order.warehouseId, zoneId: await zoneOf(tx, slot.locationId), locationId: slot.locationId, productId: line.productId, batchId: slot.batchId,
        quantity: take, priority: order.priority,
      });
      pickTasks++;
      need -= take;
      reservedUnits += take;
      line.reservedQty += take;
    }
    await tx.update(t.salesOrderLines).set({ reservedQty: line.reservedQty }).where(eq(t.salesOrderLines.id, line.id));
    if (need > 1e-9) shortUnits += need;
  }
  return { reservedUnits, shortUnits, pickTasks };
}

/** Returns unpicked reserved stock to available and cancels open pick tasks. */
export async function releaseReservations(tx: Tx, ctx: Ctx, orderId: string, reason: string): Promise<number> {
  const open = await tx.select().from(t.stockReservations).where(and(eq(t.stockReservations.salesOrderId, orderId), eq(t.stockReservations.tenantId, ctx.tenantId), eq(t.stockReservations.status, 'active'))).for('update');
  const [order] = await tx.select({ number: t.salesOrders.number }).from(t.salesOrders).where(eq(t.salesOrders.id, orderId));
  let released = 0;
  for (const r of open) {
    const remaining = r.quantity - r.pickedQty;
    if (remaining > 1e-9) {
      const key = { warehouseId: r.warehouseId, locationId: r.locationId, productId: r.productId, batchId: r.batchId, ownerCustomerId: r.ownerCustomerId };
      await moveStock(tx, ctx, { from: { ...key, status: 'reserved' }, to: { ...key, status: 'available' }, quantity: remaining, outType: 'reservation_release', inType: 'reservation_release', referenceType: 'sales_order', referenceId: orderId, referenceNo: order?.number, reason });
      released += remaining;
      await tx.execute(sql`UPDATE sales_order_lines SET reserved_qty = GREATEST(reserved_qty - ${remaining}, 0) WHERE id = ${r.salesOrderLineId}`);
    }
    await tx.update(t.stockReservations).set({ status: r.pickedQty > 0 ? 'picked' : 'released', quantity: r.pickedQty }).where(eq(t.stockReservations.id, r.id));
  }
  await tx.update(t.pickTasks).set({ status: 'cancelled' }).where(and(eq(t.pickTasks.salesOrderId, orderId), inArray(t.pickTasks.status, ['pending', 'in_progress'])));
  return released;
}

export async function orderOutstanding(tx: Tx, tenantId: string, customerId: string): Promise<number> {
  const row = await one<{ due: string }>(tx, sql`SELECT COALESCE(SUM(total - amount_paid), 0) AS due FROM invoices WHERE tenant_id = ${tenantId} AND customer_id = ${customerId} AND status IN ('issued', 'partially_paid')`);
  return num(row?.due);
}
