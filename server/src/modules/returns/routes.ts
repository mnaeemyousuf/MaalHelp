import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { RETURN_DISPOSITIONS, RETURN_REASONS } from '@shared/domain';
import { db, num, rows, t } from '../../db';
import { idParam, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import { nextNumber } from '../../core/numbering';
import { postMovement } from '../inventory/ledger';
import { createInvoice } from '../finance/invoicing';
import { emitEvent } from '../integrations/events';

/** Disposition → inventory status the returned goods go to. write_off posts receipt then write-off. */
const DISPOSITION_STATUS: Record<string, 'available' | 'damaged' | 'quarantine' | 'blocked'> = {
  available: 'available', damaged: 'damaged', quarantine: 'quarantine', repair: 'blocked', write_off: 'damaged',
};

export function registerReturnRoutes(r: Router) {
  r.get('/', { summary: 'Customer returns', permission: ['returns.manage', 'sales.view'], query: pageQuery.extend({ customerId: z.string().uuid().optional() }) }, async ({ ctx, query }) => {
    const like = query.q ? `%${query.q.toLowerCase()}%` : null;
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT cr.id, cr.number, cr.reason, cr.status, cr.credit_total::float AS "creditTotal", cr.created_at AS "createdAt", c.name AS "customerName", so.number AS "orderNumber", w.code AS "warehouseCode",
        (SELECT COALESCE(SUM(quantity), 0)::float FROM customer_return_lines l WHERE l.return_id = cr.id) AS units, COUNT(*) OVER() AS total_count
      FROM customer_returns cr JOIN customers c ON c.id = cr.customer_id JOIN warehouses w ON w.id = cr.warehouse_id LEFT JOIN sales_orders so ON so.id = cr.sales_order_id
      WHERE cr.tenant_id = ${ctx.tenantId} ${query.customerId ? sql`AND cr.customer_id = ${query.customerId}` : sql``}
      ${like ? sql`AND (lower(cr.number) LIKE ${like} OR lower(c.name) LIKE ${like} OR lower(COALESCE(so.number, '')) LIKE ${like})` : sql``}
      ORDER BY cr.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(list.map(({ total_count: _t, ...x }) => x), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.get('/:id', { summary: 'Return detail', permission: ['returns.manage', 'sales.view'], params: idParam }, async ({ ctx, params }) => {
    const [ret] = await rows<Record<string, unknown>>(db(), sql`SELECT cr.*, c.name AS customer_name, so.number AS order_number FROM customer_returns cr JOIN customers c ON c.id = cr.customer_id LEFT JOIN sales_orders so ON so.id = cr.sales_order_id WHERE cr.id = ${params.id} AND cr.tenant_id = ${ctx.tenantId}`);
    if (!ret) throw notFound('Return');
    const lines = await rows(db(), sql`SELECT l.*, l.quantity::float AS quantity, p.sku, p.name AS product_name, loc.code AS location_code, bt.batch_no FROM customer_return_lines l JOIN products p ON p.id = l.product_id JOIN locations loc ON loc.id = l.location_id LEFT JOIN batches bt ON bt.id = l.batch_id WHERE l.return_id = ${params.id}`);
    return { ...ret, lines };
  });

  r.post('/', {
    summary: 'Receive a customer return. Each line goes to Available, Damaged, Quarantine, Repair (blocked) or Write-off.',
    permission: 'returns.manage',
    idempotent: true,
    body: z.object({
      salesOrderId: z.string().uuid().nullish(),
      customerId: z.string().uuid().optional(),
      warehouseId: z.string().uuid().optional(),
      reason: z.enum(RETURN_REASONS),
      notes: z.string().trim().max(500).default(''),
      issueCreditNote: z.boolean().default(true),
      lines: z.array(z.object({
        productId: z.string().uuid(), quantity: z.number().positive(), disposition: z.enum(RETURN_DISPOSITIONS), locationId: z.string().uuid().optional(),
        reason: z.enum(RETURN_REASONS).optional(), batchId: z.string().uuid().nullish(), notes: z.string().max(300).default(''),
      })).min(1),
    }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      let order: typeof t.salesOrders.$inferSelect | undefined;
      let orderLines: (typeof t.salesOrderLines.$inferSelect)[] = [];
      if (body.salesOrderId) {
        [order] = await tx.select().from(t.salesOrders).where(and(eq(t.salesOrders.id, body.salesOrderId), eq(t.salesOrders.tenantId, ctx.tenantId))).limit(1);
        if (!order) throw notFound('Sales order');
        if (!['dispatched', 'delivered', 'completed'].includes(order.status)) throw badRequest('Only shipped orders can be returned.');
        orderLines = await tx.select().from(t.salesOrderLines).where(eq(t.salesOrderLines.salesOrderId, order.id));
        const prior = await rows<{ product_id: string; q: string }>(tx, sql`SELECT l.product_id, SUM(l.quantity) AS q FROM customer_return_lines l JOIN customer_returns cr ON cr.id = l.return_id WHERE cr.sales_order_id = ${order.id} GROUP BY l.product_id`);
        for (const l of body.lines) {
          const shipped = orderLines.filter((x) => x.productId === l.productId).reduce((s, x) => s + x.shippedQty, 0);
          const already = num(prior.find((p) => p.product_id === l.productId)?.q);
          if (l.quantity + already > shipped + 1e-9) throw badRequest(`Cannot return more than shipped (${shipped} shipped, ${already} already returned).`);
        }
      }
      const customerId = order?.customerId ?? body.customerId;
      const warehouseId = order?.warehouseId ?? body.warehouseId;
      if (!customerId || !warehouseId) throw badRequest('Choose the customer and warehouse for a return without an order.');
      const [cust] = await tx.select({ id: t.customers.id }).from(t.customers).where(and(eq(t.customers.id, customerId), eq(t.customers.tenantId, ctx.tenantId))).limit(1);
      if (!cust) throw notFound('Customer');
      const [dock] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.tenantId, ctx.tenantId), eq(t.locations.warehouseId, warehouseId), eq(t.locations.isReceiving, true))).limit(1);
      const products = await tx.select().from(t.products).where(and(eq(t.products.tenantId, ctx.tenantId), inArray(t.products.id, body.lines.map((l) => l.productId))));

      const number = await nextNumber(tx, ctx.tenantId, 'RMA');
      const [ret] = await tx.insert(t.customerReturns).values({ tenantId: ctx.tenantId, number, salesOrderId: order?.id ?? null, customerId, warehouseId, reason: body.reason, notes: body.notes, status: 'completed', createdBy: ctx.userId, receivedAt: new Date() }).returning();
      let credit = 0;
      const creditLines: Parameters<typeof createInvoice>[2]['lines'] = [];
      for (const l of body.lines) {
        const p = products.find((x) => x.id === l.productId);
        if (!p) throw notFound('Product');
        const locationId = l.locationId ?? dock?.id;
        if (!locationId) throw badRequest('Choose a location to receive the return.');
        const status = DISPOSITION_STATUS[l.disposition]!;
        const common = { warehouseId, locationId, productId: p.id, batchId: l.batchId ?? null, unitCost: p.costPrice, referenceType: 'customer_return', referenceId: ret!.id, referenceNo: number };
        await postMovement(tx, ctx, { ...common, status, quantity: l.quantity, type: 'return', reason: `${l.reason ?? body.reason} → ${l.disposition}` });
        if (l.disposition === 'write_off') await postMovement(tx, ctx, { ...common, status, quantity: -l.quantity, type: 'write_off', reason: `Return ${number} written off` });
        const ol = orderLines.find((x) => x.productId === p.id);
        const unitPrice = ol?.unitPrice ?? p.sellingPrice;
        await tx.insert(t.customerReturnLines).values({ tenantId: ctx.tenantId, returnId: ret!.id, productId: p.id, batchId: l.batchId ?? null, locationId, quantity: l.quantity, reason: l.reason ?? body.reason, disposition: l.disposition, unitPrice, notes: l.notes });
        const lineNet = l.quantity * unitPrice * (1 - (ol?.discountPct ?? 0) / 100);
        const tax = lineNet * ((ol?.taxRate ?? 0) / 100);
        credit += lineNet + tax;
        creditLines.push({ productId: p.id, description: `Return ${p.sku} (${l.disposition.replace('_', ' ')})`, quantity: -l.quantity, unitPrice, taxRate: ol?.taxRate ?? 0, taxAmount: -Math.round(tax * 100) / 100, lineTotal: -Math.round((lineNet + tax) * 100) / 100 });
      }
      credit = Math.round(credit * 100) / 100;
      await tx.update(t.customerReturns).set({ creditTotal: credit }).where(eq(t.customerReturns.id, ret!.id));
      if (body.issueCreditNote && credit > 0 && ctx.permissions.has('billing.manage')) {
        await createInvoice(tx, ctx, { type: 'credit_note', customerId, salesOrderId: order?.id ?? null, warehouseId, currency: order?.currency ?? ctx.currency, notes: `Credit for ${number}`, lines: creditLines });
      }
      await audit(tx, ctx, { action: 'return.received', entityType: 'customer_return', entityId: ret!.id, newValue: { number, order: order?.number ?? null, lines: body.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, disposition: l.disposition })), credit } });
      await emitEvent(tx, ctx.tenantId, 'return.received', { returnId: ret!.id, number });
      return { ...ret!, creditTotal: credit };
    });
  });
}
