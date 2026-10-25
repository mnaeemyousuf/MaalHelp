import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { COUNT_TYPES } from '@shared/domain';
import { db, num, rows, t, type Tx } from '../../db';
import { idParam, pageQuery, paged, type Router } from '../../core/http';
import { badRequest, forbidden, invalidState, notFound } from '../../core/errors';
import { audit } from '../../core/audit';
import type { Ctx } from '../../core/context';
import { nextNumber } from '../../core/numbering';
import { redactFinance } from '../../core/finance-visibility';
import { postMovement } from '../inventory/ledger';
import { createApprovalRequest, findApplicableRule, registerApprovalHandler } from '../approvals/engine';
import { emitEvent } from '../integrations/events';

async function load(tx: Tx | ReturnType<typeof db>, tenantId: string, id: string) {
  const [c] = await tx.select().from(t.stockCounts).where(and(eq(t.stockCounts.id, id), eq(t.stockCounts.tenantId, tenantId))).limit(1);
  if (!c) throw notFound('Stock count');
  return c;
}

/** Posts variances as stock_count transactions. Lines with zero variance post nothing. */
async function postCount(tx: Tx, ctx: Ctx, countId: string) {
  const count = await load(tx, ctx.tenantId, countId);
  const lines = await tx.select().from(t.stockCountLines).where(eq(t.stockCountLines.countId, countId));
  for (const l of lines) {
    if (l.countedQty === null || Math.abs(l.varianceQty) < 1e-9) continue;
    await postMovement(tx, ctx, { warehouseId: count.warehouseId, locationId: l.locationId, productId: l.productId, batchId: l.batchId, ownerCustomerId: l.ownerCustomerId, status: 'available', quantity: l.varianceQty, type: 'stock_count', unitCost: l.unitCost, referenceType: 'stock_count', referenceId: count.id, referenceNo: count.number, reason: `Count variance (expected ${l.expectedQty}, counted ${l.countedQty})` });
  }
  await tx.update(t.stockCounts).set({ status: 'posted', postedAt: new Date(), approvedBy: ctx.userId, approvedAt: count.approvedAt ?? new Date() }).where(eq(t.stockCounts.id, count.id));
  await audit(tx, ctx, { action: 'stock_count.posted', entityType: 'stock_count', entityId: count.id, newValue: { number: count.number, varianceQty: count.varianceQty, varianceValue: count.varianceValue } });
  await emitEvent(tx, ctx.tenantId, 'stock_count.posted', { countId: count.id, number: count.number });
}

registerApprovalHandler('stock_count', {
  approve: async (tx, ctx, id) => {
    const c = await load(tx, ctx.tenantId, id);
    if (c.status !== 'pending_approval') throw invalidState('Count is not awaiting approval.');
    await tx.update(t.stockCounts).set({ status: 'approved', approvedAt: new Date(), approvedBy: ctx.userId }).where(eq(t.stockCounts.id, id));
    await postCount(tx, ctx, id);
  },
  reject: async (tx, ctx, id, comment) => {
    await tx.update(t.stockCounts).set({ status: 'counting', notes: sql`${t.stockCounts.notes} || ${`\n[Recount requested] ${comment}`}` }).where(and(eq(t.stockCounts.id, id), eq(t.stockCounts.tenantId, ctx.tenantId)));
  },
});

export function registerCountRoutes(r: Router) {
  r.get('/', { summary: 'Stock counts', permission: ['inventory.count', 'inventory.view'], query: pageQuery.extend({ status: z.string().optional(), mine: z.coerce.boolean().optional() }) }, async ({ ctx, query }) => {
    const statuses = query.status?.split(',').filter(Boolean);
    const list = await rows<Record<string, unknown>>(db(), sql`
      SELECT c.id, c.number, c.type, c.status, c.is_blind AS "isBlind", c.variance_qty::float AS "varianceQty", c.variance_value::float AS "varianceValue", c.created_at AS "createdAt", c.submitted_at AS "submittedAt",
        w.code AS "warehouseCode", u.name AS "assignedTo", c.assigned_to AS "assignedToId",
        (SELECT COUNT(*)::int FROM stock_count_lines l WHERE l.count_id = c.id) AS lines,
        (SELECT COUNT(*)::int FROM stock_count_lines l WHERE l.count_id = c.id AND l.counted_qty IS NOT NULL) AS counted,
        COUNT(*) OVER() AS total_count
      FROM stock_counts c JOIN warehouses w ON w.id = c.warehouse_id LEFT JOIN users u ON u.id = c.assigned_to
      WHERE c.tenant_id = ${ctx.tenantId}
      ${statuses?.length ? sql`AND c.status IN (${sql.join(statuses.map((s) => sql`${s}`), sql`, `)})` : sql``}
      ${query.mine ? sql`AND c.assigned_to = ${ctx.userId}` : sql``}
      ORDER BY c.created_at DESC LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`);
    return paged(redactFinance(ctx, list.map(({ total_count: _t, ...x }) => x)), num(list[0]?.total_count), query.page, query.pageSize);
  });

  r.post('/', {
    summary: 'Create a count. Lines are snapshotted from the system balance (full, cycle, blind, location or product scope).',
    permission: 'inventory.count',
    body: z.object({
      warehouseId: z.string().uuid(),
      type: z.enum(COUNT_TYPES).default('cycle'),
      blind: z.boolean().default(false),
      assignedTo: z.string().uuid().nullish(),
      locationIds: z.array(z.string().uuid()).max(2000).optional(),
      productIds: z.array(z.string().uuid()).max(2000).optional(),
      zoneId: z.string().uuid().optional(),
      cycleSample: z.number().int().min(1).max(500).default(20),
      notes: z.string().trim().max(500).default(''),
    }),
  }, async ({ ctx, body }) => {
    return db().transaction(async (tx) => {
      const [w] = await tx.select({ id: t.warehouses.id }).from(t.warehouses).where(and(eq(t.warehouses.id, body.warehouseId), eq(t.warehouses.tenantId, ctx.tenantId))).limit(1);
      if (!w) throw notFound('Warehouse');
      if (body.type === 'location' && !body.locationIds?.length && !body.zoneId) throw badRequest('Choose the locations or zone to count.');
      if (body.type === 'product' && !body.productIds?.length) throw badRequest('Choose the products to count.');
      const zoneFilter = body.zoneId ? sql`AND b.location_id IN (WITH RECURSIVE tree AS (SELECT id FROM locations WHERE id = ${body.zoneId} UNION ALL SELECT l.id FROM locations l JOIN tree ON l.parent_id = tree.id) SELECT id FROM tree)` : sql``;
      const locFilter = body.locationIds?.length ? sql`AND b.location_id IN (${sql.join(body.locationIds.map((x) => sql`${x}`), sql`, `)})` : sql``;
      const prodFilter = body.productIds?.length ? sql`AND b.product_id IN (${sql.join(body.productIds.map((x) => sql`${x}`), sql`, `)})` : sql``;
      // Cycle count: highest-value / least-recently-counted items first (ABC-style sampling).
      const cycle = body.type === 'cycle' && !body.locationIds?.length && !body.productIds?.length && !body.zoneId;
      const snapshot = await rows<{ location_id: string; product_id: string; batch_id: string | null; owner_customer_id: string | null; quantity: string; cost: string }>(tx, sql`
        SELECT b.location_id, b.product_id, b.batch_id, b.owner_customer_id, b.quantity, p.cost_price AS cost
        FROM inventory_balances b JOIN products p ON p.id = b.product_id JOIN locations l ON l.id = b.location_id
        WHERE b.tenant_id = ${ctx.tenantId} AND b.warehouse_id = ${w.id} AND b.status = 'available' AND b.quantity > 0 AND l.type NOT IN ('dock')
        ${zoneFilter} ${locFilter} ${prodFilter}
        ${cycle ? sql`ORDER BY (SELECT MAX(sc.created_at) FROM stock_count_lines scl JOIN stock_counts sc ON sc.id = scl.count_id WHERE scl.product_id = b.product_id AND scl.location_id = b.location_id) ASC NULLS FIRST, b.quantity * p.cost_price DESC LIMIT ${body.cycleSample}` : sql`ORDER BY l.code`}`);
      if (!snapshot.length) throw badRequest('No stock found in the selected scope.');
      const [count] = await tx.insert(t.stockCounts).values({
        tenantId: ctx.tenantId, number: await nextNumber(tx, ctx.tenantId, 'CNT'), warehouseId: w.id, type: body.type, isBlind: body.blind || body.type === 'blind',
        status: body.assignedTo ? 'assigned' : 'draft', assignedTo: body.assignedTo ?? null, notes: body.notes, createdBy: ctx.userId,
        scope: { locationIds: body.locationIds, productIds: body.productIds, zoneId: body.zoneId },
      }).returning();
      await tx.insert(t.stockCountLines).values(snapshot.map((s) => ({ tenantId: ctx.tenantId, countId: count!.id, locationId: s.location_id, productId: s.product_id, batchId: s.batch_id, ownerCustomerId: s.owner_customer_id, expectedQty: num(s.quantity), unitCost: num(s.cost) })));
      await audit(tx, ctx, { action: 'stock_count.created', entityType: 'stock_count', entityId: count!.id, newValue: { number: count!.number, type: body.type, lines: snapshot.length } });
      return { ...count!, lines: snapshot.length };
    });
  });

  r.get('/:id', { summary: 'Count sheet. Blind counts hide expected quantities from counters until submitted.', permission: ['inventory.count', 'inventory.view'], params: idParam }, async ({ ctx, params }) => {
    const c = await load(db(), ctx.tenantId, params.id);
    const hideExpected = c.isBlind && ['draft', 'assigned', 'counting'].includes(c.status) && !ctx.permissions.has('inventory.approve');
    const lines = await rows<Record<string, unknown>>(db(), sql`
      SELECT l.id, l.location_id AS "locationId", loc.code AS "locationCode", loc.barcode AS "locationBarcode", p.id AS "productId", p.sku, p.name AS "productName", p.barcode, p.uom, bt.batch_no AS "batchNo",
        l.expected_qty::float AS "expectedQty", l.counted_qty::float AS "countedQty", l.variance_qty::float AS "varianceQty", l.variance_value::float AS "varianceValue", l.counted_at AS "countedAt", u.name AS "countedBy"
      FROM stock_count_lines l JOIN locations loc ON loc.id = l.location_id JOIN products p ON p.id = l.product_id LEFT JOIN batches bt ON bt.id = l.batch_id LEFT JOIN users u ON u.id = l.counted_by
      WHERE l.count_id = ${c.id} ORDER BY loc.code, p.sku`);
    const [w] = await db().select({ code: t.warehouses.code, name: t.warehouses.name }).from(t.warehouses).where(eq(t.warehouses.id, c.warehouseId));
    const [tenant] = await db().select({ settings: t.tenants.settings }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId));
    return redactFinance(ctx, {
      ...c, warehouse: w, hideExpected, tolerancePct: tenant?.settings.inventory?.defaultCountTolerancePct ?? 2,
      lines: hideExpected ? lines.map((l) => ({ ...l, expectedQty: null, varianceQty: null, varianceValue: null })) : lines,
    });
  });

  r.post('/:id/assign', { summary: 'Assign a counter', permission: ['inventory.count', 'task.manage'], params: idParam, body: z.object({ userId: z.string().uuid() }) }, async ({ ctx, params, body }) => {
    const c = await load(db(), ctx.tenantId, params.id);
    if (!['draft', 'assigned'].includes(c.status)) throw invalidState('Counting has already started.');
    await db().update(t.stockCounts).set({ assignedTo: body.userId, status: 'assigned' }).where(eq(t.stockCounts.id, c.id));
    await audit(db(), ctx, { action: 'stock_count.assigned', entityType: 'stock_count', entityId: c.id, newValue: body });
    return { ok: true };
  });

  r.post('/:id/record', {
    summary: 'Record counted quantities (scan location + product, enter quantity). Can be called repeatedly.',
    permission: 'inventory.count',
    idempotent: true,
    params: idParam,
    body: z.object({ lines: z.array(z.object({ lineId: z.string().uuid().optional(), locationId: z.string().uuid().optional(), productId: z.string().uuid().optional(), countedQty: z.number().min(0) })).min(1).max(2000) }),
  }, async ({ ctx, params, body }) => {
    return db().transaction(async (tx) => {
      const c = await load(tx, ctx.tenantId, params.id);
      if (!['draft', 'assigned', 'counting'].includes(c.status)) throw invalidState('This count is no longer open for counting.');
      if (c.assignedTo && c.assignedTo !== ctx.userId && !ctx.permissions.has('task.manage') && !ctx.permissions.has('inventory.approve')) throw forbidden('This count is assigned to someone else.');
      let recorded = 0;
      for (const input of body.lines) {
        let [line] = input.lineId
          ? await tx.select().from(t.stockCountLines).where(and(eq(t.stockCountLines.id, input.lineId), eq(t.stockCountLines.countId, c.id))).limit(1)
          : await tx.select().from(t.stockCountLines).where(and(eq(t.stockCountLines.countId, c.id), eq(t.stockCountLines.locationId, input.locationId ?? ''), eq(t.stockCountLines.productId, input.productId ?? ''))).limit(1);
        if (!line && input.locationId && input.productId) {
          // Found stock that the system did not expect at this location.
          const [p] = await tx.select({ cost: t.products.costPrice }).from(t.products).where(and(eq(t.products.id, input.productId), eq(t.products.tenantId, ctx.tenantId))).limit(1);
          const [loc] = await tx.select({ id: t.locations.id }).from(t.locations).where(and(eq(t.locations.id, input.locationId), eq(t.locations.warehouseId, c.warehouseId))).limit(1);
          if (!p || !loc) throw badRequest('Unknown product or location for this warehouse.');
          [line] = await tx.insert(t.stockCountLines).values({ tenantId: ctx.tenantId, countId: c.id, locationId: loc.id, productId: input.productId, expectedQty: 0, unitCost: p.cost }).returning();
        }
        if (!line) throw badRequest('Count line not found.');
        const variance = input.countedQty - line.expectedQty;
        await tx.update(t.stockCountLines).set({ countedQty: input.countedQty, varianceQty: variance, varianceValue: Math.round(variance * line.unitCost * 100) / 100, countedBy: ctx.userId, countedAt: new Date() }).where(eq(t.stockCountLines.id, line.id));
        recorded++;
      }
      await tx.update(t.stockCounts).set({ status: 'counting', startedAt: c.startedAt ?? new Date() }).where(eq(t.stockCounts.id, c.id));
      return { recorded };
    });
  });

  r.post('/:id/submit', {
    summary: 'Submit for review. Variances within tolerance post automatically; significant variances require approval.',
    permission: 'inventory.count',
    params: idParam,
  }, async ({ ctx, params }) => {
    return db().transaction(async (tx) => {
      const c = await load(tx, ctx.tenantId, params.id);
      if (!['counting', 'assigned', 'draft'].includes(c.status)) throw invalidState('This count was already submitted.');
      const lines = await tx.select().from(t.stockCountLines).where(eq(t.stockCountLines.countId, c.id));
      const uncounted = lines.filter((l) => l.countedQty === null).length;
      if (uncounted) throw badRequest(`${uncounted} line(s) have not been counted yet. Enter 0 for empty locations.`);
      const varianceQty = lines.reduce((s, l) => s + l.varianceQty, 0);
      const varianceValue = Math.round(lines.reduce((s, l) => s + Math.abs(l.varianceValue), 0) * 100) / 100;
      const expected = lines.reduce((s, l) => s + l.expectedQty, 0);
      const [tenant] = await tx.select({ settings: t.tenants.settings }).from(t.tenants).where(eq(t.tenants.id, ctx.tenantId));
      const tolerance = tenant?.settings.inventory?.defaultCountTolerancePct ?? 2;
      const maxLinePct = Math.max(0, ...lines.map((l) => (l.expectedQty > 0 ? (Math.abs(l.varianceQty) / l.expectedQty) * 100 : l.varianceQty !== 0 ? 100 : 0)));
      await tx.update(t.stockCounts).set({ varianceQty, varianceValue, submittedAt: new Date(), status: 'review' }).where(eq(t.stockCounts.id, c.id));
      const rule = await findApplicableRule(tx, ctx.tenantId, 'stock_count', varianceValue);
      const significant = !!rule || maxLinePct > tolerance;
      if (!lines.some((l) => Math.abs(l.varianceQty) > 1e-9)) {
        await postCount(tx, ctx, c.id);
        return { status: 'posted', varianceQty: 0, message: 'No variances — count posted.' };
      }
      if (significant) {
        // Outside tolerance with no value rule: route to the warehouse manager.
        const requestId = await createApprovalRequest(tx, ctx, { entityType: 'stock_count', entityId: c.id, entityNumber: c.number, amount: varianceValue, rule: rule ?? { id: null, approverRoleKey: 'warehouse_manager' }, summary: `${c.number}: net variance ${varianceQty} units, absolute value ${varianceValue.toLocaleString()} (expected ${expected} units, largest line variance ${Math.round(maxLinePct)}%)` });
        await tx.update(t.stockCounts).set({ status: 'pending_approval', approvalRequestId: requestId }).where(eq(t.stockCounts.id, c.id));
        await audit(tx, ctx, { action: 'stock_count.submitted', entityType: 'stock_count', entityId: c.id, newValue: { varianceQty, varianceValue, requiresApproval: true } });
        return { status: 'pending_approval', varianceQty, varianceValue };
      }
      await postCount(tx, ctx, c.id);
      return { status: 'posted', varianceQty, varianceValue, message: `Variances within ${tolerance}% tolerance were posted.` };
    });
  });

  r.post('/:id/cancel', { summary: 'Cancel an open count', permission: 'inventory.count', params: idParam }, async ({ ctx, params }) => {
    const c = await load(db(), ctx.tenantId, params.id);
    if (['posted', 'cancelled'].includes(c.status)) throw invalidState('This count is closed.');
    await db().update(t.stockCounts).set({ status: 'cancelled' }).where(eq(t.stockCounts.id, c.id));
    if (c.approvalRequestId) await db().update(t.approvalRequests).set({ status: 'cancelled' }).where(eq(t.approvalRequests.id, c.approvalRequestId));
    await audit(db(), ctx, { action: 'stock_count.cancelled', entityType: 'stock_count', entityId: c.id });
    return { ok: true };
  });
}
